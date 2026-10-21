// Formulários federais da folha a partir dos números do Fluxo: Form 941 (linhas 1–15, Parte 2 e Schedule B), Form 940 (linhas 1–17,
// Parte 5), W-2/W-3 (quadros), arquivo EFW2 para o SSA (Business Services Online) e 1099-NEC (cópia do prestador e CSV para o IRIS).
// O Fluxo NÃO envia nada ao governo: gera os números e os arquivos; a empresa confere, assina e envia.
import { all, get, getSetting, setSetting } from './db.js';
import { HttpError } from './accounting.js';
import { open as openTaxId, mask as maskTaxId } from './taxid.js';
import { report1099, form1099Threshold, US_2026 } from './payroll.js';
import { liabilitiesByPayday, computeDeposits, quarterOf, scheduleFor, SMALL_QUARTER, FED_CODES } from './payrollDeposits.js';

const bad = (m) => new HttpError(400, m);
const p2 = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const quarterRange = (year, q) => { const m1 = (q - 1) * 3 + 1, m3 = m1 + 2; return [`${year}-${p2(m1)}-01`, `${year}-${p2(m3)}-${p2(lastDay(year, m3))}`]; };
const sumCodes = (d, codes, onlyEe = false) => [...d.ee, ...(onlyEe ? [] : d.er)].filter((x) => codes.includes(x.code)).reduce((s, x) => s + x.amount, 0);
const finalLines = (from, to) => all(`SELECT l.*, e.name AS employee_name, r.pay_date, r.period_start, r.period_end, r.id AS run_id FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id JOIN employees e ON e.id=l.employee_id
  WHERE r.status='final' AND r.pay_date>=? AND r.pay_date<=? ORDER BY r.pay_date, r.id, l.id`, from, to).map((l) => ({ ...l, details: JSON.parse(l.details) }));

/* ------------------------------------------- empregador ------------------------------------------- */
export const EMPLOYER_KEYS = ['employer_ein', 'employer_name', 'employer_trade_name', 'employer_address', 'employer_city', 'employer_state', 'employer_zip', 'employer_state_id',
  'employer_kind', 'w2_bso_user_id', 'w2_contact_name', 'w2_contact_phone', 'w2_contact_email', 'w2_include_rs', 'w2_state_code'];
export function employerSettings() {
  const s = Object.fromEntries(EMPLOYER_KEYS.map((k) => [k, getSetting(k, '')]));
  const companyEin = String(getSetting('company_tax_id', '')).replace(/\D/g, '');
  s.employer_ein ||= getSetting('nacha_ein', '') || (companyEin.length === 9 ? companyEin : ''); // mesmo EIN já digitado no arquivo do banco ou na empresa
  s.employer_name ||= getSetting('company_name', '');
  s.employer_kind ||= 'N';
  s.w2_contact_email ||= getSetting('company_email', '');
  s.w2_include_rs = s.w2_include_rs === '1';
  return s;
}
export function saveEmployerSettings(b) {
  const ein = String(b.employer_ein ?? '').replace(/\D/g, '');
  if (ein && ein.length !== 9) throw bad('EIN must have 9 digits');
  if (b.employer_state && !/^[A-Za-z]{2}$/.test(b.employer_state)) throw bad('State must be the 2-letter abbreviation');
  if (b.employer_zip && !/^\d{5}(-?\d{4})?$/.test(String(b.employer_zip).trim())) throw bad('Invalid ZIP code');
  if (b.w2_bso_user_id && !/^[A-Za-z0-9]{8}$/.test(String(b.w2_bso_user_id).trim())) throw bad('The BSO User ID has 8 letters or numbers');
  if (b.employer_kind && !['N', 'T', 'S', 'Y', 'F'].includes(b.employer_kind)) throw bad('Invalid kind of employer');
  for (const k of EMPLOYER_KEYS) {
    if (!(k in b)) continue;
    let v = b[k];
    if (k === 'employer_ein') v = ein;
    else if (k === 'w2_include_rs') v = b[k] ? '1' : '0';
    else if (k === 'employer_state') v = String(v || '').toUpperCase();
    else v = String(v ?? '').trim().slice(0, 120);
    setSetting(k, v);
  }
  return employerSettings();
}

