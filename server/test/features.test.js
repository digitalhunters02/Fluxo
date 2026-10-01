import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const rep = await import('../src/reports.js');
const { app } = await import('../src/index.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const bal = (code) => get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=?', A(code)).v;
const t = acc.today();
const setPlan = (plan, payroll = true) => call('/plan', 'PUT', { plan, payroll });
const cust = () => insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente')");
const invoice = (contact_id, amount = 10000, extra = {}) => acc.saveDoc({ type: 'invoice', contact_id, issue_date: t, due_date: t, post: true, lines: [{ description: 's', qty: 1, unit_price: amount, ...extra }] });

test('configuração inicial define o plano e login funciona', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'starter', lang: 'en' }, '');
  assert.equal(s.status, 200); token = s.body.token;
  const me = await call('/me');
  assert.equal(me.body.planInfo.plan, 'starter');
  assert.equal(me.body.planInfo.features.bills, false);
  assert.equal(me.body.planInfo.features.payroll, true);
});

test('cada recurso é travado pelo plano mínimo (402) e liberado ao subir de plano', async () => {
  await setPlan('starter');
  const blocked = [['/docs/bill', 'bills'], ['/recurring', 'recurring'], ['/projects', 'time_tracking'], ['/audit', 'audit_log'], ['/reports/ap-aging', 'reports_full'], ['/reports/inventory', 'inventory'],
    ['/budgets', 'budgets'], ['/reports/budget', 'budgets'], ['/reports/pnl-class', 'classes'], ['/reports/1099', 'contractors_1099'], ['/roles', 'custom_roles'], ['/docs/po', 'purchase_orders']];
  for (const [path, feature] of blocked) {
    const r = await call(path);
    assert.equal(r.status, 402, `${path} deveria exigir plano`); assert.equal(r.body.feature, feature);
  }
  assert.equal((await call('/docs/invoice')).status, 200);                    // faturas valem em todos os planos
  assert.equal((await call('/reports/pnl')).status, 200);
  assert.equal((await call('/docs/credit')).status, 200);                      // nota de crédito também
  const item = await call('/items', 'POST', { name: 'Prod', kind: 'product', price: 100, track_inventory: true });
  assert.equal(item.status, 402); assert.equal(item.body.required, 'plus');
  await setPlan('essentials');
  assert.equal((await call('/docs/bill')).status, 200);
  assert.equal((await call('/recurring')).status, 200);
  assert.equal((await call('/budgets')).status, 402);                          // ainda não: exige Plus
  await setPlan('plus');
  assert.equal((await call('/budgets')).status, 200);
  assert.equal((await call('/roles')).status, 402);                            // exige Advanced
  assert.equal((await call('/docs/invoice/batch', 'POST', {})).status, 402);
  await setPlan('advanced');
  assert.equal((await call('/roles')).status, 200);
});

test('complemento de folha desligado bloqueia /payroll', async () => {
  await setPlan('advanced', false);
  const r = await call('/payroll/employees');
  assert.equal(r.status, 402); assert.equal(r.body.required, 'addon');
  await setPlan('advanced', true);
  assert.equal((await call('/payroll/employees')).status, 200);
});

test('apenas o proprietário muda o plano', async () => {
  const u = await call('/users', 'POST', { name: 'Vend', email: 'v@x.com', password: 'senha1234', role: 'sales' });
  assert.equal(u.status, 200);
  const sales = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' }, '')).body.token;
  assert.equal((await call('/plan', 'PUT', { plan: 'starter' }, sales)).status, 403);
  assert.equal((await call('/plan', 'PUT', { plan: 'bogus' })).status, 400);
});

test('nota de crédito: lança, aplica em fatura, reembolsa e desfaz', () => {
  const c = cust();
  const inv = invoice(c, 20000);
  const cm = acc.saveDoc({ type: 'credit', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 'Return', qty: 1, unit_price: 12000 }] });
  assert.equal(cm.status, 'open'); assert.equal(cm.type, 'credit');
  assert.equal(bal('1200'), 8000);                                              // 20.000 - 12.000
  assert.equal(rep.aging('receivable', t).totals.total, 20000 - 12000);          // saldo da nota entra no aging como negativo
  acc.applyCredit(cm.id, { invoice_id: inv.id, amount: 5000, date: t });
  assert.equal(acc.loadDoc(inv.id).balance, 15000);
  assert.equal(acc.loadDoc(cm.id).status, 'partial');
  assert.throws(() => acc.applyCredit(cm.id, { invoice_id: inv.id, amount: 99999, date: t }), /larger than the credit balance/);
  acc.acc ?? 0;
  const other = invoice(cust(), 1000);
  assert.throws(() => acc.applyCredit(cm.id, { invoice_id: other.id, amount: 100, date: t }), /different customers/);
  // reembolso do restante: sai dinheiro do banco
  const before = bal('1010');
  acc.refundCredit(cm.id, { amount: 7000, account_id: A('1010'), date: t });
  assert.equal(bal('1010'), before - 7000);
  assert.equal(acc.loadDoc(cm.id).status, 'used');
  assert.throws(() => acc.setDocStatus(cm.id, 'void'), /Remove the credit applications/);
  const apps = acc.loadDoc(cm.id).applications;
  for (const a of apps) acc.removeCreditApplication(a.id);
  assert.equal(acc.loadDoc(cm.id).paid, 0); assert.equal(acc.loadDoc(inv.id).balance, 20000);
  assert.equal(bal('1010'), before);
  acc.setDocStatus(cm.id, 'void');
  assert.equal(get('SELECT SUM(debit)-SUM(credit) AS v FROM journal_lines').v, 0);
});

