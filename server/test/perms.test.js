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
let owner = '';
test('acesso por aba: só a partir do Starter, e cada funcionário vê só o que foi liberado', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'free', lang: 'en' })).body.token;
  const body = { name: 'Vera', email: 'v@x.com', password: 'senha1234', perms: { read: ['reports'], write: ['sales'] } };
  assert.equal((await call('/users', 'POST', body, owner)).status, 402);                // free: 1 usuário
  await call('/plan', 'PUT', { plan: 'starter' }, owner);
  assert.equal((await call('/users', 'POST', { ...body, perms: { read: [], write: [] } }, owner)).status, 400);     // precisa de ao menos uma área
  const u = await call('/users', 'POST', body, owner);
  assert.equal(u.status, 200); assert.deepEqual(u.body.permissions.write, ['sales']); assert.deepEqual(u.body.permissions.read.sort(), ['reports', 'sales', 'settings']);
  const tk = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' })).body.token;
  assert.equal((await call('/docs/invoice', 'GET', undefined, tk)).status, 200);        // vendas liberado
  assert.equal((await call('/reports/pnl', 'GET', undefined, tk)).status, 200);          // relatórios só leitura
  assert.equal((await call('/banking/accounts', 'GET', undefined, tk)).status, 403);     // banco não liberado
  assert.equal((await call('/payroll/employees', 'GET', undefined, tk)).status, 403);
  assert.equal((await call('/users', 'GET', undefined, tk)).status, 403);                // nunca administra usuários
  assert.equal((await call('/users', 'POST', { name: 'Z', email: 'z@x.com', password: 'senha1234', role: 'owner' }, tk)).status, 403);
});

test('acesso por aba: dá para trocar, e escolher um papel padrão limpa o acesso', async () => {
  const id = (await call('/users', 'GET', undefined, owner)).body.users.find((x) => x.email === 'v@x.com').id;
  let u = await call(`/users/${id}`, 'PUT', { perms: { write: ['banking', 'settings', 'invented'] } }, owner);        // "settings" e módulos inventados são descartados
  assert.equal(u.status, 200); assert.deepEqual(u.body.custom_perms, { read: ['banking'], write: ['banking'] });
  u = await call(`/users/${id}`, 'PUT', { role: 'viewer' }, owner);
  assert.equal(u.body.custom_perms, null); assert.equal(u.body.role, 'viewer');
  u = await call(`/users/${id}`, 'PUT', { perms: { read: ['sales'] } }, owner); assert.equal(u.body.custom_perms.read[0], 'sales');
  u = await call(`/users/${id}`, 'PUT', { name: 'Vera S.' }, owner);                                                  // mudar só o nome mantém o acesso
  assert.equal(u.body.custom_perms.read[0], 'sales');
  u = await call(`/users/${id}`, 'PUT', { perms: null }, owner); assert.equal(u.body.custom_perms, null);
});
test.after(() => server.close());