/* --------------------------------------------- Form 941 --------------------------------------------- */
/** Mapeia os números do Fluxo para cada linha do Form 941 do trimestre (linhas 1–15, Parte 2, Schedule B quando semiweekly). */
export function form941Lines(year, quarter) {
  if (!(quarter >= 1 && quarter <= 4)) throw bad('Quarter must be 1–4');
  const [from, to] = quarterRange(year, quarter);
  const ls = finalLines(from, to);
  const sum = (f) => ls.reduce((s, l) => s + f(l.details, l), 0);
  const twelfth = `${year}-${p2(quarter * 3)}-12`;
  const line1 = new Set(ls.filter((l) => l.period_start <= twelfth && l.period_end >= twelfth).map((l) => l.employee_id)).size;
  const line2 = sum((d) => d.bases.fit);
  const line3 = sum((d) => sumCodes(d, ['fit']));
  const ssWages = sum((d) => d.bases.ss), medWages = sum((d) => d.bases.med);
  // salário sujeito ao Medicare adicional: o que passou de US$ 200.000 no ano, por funcionário (conta o ano até o fim do trimestre)
  const ytd = new Map(); let addMedWages = 0;
  for (const l of finalLines(`${year}-01-01`, to)) {
    const before = ytd.get(l.employee_id) || 0; ytd.set(l.employee_id, before + l.gross);
    if (l.pay_date >= from) addMedWages += Math.max(0, before + l.gross - Math.max(US_2026.addMedThreshold, before));
  }
  const l5a2 = Math.round(ssWages * 0.124), l5c2 = Math.round(medWages * 0.029), l5d2 = Math.round(addMedWages * 0.009);
  const l5e = l5a2 + l5c2 + l5d2;
  const actualFica = sum((d) => sumCodes(d, ['ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee']));
  const line6 = line3 + l5e;
  const line7 = actualFica - l5e; // frações de centavo: deixa a linha 10 igual ao que foi retido e devido de verdade
  const line10 = line6 + line7;
  const line11 = 0, line12 = line10 - line11;
  // linha 13: depósitos ligados aos períodos deste trimestre + recolhimentos antigos (sem depósito) datados no trimestre
  const periodOf = Object.fromEntries(computeDeposits(liabilitiesByPayday()).map((d) => [d.key, d]));
  const linked = all("SELECT d.dkey, r.amount FROM tax_deposits d JOIN payroll_remittances r ON r.deposit_id=d.id WHERE d.kind='941'");
  const line13 = linked.filter((x) => periodOf[x.dkey]?.year === year && periodOf[x.dkey]?.quarter === quarter).reduce((s, x) => s + x.amount, 0)
    + get(`SELECT COALESCE(SUM(amount),0) AS v FROM payroll_remittances WHERE deposit_id IS NULL AND date>=? AND date<=? AND component IN (${FED_CODES.map(() => '?').join(',')})`, from, to, ...FED_CODES).v;
  const line14 = Math.max(0, line12 - line13), line15 = Math.max(0, line13 - line12);
  // Parte 2: passivo por mês e por dia (Schedule B)
  const days = liabilitiesByPayday(from, to);
  const months = [1, 2, 3].map((i) => days.filter((d) => Number(d.date.slice(5, 7)) === (quarter - 1) * 3 + i).reduce((s, d) => s + d.total941, 0));
  const sched = scheduleFor(year).schedule;
  const nextDay = days.reduce((acc, d) => acc || d.total941 >= 10_000_000, false);
  const part2 = line12 < SMALL_QUARTER && !nextDay ? 'small' : sched === 'monthly' && !nextDay ? 'monthly' : 'semiweekly';
  const scheduleB = part2 === 'semiweekly' ? [1, 2, 3].map((i) => {
    const m = (quarter - 1) * 3 + i;
    const daily = Array(lastDay(year, m)).fill(0);
    for (const d of days) if (Number(d.date.slice(5, 7)) === m) daily[Number(d.date.slice(8, 10)) - 1] += d.total941;
    return { month: m, daily, total: daily.reduce((s, v) => s + v, 0) };
  }) : null;
  const lines = {
    1: line1, 2: line2, 3: line3, 4: ssWages === 0 && medWages === 0,
    '5a1': ssWages, '5a2': l5a2, '5b1': 0, '5b2': 0, '5c1': medWages, '5c2': l5c2, '5d1': addMedWages, '5d2': l5d2, '5e': l5e, '5f': 0,
    6: line6, 7: line7, 8: 0, 9: 0, 10: line10, 11: line11, 12: line12, 13: line13, 14: line14, 15: line15,
    16: part2, '16m1': months[0], '16m2': months[1], '16m3': months[2], '16total': months[0] + months[1] + months[2],
  };
  return { year, quarter, from, to, lines, scheduleB, schedule: sched, employees: new Set(ls.map((l) => l.employee_id)).size,
    check: { line12EqualsLiability: lines['16total'] === line12, scheduleBTotal: scheduleB ? scheduleB.reduce((s, m) => s + m.total, 0) : null } };
}

