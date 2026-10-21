// Folha "Plano B": NACHA, calendário de depósitos, 941/940, W-2/EFW2 e 1099 IRIS — testes de unidade (sem servidor HTTP).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert, run, setSetting } = await import('../src/db.js');
const pay = await import('../src/payroll.js');
const acc = await import('../src/accounting.js');
const bank = await import('../src/payrollBank.js');
const dep = await import('../src/payrollDeposits.js');
const forms = await import('../src/payrollForms.js');
const pdf = await import('../src/payrollPdf.js');
const taxid = await import('../src/taxid.js');
const { PDFDocument } = await import('pdf-lib');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const addEmp = (o = {}) => {
  const e = { name: 'Ann Lee', hire_date: '2026-01-01', pay_basis: 'year', pay_rate: 7_800_000, frequency: 'biweekly', filing_status: 'single', state_pct: 0, pretax_deduction: 0, ...o };
  return insert('INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status,state_pct,pretax_deduction,tax_id,address,city,state,zip) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    e.name, e.hire_date, e.pay_basis, e.pay_rate, e.frequency, e.filing_status, e.state_pct, e.pretax_deduction, e.tax_id || '', e.address || '', e.city || '', e.state || '', e.zip || '');
};
const finalRun = (pay_date, lines, period = [pay_date, pay_date]) => { const d = pay.saveRun({ type: 'regular', period_start: period[0], period_end: period[1], pay_date, lines }); return pay.finalizeRun(d.id, A('1010')); };
acc.postEntry({ date: '2025-01-01', memo: 'seed', lines: [{ account_id: A('1010'), debit: 900_000_000 }, { account_id: A('3000'), credit: 900_000_000 }] });

/* ------------------------------------------------ ABA / conta ------------------------------------------------ */
test('roteamento ABA: dígito verificador 3-7-1', () => {
  for (const ok of ['011000015', '021000021', '122105155', '026009593']) assert.equal(bank.abaValid(ok), true, ok);
  for (const no of ['011000016', '12345678', '1234567890', 'abcdefghi', '000000000']) assert.equal(bank.abaValid(no), false, no);
  assert.equal(bank.abaCheckDigit('02100002'), 1);
});

test('conta bancária: cifrada em repouso, só o final aparece', () => {
  const b = bank.prepareBank({ routing: '021000021', account: '1234-5678 9012', type: 'savings' });
  assert.ok(b.bank_account_enc.startsWith('enc1:')); assert.ok(!b.bank_account_enc.includes('123456789012'));
  assert.equal(bank.openAccount(b.bank_account_enc), '123456789012'); assert.equal(b.bank_account_last4, '9012');
  const pub = bank.publicBank({ id: 1, name: 'X', ...b }, true);
  assert.equal(pub.bank_account_mask, '****9012'); assert.equal(pub.bank_account_enc, undefined); assert.equal(pub.has_bank, true);
  const emp = bank.publicBank({ id: 1, name: 'X', ...b }, false);
  assert.equal(emp.bank_routing, undefined); assert.equal(emp.bank_account_last4, undefined); assert.equal(emp.has_bank, true);
  // editar sem redigitar a conta (vem mascarada) mantém a cifrada
  const again = bank.prepareBank({ routing: '021000021', account: '****9012', type: 'checking' }, b);
  assert.equal(again.bank_account_enc, b.bank_account_enc);
  assert.throws(() => bank.prepareBank({ routing: '021000022', account: '123456' }), /routing/);
  assert.throws(() => bank.prepareBank({ routing: '021000021', account: '12' }), /account number/);
});

/* --------------------------------------------------- NACHA --------------------------------------------------- */
const cfg = { companyName: 'Acme Café LLC', companyId: '1123456789', odfiRouting: '021000021', bankName: 'Chase', origin: '1123456789', originName: 'Acme', effectiveDate: '2026-10-23', now: new Date('2026-10-21T14:05:00Z') };
const entries = [
  { routing: '011000015', account: '123456789', type: 'checking', amount: 150_025, id: 'EMP1', name: 'Ana Pérez' },
  { routing: '122105155', account: '9876543210', type: 'savings', amount: 99_999, id: 'EMP2', name: 'Bob Smith' },
];
test('NACHA desbalanceado: registros de 94, blocagem 10, totais e hash', () => {
  const f = bank.buildNacha(cfg, entries);
  const lines = f.text.trimEnd().split('\r\n');
  assert.ok(lines.every((l) => l.length === 94));
  assert.equal(lines.length % 10, 0); assert.equal(lines.length, 10);
  const [h, b, e1, e2, bc, fc] = lines;
  assert.equal(h.slice(0, 3), '101'); assert.equal(h.slice(3, 13), ' 021000021'); assert.equal(h.slice(13, 23), '1123456789');
  assert.equal(h.slice(23, 29), '261021'); assert.equal(h.slice(29, 33), '1405'); assert.equal(h.slice(34, 40), '094101');
  assert.equal(b.slice(0, 4), '5220'); assert.equal(b.slice(4, 20), 'ACME CAFE LLC   '); assert.equal(b.slice(40, 50), '1123456789'); assert.equal(b.slice(50, 53), 'PPD');
  assert.equal(b.slice(69, 75), '261023'); assert.equal(b.slice(79, 87), '02100002');
  assert.equal(e1.slice(0, 3), '622'); assert.equal(e1.slice(3, 11), '01100001'); assert.equal(e1[11], '5');
  assert.equal(e1.slice(12, 29), '123456789        '); assert.equal(e1.slice(29, 39), '0000150025'); assert.equal(e1.slice(54, 76), 'ANA PEREZ             ');
  assert.equal(e1.slice(79, 94), '021000020000001'); assert.equal(e2.slice(1, 3), '32');
  const hash = String(1100001 + 12210515).padStart(10, '0');
  assert.equal(bc.slice(0, 4), '8220'); assert.equal(bc.slice(4, 10), '000002'); assert.equal(bc.slice(10, 20), hash);
  assert.equal(bc.slice(20, 32), '000000000000'); assert.equal(bc.slice(32, 44), '000000250024');
  assert.equal(fc.slice(0, 7), '9000001'); assert.equal(fc.slice(7, 13), '000001'); assert.equal(fc.slice(13, 21), '00000002'); assert.equal(fc.slice(21, 31), hash);
  assert.equal(fc.slice(43, 55), '000000250024');
  assert.ok(lines.slice(6).every((l) => l === '9'.repeat(94)));
  assert.deepEqual(f.totals, { entries: 2, credit: 250_024, debit: 0, hash, blocks: 1, records: 10 });
});
test('NACHA balanceado: débito de compensação na conta da empresa e classe 200', () => {
  const f = bank.buildNacha({ ...cfg, balanced: true, offset: { account: '5550001', type: 'checking' } }, entries);
  const lines = f.text.trimEnd().split('\r\n');
  assert.equal(lines[1].slice(1, 4), '200');
  const off = lines[4]; assert.equal(off.slice(1, 3), '27'); assert.equal(off.slice(3, 12), '021000021'); assert.equal(off.slice(29, 39), '0000250024');
  const bc = lines[5]; assert.equal(bc.slice(4, 10), '000003'); assert.equal(bc.slice(20, 32), '000000250024'); assert.equal(bc.slice(32, 44), '000000250024');
  assert.equal(bc.slice(10, 20), String(1100001 + 12210515 + 2100002).padStart(10, '0'));
  assert.throws(() => bank.buildNacha({ ...cfg, balanced: true }, entries), /balanced file/);
});
test('NACHA: muitos funcionários → vários blocos', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ ...entries[0], id: `E${i}`, amount: 1000 + i }));
  const lines = bank.buildNacha(cfg, many).text.trimEnd().split('\r\n');
  assert.equal(lines.length, 20); assert.equal(lines[15].slice(7, 13), '000002');
});

