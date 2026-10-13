import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const bank = await import('../src/banking.js');
const pay = await import('../src/payroll.js');
const rep = await import('../src/reports.js');
const cpay = await import('../src/contractorPay.js');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const C = (n) => Math.round(n * 100);
const contractor = (name, tax = '') => insert("INSERT INTO contacts(kind,name,tax_id,is_1099) VALUES('vendor',?,?,1)", name, tax);
const spend = (cid, date, v, method, from = '1010') => acc.saveExpense({ date, contact_id: cid, account_id: A('6400'), paid_from_id: A(from), amount: C(v), description: 'Pagamento', method });
const row = (r, name) => r.rows.find((x) => x.name === name);
const cardCode = () => get("SELECT code FROM accounts WHERE subtype='credit_card' LIMIT 1").code;

test('classifyMethod entende as chaves e os textos antigos em en/pt/es', () => {
  for (const [v, k] of [['ACH', 'ach'], ['PIX', 'ach'], ['Card', 'card'], ['Cartão', 'card'], ['Tarjeta', 'card'], ['PayPal', 'paypal'], ['stripe', 'stripe'], ['Venmo', 'app'], ['Cash App', 'app'],
    ['Cash', 'cash'], ['Dinheiro', 'cash'], ['Check', 'check'], ['Cheque', 'check'], ['Wire transfer', 'wire'], ['Transferência', 'wire'], ['Money order', 'money_order'], ['Boleto', 'money_order'], ['Zelle', 'zelle'], ['', ''], ['coisa estranha', '']]) {
    assert.equal(cpay.classifyMethod(v), k, v);
  }
  assert.equal(cpay.formFor('Cartão'), '1099-K'); assert.equal(cpay.formFor('ach'), '1099-NEC'); assert.equal(cpay.formFor(''), '1099-NEC');
});

test('cenário do dono: lucro 8.900 e 1099 separa NEC de cartão/PayPal', () => {
  const cust = insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente')");
  for (const [d, v] of [['2026-02-10', 3000], ['2026-05-10', 4500], ['2026-08-10', 6000]]) {
    const inv = acc.saveDoc({ type: 'invoice', contact_id: cust, issue_date: d, due_date: d, post: true, lines: [{ description: 'serviço', qty: 1, unit_price: C(v) }] });
    acc.addPayment(inv.id, { date: d, amount: C(v), account_id: A('1010'), method: 'ach' });
  }
  const a = contractor('Contractor A', '123-45-6789'), b = contractor('Contractor B'), c = contractor('Contractor C LLC');
  spend(a, '2026-03-01', 1200, 'ach'); spend(a, '2026-04-01', 1300, 'ach');
  spend(b, '2026-05-01', 400, 'ach'); spend(b, '2026-06-01', 300, 'paypal');
  spend(c, '2026-07-01', 900, 'card');
  acc.saveExpense({ date: '2026-03-05', account_id: A('6300'), paid_from_id: A('1010'), amount: C(500), description: 'Software' });
  const p = rep.profitAndLoss('2026-01-01', '2026-12-31');
  assert.equal(p.totalIncome, C(13500)); assert.equal(p.totalOpex, C(4600)); assert.equal(p.netIncome, C(8900));
  const r = pay.report1099(2026);
  assert.equal(row(r, 'Contractor A').paid, C(2500)); assert.equal(row(r, 'Contractor A').reportable, true);
  assert.equal(row(r, 'Contractor B').paid, C(400)); assert.equal(row(r, 'Contractor B').platform, C(300)); assert.equal(row(r, 'Contractor B').missingTaxId, true);
  assert.equal(row(r, 'Contractor C LLC').paid, 0); assert.equal(row(r, 'Contractor C LLC').platform, C(900));
  assert.equal(row(r, 'Contractor C LLC').reportable, false);
  assert.equal(row(r, 'Contractor A').unknown, 0);
});