/* --------------------------------------------- Form 940 --------------------------------------------- */
export function form940Lines(year) {
  const ls = finalLines(`${year}-01-01`, `${year}-12-31`);
  const base = US_2026.futaWageBase;
  const ytd = new Map(); const quarterWages = [0, 0, 0, 0];
  let line3 = 0, line5 = 0;
  for (const l of ls) {
    const before = ytd.get(l.employee_id) || 0;
    const futaPart = Math.max(0, Math.min(l.gross, base - before));
    ytd.set(l.employee_id, before + l.gross);
    line3 += l.gross; line5 += l.gross - futaPart; quarterWages[quarterOf(l.pay_date) - 1] += futaPart;
  }
  const line4 = 0, line6 = line4 + line5, line7 = line3 - line6;
  const line8 = Math.round(line7 * 0.006);
  const line9 = 0, line10 = 0, line11 = 0;
  const line12 = line8 + line9 + line10 + line11;
  const line13 = get("SELECT COALESCE(SUM(r.amount),0) AS v FROM payroll_remittances r LEFT JOIN tax_deposits d ON d.id=r.deposit_id WHERE r.component='futa' AND ((d.dkey LIKE ?) OR (r.deposit_id IS NULL AND r.date>=? AND r.date<=?))", `futa:${year}:%`, `${year}-01-01`, `${year + 1}-01-31`).v;
  const line14 = Math.max(0, line12 - line13), line15 = Math.max(0, line13 - line12);
  const q = quarterWages.map((w) => Math.round(w * 0.006));
  const diff = line12 - q.reduce((s, v) => s + v, 0); // arredondamento: a Parte 5 tem de somar a linha 12
  if (diff) { const i = q.map((v, k) => (v ? k : -1)).filter((k) => k >= 0).pop() ?? 3; q[i] += diff; }
  const state = employerSettings().employer_state;
  const lines = { '1a': state, '1b': false, 2: false, 3: line3, 4: line4, 5: line5, 6: line6, 7: line7, 8: line8, 9: line9, 10: line10, 11: line11, 12: line12, 13: line13, 14: line14, 15: line15,
    '16a': q[0], '16b': q[1], '16c': q[2], '16d': q[3], 17: q.reduce((s, v) => s + v, 0), part5Required: line12 > 50_000 };
  return { year, lines, employees: ytd.size };
}