/* ------------------------------------------ calendário de depósitos ------------------------------------------ */
test('feriados federais e rolagem', () => {
  const h = dep.federalHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) assert.ok(h.includes(d), d);
  assert.equal(dep.rollForward('2026-11-15'), '2026-11-16');  // domingo → segunda
  assert.equal(dep.monthlyDue('2026-10'), '2026-11-16');
  assert.equal(dep.monthlyDue('2026-12'), '2027-01-15');
  assert.equal(dep.monthlyDue('2027-01'), '2027-02-16');      // 15/fev/2027 é Presidents Day
  assert.ok(dep.federalHolidays(2029).includes('2029-01-22') === false && dep.federalHolidays(2029).includes('2029-01-20')); // posse (sábado: sem dia útil a mais)
});
test('semiweekly: qua/qui/sex → quarta seguinte; sáb–ter → sexta seguinte; feriado empurra', () => {
  assert.equal(dep.semiweeklyDue('2026-10-21'), '2026-10-28'); // quarta → quarta
  assert.equal(dep.semiweeklyDue('2026-10-23'), '2026-10-28'); // sexta → quarta
  assert.equal(dep.semiweeklyDue('2026-10-24'), '2026-10-30'); // sábado → sexta
  assert.equal(dep.semiweeklyDue('2026-10-27'), '2026-10-30'); // terça → sexta
  assert.equal(dep.semiweeklyDue('2026-10-09'), '2026-10-15'); // sexta antes do Columbus Day (seg 12) → quinta
  assert.equal(dep.semiweeklyDue('2026-11-24'), '2026-11-30'); // terça antes de Ação de Graças (qui 26) → segunda
  assert.equal(dep.semiweeklyPeriodEnd('2026-10-25'), '2026-10-27');
});
test('regra de lookback e dos US$ 2.500 / US$ 100.000 / FUTA (função pura)', () => {
  const day = (date, total941, futa = 0) => ({ date, comp: { fit: total941, ss_ee: 0, ss_er: 0, med_ee: 0, med_er: 0, addmed_ee: 0, futa }, total941, futa });
  const m = dep.computeDeposits([day('2026-01-09', 100_000), day('2026-01-23', 100_000), day('2026-02-06', 120_000)], () => 'monthly');
  assert.deepEqual(m.filter((d) => d.kind === '941').map((d) => [d.key, d.amount, d.due_date]), [['941:M:2026-01', 200_000, '2026-02-17'], ['941:M:2026-02', 120_000, '2026-03-16']]);
  assert.ok(m.filter((d) => d.kind === '941').every((d) => d.small_quarter === false)); // 3.200 no trimestre
  const small = dep.computeDeposits([day('2026-04-10', 50_000)], () => 'monthly');
  assert.equal(small[0].small_quarter, true);
  const sw = dep.computeDeposits([day('2026-03-27', 300_000), day('2026-03-31', 300_000), day('2026-09-30', 300_000), day('2026-10-02', 300_000)], () => 'semiweekly');
  assert.deepEqual(sw.map((d) => [d.key, d.amount, d.due_date]), [['941:S:2026-03-27:Q1', 300_000, '2026-04-01'], ['941:S:2026-03-31:Q1', 300_000, '2026-04-03'],
    ['941:S:2026-10-02:Q3', 300_000, '2026-10-07'], ['941:S:2026-10-02:Q4', 300_000, '2026-10-07']]); // qua 30/set–sex 2/out atravessa o trimestre: dois depósitos
  const big = dep.computeDeposits([day('2026-05-08', 6_000_000), day('2026-05-22', 5_000_000), day('2026-06-05', 1_000_000)], () => 'monthly');
  assert.equal(big[0].next_day, true); assert.equal(big[0].amount, 11_000_000); assert.equal(big[0].due_date, '2026-05-26'); // 25/mai é Memorial Day
  assert.equal(big[1].schedule, 'semiweekly'); // passa a semiweekly
  const futa = dep.computeDeposits([day('2026-01-15', 0, 30_000), day('2026-04-15', 0, 30_000), day('2026-07-15', 0, 10_000)], () => 'monthly').filter((d) => d.kind === 'futa');
  assert.deepEqual(futa.map((d) => [d.key, d.amount, d.due_date]), [['futa:2026:Q2', 60_000, '2026-07-31'], ['futa:2026:Q4', 10_000, '2027-02-01']]); // 31/jan/2027 domingo
});

