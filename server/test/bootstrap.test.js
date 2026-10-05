import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1';
const { app, bootstrapOwner } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, method = 'GET', body, tk = '') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const env = { BOOTSTRAP_OWNER_EMAIL: 'Dono@Exemplo.com', BOOTSTRAP_OWNER_PASSWORD: 'senha-do-dono-14', BOOTSTRAP_OWNER_NAME: 'Dono' };
const login = (password) => call('/login', 'POST', { email: 'dono@exemplo.com', password });
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); };

test('sem as variáveis ou com senha curta, não cria nada', () => {
  assert.equal(bootstrapOwner({}), false);
  assert.equal(bootstrapOwner({ BOOTSTRAP_OWNER_EMAIL: 'a@b.com' }), false);
  assert.equal(bootstrapOwner({ BOOTSTRAP_OWNER_EMAIL: 'a@b.com', BOOTSTRAP_OWNER_PASSWORD: 'curta' }), false);
});

test('primeira subida cria o dono, o login funciona e o plano é o topo', async () => {
  assert.equal(bootstrapOwner(env), true);
  assert.deepEqual(logs.filter((l) => l.includes('bootstrap')), ['bootstrap owner created for dono@exemplo.com']);
  assert.ok(!logs.join('\n').includes(env.BOOTSTRAP_OWNER_PASSWORD));
  const r = await login(env.BOOTSTRAP_OWNER_PASSWORD);
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'owner');
  const me = await call('/me', 'GET', undefined, r.body.token);
  assert.equal(me.body.planInfo.plan, 'advanced');
  assert.equal(me.body.planInfo.payroll, true);
  assert.equal(me.body.planInfo.limits.users, null);               // o Free tem 1 usuário
  assert.equal(me.body.planInfo.limits.invoices_per_month, null);   // o Free tem 5 faturas por mês
});

test('segunda subida não faz nada e não troca a senha', async () => {
  const before = logs.length;
  assert.equal(bootstrapOwner({ ...env, BOOTSTRAP_OWNER_PASSWORD: 'outra-senha-qualquer' }), false);
  assert.equal(logs.length, before);
  assert.equal((await login('outra-senha-qualquer')).status, 401);
  assert.equal((await login(env.BOOTSTRAP_OWNER_PASSWORD)).status, 200);
});

test('senha errada é recusada', async () => {
  assert.equal((await login('senha-errada-123')).status, 401);
});

test('o cadastro normal continua começando no Free', async () => {
  const r = await call('/setup', 'POST', { company_name: 'Empresa Normal', name: 'X', email: 'x@y.com', password: 'senha1234' });
  assert.equal(r.status, 200);
  assert.equal((await call('/me', 'GET', undefined, r.body.token)).body.planInfo.plan, 'free');
});

test.after(() => { console.log = origLog; server.close(); });
