import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert, run } = await import('../src/db.js');
const pay = await import('../src/payroll.js');
const acc = await import('../src/accounting.js');
const rep = await import('../src/reports.js');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const emp = (o = {}) => ({ name: 'Ann', hire_date: '2026-01-01', pay_basis: 'year', pay_rate: 7_800_000, frequency: 'biweekly', filing_status: 'single', credits: 0, extra_withholding: 0, state_pct: 0, pretax_deduction: 0, other_deduction: 0, active: 1, ...o });
const addEmp = (o) => { const e = emp(o); return insert(`INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status,credits,extra_withholding,state_pct,pretax_deduction,other_deduction) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, e.name, e.hire_date, e.pay_basis, e.pay_rate, e.frequency, e.filing_status, e.credits, e.extra_withholding, e.state_pct, e.pretax_deduction, e.other_deduction); };
const code = (arr, c) => arr.find((x) => x.code === c)?.amount ?? 0;

test('bracketTax confere com a tabela 2026 (solteiro, base anual 61.900)', () => {
  // 10% de 12.400 + 12% de 38.000 + 22% de 11.500 = 8.330
  assert.equal(Math.round(pay.bracketTax(6_190_000, pay.US_2026.brackets.single)), 833_000);
});

test('salário anual de $78.000 quinzenal: FICA e imposto federal', () => {
  const c = pay.computeLine(emp(), {}, {});
  assert.equal(c.gross, 300_000);
  assert.equal(code(c.details.ee, 'ss_ee'), 18_600);       // 6,2%
  assert.equal(code(c.details.ee, 'med_ee'), 4_350);        // 1,45%
  assert.equal(code(c.details.ee, 'fit'), 32_038);          // 8.330 / 26 = 320,38
  assert.equal(code(c.details.er, 'ss_er'), 18_600);
  assert.equal(code(c.details.er, 'futa'), 1_800);          // 0,6%
  assert.equal(c.net, 300_000 - 18_600 - 4_350 - 32_038);
});

test('horista com hora extra, deduções pré e pós-imposto', () => {
  const e = emp({ pay_basis: 'hour', pay_rate: 2_500, pretax_deduction: 10_000, other_deduction: 5_000 });
  const c = pay.computeLine(e, { hours: 80, overtime_hours: 10 }, {});
  assert.equal(c.details.regular, 200_000);
  assert.equal(c.details.overtime, 37_500);                // 10h x $25 x 1,5
  assert.equal(c.gross, 237_500);
  assert.equal(c.pretax_deduction, 10_000);
  assert.equal(c.net, c.gross - c.ee_total - 5_000);
  // 401(k)-style pré-imposto reduz a base do imposto de renda, mas não a de Social Security
  assert.equal(c.details.bases.fit, 227_500); assert.equal(c.details.bases.ss, 237_500);
});

test('teto de Social Security, Medicare adicional e FUTA acumulados no ano', () => {
  const e = emp({ pay_rate: 30_000_000 });                   // $300.000/ano
  const near = pay.computeLine(e, { bonus: 0 }, { ytdGross: 18_400_000 });
  assert.equal(code(near.details.ee, 'ss_ee'), Math.round((18_450_000 - 18_400_000) * 0.062)); // só até o teto
  const high = pay.computeLine(e, {}, { ytdGross: 19_000_000 });
  assert.equal(code(high.details.ee, 'ss_ee'), 0);
  assert.ok(code(high.details.ee, 'addmed_ee') > 0);
  assert.equal(code(high.details.er, 'futa'), 0);            // base FUTA ($7.000) esgotada
});

test('bônus usa alíquota suplementar de 22% e não paga salário', () => {
  const c = pay.computeLine(emp(), { bonus: 100_000 }, { type: 'bonus' });
  assert.equal(c.gross, 100_000); assert.equal(code(c.details.ee, 'fit'), 22_000);
});

test('rodada: contabiliza, recolhe impostos e fecha o passivo', () => {
  const id1 = addEmp({ name: 'Bob', pay_rate: 6_500_000, frequency: 'monthly' });
  const id2 = addEmp({ name: 'Cy', pay_basis: 'hour', pay_rate: 3_000 });
  acc.postEntry({ date: '2026-01-01', memo: 'seed', lines: [{ account_id: A('1010'), debit: 50_000_000 }, { account_id: A('3000'), credit: 50_000_000 }] });
  const draft = pay.saveRun({ type: 'regular', period_start: '2026-02-01', period_end: '2026-02-28', pay_date: '2026-03-01', lines: [{ employee_id: id1 }, { employee_id: id2, hours: 160 }] });
  assert.equal(draft.status, 'draft');
  assert.throws(() => pay.finalizeRun(draft.id, A('6000')), /bank account/);
  const done = pay.finalizeRun(draft.id, A('1010'));
  assert.equal(done.status, 'final');
  const bal = (c) => get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=?', A(c)).v;
  assert.equal(bal('6100'), done.gross);
  assert.equal(bal('6110'), done.employer_taxes);
  assert.equal(-bal('2300'), done.employee_taxes + done.deductions + done.employer_taxes);
  assert.equal(get('SELECT SUM(debit)-SUM(credit) AS v FROM journal_lines').v, 0);
  // a soma dos passivos por componente é igual ao saldo da conta 2300
  const liab = pay.liabilities();
  assert.equal(liab.reduce((s, l) => s + l.outstanding, 0), -bal('2300'));
  // pagamento ao governo (depósito federal)
  const fed = liab.filter((l) => ['fit', 'ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee'].includes(l.component));
  assert.throws(() => pay.remit({ items: [{ component: 'fit', amount: 999_999_999 }], date: '2026-03-15', account_id: A('1010') }), /larger/);
  pay.remit({ items: fed.map((l) => ({ component: l.component, amount: l.outstanding })), date: '2026-03-15', account_id: A('1010') });
  assert.equal(pay.liabilities().filter((l) => ['fit', 'ss_ee', 'med_ee'].includes(l.component)).reduce((s, l) => s + l.outstanding, 0), 0);
  // não deixa anular com impostos já pagos
  assert.throws(() => pay.voidRun(draft.id), /already remitted/);
  assert.equal(get("SELECT status FROM pay_runs WHERE id=?", draft.id).status, 'final'); // rollback
  // relatórios
  const q = pay.form941(2026, 1);
  assert.equal(q.wages, done.gross); assert.equal(q.balance, q.totalTax - q.deposits); assert.equal(q.employees, 2);
  const w2 = pay.w2Summary(2026); assert.equal(w2.rows.length, 2);
  assert.equal(w2.rows.reduce((s, r) => s + r.box1, 0), done.gross);
  assert.equal(pay.payrollSummary('2026-01-01', '2026-12-31').totals.gross, done.gross);
  assert.equal(rep.balanceSheet('2026-12-31').balanced, true);
});

test('anular rodada sem recolhimentos desfaz o lançamento', () => {
  const id = addEmp({ name: 'Dee' });
  const d = pay.saveRun({ type: 'regular', period_start: '2026-04-01', period_end: '2026-04-14', pay_date: '2026-04-17', lines: [{ employee_id: id }] });
  pay.finalizeRun(d.id, A('1010'));
  pay.voidRun(d.id);
  assert.equal(get('SELECT status FROM pay_runs WHERE id=?', d.id).status, 'void');
  assert.equal(all("SELECT 1 FROM journal_entries WHERE source_type='payroll' AND source_id=?", d.id).length, 0);
});

test('relatório 1099: limite de $2.000 em 2026', () => {
  const c = insert("INSERT INTO contacts(kind,name,is_1099,tax_id) VALUES('vendor','Freelancer Joe',1,'')");
  acc.saveExpense({ date: '2026-05-01', contact_id: c, account_id: A('6400'), paid_from_id: A('1010'), amount: 150_000, description: 'Design' });
  assert.equal(pay.report1099(2026).rows[0].reportable, false);
  acc.saveExpense({ date: '2026-06-01', contact_id: c, account_id: A('6400'), paid_from_id: A('1010'), amount: 60_000, description: 'More' });
  const r = pay.report1099(2026).rows[0];
  assert.equal(r.paid, 210_000); assert.equal(r.reportable, true); assert.equal(r.missingTaxId, true);
});
