import test from 'node:test';
import assert from 'node:assert/strict';

// Instalação própria (uma empresa só, sem FLUXO_MULTI): recuperar o acesso do dono pelo servidor.
process.env.FLUXO_DB = ':memory:'; delete process.env.FLUXO_MULTI;
const { app, bootstrapOwner } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, method = 'GET', body, tk = '') => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const env = { BOOTSTRAP_OWNER_EMAIL: 'Dono@Exemplo.com', BOOTSTRAP_OWNER_PASSWORD: 'senha-do-dono-14' };
const login = (password) => call('/login', 'POST', { email: 'dono@exemplo.com', password });
const logs = [];
const origLog = console.log; console.log = (...a) => { logs.push(a.join(' ')); };

test('instalação própria: cria o dono, e o RESET troca a senha dele sem criar outra conta', async () => {
  assert.equal(bootstrapOwner(env), true);
  const old = (await login(env.BOOTSTRAP_OWNER_PASSWORD)).body.token;
  assert.ok(old);

  // esqueceu a senha: sem RESET não muda nada (a instalação já tem usuários)
  assert.equal(bootstrapOwner({ ...env, BOOTSTRAP_OWNER_PASSWORD: 'senha-nova-do-dono' }), false);
  assert.equal((await login('senha-nova-do-dono')).status, 401);

  assert.equal(bootstrapOwner({ ...env, BOOTSTRAP_OWNER_PASSWORD: 'senha-nova-do-dono', BOOTSTRAP_OWNER_RESET: '1' }), true);
  assert.ok(logs.some((l) => l.includes('password reset for dono@exemplo.com')));
  assert.ok(!logs.join('\n').includes('senha-nova-do-dono'));
  assert.equal((await login('senha-nova-do-dono')).status, 200);
  assert.equal((await login(env.BOOTSTRAP_OWNER_PASSWORD)).status, 401);
  assert.equal((await call('/me', 'GET', undefined, old)).status, 401, 'sessão antiga caiu');

  // e-mail que não é dono: o RESET não troca a senha de ninguém
  assert.equal(bootstrapOwner({ BOOTSTRAP_OWNER_EMAIL: 'outro@exemplo.com', BOOTSTRAP_OWNER_PASSWORD: 'outra-senha-123', BOOTSTRAP_OWNER_RESET: '1' }), false);
  assert.equal((await login('senha-nova-do-dono')).status, 200);
});

test.after(() => { console.log = origLog; server.close(); });
