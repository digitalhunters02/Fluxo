// Calendário de depósitos federais da folha (IRS Pub. 15, seção 11). O Fluxo CALCULA quanto e até quando depositar;
// quem paga é a empresa, no EFTPS.gov. "Marcar como pago" só registra o pagamento nos livros (baixa do passivo da folha).
//
// Regras implementadas:
//  - período de referência (lookback) do 941 para o ano Y: 1º/jul de Y-2 a 30/jun de Y-1. Imposto ≤ US$ 50.000 → mensal; acima → quinzenal
//    ("semiweekly"); sem folha no período (empresa nova) → mensal. Pode ser fixado à mão em Configurações > Folha (ex.: folha feita em outro sistema).
//  - mensal: imposto do mês vence no dia 15 do mês seguinte.
//  - semiweekly: pagamento na qua/qui/sex → quarta seguinte; sáb/dom/seg/ter → sexta seguinte. Na prática é o 3º dia útil depois do fim do
//    período (sexta ou terça); cada feriado nesses 3 dias empurra um dia útil. Um período que atravessa o fim do trimestre vira dois depósitos.
//  - regra dos US$ 100.000: se o imposto acumulado num período chega a US$ 100.000, deposita no dia útil seguinte e passa a semiweekly.
//  - trimestre com menos de US$ 2.500 de imposto: pode ser pago junto com o Form 941 (o depósito aparece marcado como opcional).
//  - FUTA: acumula por trimestre; acima de US$ 500 deposita até o último dia do mês seguinte ao trimestre; abaixo, passa para o próximo.
//  - toda data que cai em fim de semana ou feriado federal (lista da Pub. 15, inclusive o Emancipation Day de D.C.) vai para o próximo dia útil.
import { all, get, run, insert, tx, getSetting, setSetting } from './db.js';
import { HttpError, today, isDate } from './accounting.js';
import { remit } from './payroll.js';
import { removeEntries } from './accounting.js';

const bad = (m) => new HttpError(400, m);
export const LOOKBACK_LIMIT = 5_000_000;       // US$ 50.000
export const NEXT_DAY_LIMIT = 10_000_000;      // US$ 100.000
export const SMALL_QUARTER = 250_000;          // US$ 2.500
export const FUTA_DEPOSIT_LIMIT = 50_000;      // US$ 500
export const FED_CODES = ['fit', 'ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee'];

