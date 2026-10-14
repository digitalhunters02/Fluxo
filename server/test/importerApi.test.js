import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const CSV = `Product/Service List\nProduct/Service Name,SKU,Type,Sales Price / Rate\nRoof inspection,RI-1,Service,150.00\nShingle bundle,SH-1,Inventory,32.50`;

test('importar pela API: só o dono, prévia não grava, gravar grava e fica no registro', async () => {
  assert.equal((await call('/import/preview', 'POST', { kind: 'items', text: CSV })).status, 401);
  const owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en', demo: false })).body.token;
  await call('/users', 'POST', { name: 'Vera', email: 'v@x.com', password: 'senha1234', role: 'accountant' }, owner);
  const vera = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' })).body.token;
  assert.equal((await call('/import/preview', 'POST', { kind: 'items', text: CSV }, vera)).status, 403, 'contador não importa');
  const before = (await call('/items', 'GET', undefined, owner)).body.length;
  const pv = await call('/import/preview', 'POST', { kind: 'items', text: CSV }, owner);
  assert.equal(pv.status, 200); assert.equal(pv.body.ready, true); assert.equal(pv.body.rowCount, 2); assert.equal(pv.body.mapping.price, 'Sales Price / Rate');
  assert.equal((await call('/items', 'GET', undefined, owner)).body.length, before, 'prévia não grava');
  const run = await call('/import/run', 'POST', { kind: 'items', text: CSV, source: 'quickbooks' }, owner);
  assert.equal(run.status, 200); assert.equal(run.body.created, 2);
  assert.equal((await call('/items', 'GET', undefined, owner)).body.length, before + 2);
  const bad = await call('/import/run', 'POST', { kind: 'items', text: 'a,b\n1,2' }, owner);
  assert.equal(bad.status, 400);
  const st = await call('/import/status', 'GET', undefined, owner);
  assert.equal(st.body.history[0].kind, 'items'); assert.equal(st.body.history[0].source, 'quickbooks');
  const audit = (await call('/audit', 'GET', undefined, owner)).body;
  assert.ok(audit.some((a) => a.action === 'import' && a.entity === 'items'));
});
test.after(() => server.close());