/* ----------------------------------------------- W-2 ----------------------------------------------- */
export const BOX12_CODES = ['', 'D', 'E', 'G', 'AA', 'BB'];
export function w2Data(year) {
  const by = new Map();
  for (const l of finalLines(`${year}-01-01`, `${year}-12-31`)) {
    const e = by.get(l.employee_id) || { employee_id: l.employee_id, box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, pretax: 0, box16: 0, box17: 0 };
    const d = l.details;
    e.box1 += d.bases.fit; e.box2 += sumCodes(d, ['fit']); e.box3 += d.bases.ss; e.box4 += sumCodes(d, ['ss_ee'], true);
    e.box5 += d.bases.med; e.box6 += sumCodes(d, ['med_ee', 'addmed_ee'], true); e.pretax += l.pretax_deduction;
    const sit = sumCodes(d, ['sit'], true); e.box17 += sit; if (sit) e.box16 += d.bases.fit;
    by.set(l.employee_id, e);
  }
  const er = employerSettings();
  const rows = [...by.values()].map((w) => {
    const emp = get('SELECT * FROM employees WHERE id=?', w.employee_id);
    const code = BOX12_CODES.includes(emp.w2_box12_code) ? emp.w2_box12_code : 'D';
    const box12 = w.pretax > 0 && code ? [{ code, amount: w.pretax }] : [];
    const ssn = openTaxId(emp.tax_id).replace(/\D/g, '');
    return { ...w, name: emp.name, ssn_masked: maskTaxId(emp.tax_id), has_ssn: ssn.length === 9, address: emp.address, city: emp.city, state: emp.state, zip: emp.zip,
      box12, box13_retirement: box12.length > 0, box15_state: emp.state_pct > 0 ? er.employer_state : '', box15_id: emp.state_pct > 0 ? er.employer_state_id : '' };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const t = (k) => rows.reduce((s, r) => s + r[k], 0);
  const w3 = { count: rows.length, box1: t('box1'), box2: t('box2'), box3: t('box3'), box4: t('box4'), box5: t('box5'), box6: t('box6'), box12: Object.fromEntries(BOX12_CODES.filter(Boolean).map((c) => [c, rows.reduce((s, r) => s + r.box12.filter((x) => x.code === c).reduce((a, x) => a + x.amount, 0), 0)])), box16: t('box16'), box17: t('box17') };
  return { year, rows, w3, employer: er };
}
/** O que falta para gerar os W-2 / o EFW2 (bloqueia a geração com a lista). */
export function w2Problems(data, { efw2 = false } = {}) {
  const p = [];
  const er = data.employer;
  if (!/^\d{9}$/.test(er.employer_ein)) p.push('Employer EIN');
  if (!er.employer_name) p.push('Employer name');
  if (!er.employer_address || !er.employer_city || !er.employer_state || !er.employer_zip) p.push('Employer address');
  if (efw2) { if (!/^[A-Za-z0-9]{8}$/.test(er.w2_bso_user_id)) p.push('BSO User ID'); if (!er.w2_contact_name || !er.w2_contact_phone || !er.w2_contact_email) p.push('Contact name, phone and email'); }
  for (const r of data.rows) {
    if (!r.has_ssn) p.push(`SSN of ${r.name}`);
    if (!r.address || !r.city || !/^[A-Za-z]{2}$/.test(r.state || '') || !/^\d{5}/.test(r.zip || '')) p.push(`Address of ${r.name}`);
  }
  if (!data.rows.length) p.push('No finalized payroll in this year');
  return p;
}

/* ---------------------------------------------- EFW2 ---------------------------------------------- */
// SSA Publication 42-007 (EFW2), registros de 512 posições. Campos de texto: maiúsculas, alinhados à esquerda, completados com espaço.
// Valores: centavos, alinhados à direita com zeros. Cada registro termina com CR/LF.
const up = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 \-,./'&#]/g, ' ').replace(/\s+/g, ' ').trim();
export const A = (s, n) => up(s).slice(0, n).padEnd(n, ' ');
export const N = (v, n) => { const s = String(Math.max(0, Math.round(Number(v) || 0))); if (s.length > n) throw bad('Amount too large for the EFW2 file'); return s.padStart(n, '0'); };
const B = (n) => ' '.repeat(n);
export function splitName(full) {
  const parts = up(full).replace(/[^A-Z \-']/g, '').split(' ').filter(Boolean);
  const suffixes = ['JR', 'SR', 'II', 'III', 'IV'];
  let suffix = '';
  if (parts.length > 2 && suffixes.includes(parts[parts.length - 1])) suffix = parts.pop();
  const last = parts.length > 1 ? parts.pop() : (parts[0] || '');
  const first = parts.length ? parts.shift() : '';
  return { first, middle: parts.join(' '), last, suffix };
}
const zip5 = (z) => String(z || '').replace(/\D/g, '').slice(0, 5);
const zip4 = (z) => String(z || '').replace(/\D/g, '').slice(5, 9);
/** Campos fixos dos registros (início 1-based, tamanho) — usados pelos testes para conferir posições. */
export const EFW2_LAYOUT = {
  RA: [['id', 1, 2], ['ein', 3, 9], ['userId', 12, 8], ['vendor', 20, 4], ['b1', 24, 5], ['resub', 29, 1], ['wfid', 30, 6], ['softwareCode', 36, 2], ['companyName', 38, 57], ['coLocation', 95, 22], ['coDelivery', 117, 22], ['coCity', 139, 22], ['coState', 161, 2], ['coZip', 163, 5], ['coZip4', 168, 4], ['b2', 172, 5], ['coForeignState', 177, 23], ['coForeignZip', 200, 15], ['coCountry', 215, 2], ['subName', 217, 57], ['subLocation', 274, 22], ['subDelivery', 296, 22], ['subCity', 318, 22], ['subState', 340, 2], ['subZip', 342, 5], ['subZip4', 347, 4], ['b3', 351, 5], ['subForeignState', 356, 23], ['subForeignZip', 379, 15], ['subCountry', 394, 2], ['contactName', 396, 27], ['contactPhone', 423, 15], ['contactExt', 438, 5], ['b4', 443, 3], ['contactEmail', 446, 40], ['b5', 486, 3], ['contactFax', 489, 10], ['b6', 499, 1], ['preparer', 500, 1], ['b7', 501, 12]],
  RE: [['id', 1, 2], ['year', 3, 4], ['agentInd', 7, 1], ['ein', 8, 9], ['agentEin', 17, 9], ['terminating', 26, 1], ['establishment', 27, 4], ['otherEin', 31, 9], ['name', 40, 57], ['location', 97, 22], ['delivery', 119, 22], ['city', 141, 22], ['state', 163, 2], ['zip', 165, 5], ['zip4', 170, 4], ['kind', 174, 1], ['b1', 175, 4], ['foreignState', 179, 23], ['foreignZip', 202, 15], ['country', 217, 2], ['employmentCode', 219, 1], ['taxJurisdiction', 220, 1], ['sickPay', 221, 1], ['contactName', 222, 27], ['contactPhone', 249, 15], ['contactExt', 264, 5], ['contactFax', 269, 10], ['contactEmail', 279, 40], ['b2', 319, 194]],
  RW: [['id', 1, 2], ['ssn', 3, 9], ['first', 12, 15], ['middle', 27, 15], ['last', 42, 20], ['suffix', 62, 4], ['location', 66, 22], ['delivery', 88, 22], ['city', 110, 22], ['state', 132, 2], ['zip', 134, 5], ['zip4', 139, 4], ['b1', 143, 5], ['foreignState', 148, 23], ['foreignZip', 171, 15], ['country', 186, 2], ['box1', 188, 11], ['box2', 199, 11], ['box3', 210, 11], ['box4', 221, 11], ['box5', 232, 11], ['box6', 243, 11], ['box7', 254, 11], ['b2', 265, 11], ['box10', 276, 11], ['D', 287, 11], ['E', 298, 11], ['F', 309, 11], ['G', 320, 11], ['H', 331, 11], ['b3', 342, 11], ['nq457', 353, 11], ['W', 364, 11], ['nqNot457', 375, 11], ['Q', 386, 11], ['b4', 397, 11], ['C', 408, 11], ['V', 419, 11], ['Y', 430, 11], ['AA', 441, 11], ['BB', 452, 11], ['DD', 463, 11], ['FF', 474, 11], ['b5', 485, 1], ['statutory', 486, 1], ['b6', 487, 1], ['retirement', 488, 1], ['sickPay', 489, 1], ['b7', 490, 23]],
  RS: [['id', 1, 2], ['stateCode', 3, 2], ['taxingEntity', 5, 5], ['ssn', 10, 9], ['first', 19, 15], ['middle', 34, 15], ['last', 49, 20], ['suffix', 69, 4], ['location', 73, 22], ['delivery', 95, 22], ['city', 117, 22], ['state', 139, 2], ['zip', 141, 5], ['zip4', 146, 4], ['b1', 150, 5], ['foreignState', 155, 23], ['foreignZip', 178, 15], ['country', 193, 2], ['optional', 195, 2], ['period', 197, 6], ['quiTotal', 203, 11], ['quiTaxable', 214, 11], ['weeks', 225, 2], ['firstEmployed', 227, 8], ['separation', 235, 8], ['b2', 243, 5], ['stateAccount', 248, 20], ['b3', 268, 6], ['stateCode2', 274, 2], ['stateWages', 276, 11], ['stateTax', 287, 11], ['otherData', 298, 10], ['taxType', 308, 1], ['localWages', 309, 11], ['localTax', 320, 11], ['control', 331, 7], ['supp1', 338, 75], ['supp2', 413, 75], ['b4', 488, 25]],
  RT: [['id', 1, 2], ['count', 3, 7], ['box1', 10, 15], ['box2', 25, 15], ['box3', 40, 15], ['box4', 55, 15], ['box5', 70, 15], ['box6', 85, 15], ['box7', 100, 15], ['b1', 115, 15], ['box10', 130, 15], ['D', 145, 15], ['E', 160, 15], ['F', 175, 15], ['G', 190, 15], ['H', 205, 15], ['b2', 220, 15], ['nq457', 235, 15], ['W', 250, 15], ['nqNot457', 265, 15], ['Q', 280, 15], ['C', 295, 15], ['sickPayTax', 310, 15], ['V', 325, 15], ['Y', 340, 15], ['AA', 355, 15], ['BB', 370, 15], ['DD', 385, 15], ['FF', 400, 15], ['b3', 415, 98]],
  RF: [['id', 1, 2], ['b1', 3, 5], ['count', 8, 9], ['b2', 17, 496]],
};
const MONEY_FIELDS = new Set(['box1', 'box2', 'box3', 'box4', 'box5', 'box6', 'box7', 'box10', 'D', 'E', 'F', 'G', 'H', 'nq457', 'W', 'nqNot457', 'Q', 'C', 'V', 'Y', 'AA', 'BB', 'DD', 'FF', 'sickPayTax', 'quiTotal', 'quiTaxable', 'stateWages', 'stateTax', 'localWages', 'localTax']);
const NUMERIC_FIELDS = new Set(['ssn', 'ein', 'count', 'year']);
const RAW_FIELDS = new Set(['contactEmail']); // e-mail: mantém minúsculas e @ (só ASCII)
/** Monta um registro de 512 posições a partir do layout; campos não informados ficam em branco (ou zero, se forem valores). */
export function record(type, values) {
  let out = '';
  for (const [name, start, len] of EFW2_LAYOUT[type]) {
    if (out.length !== start - 1) throw new Error(`EFW2 layout ${type}.${name} starts at ${start}, built ${out.length + 1}`);
    const v = values[name];
    if (name === 'id') out += type;
    else if (MONEY_FIELDS.has(name)) out += N(v, len);
    else if (NUMERIC_FIELDS.has(name)) out += v === undefined || v === '' ? B(len) : N(v, len);
    else if (RAW_FIELDS.has(name)) out += String(v ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, len).padEnd(len, ' ');
    else out += A(v ?? '', len);
  }
  if (out.length !== 512) throw new Error(`EFW2 ${type} record has ${out.length} characters`);
  return out;
}
const STATE_FIPS = { AL: '01', AK: '02', AZ: '04', AR: '05', CA: '06', CO: '08', CT: '09', DE: '10', DC: '11', FL: '12', GA: '13', HI: '15', ID: '16', IL: '17', IN: '18', IA: '19', KS: '20', KY: '21', LA: '22', ME: '23', MD: '24', MA: '25', MI: '26', MN: '27', MS: '28', MO: '29', MT: '30', NE: '31', NV: '32', NH: '33', NJ: '34', NM: '35', NY: '36', NC: '37', ND: '38', OH: '39', OK: '40', OR: '41', PA: '42', RI: '44', SC: '45', SD: '46', TN: '47', TX: '48', UT: '49', VT: '50', VA: '51', WA: '53', WV: '54', WI: '55', WY: '56' };
/** Arquivo EFW2 do ano (texto). Exige EIN, endereço, BSO User ID e contato; SSN completo de cada funcionário (decifrado só aqui). */
export function buildEfw2(year) {
  const data = w2Data(year);
  const problems = w2Problems(data, { efw2: true });
  if (problems.length) throw new HttpError(400, 'Complete before generating: ' + problems.join('; '), { missing: problems });
  const er = data.employer;
  const recs = [];
  recs.push(record('RA', { ein: er.employer_ein, userId: er.w2_bso_user_id.toUpperCase(), resub: '0', softwareCode: '98', companyName: er.employer_name, coDelivery: er.employer_address, coCity: er.employer_city, coState: er.employer_state, coZip: zip5(er.employer_zip), coZip4: zip4(er.employer_zip),
    subName: er.employer_name, subDelivery: er.employer_address, subCity: er.employer_city, subState: er.employer_state, subZip: zip5(er.employer_zip), subZip4: zip4(er.employer_zip),
    contactName: er.w2_contact_name, contactPhone: String(er.w2_contact_phone).replace(/\D/g, '').slice(0, 15), contactEmail: er.w2_contact_email, preparer: 'L' }));
  recs.push(record('RE', { year: String(year), ein: er.employer_ein, terminating: '0', name: er.employer_name, delivery: er.employer_address, city: er.employer_city, state: er.employer_state, zip: zip5(er.employer_zip), zip4: zip4(er.employer_zip),
    kind: er.employer_kind || 'N', employmentCode: 'R', sickPay: '0', contactName: er.w2_contact_name, contactPhone: String(er.w2_contact_phone).replace(/\D/g, '').slice(0, 15), contactEmail: er.w2_contact_email }));
  const tot = { box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, D: 0, E: 0, G: 0, AA: 0, BB: 0 };
  for (const r of data.rows) {
    const emp = get('SELECT tax_id FROM employees WHERE id=?', r.employee_id);
    const nm = splitName(r.name);
    const codes = Object.fromEntries(r.box12.map((x) => [x.code, x.amount]));
    const rw = { ssn: openTaxId(emp.tax_id).replace(/\D/g, ''), ...nm, delivery: r.address, city: r.city, state: String(r.state).toUpperCase(), zip: zip5(r.zip), zip4: zip4(r.zip),
      box1: r.box1, box2: r.box2, box3: r.box3, box4: r.box4, box5: r.box5, box6: r.box6, ...codes, statutory: '0', retirement: r.box13_retirement ? '1' : '0', sickPay: '0' };
    recs.push(record('RW', rw));
    for (const k of Object.keys(tot)) tot[k] += Number(rw[k] || 0);
    if (er.w2_include_rs && r.box15_state && STATE_FIPS[r.box15_state]) {
      recs.push(record('RS', { stateCode: STATE_FIPS[r.box15_state], ssn: rw.ssn, first: nm.first, middle: nm.middle, last: nm.last, suffix: nm.suffix, delivery: r.address, city: r.city, state: rw.state, zip: rw.zip, zip4: rw.zip4,
        period: `12${year}`, stateAccount: er.employer_state_id, stateCode2: STATE_FIPS[r.box15_state], stateWages: r.box16, stateTax: r.box17, taxType: ' ' }));
    }
  }
  recs.push(record('RT', { count: data.rows.length, ...tot }));
  recs.push(record('RF', { count: data.rows.length }));
  return { text: recs.map((r) => r + '\r\n').join(''), totals: { employees: data.rows.length, ...tot }, records: recs.length };
}

/* ---------------------------------------------- 1099 ---------------------------------------------- */
/** Endereço livre do cadastro → partes (melhor esforço: "rua, cidade, UF 12345" ou em linhas). */
export function parseAddress(text) {
  const s = String(text || '').replace(/\r/g, '').trim();
  const m = s.match(/^(.*?)[,\n]\s*([^,\n]+?)[,\s]+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/s);
  if (m) return { street: m[1].replace(/\n/g, ' ').trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: m[4] };
  return { street: s.replace(/\n/g, ' '), city: '', state: '', zip: '' };
}
export function data1099(year) {
  const r = report1099(year);
  const rows = r.rows.filter((x) => x.reportable).map((x) => {
    const c = get('SELECT tax_id, address, email FROM contacts WHERE id=?', x.id);
    const tin = openTaxId(c.tax_id).replace(/\D/g, '');
    return { id: x.id, name: x.name, tin, tin_masked: x.tax_id, tin_type: /^\d{2}-/.test(openTaxId(c.tax_id)) ? 'EIN' : 'SSN', address: parseAddress(c.address), box1: x.paid, missingTaxId: !tin };
  });
  return { year, threshold: form1099Threshold(year), rows, payer: employerSettings() };
}
/**
 * CSV para o portal IRIS (Taxpayer Portal) — 1099-NEC. BETA: as colunas seguem o modelo de envio em lote do IRIS como o conhecemos;
 * confira com o modelo atual baixado do IRS antes de enviar (o IRS pode mudar nomes e ordem das colunas).
 */
export const IRIS_NEC_COLUMNS = ['Form Type', 'Tax Year', 'Payer TIN Type', 'Payer TIN', 'Payer Name Line 1', 'Payer Address Line 1', 'Payer City', 'Payer State', 'Payer ZIP Code', 'Payer Country',
  'Recipient TIN Type', 'Recipient TIN', 'Recipient Name Line 1', 'Recipient Address Line 1', 'Recipient City', 'Recipient State', 'Recipient ZIP Code', 'Recipient Country',
  'Account Number', 'Second TIN Notice', 'Box 1 Nonemployee Compensation', 'Box 2 Direct Sales Indicator', 'Box 4 Federal Income Tax Withheld', 'Box 5 State Tax Withheld', 'Box 6 State', 'Box 6 Payer State Number', 'Box 7 State Income'];
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const dollars = (c) => (c / 100).toFixed(2);
export function irisNecCsv(year) {
  const d = data1099(year);
  const p = d.payer;
  const problems = [];
  if (!/^\d{9}$/.test(p.employer_ein)) problems.push('Payer EIN');
  if (!p.employer_address || !p.employer_city || !p.employer_state || !p.employer_zip) problems.push('Payer address');
  for (const r of d.rows) { if (r.missingTaxId) problems.push(`TIN of ${r.name}`); if (!r.address.city || !r.address.state || !r.address.zip) problems.push(`Address of ${r.name} (use "street, city, ST 12345")`); }
  if (!d.rows.length) problems.push('No contractor reached the 1099 threshold this year');
  if (problems.length) throw new HttpError(400, 'Complete before generating: ' + problems.join('; '), { missing: problems });
  const lines = [IRIS_NEC_COLUMNS.map(csvCell).join(',')];
  for (const r of d.rows) {
    lines.push(['1099-NEC', year, 'EIN', p.employer_ein, p.employer_name, p.employer_address, p.employer_city, p.employer_state, p.employer_zip, 'US',
      r.tin_type, r.tin, r.name, r.address.street, r.address.city, r.address.state, r.address.zip, 'US', `C${r.id}`, '', dollars(r.box1), '', '0.00', '', '', '', ''].map(csvCell).join(','));
  }
  return { text: lines.join('\r\n') + '\r\n', totals: { recipients: d.rows.length, box1: d.rows.reduce((s, r) => s + r.box1, 0) } };
}