test('forma inválida é recusada; forma em branco conta como NEC e fica marcada para conferir', () => {
  const x = contractor('Sem Forma');
  assert.throws(() => spend(x, '2026-03-01', 100, 'bitcoin'), /Invalid payment method/);
  assert.throws(() => spend(x, '2026-03-01', -5, 'ach'), /positive/);
  assert.throws(() => spend(x, 'abc', 5, 'ach'), /Invalid date/);
  spend(x, '2026-03-01', 250, '');
  const r = row(pay.report1099(2026), 'Sem Forma');
  assert.equal(r.paid, C(250)); assert.equal(r.unknown, C(250));
});

test('despesa paga no cartão de crédito da empresa e conta paga com "Cartão" saem do NEC', () => {
  const x = contractor('Cartao Co');
  spend(x, '2026-04-01', 700, '', cardCode());          // sem forma, mas paga no cartão da empresa
  const bill = acc.saveDoc({ type: 'bill', contact_id: x, issue_date: '2026-04-02', due_date: '2026-04-30', post: true, lines: [{ description: 'serviço', qty: 1, unit_price: C(800) }] });
  acc.addPayment(bill.id, { date: '2026-04-05', amount: C(300), account_id: A('1010'), method: 'Cartão' }); // texto antigo traduzido
  acc.addPayment(bill.id, { date: '2026-04-06', amount: C(500), account_id: A('1010'), method: 'Zelle' });
  const r = row(pay.report1099(2026), 'Cartao Co');
  assert.equal(r.platform, C(1000)); assert.equal(r.paid, C(500));
});

test('transação do banco categorizada com o prestador entra no 1099 (e só uma vez)', () => {
  const x = contractor('Bank Contractor', '987-65-4321');
  bank.importTxns(A('1010'), [{ date: '2026-05-01', description: 'ZELLE TO BANK CONTRACTOR', amount: -250000 }]);
  const t = all('SELECT id FROM bank_txns ORDER BY id DESC LIMIT 1')[0];
  bank.categorize(t.id, { account_id: A('6400'), contact_id: x }, { id: 1 });
  let r = row(pay.report1099(2026), 'Bank Contractor');
  assert.equal(r.paid, 250000); assert.equal(r.unknown, 250000, 'o banco não diz a forma: aparece para conferir'); assert.equal(r.reportable, true);
  // despesa lançada à mão e depois o mesmo dinheiro chega pelo banco: categorizar de novo contaria em dobro
  spend(x, '2026-06-01', 1000, 'ach');
  bank.importTxns(A('1010'), [{ date: '2026-06-02', description: 'ACH TO BANK CONTRACTOR', amount: -100000 }]);
  const t2 = all('SELECT id FROM bank_txns ORDER BY id DESC LIMIT 1')[0];
  assert.throws(() => bank.categorize(t2.id, { account_id: A('6400'), contact_id: x }, { id: 1 }), (e) => e.status === 409 && e.extra?.code === 'possible_duplicate');
  assert.equal(row(pay.report1099(2026), 'Bank Contractor').paid, 250000 + 100000, 'a despesa conta uma vez só');
  // o caminho certo é parear com o lançamento existente: continua uma vez só
  const sug = get('SELECT suggested_line_id FROM bank_txns WHERE id=?', t2.id).suggested_line_id;
  bank.matchTxn(t2.id, sug);
  assert.equal(row(pay.report1099(2026), 'Bank Contractor').paid, 250000 + 100000);
  // pagamento de verdade separado de mesmo valor: confirmando (force), conta como outro
  bank.importTxns(A('1010'), [{ date: '2026-06-03', description: 'ACH TO BANK CONTRACTOR 2', amount: -100000 }]);
  const t3 = all('SELECT id FROM bank_txns ORDER BY id DESC LIMIT 1')[0];
  bank.categorize(t3.id, { account_id: A('6400'), contact_id: x, force: true }, { id: 1 });
  assert.equal(row(pay.report1099(2026), 'Bank Contractor').paid, 250000 + 200000);
});

test('limite do ano: 2025 usa US$ 600; ano sem pagamentos devolve zero', () => {
  const x = contractor('Ano Antigo');
  spend(x, '2025-12-30', 650, 'ach');
  const r25 = pay.report1099(2025);
  assert.equal(r25.threshold, 60_000); assert.equal(row(r25, 'Ano Antigo').reportable, true);
  assert.equal(row(pay.report1099(2026), 'Ano Antigo').paid, 0);
});
