import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const bank = await import('../src/banking.js');
const rep = await import('../src/reports.js');
const { loadDemo } = await import('../src/seed.js');
const { app } = await import('../src/index.js');
const { hashPassword } = await import('../src/auth.js');
const { insert } = await import('../src/db.js');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const t = acc.today();
const bal = (code) => { const r = get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=?', A(code)); return r.v; };
const ledgerBalanced = () => { const r = get('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines'); assert.equal(r.d, r.c); };

test('fatura com imposto e estoque gera lançamentos balanceados', () => {
  const cust = insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente A')");
  const vend = insert("INSERT INTO contacts(kind,name) VALUES('vendor','Fornecedor A')");
  const item = insert("INSERT INTO items(name,kind,price,track_inventory) VALUES('Produto','product',20000,1)");
  acc.saveDoc({ type: 'bill', contact_id: vend, issue_date: t, due_date: t, lines: [{ item_id: item, description: 'p', qty: 10, unit_price: 10000 }] });
  assert.equal(get('SELECT qty_on_hand,cost FROM items WHERE id=?', item).qty_on_hand, 10);
  assert.equal(bal('1300'), 100000);
  assert.equal(bal('2000'), -100000);
  const inv = acc.saveDoc({ type: 'invoice', contact_id: cust, issue_date: t, due_date: t, post: true, lines: [{ item_id: item, description: 'p', qty: 2, unit_price: 20000, tax_rate: 10 }] });
  assert.equal(inv.total, 44000); assert.equal(inv.tax, 4000);
  assert.equal(bal('1200'), 44000); assert.equal(bal('2200'), -4000); assert.equal(bal('5000'), 20000); assert.equal(bal('1300'), 80000);
  assert.equal(get('SELECT qty_on_hand FROM items WHERE id=?', item).qty_on_hand, 8);
  ledgerBalanced();
  // pagamento parcial e total
  let d = acc.addPayment(inv.id, { date: t, amount: 14000, account_id: A('1010') });
  assert.equal(d.status, 'partial');
  assert.throws(() => acc.addPayment(inv.id, { date: t, amount: 99999999, account_id: A('1010') }), /larger than the open balance/);
  d = acc.addPayment(inv.id, { date: t, amount: 30000, account_id: A('1010') });
  assert.equal(d.status, 'paid'); assert.equal(bal('1200'), 0);
  // anular exige remover pagamentos; depois estoque volta
  assert.throws(() => acc.setDocStatus(inv.id, 'void'), /payments/);
  for (const p of d.payments) acc.deletePayment(p.id);
  acc.setDocStatus(inv.id, 'void');
  assert.equal(get('SELECT qty_on_hand FROM items WHERE id=?', item).qty_on_hand, 10);
  assert.equal(bal('1200'), 0); assert.equal(bal('5000'), 0);
  ledgerBalanced();
});

test('orçamento vira fatura', () => {
  const c = insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente B')");
  const e = acc.saveDoc({ type: 'estimate', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 'Serviço', qty: 3, unit_price: 5000 }] });
  assert.equal(bal('1200'), 0); // orçamento não lança
  const inv = acc.convertEstimate(e.id);
  assert.equal(inv.type, 'invoice'); assert.equal(get('SELECT status FROM docs WHERE id=?', e.id).status, 'invoiced');
  assert.throws(() => acc.convertEstimate(e.id), /already converted/);
});

test('lançamento desbalanceado é recusado', () => {
  assert.throws(() => acc.postEntry({ date: t, lines: [{ account_id: A('1010'), debit: 100 }, { account_id: A('4000'), credit: 90 }] }), /Out of balance/);
});

test('importação bancária, regras, pareamento e conciliação', () => {
  const exp = acc.saveExpense({ date: t, account_id: A('6000'), paid_from_id: A('1010'), amount: 25000, description: 'Aluguel' });
  const r = bank.importTxns(A('1010'), [
    { date: t, description: 'PIX ALUGUEL', amount: -25000 },
    { date: t, description: 'TARIFA MENSAL', amount: -990 },
    { date: t, description: 'TARIFA MENSAL', amount: -990 },
  ]);
  assert.equal(r.added, 3);
  assert.equal(bank.importTxns(A('1010'), [{ date: t, description: 'PIX ALUGUEL', amount: -25000 }]).duplicates, 1);
  const txns = all("SELECT * FROM bank_txns WHERE status='pending' ORDER BY id");
  assert.ok(txns[0].suggested_line_id, 'deveria sugerir lançamento existente');
  bank.matchTxn(txns[0].id, txns[0].suggested_line_id);
  bank.categorize(txns[1].id, { account_id: A('6800'), remember: true });
  // regra aprendida sugere categoria na próxima importação
  bank.importTxns(A('1010'), [{ date: t, description: 'TARIFA MENSAL', amount: -990 }, { date: acc.addDays(t, -1), description: 'TARIFA MENSAL', amount: -990 }]);
  const sug = get("SELECT * FROM bank_txns WHERE status='pending' AND suggestion_source='rule'");
  assert.equal(sug.suggested_account_id, A('6800'));
  ledgerBalanced();
  // conciliação: seleciona tudo e fecha com o saldo certo
  const st = bank.reconcileState(A('1010'), t);
  const total = st.beginning + st.lines.reduce((s, l) => s + l.amount, 0);
  assert.throws(() => bank.finishReconcile(A('1010'), { statement_date: t, statement_balance: total + 1, line_ids: st.lines.map((l) => l.id) }), /does not balance/);
  const done = bank.finishReconcile(A('1010'), { statement_date: t, statement_balance: total, line_ids: st.lines.map((l) => l.id) });
  assert.equal(done.reconciled, st.lines.length);
  assert.throws(() => acc.deleteExpense(exp.id), /reconciled/);
  bank.undoLastReconcile(A('1010'));
  acc.deleteExpense(exp.id);
  void exp;
});