/* ----------------------------------------- dados reais: folhas finalizadas ----------------------------------------- */
let ann, bob, run1;
test('agenda pelo período de referência (lookback): sem folha = mensal; > US$ 50.000 = semiweekly; manual vence', () => {
  ann = addEmp({ name: 'Ann Marie Lee', tax_id: taxid.seal('123-45-6789'), address: '10 Main St', city: 'Austin', state: 'TX', zip: '73301', pretax_deduction: 10_000 });
  bob = addEmp({ name: 'Bob Stone Jr', pay_rate: 26_000_000, tax_id: taxid.seal('987-65-4320'), address: '5 Oak Ave', city: 'Austin', state: 'TX', zip: '73301-1234', state_pct: 3 });
  assert.equal(dep.scheduleFor(2026).schedule, 'monthly'); assert.equal(dep.scheduleFor(2026).reason, 'first_year');
  // folha do período de referência de 2027 (jul/2025–jun/2026) gravada direto (o Fluxo não tem a tabela de 2025 para finalizar)
  const old = (date, fit) => { const r = insert("INSERT INTO pay_runs(period_start,period_end,pay_date,status,gross,net) VALUES(?,?,?,'final',?,?)", date, date, date, fit * 4, fit * 3);
    insert('INSERT INTO pay_run_lines(run_id,employee_id,gross,net,details) VALUES(?,?,?,?,?)', r, bob, fit * 4, fit * 3, JSON.stringify({ ee: [{ code: 'fit', amount: fit }], er: [], bases: { fit: fit * 4, ss: fit * 4, med: fit * 4 } })); return r; };
  const oldRuns = [old('2025-08-15', 2_000_000), old('2025-11-14', 2_000_000)];
  assert.deepEqual(dep.lookbackTotal(2027), { from: '2025-07-01', to: '2026-06-30', total: 4_000_000, hasPayroll: true });
  assert.equal(dep.scheduleFor(2027).schedule, 'monthly');           // US$ 40.000 ≤ US$ 50.000
  oldRuns.push(old('2025-12-12', 2_000_000));
  assert.equal(dep.scheduleFor(2027).schedule, 'semiweekly');        // US$ 60.000 > US$ 50.000
  for (const r of oldRuns) run('DELETE FROM pay_runs WHERE id=?', r);
  setSetting('payroll_lookback_amount', '6000000'); assert.equal(dep.scheduleFor(2027).schedule, 'semiweekly');
  setSetting('payroll_lookback_amount', ''); setSetting('payroll_deposit_schedule', 'semiweekly'); assert.equal(dep.scheduleFor(2026).schedule, 'semiweekly');
  setSetting('payroll_deposit_schedule', 'auto');
});

