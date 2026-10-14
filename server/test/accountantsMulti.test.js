import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1'; process.env.FLUXO_ALLOW_MANUAL_PLAN = '1'; process.env.APP_URL = 'https://app.fluxo.test';
const mailer = await import('../src/mailer.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
mailer.setTransport(async () => {});
const code = (link) => decodeURIComponent(link.split('/accountant/')[1]);
const signup = async (company, email) => (await call('/setup', 'POST', { company_name: company, name: 'Dono', email, password: 'senha1234', lang: 'en' })).body.token;

test('com várias empresas: o link traz a empresa, o contador entra só na empresa que convidou', async () => {
  const a = await signup('Empresa A', 'a@x.com'), b = await signup('Empresa B', 'b@x.com');
  await call('/plan', 'PUT', { plan: 'advanced' }, a); await call('/plan', 'PUT', { plan: 'advanced' }, b);
  const inv = await call('/accountants', 'POST', { email: 'cpa@x.com', name: 'Carla' }, a);
  assert.equal(inv.status, 200); assert.match(inv.body.link, /\/accountant\/empresa-a\.[0-9a-f]{64}$/);
  const v = await call(`/public/accountant/${code(inv.body.link)}`);
  assert.equal(v.status, 200); assert.equal(v.body.company, 'Empresa A');
  const acc = await call(`/public/accountant/${code(inv.body.link)}/accept`, 'POST', { password: 'senha-contador-1' });
  assert.equal(acc.status, 200); assert.match(acc.body.token, /^empresa-a\./);
  assert.equal((await call('/dashboard', 'GET', undefined, acc.body.token)).status, 200);
  assert.equal((await call('/docs/invoice', 'POST', {}, acc.body.token)).status, 403);
  const login = await call('/login', 'POST', { email: 'cpa@x.com', password: 'senha-contador-1' });
  assert.equal(login.status, 200); assert.match(login.body.token, /^empresa-a\./);
  // o mesmo link com outra empresa na frente não funciona
  const raw = code(inv.body.link).split('.')[1];
  assert.equal((await call(`/public/accountant/empresa-b.${raw}`)).status, 404);
  assert.equal((await call(`/public/accountant/semempresa.${raw}`)).status, 404);
  // encerrar na empresa A derruba a sessão
  const id = (await call('/accountants', 'GET', undefined, a)).body.accountants[0].id;
  await call(`/accountants/${id}`, 'DELETE', undefined, a);
  assert.equal((await call('/dashboard', 'GET', undefined, login.body.token)).status, 401);
});

test('o mesmo e-mail em outra empresa avisa com clareza (um e-mail, uma empresa)', async () => {
  const b = (await call('/login', 'POST', { email: 'b@x.com', password: 'senha1234' })).body.token;
  const inv = await call('/accountants', 'POST', { email: 'cpa@x.com' }, b);
  assert.equal(inv.status, 200);
  const acc = await call(`/public/accountant/${code(inv.body.link)}/accept`, 'POST', { password: 'senha-contador-1' });
  assert.equal(acc.status, 409); assert.match(acc.body.error || acc.body.message || JSON.stringify(acc.body), /another company/);
});
test.after(() => server.close());
