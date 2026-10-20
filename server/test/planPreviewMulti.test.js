// "Ver como plano" no modo hospedado (uma empresa por arquivo): vale só para o dono da plataforma e só na requisição dele;
// outra empresa (plano Free) com o mesmo cabeçalho é ignorada e continua enxergando o próprio plano.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1'; process.env.OWNER_EMAILS = 'dono@exemplo.com';
const { app, bootstrapOwner } = await import('../src/index.js');
const server = app.listen(0);
test.after(() => server.close());
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, { method = 'GET', body, token = '', preview = '' } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(preview ? { 'x-preview-plan': preview } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const log = console.log; console.log = () => {};
test('dono (bootstrap) vê como Free; empresa Free comum não ganha nada com o cabeçalho', async () => {
  assert.equal(bootstrapOwner({ BOOTSTRAP_OWNER_EMAIL: 'dono@exemplo.com', BOOTSTRAP_OWNER_PASSWORD: 'senha-do-dono-14', BOOTSTRAP_OWNER_NAME: 'Dono' }), true);
  const dono = (await call('/login', { method: 'POST', body: { email: 'dono@exemplo.com', password: 'senha-do-dono-14' } })).body.token;
  assert.ok(dono);
  const real = await call('/me', { token: dono });
  assert.equal(real.body.owner, true); assert.equal(real.body.planInfo.plan, 'enterprise'); assert.equal(real.body.previewPlan, null);
  const v = await call('/me', { token: dono, preview: 'free' });
  assert.equal(v.body.previewPlan, 'free'); assert.equal(v.body.planInfo.plan, 'free'); assert.equal(v.body.realPlan, 'enterprise');
  assert.equal(v.body.gates.bills.locked, true); assert.equal(v.body.gates.payroll.locked, true);
  assert.equal((await call('/docs/bill', { token: dono, preview: 'free' })).status, 402);
  assert.equal((await call('/docs/bill', { token: dono })).status, 200);
  assert.equal((await call('/plan', { method: 'PUT', body: { plan: 'free' }, token: dono, preview: 'starter' })).status, 409);
  assert.equal((await call('/me', { token: dono })).body.planInfo.plan, 'enterprise', 'a conta do dono não mudou');

  // uma empresa Free qualquer (cadastro público, plano Free) tentando o mesmo cabeçalho
  const s = await call('/setup', { method: 'POST', body: { company_name: 'Outra', name: 'Fulana', email: 'fulana@exemplo.com', password: 'senha-longa-1', lang: 'en' } });
  assert.equal(s.status, 200);
  const me = await call('/me', { token: s.body.token, preview: 'enterprise' });
  assert.equal(me.body.owner, false); assert.equal(me.body.previewPlan, null);
  assert.equal(me.body.planInfo.plan, 'free', 'o cabeçalho não sobe o plano de ninguém');
  assert.equal((await call('/docs/bill', { token: s.body.token, preview: 'enterprise' })).status, 402);
  console.log = log;
});
