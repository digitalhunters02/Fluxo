// Folha de pagamento (EUA): cálculo, contabilização, passivos e relatórios 941 / W-2 / 1099.
// Os parâmetros fiscais ficam em US_2026 e devem ser revisados todo ano (IRS Pub. 15-T e Pub. 15).
import { all, get, run, insert, tx, getSetting } from './db.js';
import { HttpError, postEntry, removeEntries, sysAccount, isDate, cents, today, memoText } from './accounting.js';

const bad = (m) => new HttpError(400, m);
const R = Math.round;

export const PERIODS = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };

// Valores em centavos. Fonte: IRS Pub. 15-T (2026) e Pub. 15 (2026).
export const US_2026 = {
  year: 2026,
  ssRate: 0.062, ssWageBase: 18_450_000,
  medRate: 0.0145, addMedRate: 0.009, addMedThreshold: 20_000_000,
  futaRate: 0.006, futaWageBase: 700_000, // 6% - crédito de 5,4% por SUTA em dia
  supplementalRate: 0.22, overtimeFactor: 1.5, form1099Threshold: 200_000,
  stdDeduction: { single: 1_610_000, married: 3_220_000 },
  brackets: {
    single: [[1_240_000, 0.10], [5_040_000, 0.12], [10_570_000, 0.22], [20_177_500, 0.24], [25_622_500, 0.32], [64_060_000, 0.35], [Infinity, 0.37]],
    married: [[2_480_000, 0.10], [10_080_000, 0.12], [21_140_000, 0.22], [40_355_000, 0.24], [51_245_000, 0.32], [76_870_000, 0.35], [Infinity, 0.37]],
  },
};