test('ordem de compra não lança e vira conta a pagar', () => {
  const v = insert("INSERT INTO contacts(kind,name) VALUES('vendor','Forn')");
  const po = acc.saveDoc({ type: 'po', contact_id: v, issue_date: t, due_date: t, post: true, lines: [{ description: 'Parts', qty: 4, unit_price: 2500, tax_rate: 9 }] });
  assert.equal(po.total, 10000);                                               // sem imposto em compras
  const ap = bal('2000');
  const bill = acc.convertPO(po.id);
  assert.equal(bill.type, 'bill'); assert.equal(bill.status, 'draft'); assert.equal(bal('2000'), ap);
  assert.equal(get('SELECT status FROM docs WHERE id=?', po.id).status, 'billed');
  assert.throws(() => acc.convertPO(po.id), /already converted/);
  acc.setDocStatus(bill.id, 'post');
  assert.equal(bal('2000'), ap - 10000);
});

test('fechamento de período bloqueia lançar e desfazer', async () => {
  const c = cust();
  const inv = invoice(c, 3000);
  await call('/lock-date', 'PUT', { date: t });
  assert.throws(() => invoice(c, 100), /Books are closed through/);
  assert.throws(() => acc.setDocStatus(inv.id, 'void'), /Books are closed through/);
  const r = await call('/lock-date', 'PUT', { date: 'x' }); assert.equal(r.status, 400);
  await call('/lock-date', 'PUT', { date: '' });
  assert.doesNotThrow(() => invoice(c, 100));
});

test('classes: DRE por classe separa receitas e despesas', async () => {
  const k1 = (await call('/classes', 'POST', { name: 'Retail' })).body.id, k2 = (await call('/classes', 'POST', { name: 'Online' })).body.id;
  assert.ok(k1 && k2);
  assert.equal((await call('/classes', 'POST', { name: 'Retail' })).status, 400);
  const c = cust();
  invoice(c, 40000, { class_id: k1 }); invoice(c, 10000, { class_id: k2 });
  acc.saveExpense({ date: t, account_id: A('6200'), paid_from_id: A('1010'), amount: 3000, description: 'ads', class_id: k2 });
  const r = rep.plByClass(`${t.slice(0, 4)}-01-01`, t);
  const sales = r.income.reduce((s, a) => s + (a.byClass[k1] || 0), 0);
  assert.ok(sales >= 40000);
  assert.equal(r.net[k2], r.income.reduce((s, a) => s + (a.byClass[k2] || 0), 0) - 3000);
  assert.equal(get('SELECT SUM(debit)-SUM(credit) AS v FROM journal_lines').v, 0);
});

test('orçamento x realizado', async () => {
  const month = t.slice(0, 7);
  const sales = A('4100'), ads = A('6200');
  const months = Array(12).fill(0); months[Number(month.slice(5)) - 1] = 100000;
  assert.equal((await call('/budgets', 'PUT', { year: Number(t.slice(0, 4)), rows: [{ account_id: sales, months }, { account_id: ads, months: months.map((m) => m / 10) }] })).status, 200);
  const g = await call(`/budgets?year=${t.slice(0, 4)}`);
  assert.equal(g.body.rows.find((r) => r.id === sales).months[Number(month.slice(5)) - 1], 100000);
  const r = rep.budgetVsActual(`${month}-01`, t);
  const row = r.income.find((x) => x.id === sales);
  assert.equal(row.budget, 100000); assert.equal(row.variance, row.actual - 100000);
  const ex = r.expense.find((x) => x.id === ads);
  assert.equal(ex.variance, 10000 - ex.actual);
  assert.equal((await call('/budgets', 'PUT', { year: 1900, rows: [] })).status, 400);
});