test('941 do trimestre: linhas batem com as folhas e com o passivo por mês', () => {
  run1 = finalRun('2026-01-16', [{ employee_id: ann }, { employee_id: bob }], ['2026-01-01', '2026-01-14']);
  finalRun('2026-02-13', [{ employee_id: ann }, { employee_id: bob }], ['2026-02-01', '2026-02-14']);
  finalRun('2026-03-13', [{ employee_id: ann }, { employee_id: bob }], ['2026-03-01', '2026-03-14']);
  const f = forms.form941Lines(2026, 1), L = f.lines;
  const ls = all("SELECT l.* FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id WHERE r.status='final' AND r.pay_date BETWEEN '2026-01-01' AND '2026-03-31'").map((l) => ({ ...l, d: JSON.parse(l.details) }));
  const code = (c) => ls.reduce((s, l) => s + [...l.d.ee, ...l.d.er].filter((x) => x.code === c).reduce((a, x) => a + x.amount, 0), 0);
  assert.equal(L[1], 2);
  assert.equal(L[2], ls.reduce((s, l) => s + l.gross - l.pretax_deduction, 0));
  assert.equal(L[3], code('fit'));
  assert.equal(L['5a1'], ls.reduce((s, l) => s + l.gross, 0));
  assert.equal(L[10], code('fit') + code('ss_ee') + code('ss_er') + code('med_ee') + code('med_er') + code('addmed_ee'));
  assert.equal(L[12], L[10]); assert.equal(L['16total'], L[12]); assert.equal(f.check.line12EqualsLiability, true);
  assert.equal(L[16], 'monthly'); assert.equal(L[14], L[12] - L[13]);
  assert.ok(Math.abs(L[7]) < 100, 'frações de centavo pequenas');
});