export function bracketTax(taxable, brackets) {
  let tax = 0, lower = 0;
  for (const [upper, rate] of brackets) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

export const ytdFor = (employee_id, year, excludeRunId = 0) => {
  const r = get(`SELECT COALESCE(SUM(l.gross),0) AS gross FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id
    WHERE l.employee_id=? AND r.status='final' AND substr(r.pay_date,1,4)=? AND r.id<>?`, employee_id, String(year), excludeRunId);
  return r.gross;
};

/** Calcula uma linha do holerite. Tudo em centavos inteiros. */
export function computeLine(emp, inp = {}, { type = 'regular', ytdGross = 0, suta = { rate: 0, base: 0 }, year = US_2026.year } = {}) {
  const P = US_2026;
  const ppy = PERIODS[emp.frequency];
  const hours = Number(inp.hours ?? 0), otHours = Number(inp.overtime_hours ?? 0);
  const bonus = cents(inp.bonus ?? 0), other = cents(inp.other_earnings ?? 0);
  const pretax = cents(inp.pretax_deduction ?? emp.pretax_deduction ?? 0), otherDed = cents(inp.other_deduction ?? emp.other_deduction ?? 0);
  if (![hours, otHours].every((n) => Number.isFinite(n) && n >= 0 && n <= 744)) throw bad('Invalid hours');
  if (bonus < 0 || other < 0 || pretax < 0 || otherDed < 0) throw bad('Amounts cannot be negative');

  let regular = 0, overtime = 0;
  if (type !== 'bonus') {
    if (emp.pay_basis === 'hour') { regular = R(hours * emp.pay_rate); overtime = R(otHours * emp.pay_rate * P.overtimeFactor); } else regular = R(emp.pay_rate / ppy);
  }
  const gross = regular + overtime + bonus + other;
  const ee = [], er = [];
  const push = (list, code, amount) => { if (amount) list.push({ code, amount }); };

  // Social Security e Medicare
  const ssBase = Math.min(gross, Math.max(0, P.ssWageBase - ytdGross));
  const ssWages = ssBase;
  const ssAmt = R(ssBase * P.ssRate);
  push(ee, 'ss_ee', ssAmt); push(er, 'ss_er', ssAmt);
  const medAmt = R(gross * P.medRate);
  push(ee, 'med_ee', medAmt); push(er, 'med_er', medAmt);
  const overThreshold = Math.max(0, ytdGross + gross - Math.max(P.addMedThreshold, ytdGross));
  push(ee, 'addmed_ee', R(overThreshold * P.addMedRate));

  // Imposto de renda federal retido
  const fitWages = Math.max(0, gross - pretax);
  let fit;
  if (type === 'bonus') fit = R(fitWages * P.supplementalRate);
  else {
    const annual = fitWages * ppy;
    const taxable = Math.max(0, annual - P.stdDeduction[emp.filing_status]);
    const annualTax = Math.max(0, bracketTax(taxable, P.brackets[emp.filing_status]) - (emp.credits || 0));
    fit = R(annualTax / ppy);
  }
  fit += emp.extra_withholding || 0;
  push(ee, 'fit', Math.min(fit, fitWages));
  push(ee, 'sit', R((fitWages * (emp.state_pct || 0)) / 100));

  // Encargos do empregador: FUTA (federal) e SUTA (estadual)
  push(er, 'futa', R(Math.min(gross, Math.max(0, P.futaWageBase - ytdGross)) * P.futaRate));
  if (suta.rate > 0 && suta.base > 0) push(er, 'suta', R(Math.min(gross, Math.max(0, suta.base - ytdGross)) * (suta.rate / 100)));

  const eeTotal = ee.reduce((s, x) => s + x.amount, 0), erTotal = er.reduce((s, x) => s + x.amount, 0);
  const net = gross - eeTotal - otherDed;
  if (net < 0) throw bad(`Deductions exceed gross pay for ${emp.name}`);
  return {
    hours, overtime_hours: otHours, bonus, other_earnings: other, pretax_deduction: pretax, other_deduction: otherDed, gross, net,
    details: { regular, overtime, ee, er, deduction: otherDed, deduction_label: emp.other_deduction_label || '', bases: { ss: ssWages, med: gross, fit: fitWages }, year },
    ee_total: eeTotal, er_total: erTotal,
  };
}

const sutaCfg = () => ({ rate: Number(getSetting('payroll_suta_rate', 0)), base: cents(getSetting('payroll_suta_base', 0)) });
const yearOf = (d) => Number(d.slice(0, 4));

function validateRunInput(input) {
  if (!['regular', 'bonus'].includes(input.type || 'regular')) throw bad('Invalid pay run type');
  if (![input.period_start, input.period_end, input.pay_date].every(isDate)) throw bad('Invalid dates');
  if (input.period_end < input.period_start) throw bad('The period end is before its start');
  if (!Array.isArray(input.lines) || !input.lines.length) throw bad('Add at least one employee');
}

export function buildLines(input, runId = 0) {
  validateRunInput(input);
  const year = yearOf(input.pay_date), seen = new Set();
  return input.lines.map((l) => {
    const emp = get('SELECT * FROM employees WHERE id=?', l.employee_id);
    if (!emp || !emp.active) throw bad('Employee not found or inactive');
    if (seen.has(emp.id)) throw bad(`${emp.name} appears twice in this pay run`);
    seen.add(emp.id);
    const c = computeLine(emp, l, { type: input.type || 'regular', ytdGross: ytdFor(emp.id, year, runId), suta: sutaCfg(), year });
    return { employee_id: emp.id, employee_name: emp.name, ...c };
  });
}

const totals = (lines) => ({
  gross: lines.reduce((s, l) => s + l.gross, 0), net: lines.reduce((s, l) => s + l.net, 0), employee_taxes: lines.reduce((s, l) => s + l.ee_total, 0),
  employer_taxes: lines.reduce((s, l) => s + l.er_total, 0), deductions: lines.reduce((s, l) => s + l.other_deduction, 0),
});

export function previewRun(input, runId = 0) {
  const lines = buildLines(input, runId);
  return { lines, totals: totals(lines) };
}

export function loadRun(id) {
  const r = get('SELECT * FROM pay_runs WHERE id=?', id);
  if (!r) return null;
  r.lines = all(`SELECT l.*, e.name AS employee_name FROM pay_run_lines l JOIN employees e ON e.id=l.employee_id WHERE run_id=? ORDER BY e.name`, id)
    .map((l) => ({ ...l, details: JSON.parse(l.details) }));
  return r;
}

export function saveRun(input, user) {
  const lines = buildLines(input, input.id || 0);
  const t = totals(lines);
  if (t.gross <= 0) throw bad('The pay run has no earnings');
  return tx(() => {
    let id = input.id;
    if (id) {
      const cur = get('SELECT status FROM pay_runs WHERE id=?', id);
      if (!cur) throw new HttpError(404, 'Pay run not found');
      if (cur.status !== 'draft') throw bad('Only draft pay runs can be edited');
      run('UPDATE pay_runs SET type=?,period_start=?,period_end=?,pay_date=?,memo=?,gross=?,net=?,employee_taxes=?,employer_taxes=?,deductions=? WHERE id=?',
        input.type || 'regular', input.period_start, input.period_end, input.pay_date, input.memo || '', t.gross, t.net, t.employee_taxes, t.employer_taxes, t.deductions, id);
      run('DELETE FROM pay_run_lines WHERE run_id=?', id);
    } else {
      id = insert('INSERT INTO pay_runs(type,period_start,period_end,pay_date,memo,gross,net,employee_taxes,employer_taxes,deductions,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        input.type || 'regular', input.period_start, input.period_end, input.pay_date, input.memo || '', t.gross, t.net, t.employee_taxes, t.employer_taxes, t.deductions, user?.id ?? null);
    }
    for (const l of lines) {
      run('INSERT INTO pay_run_lines(run_id,employee_id,hours,overtime_hours,bonus,other_earnings,pretax_deduction,other_deduction,gross,net,details) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, l.employee_id, l.hours, l.overtime_hours, l.bonus, l.other_earnings, l.pretax_deduction, l.other_deduction, l.gross, l.net,
        JSON.stringify({ ...l.details, ee_total: l.ee_total, er_total: l.er_total }));
    }
    return loadRun(id);
  });
}

const wageAccount = () => get("SELECT id FROM accounts WHERE subtype='payroll_wages' AND active=1 ORDER BY code LIMIT 1")?.id ?? sysAccount('payroll_exp').id;

export function finalizeRun(id, paid_from_id, user) {
  return tx(() => {
    const r = loadRun(id);
    if (!r) throw new HttpError(404, 'Pay run not found');
    if (r.status !== 'draft') throw bad('This pay run is already finalized');
    const bank = get("SELECT * FROM accounts WHERE id=? AND type='asset' AND subtype='bank'", paid_from_id);
    if (!bank) throw bad('Choose the bank account the payroll is paid from');
    // recalcula: o acumulado do ano pode ter mudado desde o rascunho
    const saved = saveRun({ id, type: r.type, period_start: r.period_start, period_end: r.period_end, pay_date: r.pay_date, memo: r.memo,
      lines: r.lines.map((l) => ({ employee_id: l.employee_id, hours: l.hours, overtime_hours: l.overtime_hours, bonus: l.bonus, other_earnings: l.other_earnings, pretax_deduction: l.pretax_deduction, other_deduction: l.other_deduction })) }, user);
    const liab = sysAccount('payroll_liab').id, exp = sysAccount('payroll_exp').id;
    const withheld = saved.employee_taxes + saved.deductions + saved.employer_taxes;
    postEntry({ date: saved.pay_date, memo: `${memoText('payroll')} ${saved.period_start} – ${saved.period_end}`, source_type: 'payroll', source_id: id, user_id: user?.id,
      lines: [{ account_id: wageAccount(), debit: saved.gross }, { account_id: exp, debit: saved.employer_taxes }, { account_id: bank.id, credit: saved.net }, { account_id: liab, credit: withheld }] });
    run("UPDATE pay_runs SET status='final', paid_from_id=? WHERE id=?", bank.id, id);
    return loadRun(id);
  });
}

export function deleteRun(id) {
  const r = get('SELECT status FROM pay_runs WHERE id=?', id);
  if (!r) throw new HttpError(404, 'Pay run not found');
  if (r.status === 'final') throw bad('Void a finalized pay run instead of deleting it');
  run('DELETE FROM pay_runs WHERE id=?', id);
}

export function voidRun(id) {
  return tx(() => {
    const r = loadRun(id);
    if (!r) throw new HttpError(404, 'Pay run not found');
    if (r.status !== 'final') throw bad('Only finalized pay runs can be voided');
    removeEntries('payroll', id);
    run("UPDATE pay_runs SET status='void' WHERE id=?", id);
    for (const l of liabilities()) if (l.outstanding < 0) throw bad('Some of this payroll’s taxes were already remitted. Delete those remittances first.');
    return loadRun(id);
  });
}

/* -------------------------------- passivos -------------------------------- */
export const COMPONENTS = ['fit', 'ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee', 'sit', 'futa', 'suta', 'deduction'];

export function liabilities() {
  const acc = Object.fromEntries(COMPONENTS.map((c) => [c, 0]));
  for (const l of all("SELECT l.details FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id WHERE r.status='final'")) {
    const d = JSON.parse(l.details);
    for (const x of [...d.ee, ...d.er]) acc[x.code] = (acc[x.code] || 0) + x.amount;
    acc.deduction += d.deduction || 0;
  }
  const rem = Object.fromEntries(all('SELECT component, SUM(amount) AS v FROM payroll_remittances GROUP BY component').map((r) => [r.component, r.v]));
  return Object.keys(acc).map((component) => ({ component, accrued: acc[component], remitted: rem[component] || 0, outstanding: acc[component] - (rem[component] || 0) }))
    .filter((x) => x.accrued || x.remitted);
}

export function remit({ items, date, account_id, memo = '' }, user) {
  if (!isDate(date)) throw bad('Invalid date');
  if (!Array.isArray(items) || !items.length) throw bad('Choose what to pay');
  const bank = get("SELECT * FROM accounts WHERE id=? AND type='asset' AND subtype='bank'", account_id);
  if (!bank) throw bad('Choose a bank account');
  return tx(() => {
    const open = Object.fromEntries(liabilities().map((l) => [l.component, l.outstanding]));
    let total = 0;
    for (const it of items) {
      const amt = cents(it.amount);
      if (!COMPONENTS.includes(it.component)) throw bad('Unknown payroll component');
      if (amt <= 0) throw bad('Amounts must be positive');
      if (amt > (open[it.component] || 0)) throw bad('Amount is larger than what is owed');
      total += amt;
    }
    const rid = insert('INSERT INTO payroll_remittances(component,amount,date,account_id,memo) VALUES(?,?,?,?,?)', items[0].component, cents(items[0].amount), date, bank.id, memo);
    for (const it of items.slice(1)) insert('INSERT INTO payroll_remittances(component,amount,date,account_id,memo) VALUES(?,?,?,?,?)', it.component, cents(it.amount), date, bank.id, memo);
    postEntry({ date, memo: memo || memoText('payroll_tax'), source_type: 'payroll_remit', source_id: rid, user_id: user?.id,
      lines: [{ account_id: sysAccount('payroll_liab').id, debit: total }, { account_id: bank.id, credit: total }] });
    return { total };
  });
}

/* --------------------------------- relatórios ------------------------------ */
const finalLines = (from, to) => all(`SELECT l.*, e.name AS employee_name, r.pay_date FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id JOIN employees e ON e.id=l.employee_id
  WHERE r.status='final' AND r.pay_date>=? AND r.pay_date<=? ORDER BY e.name, r.pay_date`, from, to).map((l) => ({ ...l, details: JSON.parse(l.details) }));
const sumCodes = (d, codes) => [...d.ee, ...d.er].filter((x) => codes.includes(x.code)).reduce((s, x) => s + x.amount, 0);

export function payrollSummary(from, to) {
  const by = new Map();
  for (const l of finalLines(from, to)) {
    const e = by.get(l.employee_id) || { employee_id: l.employee_id, name: l.employee_name, gross: 0, employee_taxes: 0, deductions: 0, net: 0, employer_taxes: 0 };
    e.gross += l.gross; e.employee_taxes += l.details.ee_total; e.deductions += l.other_deduction; e.net += l.net; e.employer_taxes += l.details.er_total;
    by.set(l.employee_id, e);
  }
  const rows = [...by.values()];
  const t = (k) => rows.reduce((s, r) => s + r[k], 0);
  return { from, to, rows, totals: { gross: t('gross'), employee_taxes: t('employee_taxes'), deductions: t('deductions'), net: t('net'), employer_taxes: t('employer_taxes') } };
}

/** Resumo para o Form 941 do trimestre: valores a conferir com o formulário, não é o formulário. */
export function form941(year, quarter) {
  if (!(quarter >= 1 && quarter <= 4)) throw bad('Quarter must be 1–4');
  const m1 = (quarter - 1) * 3 + 1, from = `${year}-${String(m1).padStart(2, '0')}-01`;
  const endMonth = m1 + 2, to = `${year}-${String(endMonth).padStart(2, '0')}-${endMonth === 6 || endMonth === 9 ? 30 : 31}`;
  const ls = finalLines(from, to);
  const sum = (f) => ls.reduce((s, l) => s + f(l.details), 0);
  const wages = sum((d) => d.bases.med), fit = sum((d) => sumCodes(d, ['fit']));
  const ssWages = sum((d) => d.bases.ss), ssTax = sum((d) => sumCodes(d, ['ss_ee', 'ss_er']));
  const medTax = sum((d) => sumCodes(d, ['med_ee', 'med_er'])), addMed = sum((d) => sumCodes(d, ['addmed_ee']));
  const total = fit + ssTax + medTax + addMed;
  const deposits = get(`SELECT COALESCE(SUM(amount),0) AS v FROM payroll_remittances WHERE date>=? AND date<=? AND component IN ('fit','ss_ee','ss_er','med_ee','med_er','addmed_ee')`, from, to).v;
  return { year, quarter, from, to, employees: new Set(ls.map((l) => l.employee_id)).size, wages, fit, ssWages, ssTax, medWages: wages, medTax, addMed, totalTax: total, deposits, balance: total - deposits };
}

export function w2Summary(year) {
  const by = new Map();
  for (const l of finalLines(`${year}-01-01`, `${year}-12-31`)) {
    const e = by.get(l.employee_id) || { employee_id: l.employee_id, name: l.employee_name, box1: 0, box2: 0, box3: 0, box4: 0, box5: 0, box6: 0, box17: 0 };
    const d = l.details;
    e.box1 += d.bases.fit; e.box2 += sumCodes(d, ['fit']); e.box3 += d.bases.ss; e.box4 += sumCodes({ ee: d.ee, er: [] }, ['ss_ee']);
    e.box5 += d.bases.med; e.box6 += sumCodes({ ee: d.ee, er: [] }, ['med_ee', 'addmed_ee']); e.box17 += sumCodes({ ee: d.ee, er: [] }, ['sit']);
    by.set(l.employee_id, e);
  }
  return { year, rows: [...by.values()] };
}

/** Prestadores marcados como 1099: total pago no ano (contas pagas + despesas). */
export function report1099(year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const rows = all(`SELECT c.id, c.name, c.tax_id, c.email,
      COALESCE((SELECT SUM(p.amount) FROM payments p JOIN docs d ON d.id=p.doc_id WHERE d.type='bill' AND d.contact_id=c.id AND p.date>=? AND p.date<=?),0)
      + COALESCE((SELECT SUM(amount) FROM expenses WHERE contact_id=c.id AND date>=? AND date<=?),0) AS paid
    FROM contacts c WHERE c.is_1099=1 AND c.active=1 ORDER BY paid DESC`, from, to, from, to);
  const threshold = year >= 2026 ? US_2026.form1099Threshold : 60_000;
  return { year, threshold, rows: rows.map((r) => ({ ...r, reportable: r.paid >= threshold, missingTaxId: !r.tax_id })) };
}

export { today };