test('papéis personalizados limitam o que o usuário vê e altera', async () => {
  const role = await call('/roles', 'POST', { name: 'Clerk', read: ['sales', 'reports'], write: ['sales'] });
  assert.equal(role.status, 200);
  const u = await call('/users', 'POST', { name: 'Clerk', email: 'c@x.com', password: 'senha1234', custom_role_id: role.body.id });
  assert.equal(u.status, 200);
  const tk = (await call('/login', 'POST', { email: 'c@x.com', password: 'senha1234' }, '')).body.token;
  assert.equal((await call('/docs/invoice', 'GET', null, tk)).status, 200);
  assert.equal((await call('/banking/accounts', 'GET', null, tk)).status, 403);   // sem acesso a banco
  assert.equal((await call('/expenses', 'POST', { amount: 1 }, tk)).status, 403);
  assert.equal((await call('/users', 'GET', null, tk)).status, 403);
  assert.equal((await call('/reports/pnl', 'GET', null, tk)).status, 200);
  const me = (await call('/me', 'GET', null, tk)).body;
  assert.ok(me.permissions.read.includes('sales') && !me.permissions.write.includes('purchases'));
  assert.equal((await call(`/roles/${role.body.id}`, 'DELETE')).status, 400);      // em uso
  // ao cair de plano, o papel personalizado deixa de poder ser atribuído
  await setPlan('plus');
  assert.equal((await call('/users', 'POST', { name: 'X', email: 'x@x.com', password: 'senha1234', custom_role_id: role.body.id })).status, 402);
  await setPlan('advanced');
});

test('faturas em lote criam uma fatura por cliente', async () => {
  const ids = [cust(), cust(), cust()];
  const r = await call('/docs/invoice/batch', 'POST', { contact_ids: ids, issue_date: t, terms_days: 10, post: true, lines: [{ description: 'Monthly fee', qty: 1, unit_price: 5000 }] });
  assert.equal(r.status, 200); assert.equal(r.body.ids.length, 3);
  for (const id of r.body.ids) { const d = acc.loadDoc(id); assert.equal(d.total, 5000); assert.equal(d.status, 'sent'); assert.equal(d.due_date, acc.addDays(t, 10)); }
  assert.equal((await call('/docs/invoice/batch', 'POST', { contact_ids: [], issue_date: t, lines: [] })).status, 400);
});

test('recibo de venda: fatura emitida e paga na hora', async () => {
  const c = cust();
  const r = await call('/docs/invoice', 'POST', { contact_id: c, issue_date: t, due_date: t, lines: [{ description: 'Walk-in', qty: 1, unit_price: 2500 }], pay_now: { account_id: A('1010'), method: 'Card' } });
  assert.equal(r.status, 200); assert.equal(r.body.status, 'paid'); assert.equal(r.body.balance, 0); assert.equal(r.body.payments.length, 1);
});

test('cliente aceita orçamento pelo link público', async () => {
  const c = cust();
  const est = acc.saveDoc({ type: 'estimate', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 'Job', qty: 1, unit_price: 9000 }] });
  const tok = acc.loadDoc(est.id).share_token;
  assert.equal((await call(`/public/doc/${tok}/accept`, 'POST', { name: 'A' }, '')).status, 400);
  const ok = await call(`/public/doc/${tok}/accept`, 'POST', { name: 'Jane Customer' }, '');
  assert.equal(ok.status, 200);
  const d = acc.loadDoc(est.id); assert.equal(d.status, 'accepted'); assert.equal(d.accepted_by, 'Jane Customer');
  assert.equal((await call(`/public/doc/${tok}/accept`, 'POST', { name: 'Jane Customer' }, '')).status, 400); // já aceito
  const bill = acc.saveDoc({ type: 'bill', contact_id: c, issue_date: t, due_date: t, lines: [{ description: 'x', qty: 1, unit_price: 100 }] });
  assert.equal((await call(`/public/doc/${acc.loadDoc(bill.id).share_token}`, 'GET', null, '')).status, 404); // conta a pagar nunca é pública
});

test('logo e cor da marca são validados', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.equal((await call('/settings', 'PUT', { company_logo: png, brand_color: '#112233' })).status, 200);
  assert.equal((await call('/settings', 'PUT', { company_logo: 'data:image/svg+xml;base64,PHN2Zz4=' })).status, 400);
  assert.equal((await call('/settings', 'PUT', { company_logo: 'http://evil/x.png' })).status, 400);
  assert.equal((await call('/settings', 'PUT', { brand_color: 'red' })).status, 400);
  const c = cust(); const d = acc.saveDoc({ type: 'invoice', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 'a', qty: 1, unit_price: 100 }] });
  const pub = await call(`/public/doc/${acc.loadDoc(d.id).share_token}`, 'GET', null, '');
  assert.equal(pub.body.company.company_logo, png);
});

test.after(() => server.close());