test('depósitos reais + marcar como pago lança no livro e abate do 941 (linha 13)', () => {
  const list = dep.listDeposits({ year: 2026 }).deposits.filter((d) => d.kind === '941');
  assert.deepEqual(list.map((d) => d.key), ['941:M:2026-01', '941:M:2026-02', '941:M:2026-03']);
  const jan = list[0];
  assert.equal(jan.due_date, '2026-02-17'); // 15/fev domingo, 16/fev Presidents Day
  const liabBefore = -get("SELECT COALESCE(SUM(debit-credit),0) v FROM journal_lines WHERE account_id=?", A('2300')).v;
  assert.throws(() => dep.markPaid({ key: jan.key, paid_date: '2099-01-01', account_id: A('1010') }), /future/);
  assert.throws(() => dep.markPaid({ key: jan.key, paid_date: '2026-02-10', account_id: A('1010'), receipt: 'data:text/html;base64,AAAA' }), /receipt/);
  const r = dep.markPaid({ key: jan.key, paid_date: '2026-02-10', account_id: A('1010'), eftps_confirmation: '270012345678901', receipt: 'data:application/pdf;base64,JVBERi0=' }, { id: 1, name: 'Owner' });
  assert.equal(r.total, jan.amount);
  const liabAfter = -get("SELECT COALESCE(SUM(debit-credit),0) v FROM journal_lines WHERE account_id=?", A('2300')).v;
  assert.equal(liabBefore - liabAfter, jan.amount);
  assert.throws(() => dep.markPaid({ key: jan.key, paid_date: '2026-02-10', account_id: A('1010') }), /already/);
  const after = dep.listDeposits({ year: 2026 }).deposits.find((d) => d.key === jan.key);
  assert.equal(after.status, 'paid'); assert.equal(after.payment.eftps_confirmation, '270012345678901'); assert.equal(after.payment.has_receipt, true);
  assert.equal(forms.form941Lines(2026, 1).lines[13], jan.amount);
  // desfazer devolve o passivo
  dep.unmarkPaid(after.payment.id);
  assert.equal(-get("SELECT COALESCE(SUM(debit-credit),0) v FROM journal_lines WHERE account_id=?", A('2300')).v, liabBefore);
  assert.equal(forms.form941Lines(2026, 1).lines[13], 0);
});

test('940 do ano: FUTA até US$ 7.000 por funcionário e Parte 5 soma a linha 12', () => {
  const f = forms.form940Lines(2026), L = f.lines;
  const gross = get("SELECT SUM(l.gross) v FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id WHERE r.status='final' AND r.pay_date LIKE '2026-%'").v;
  assert.equal(L[3], gross); assert.equal(L[7], 1_400_000); assert.equal(L[8], 8_400); assert.equal(L[12], 8_400);
  assert.equal(L['16a'] + L['16b'] + L['16c'] + L['16d'], L[12]); assert.equal(L[17], L[12]);
  const futaAccrued = all("SELECT l.details FROM pay_run_lines l JOIN pay_runs r ON r.id=l.run_id WHERE r.status='final' AND r.pay_date LIKE '2026-%'").reduce((s, x) => s + JSON.parse(x.details).er.filter((e) => e.code === 'futa').reduce((a, e) => a + e.amount, 0), 0);
  assert.ok(Math.abs(futaAccrued - L[12]) <= 2);
});