test('dados de exemplo: balanço fecha e relatórios são coerentes', async () => {
  insert("INSERT INTO users(name,email,password_hash,role) VALUES('Dono','dono@x.com',?,'owner')", hashPassword('senha1234'));
  // limpa o que os testes anteriores criaram para o demo carregar
  const { db } = await import('../src/db.js');
  db.exec('DELETE FROM bank_txns; DELETE FROM payments; DELETE FROM journal_entries; DELETE FROM stock_moves; DELETE FROM doc_lines; DELETE FROM docs; DELETE FROM expenses; DELETE FROM items; DELETE FROM bank_rules;');
  assert.equal(loadDemo(), true);
  ledgerBalanced();
  const bs = rep.balanceSheet(t);
  assert.ok(bs.balanced, 'Ativo = Passivo + PL');
  assert.ok(bs.totalAssets > 0);
  const tb = rep.trialBalance(t); assert.equal(tb.totalDebit, tb.totalCredit);
  const from = acc.addMonths(t, -12);
  const pnl = rep.profitAndLoss(from, t);
  assert.equal(pnl.netIncome, bs.currentEarnings);
  const cf = rep.cashFlow(from, t);
  assert.equal(cf.closing - cf.opening, cf.netChange);
  assert.equal(cf.operating.total + cf.investing.total + cf.financing.total, cf.netChange);
  const ar = rep.aging('receivable', t);
  const openInvoices = get("SELECT COALESCE(SUM(total-paid),0) AS v FROM docs WHERE type='invoice' AND status IN ('sent','partial')").v;
  const openCredits = get("SELECT COALESCE(SUM(total-paid),0) AS v FROM docs WHERE type='credit' AND status IN ('open','partial')").v;
  assert.ok(openCredits > 0, 'o exemplo inclui uma nota de crédito em aberto');
  assert.equal(ar.totals.total, openInvoices - openCredits);        // contas a receber líquidas das notas de crédito
  assert.equal(ar.totals.total, -bal('2000') * 0 + bal('1200'));
  const dash = rep.dashboard(); assert.ok(dash.series.length === 6);
});

test('API: login, permissões e erros', async () => {
  const server = app.listen(0); const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, opts = {}, token) => { const r = await fetch(base + path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    assert.equal((await call('/dashboard')).status, 401);
    assert.equal((await call('/login', { method: 'POST', body: { email: 'dono@x.com', password: 'errada' } })).status, 401);
    const login = await call('/login', { method: 'POST', body: { email: 'dono@x.com', password: 'senha1234' } });
    assert.equal(login.status, 200);
    const token = login.body.token;
    assert.equal((await call('/dashboard', {}, token)).status, 200);
    assert.equal((await call('/reports/pnl?from=2020-02-31x&to=2020-01-01', {}, token)).status, 400);
    // cria usuário "viewer": não pode escrever
    const nu = await call('/users', { method: 'POST', body: { name: 'Leitor', email: 'l@x.com', password: 'leitor1234', role: 'viewer' } }, token);
    assert.equal(nu.status, 200);
    const vt = (await call('/login', { method: 'POST', body: { email: 'l@x.com', password: 'leitor1234' } })).body.token;
    assert.equal((await call('/contacts', { method: 'POST', body: { name: 'X' } }, vt)).status, 403);
    assert.equal((await call('/users', {}, vt)).status, 403);
    assert.equal((await call('/reports/balance-sheet', {}, vt)).status, 200);
    // link público
    const list = await call('/docs/invoice', {}, token);
    const doc = (await call(`/doc/${list.body[0].id}`, {}, token)).body;
    const pub = await call(`/public/doc/${doc.share_token}`);
    assert.equal(pub.status, 200); assert.equal(pub.body.doc.number, doc.number); assert.equal(pub.body.doc.share_token, undefined);
    // não pode remover o último proprietário
    const me = (await call('/me', {}, token)).body;
    assert.equal((await call(`/users/${me.id}`, { method: 'PUT', body: { role: 'viewer' } }, token)).status, 400);
  } finally { server.close(); }
});