/* ------------------------------------------- datas ------------------------------------------- */
const D = (iso) => new Date(`${iso}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);
export const addDaysIso = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekday = (s) => D(s).getUTCDay(); // 0 domingo … 6 sábado
const nthWeekday = (y, m, wd, n) => { // n-ésimo dia da semana do mês (n = -1: último)
  if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)); const d = 1 + ((wd - first.getUTCDay() + 7) % 7) + (n - 1) * 7; return iso(new Date(Date.UTC(y, m - 1, d))); }
  const last = new Date(Date.UTC(y, m, 0)); const d = last.getUTCDate() - ((last.getUTCDay() - wd + 7) % 7); return iso(new Date(Date.UTC(y, m - 1, d)));
};
const observed = (s) => { const w = weekday(s); return w === 6 ? addDaysIso(s, -1) : w === 0 ? addDaysIso(s, 1) : s; };
const p2 = (n) => String(n).padStart(2, '0');
/** Feriados legais (Pub. 15) do ano, com a data observada (sábado → sexta, domingo → segunda). */
export function federalHolidays(y) {
  const h = [
    observed(`${y}-01-01`), nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), observed(`${y}-04-16`), nthWeekday(y, 5, 1, -1),
    observed(`${y}-06-19`), observed(`${y}-07-04`), nthWeekday(y, 9, 1, 1), nthWeekday(y, 10, 1, 2), observed(`${y}-11-11`),
    nthWeekday(y, 11, 4, 4), observed(`${y}-12-25`),
  ];
  if ((y - 2021) % 4 === 0) h.push(weekday(`${y}-01-20`) === 0 ? `${y}-01-21` : `${y}-01-20`); // Inauguration Day (D.C.)
  const next = observed(`${y + 1}-01-01`); if (next.startsWith(String(y))) h.push(next); // 1º/jan num sábado é observado em 31/dez
  return [...new Set(h)].sort();
}
const holidayCache = new Map();
export const isHoliday = (s) => { const y = Number(s.slice(0, 4)); if (!holidayCache.has(y)) holidayCache.set(y, new Set(federalHolidays(y))); return holidayCache.get(y).has(s); };
export const isBusinessDay = (s) => { const w = weekday(s); return w !== 0 && w !== 6 && !isHoliday(s); };
/** Data que cai em fim de semana/feriado vai para o próximo dia útil. */
export const rollForward = (s) => { let d = s; while (!isBusinessDay(d)) d = addDaysIso(d, 1); return d; };
export const nextBusinessDay = (s) => rollForward(addDaysIso(s, 1));
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const quarterOf = (s) => Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1;

/** Vencimento mensal: dia 15 do mês seguinte (ajustado). */
export const monthlyDue = (ym) => { let [y, m] = ym.split('-').map(Number); m += 1; if (m > 12) { m = 1; y += 1; } return rollForward(`${y}-${p2(m)}-15`); };
/** Fim do período semiweekly do pagamento: qua–sex → sexta; sáb–ter → terça. */
export function semiweeklyPeriodEnd(payday) {
  const w = weekday(payday);
  if (w >= 3 && w <= 5) return addDaysIso(payday, 5 - w);
  return addDaysIso(payday, (2 - w + 7) % 7); // sáb(6)→+3, dom(0)→+2, seg(1)→+1, ter(2)→0
}
/** Vencimento semiweekly: 3º dia útil (sem fins de semana e feriados) depois do fim do período → quarta (pagamento qua–sex) ou sexta (sáb–ter). */
export function semiweeklyDue(payday) {
  let d = semiweeklyPeriodEnd(payday), n = 0;
  while (n < 3) { d = addDaysIso(d, 1); if (isBusinessDay(d)) n += 1; }
  return d;
}
/** FUTA: último dia do mês seguinte ao trimestre (ajustado). */
export const futaDue = (year, q) => { let m = q * 3 + 1, y = year; if (m > 12) { m = 1; y += 1; } return rollForward(`${y}-${p2(m)}-${lastDayOfMonth(y, m)}`); };

/* --------------------------------------- passivos por dia de pagamento --------------------------------------- */
/** Imposto federal (941) e FUTA de cada dia de pagamento das folhas finalizadas, por componente. */
export function liabilitiesByPayday(from = '0000-01-01', to = '9999-12-31') {
  const by = new Map();
  for (const l of all(`SELECT r.pay_date, l.details FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id WHERE r.status='final' AND r.pay_date>=? AND r.pay_date<=? ORDER BY r.pay_date`, from, to)) {
    const d = JSON.parse(l.details);
    const row = by.get(l.pay_date) || { date: l.pay_date, comp: Object.fromEntries([...FED_CODES, 'futa'].map((c) => [c, 0])) };
    for (const x of [...d.ee, ...d.er]) if (x.code in row.comp) row.comp[x.code] += x.amount;
    by.set(l.pay_date, row);
  }
  return [...by.values()].map((r) => ({ ...r, total941: FED_CODES.reduce((s, c) => s + r.comp[c], 0), futa: r.comp.futa })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Imposto do 941 no período de referência do ano (jul/Y-2 a jun/Y-1). */
export function lookbackTotal(year) {
  const rows = liabilitiesByPayday(`${year - 2}-07-01`, `${year - 1}-06-30`);
  return { from: `${year - 2}-07-01`, to: `${year - 1}-06-30`, total: rows.reduce((s, r) => s + r.total941, 0), hasPayroll: rows.length > 0 };
}
/** Mensal ou semiweekly no ano, e por quê. Configuração: payroll_deposit_schedule = auto | monthly | semiweekly; payroll_lookback_amount (centavos, opcional). */
export function scheduleFor(year) {
  const mode = getSetting('payroll_deposit_schedule', 'auto');
  if (mode === 'monthly' || mode === 'semiweekly') return { year, schedule: mode, reason: 'manual' };
  const manual = getSetting('payroll_lookback_amount', '');
  const lb = lookbackTotal(year);
  if (manual !== '') { const total = Number(manual); return { year, schedule: total > LOOKBACK_LIMIT ? 'semiweekly' : 'monthly', reason: 'lookback_manual', lookback: { ...lb, total } }; }
  if (!lb.hasPayroll) return { year, schedule: 'monthly', reason: 'first_year', lookback: lb };
  return { year, schedule: lb.total > LOOKBACK_LIMIT ? 'semiweekly' : 'monthly', reason: 'lookback', lookback: lb };
}

const sumComp = (a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] || 0) + b[k]; return a; };

/**
 * Lista de depósitos calculados a partir das folhas finalizadas (função quase pura: recebe os passivos por dia e o calendário de cada ano).
 * Cada depósito: { key, kind:'941'|'futa', schedule, period, from, to, quarter, year, amount, components, due_date, next_day, small_quarter }
 */
export function computeDeposits(rows, scheduleOf = (y) => scheduleFor(y).schedule) {
  const out = [];
  const years = [...new Set(rows.map((r) => Number(r.date.slice(0, 4))))].sort();
  for (const year of years) {
    const yr = rows.filter((r) => r.date.startsWith(String(year)));
    let schedule = scheduleOf(year);
    const qTotals = {}; for (const r of yr) qTotals[quarterOf(r.date)] = (qTotals[quarterOf(r.date)] || 0) + r.total941;
    let bucket = null;
    const close = () => { if (bucket && bucket.amount > 0) out.push(bucket); bucket = null; };
    for (const r of yr) {
      if (!r.total941) continue;
      const q = quarterOf(r.date);
      const key = schedule === 'monthly' ? `941:M:${r.date.slice(0, 7)}` : `941:S:${semiweeklyPeriodEnd(r.date)}:Q${q}`;
      if (!bucket || bucket.key !== key) {
        close();
        bucket = schedule === 'monthly'
          ? { key, kind: '941', schedule, period: r.date.slice(0, 7), year, quarter: q, from: `${r.date.slice(0, 7)}-01`, to: `${r.date.slice(0, 7)}-${p2(lastDayOfMonth(year, Number(r.date.slice(5, 7))))}`, amount: 0, components: {}, paydays: [], due_date: monthlyDue(r.date.slice(0, 7)) }
          : { key, kind: '941', schedule, period: semiweeklyPeriodEnd(r.date), year, quarter: q, from: r.date, to: r.date, amount: 0, components: {}, paydays: [], due_date: semiweeklyDue(r.date) };
      }
      bucket.amount += r.total941; sumComp(bucket.components, Object.fromEntries(FED_CODES.map((c) => [c, r.comp[c]]))); bucket.paydays.push(r.date);
      if (r.date < bucket.from) bucket.from = r.date; if (r.date > bucket.to) bucket.to = r.date;
      if (bucket.amount >= NEXT_DAY_LIMIT) { // regra dos US$ 100.000: dia útil seguinte e semiweekly daqui em diante
        bucket.key = `941:N:${r.date}`; bucket.next_day = true; bucket.due_date = nextBusinessDay(r.date); bucket.schedule = 'next_day';
        close(); schedule = 'semiweekly';
      }
    }
    close();
    for (const d of out) if (d.kind === '941' && d.year === year) d.small_quarter = (qTotals[d.quarter] || 0) < SMALL_QUARTER && !out.some((x) => x.year === year && x.quarter === d.quarter && x.next_day);
    // FUTA por trimestre
    let carry = 0, carryComp = 0;
    const now = today();
    for (let q = 1; q <= 4; q += 1) {
      const qa = yr.filter((r) => quarterOf(r.date) === q).reduce((s, r) => s + r.futa, 0);
      carry += qa; carryComp += qa;
      const qEnd = `${year}-${p2(q * 3)}-${p2(lastDayOfMonth(year, q * 3))}`;
      if (carry > FUTA_DEPOSIT_LIMIT || (q === 4 && carry > 0)) {
        out.push({ key: `futa:${year}:Q${q}`, kind: 'futa', schedule: 'quarterly', period: `${year}-Q${q}`, year, quarter: q, from: `${year}-01-01`, to: qEnd, amount: carry, components: { futa: carry },
          due_date: futaDue(year, q), with_return: q === 4 && carry <= FUTA_DEPOSIT_LIMIT, in_progress: qEnd >= now });
        carry = 0;
      }
    }
  }
  return out.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : a.key < b.key ? -1 : 1));
}

/** Depósitos com a situação (pendente/pago) e o aviso de "vence em breve". */
export function listDeposits({ year } = {}) {
  const rows = liabilitiesByPayday();
  const paid = Object.fromEntries(all('SELECT id, dkey, amount, paid_date, eftps_confirmation, receipt_name, user_name, created_at, (receipt IS NOT NULL) AS has_receipt FROM tax_deposits').map((p) => [p.dkey, p]));
  const t = today();
  let list = computeDeposits(rows).map((d) => {
    const p = paid[d.key];
    const status = p ? 'paid' : d.due_date < t ? 'overdue' : 'pending';
    return { ...d, status, payment: p ? { ...p, has_receipt: !!p.has_receipt, differs: p.amount !== d.amount } : null, due_soon: !p && d.due_date >= t && d.due_date <= addDaysIso(t, 3) };
  });
  // pagamentos cujo período sumiu (folha anulada depois) continuam aparecendo para poderem ser desfeitos
  for (const p of Object.values(paid)) if (!list.some((d) => d.key === p.dkey)) list.push({ key: p.dkey, kind: p.dkey.startsWith('futa') ? 'futa' : '941', amount: 0, components: {}, due_date: p.paid_date, status: 'paid', orphan: true, payment: { ...p, has_receipt: !!p.has_receipt, differs: true } });
  if (year) list = list.filter((d) => String(d.year || d.due_date.slice(0, 4)) === String(year));
  const years = [...new Set(rows.map((r) => Number(r.date.slice(0, 4))))];
  return { deposits: list, schedules: years.map((y) => scheduleFor(y)), settings: depositSettings() };
}

export const depositSettings = () => ({ schedule: getSetting('payroll_deposit_schedule', 'auto'), lookback_amount: getSetting('payroll_lookback_amount', '') });
export function saveDepositSettings(b) {
  if (b.schedule !== undefined) { if (!['auto', 'monthly', 'semiweekly'].includes(b.schedule)) throw bad('Invalid deposit schedule'); setSetting('payroll_deposit_schedule', b.schedule); }
  if (b.lookback_amount !== undefined) {
    if (b.lookback_amount === '' || b.lookback_amount === null) setSetting('payroll_lookback_amount', '');
    else { const n = Math.round(Number(b.lookback_amount)); if (!Number.isFinite(n) || n < 0) throw bad('Invalid amount'); setSetting('payroll_lookback_amount', String(n)); }
  }
  return depositSettings();
}

const RECEIPT_RE = /^data:(image\/(png|jpeg|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
/** Registra que o depósito foi pago no EFTPS (data, confirmação opcional, comprovante opcional) e baixa o passivo da folha nos livros. */
export function markPaid({ key, paid_date, account_id, eftps_confirmation = '', receipt = null, receipt_name = '' }, user) {
  if (!isDate(paid_date)) throw bad('Invalid date');
  if (paid_date > today()) throw bad('The payment date cannot be in the future');
  const conf = String(eftps_confirmation || '').trim();
  if (conf.length > 40) throw bad('The EFTPS confirmation number is too long');
  if (receipt && !(RECEIPT_RE.test(receipt) && receipt.length <= 2_800_000)) throw bad('The receipt must be a PNG, JPEG, WebP or PDF under 2 MB');
  const dep = computeDeposits(liabilitiesByPayday()).find((d) => d.key === key);
  if (!dep) throw new HttpError(404, 'Deposit not found');
  if (get('SELECT 1 FROM tax_deposits WHERE dkey=?', key)) throw bad('This deposit is already marked as paid');
  return tx(() => {
    const did = insert('INSERT INTO tax_deposits(dkey,kind,amount,due_date,paid_date,account_id,eftps_confirmation,receipt,receipt_name,user_id,user_name) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      key, dep.kind, dep.amount, dep.due_date, paid_date, account_id || null, conf, receipt || null, String(receipt_name || '').slice(0, 120), user?.id ?? null, user?.name || '');
    const items = Object.entries(dep.components).filter(([, v]) => v > 0).map(([component, amount]) => ({ component, amount }));
    const memo = dep.kind === 'futa' ? `FUTA deposit ${dep.period} (EFTPS)` : `Federal tax deposit ${dep.period} (EFTPS)`;
    const r = remit({ items, date: paid_date, account_id, memo: conf ? `${memo} #${conf}` : memo, deposit_id: did }, user);
    run('UPDATE tax_deposits SET remit_ids=? WHERE id=?', JSON.stringify(r.ids), did);
    return { id: did, total: r.total };
  });
}
/** Desfaz o "pago" (por engano): apaga o registro e o lançamento contábil. */
export function unmarkPaid(id) {
  const d = get('SELECT * FROM tax_deposits WHERE id=?', id);
  if (!d) throw new HttpError(404, 'Deposit not found');
  return tx(() => {
    const ids = JSON.parse(d.remit_ids || '[]');
    if (ids.length) removeEntries('payroll_remit', ids[0]);
    run('DELETE FROM payroll_remittances WHERE deposit_id=?', id);
    run('DELETE FROM tax_deposits WHERE id=?', id);
    return { ok: true };
  });
}
export function depositReceipt(id) {
  const d = get('SELECT receipt, receipt_name FROM tax_deposits WHERE id=?', id);
  if (!d?.receipt) throw new HttpError(404, 'No receipt');
  return { receipt: d.receipt, name: d.receipt_name };
}

/** Avisos de depósito: 3 dias antes e no dia (para o sino e para o e-mail). */
export function depositNotices(t = today()) {
  const out = [];
  for (const d of listDeposits().deposits) {
    if (d.status === 'paid' || d.in_progress) continue;
    if (d.due_date === t || d.due_date < t) out.push({ ...d, stage: 'due' });
    else if (d.due_date <= addDaysIso(t, 3)) out.push({ ...d, stage: 'soon' });
  }
  return out;
}
