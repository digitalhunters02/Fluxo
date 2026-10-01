import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
process.env.FLUXO_REQUIRE_PAYMENT = '1'; // o plano gratuito deve funcionar mesmo exigindo pagamento nos demais
const { get, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const t = acc.today();
const cust = insert("INSERT INTO contacts(kind,name) VALUES('customer','Cliente')");
const doc = (type = 'invoice', amount = 1000) => call(`/docs/${type}`, 'POST', { contact_id: cust, issue_date: t, due_date: t, post: type === 'invoice', lines: [{ description: 's', qty: 1, unit_price: amount }] });

test('o plano gratuito abre conta sem pagamento, mesmo com pagamento obrigatório nos outros planos', async () => {
  assert.equal((await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'starter', lang: 'en' }, '')).status, 402);
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'free', lang: 'en' }, '');
  assert.equal(s.status, 200); token = s.body.token;
  const me = await call('/me');
  assert.equal(me.body.planInfo.plan, 'free');
  assert.deepEqual([me.body.planInfo.limits.invoices_per_month, me.body.planInfo.limits.users], [5, 1]);
  assert.equal(me.body.planInfo.prices.free, 0);
});

test('free: 5 faturas por mês; a sexta é bloqueada e fatura anulada não conta', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await doc()).status, 200, `fatura ${i + 1}`);
  const r = await doc();
  assert.equal(r.status, 402); assert.equal(r.body.feature, 'invoices_per_month'); assert.equal(r.body.required, 'starter');
  assert.equal((await call('/me')).body.planInfo.limits.invoices_used, 5);
  const first = get("SELECT id FROM docs WHERE type='invoice' ORDER BY id LIMIT 1").id;
  assert.equal((await call(`/doc/${first}/void`, 'POST')).status, 200);
  assert.equal((await doc()).status, 200);                       // a anulada liberou uma vaga
});

test('free: orçamento é livre, mas convertê-lo em fatura respeita o limite', async () => {
  const e = await doc('estimate'); assert.equal(e.status, 200);
  const r = await call(`/doc/${e.body.id}/convert`, 'POST');
  assert.equal(r.status, 402); assert.equal(r.body.feature, 'invoices_per_month');
});

test('free: nota de crédito, marca própria e segundo usuário exigem upgrade', async () => {
  let r = await doc('credit'); assert.equal(r.status, 402); assert.equal(r.body.feature, 'credit_memos');
  r = await call('/settings', 'PUT', { brand_color: '#112233' }); assert.equal(r.status, 402); assert.equal(r.body.feature, 'branding');
  r = await call('/users', 'POST', { name: 'Ana', email: 'a@x.com', password: 'senha1234', role: 'accountant' });
  assert.equal(r.status, 402); assert.equal(r.body.feature, 'users');
  assert.equal((await call('/settings', 'PUT', { company_name: 'Minha Empresa' })).status, 200);   // dados da empresa continuam livres
});

test('free: despesas, contatos e relatórios básicos funcionam; banco automático e fatura recorrente não', async () => {
  assert.equal((await call('/reports/pnl')).status, 200);
  assert.equal((await call('/contacts')).status, 200);
  assert.equal((await call('/recurring')).status, 402);
  assert.equal((await call('/plaid/overview')).status, 402);
});

test('subir para Starter libera tudo isso e remove os limites', async () => {
  assert.equal((await call('/plan', 'PUT', { plan: 'starter' })).status, 200);
  assert.equal((await doc()).status, 200);
  assert.equal((await doc('credit')).status, 200);
  assert.equal((await call('/settings', 'PUT', { brand_color: '#112233' })).status, 200);
  assert.equal((await call('/users', 'POST', { name: 'Ana', email: 'a@x.com', password: 'senha1234', role: 'accountant' })).status, 200);
  assert.equal((await call('/me')).body.planInfo.limits.invoices_per_month, null);
});

test.after(() => server.close());
