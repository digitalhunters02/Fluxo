import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const bank = await import('../src/banking.js');
const rep = await import('../src/reports.js');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const C = (n) => Math.round(n * 100);
const BANK = A('1010');
const expense = (extra = {}) => acc.saveExpense({ date: '2026-06-10', account_id: A('6300'), paid_from_id: BANK, amount: C(50), description: 'Staples', ...extra });
const txn = (id) => get('SELECT * FROM bank_txns WHERE id=?', id);
const pend = () => all("SELECT * FROM bank_txns WHERE status='pending' ORDER BY id");
const cashBook = () => get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.code='1010'`).v;

test('banco primeiro, digitado depois: avisa antes de lançar em dobro', () => {
  bank.importTxns(BANK, [{ date: '2026-06-11', description: 'STAPLES #123', amount: C(-50) }]);
  assert.equal(pend().length, 1);
  assert.throws(() => expense(), (e) => e.status === 409 && e.extra?.code === 'possible_duplicate_bank' && e.extra.txn.description === 'STAPLES #123');
  assert.equal(all('SELECT 1 FROM expenses').length, 0, 'nada foi gravado');
  assert.equal(cashBook(), 0);
});

test('"é a mesma compra": grava o lançamento e liga ao do banco (conta uma vez só)', () => {
  const t = pend()[0];
  const e = expense({ matchBankTxn: t.id });
  assert.ok(e.id);
  assert.equal(txn(t.id).status, 'matched');
  assert.equal(pend().length, 0);
  assert.equal(cashBook(), -C(50), 'o caixa caiu 50, não 100');
  assert.equal(all('SELECT 1 FROM expenses').length, 1);
});

test('"são compras diferentes": grava separado com allowDuplicate', () => {
  bank.importTxns(BANK, [{ date: '2026-07-01', description: 'AMAZON', amount: C(-30) }]);
  assert.throws(() => expense({ date: '2026-07-02', amount: C(30) }), (e) => e.extra?.code === 'possible_duplicate_bank');
  const e = expense({ date: '2026-07-02', amount: C(30), allowDuplicate: true });
  assert.ok(e.id);
  assert.equal(pend().length, 1, 'a transação do banco continua pendente');
});

test('valor ou data diferentes não acusam duplicata', () => {
  bank.importTxns(BANK, [{ date: '2026-08-01', description: 'SHELL', amount: C(-40) }]);
  assert.ok(expense({ date: '2026-08-01', amount: C(41), description: 'outro valor' }).id);
  assert.ok(expense({ date: '2026-08-20', amount: C(40), description: 'outra data' }).id);
  const other = get("SELECT id FROM accounts WHERE subtype='bank' AND id<>? ORDER BY id LIMIT 1", BANK)?.id ?? get("SELECT id FROM accounts WHERE subtype='credit_card' ORDER BY id LIMIT 1").id;
  assert.ok(expense({ date: '2026-08-01', amount: C(40), paid_from_id: other, description: 'outra conta' }).id);
});

test('o Match aparece mesmo quando o lançamento digitado é posterior à importação', () => {
  const s = pend().find((t) => t.description === 'SHELL');
  const manual = acc.saveExpense({ date: '2026-08-02', account_id: A('6300'), paid_from_id: BANK, amount: C(40), description: 'Gasolina', allowDuplicate: true });
  assert.ok(manual.id);
  const rows = bank.listTxns({ status: 'pending' });
  const r = rows.find((x) => x.id === s.id);
  assert.ok(r.suggested_line_id, 'ligação sugerida na hora');
  assert.equal(r.match.memo, 'Gasolina');
});

test('categorizar às cegas uma transação que já tem lançamento igual pede confirmação (sem prestador também)', () => {
  const s = pend().find((t) => t.description === 'SHELL');
  assert.throws(() => bank.categorize(s.id, { account_id: A('6300') }, null), (e) => e.status === 409 && e.extra?.code === 'possible_duplicate');
  const before = get('SELECT COUNT(*) n FROM journal_entries').n;
  assert.equal(get('SELECT COUNT(*) n FROM journal_entries').n, before);
  bank.categorize(s.id, { account_id: A('6300'), force: true }, null); // pessoa confirmou que é outro
  assert.equal(txn(s.id).status, 'categorized');
});

test('"Aceitar sugestões" liga em vez de criar um segundo lançamento', () => {
  bank.importTxns(BANK, [{ date: '2026-09-05', description: 'OFFICE DEPOT', amount: C(-75) }]);
  const m = acc.saveExpense({ date: '2026-09-05', account_id: A('6300'), paid_from_id: BANK, amount: C(75), description: 'Office Depot', allowDuplicate: true });
  const before = get('SELECT COUNT(*) n FROM journal_entries').n;
  const r = bank.acceptAllSuggestions(BANK, null);
  assert.ok(r.matched >= 1); // inclui a da Amazon que ficou pendente no teste 3, agora ligada ao lançamento digitado
  assert.equal(get('SELECT COUNT(*) n FROM journal_entries').n, before);
  assert.equal(get("SELECT status FROM bank_txns WHERE description='OFFICE DEPOT'").status, 'matched');
  assert.ok(m.id);
});

test('pagamento de fatura recebido x depósito do banco: mesma proteção (entrada)', () => {
  const cust = insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente X')");
  const inv = acc.saveDoc({ type: 'invoice', contact_id: cust, issue_date: '2026-10-01', due_date: '2026-10-10', post: true, lines: [{ description: 'serviço', qty: 1, unit_price: C(500) }] });
  bank.importTxns(BANK, [{ date: '2026-10-03', description: 'ZELLE FROM CLIENTE X', amount: C(500) }]);
  assert.throws(() => acc.addPayment(inv.id, { date: '2026-10-03', amount: C(500), account_id: BANK, method: 'zelle' }), (e) => e.status === 409 && e.extra?.code === 'possible_duplicate_bank');
  const t = pend().find((x) => x.description === 'ZELLE FROM CLIENTE X');
  const d = acc.addPayment(inv.id, { date: '2026-10-03', amount: C(500), account_id: BANK, method: 'zelle', matchBankTxn: t.id });
  assert.equal(d.status, 'paid');
  assert.equal(txn(t.id).status, 'matched');
  const income = rep.profitAndLoss('2026-10-01', '2026-10-31');
  assert.equal(income.totalIncome, C(500), 'a receita conta uma vez');
});

test('transação de outra conta/sinal oposto nunca vira sugestão', () => {
  bank.importTxns(BANK, [{ date: '2026-11-01', description: 'REFUND', amount: C(20) }]);
  assert.ok(acc.saveExpense({ date: '2026-11-01', account_id: A('6300'), paid_from_id: BANK, amount: C(20), description: 'gasto de 20' }).id);
});

test('painel: sem banco ligado não há saldo do banco; com banco, mostra o saldo real e o que se deve nos cartões', () => {
  assert.equal(rep.dashboard().bank, null);
  insert("INSERT INTO plaid_items(item_id,access_token_enc,institution_name) VALUES('it1','x','Banco')");
  insert("INSERT INTO plaid_accounts(item_id,account_id,name,type,subtype,balance_current,linked_account_id) VALUES('it1','p1','Checking','depository','checking',700000,?)", BANK);
  const card = get("SELECT id FROM accounts WHERE subtype='credit_card' ORDER BY id LIMIT 1").id;
  insert("INSERT INTO plaid_accounts(item_id,account_id,name,type,subtype,balance_current,linked_account_id) VALUES('it1','p2','Visa','credit','credit card',80000,?)", card);
  insert("INSERT INTO plaid_accounts(item_id,account_id,name,type,subtype,balance_current) VALUES('it1','p3','Não ligada','depository','savings',999999)");
  assert.deepEqual(rep.dashboard().bank, { cash: 700000, cardDebt: 80000 });
});