test('W-2: quadros, código D, estado; EFW2 com registros de 512 e posições certas', () => {
  const d = forms.w2Data(2026);
  const a = d.rows.find((r) => r.employee_id === ann), b = d.rows.find((r) => r.employee_id === bob);
  assert.equal(a.box1, a.box3 - 30_000); assert.deepEqual(a.box12, [{ code: 'D', amount: 30_000 }]); assert.equal(a.box13_retirement, true);
  assert.ok(b.box17 > 0); assert.equal(b.box16, b.box1);
  assert.ok(forms.w2Problems(d, { efw2: true }).includes('Employer EIN'));
  assert.throws(() => forms.buildEfw2(2026), /Complete before generating/);
  forms.saveEmployerSettings({ employer_ein: '12-3456789', employer_name: 'Acme Café LLC', employer_address: '1 Market St', employer_city: 'Austin', employer_state: 'tx', employer_zip: '73301', employer_state_id: 'TX-99', w2_bso_user_id: 'ABCD1234', w2_contact_name: 'Jane Owner', w2_contact_phone: '(512) 555-0100', w2_contact_email: 'jane@acme.test', w2_include_rs: true });
  const f = forms.buildEfw2(2026);
  const recs = f.text.split('\r\n').filter(Boolean);
  assert.ok(recs.every((r) => r.length === 512));
  assert.deepEqual(recs.map((r) => r.slice(0, 2)), ['RA', 'RE', 'RW', 'RW', 'RS', 'RT', 'RF']); // RS só de quem tem imposto estadual (Bob)
  const [ra, re, rw1, rw2, rs1, rt, rf] = recs;
  const at = (r, s, n) => r.slice(s - 1, s - 1 + n);
  assert.equal(at(ra, 3, 9), '123456789'); assert.equal(at(ra, 12, 8), 'ABCD1234'); assert.equal(at(ra, 36, 2), '98'); assert.equal(at(ra, 38, 57).trim(), 'ACME CAFE LLC');
  assert.equal(at(ra, 446, 40).trim(), 'jane@acme.test'); assert.equal(at(ra, 423, 15).trim(), '5125550100'); assert.equal(at(ra, 500, 1), 'L');
  assert.equal(at(re, 3, 4), '2026'); assert.equal(at(re, 8, 9), '123456789'); assert.equal(at(re, 163, 2), 'TX'); assert.equal(at(re, 174, 1), 'N'); assert.equal(at(re, 219, 1), 'R'); assert.equal(at(re, 279, 40).trim(), 'jane@acme.test');
  const [second, first] = [rw1, rw2].sort((x, y) => (at(x, 42, 20) < at(y, 42, 20) ? -1 : 1)); // second = Ann (LEE), first = Bob (STONE)
  assert.equal(at(second, 3, 9), '123456789'); assert.equal(at(second, 12, 15).trim(), 'ANN'); assert.equal(at(second, 27, 15).trim(), 'MARIE'); assert.equal(at(second, 42, 20).trim(), 'LEE');
  assert.equal(Number(at(second, 188, 11)), a.box1); assert.equal(Number(at(second, 199, 11)), a.box2); assert.equal(Number(at(second, 210, 11)), a.box3);
  assert.equal(Number(at(second, 287, 11)), 30_000); assert.equal(at(second, 488, 1), '1');
  assert.equal(at(first, 42, 20).trim(), 'STONE'); assert.equal(at(first, 62, 4).trim(), 'JR'); assert.equal(at(first, 139, 4), '1234');
  assert.equal(at(rs1, 3, 2), '48'); assert.equal(at(rs1, 248, 20).trim(), 'TX-99');
  assert.equal(Number(at(rt, 3, 7)), 2); assert.equal(Number(at(rt, 10, 15)), d.w3.box1); assert.equal(Number(at(rt, 25, 15)), d.w3.box2); assert.equal(Number(at(rt, 145, 15)), 30_000);
  assert.equal(Number(at(rf, 8, 9)), 2);
  // o layout de cada tipo cobre as 512 posições sem buraco nem sobreposição
  for (const [type, fields] of Object.entries(forms.EFW2_LAYOUT)) { let pos = 1; for (const [, s, n] of fields) { assert.equal(s, pos, `${type} @${s}`); pos += n; } assert.equal(pos, 513, type); }
});

test('1099-NEC: limite por ano (US$ 600 em 2025, US$ 2.000 em 2026) e CSV do IRIS com as colunas', () => {
  assert.equal(pay.form1099Threshold(2025), 60_000); assert.equal(pay.form1099Threshold(2026), 200_000);
  const c = insert("INSERT INTO contacts(kind,name,is_1099,tax_id,address) VALUES('vendor','Joe Design LLC',1,?,?)", taxid.seal('12-3456780'), '200 Pine Rd, Dallas, TX 75201');
  acc.saveExpense({ date: '2026-05-01', contact_id: c, account_id: A('6400'), paid_from_id: A('1010'), amount: 250_000, description: 'Design', method: 'check' });
  acc.saveExpense({ date: '2025-05-01', contact_id: c, account_id: A('6400'), paid_from_id: A('1010'), amount: 70_000, description: 'Design', method: 'check' });
  assert.equal(forms.data1099(2025).rows.length, 1); // 700 ≥ 600
  const csv = forms.irisNecCsv(2026).text.trim().split('\r\n');
  assert.equal(csv[0], forms.IRIS_NEC_COLUMNS.join(','));
  const row = csv[1].split(',');
  assert.equal(row.length, forms.IRIS_NEC_COLUMNS.length);
  const col = (n) => row[forms.IRIS_NEC_COLUMNS.indexOf(n)];
  assert.equal(col('Form Type'), '1099-NEC'); assert.equal(col('Recipient TIN'), '123456780'); assert.equal(col('Recipient TIN Type'), 'EIN');
  assert.equal(col('Box 1 Nonemployee Compensation'), '2500.00'); assert.equal(col('Recipient State'), 'TX'); assert.equal(col('Payer TIN'), '123456789');
});

test('PDFs: planilhas com título claro e preenchimento de formulário AcroForm (para o PDF oficial)', async () => {
  const er = forms.employerSettings();
  for (const bytes of [await pdf.form941Pdf(forms.form941Lines(2026, 1), er), await pdf.form940Pdf(forms.form940Lines(2026), er), await pdf.w2Pdf(forms.w2Data(2026)), await pdf.nec1099Pdf(forms.data1099(2026))]) {
    assert.equal(bytes.slice(0, 5).toString(), '%PDF-'); assert.ok((await PDFDocument.load(bytes)).getPageCount() >= 1);
  }
  const doc = await PDFDocument.create(); const page = doc.addPage(); const form = doc.getForm();
  form.createTextField('f1_2').addToPage(page, { x: 10, y: 10 }); form.createCheckBox('c1_1').addToPage(page, { x: 10, y: 60 });
  const filled = await pdf.fillAcroForm(await doc.save(), { f1_2: '1,234.56', c1_1: true, nope: 'x' });
  const back = (await PDFDocument.load(filled.bytes)).getForm();
  assert.equal(back.getTextField('f1_2').getText(), '1,234.56'); assert.equal(back.getCheckBox('c1_1').isChecked(), true); assert.deepEqual(filled.missing, ['nope']);
  assert.equal(pdf.officialAvailable('f941', 2026), false); // sem o PDF oficial: planilha
});

test('ano sem tabela: prévia avisa e finalizar é bloqueado com mensagem clara', () => {
  const d = pay.saveRun({ type: 'regular', period_start: '2027-01-01', period_end: '2027-01-14', pay_date: '2027-01-15', lines: [{ employee_id: ann }] });
  assert.equal(pay.previewRun({ type: 'regular', period_start: '2027-01-01', period_end: '2027-01-14', pay_date: '2027-01-15', lines: [{ employee_id: ann }] }).tableMissing, 2027);
  assert.throws(() => pay.finalizeRun(d.id, A('1010')), /tax tables for 2027/);
  assert.equal(get('SELECT status FROM pay_runs WHERE id=?', d.id).status, 'draft');
});

test('NACHA de uma folha finalizada: sem conta = cheque (fora do arquivo)', () => {
  run('UPDATE employees SET bank_routing=?, bank_account_enc=?, bank_account_last4=?, bank_account_type=? WHERE id=?', '011000015', bank.sealAccount('44443333'), '3333', 'checking', ann);
  bank.saveNachaSettings({ nacha_company_name: 'Acme', nacha_ein: '123456789', nacha_odfi_routing: '021000021', nacha_bank_name: 'Chase' });
  const f = bank.nachaForRun(run1.id, { now: new Date('2026-01-14T10:00:00Z') });
  const annNet = run1.lines.find((l) => l.employee_id === ann).net;
  assert.equal(f.totals.entries, 1); assert.equal(f.totals.credit, annNet);
  assert.deepEqual(f.checks.map((c) => c.employee_id), [bob]);
  assert.ok(f.text.includes('44443333')); assert.equal(f.effectiveDate, '2026-01-16');
  const pv = bank.nachaPreview(run1.id);
  assert.deepEqual(pv.rows.map((r) => r.method).sort(), ['check', 'deposit']); assert.ok(!JSON.stringify(pv).includes('44443333'));
  const draft = pay.saveRun({ type: 'regular', period_start: '2026-04-01', period_end: '2026-04-14', pay_date: '2026-04-17', lines: [{ employee_id: ann }] });
  assert.throws(() => bank.nachaForRun(draft.id), /finalized/);
});
