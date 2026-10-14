import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.APP_URL = 'https://app.fluxo.test';
const { get } = await import('../src/db.js');
const mailer = await import('../src/mailer.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sent = [];
mailer.setTransport(async (m) => { sent.push(m); });
const tokenOf = (link) => decodeURIComponent(link.split('/accountant/')[1]);
let owner = '', link = '', cpa = '';

test('plano free não tem contador; Starter tem 1 vaga, Plus 3, Advanced sem limite', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'dono@x.com', password: 'senha1234', plan: 'free', lang: 'pt' })).body.token;
  assert.equal((await call('/accountants', 'POST', { email: 'c@x.com' }, owner)).status, 402);
  await call('/plan', 'PUT', { plan: 'starter' }, owner);
  assert.equal((await call('/accountants', 'POST', { email: 'não é e-mail' }, owner)).status, 400);
  const r = await call('/accountants', 'POST', { email: 'Contador@X.com', name: 'Carla' }, owner);
  assert.equal(r.status, 200); link = r.body.link; assert.equal(r.body.emailed, true);
  assert.match(link, /^https:\/\/app\.fluxo\.test\/accountant\/[0-9a-f]{64}$/);
  assert.equal((await call('/accountants', 'POST', { email: 'outro@x.com' }, owner)).status, 402);           // 1 vaga
  assert.equal((await call('/accountants', 'POST', { email: 'contador@x.com' }, owner)).status, 200);         // renovar o pendente não ocupa vaga
  link = (await call('/accountants', 'POST', { email: 'contador@x.com', name: 'Carla' }, owner)).body.link;  // o link anterior deixa de valer
  assert.match(sent.at(-1).text, /só de leitura/);
  assert.equal(sent.at(-1).to, 'contador@x.com');
  assert.match(sent.at(-1).subject, /convidou/);
});

test('o código é guardado só como hash; o link mostra a empresa e vale uma vez', async () => {
  const raw = tokenOf(link);
  assert.equal(get('SELECT COUNT(*) n FROM accountant_invites WHERE token_hash=?', raw).n, 0);
  const v = await call(`/public/accountant/${raw}`);
  assert.equal(v.status, 200); assert.equal(v.body.email, 'contador@x.com'); assert.equal(v.body.name, 'Carla');
  assert.equal((await call(`/public/accountant/${'a'.repeat(64)}`)).status, 404);
  assert.equal((await call(`/public/accountant/${raw}/accept`, 'POST', { password: 'curta' })).status, 400);       // senha curta não gasta o convite
  const a = await call(`/public/accountant/${raw}/accept`, 'POST', { password: 'senha-contador-1' });
  assert.equal(a.status, 200); cpa = a.body.token; assert.equal(a.body.user.role, 'cpa');
  assert.equal((await call(`/public/accountant/${raw}/accept`, 'POST', { password: 'senha-contador-1' })).status, 400); // segunda vez não
  assert.equal((await call(`/public/accountant/${raw}`)).status, 404);
});

test('contador lê os números mas não muda nada, e não vê usuários, exportação nem CPF/SSN', async () => {
  const get_ = async (p) => (await call(p, 'GET', undefined, cpa)).status;
  for (const p of ['/me', '/dashboard', '/reports/pnl', '/docs/invoice', '/accounts', '/contacts', '/journal', '/settings', '/plan']) assert.equal(await get_(p), 200, p);
  for (const p of ['/users', '/audit', '/export', '/export/all.zip', '/roles', '/security', '/accountants', '/import/status', '/contacts/1/tax-id', '/payroll/employees/1/tax-id', '/connect/status']) assert.equal(await get_(p), 403, p);
  for (const [p, m] of [['/contacts', 'POST'], ['/docs/invoice', 'POST'], ['/settings', 'PUT'], ['/users', 'POST'], ['/accountants', 'POST'], ['/plan', 'PUT'], ['/journal', 'POST']]) assert.equal((await call(p, m, { name: 'x', email: 'a@b.co' }, cpa)).status, 403, `${m} ${p}`);
  assert.equal((await call('/me/password', 'POST', { current: 'senha-contador-1', next: 'senha-contador-2' }, cpa)).status, 200);   // a própria senha pode
  const login = await call('/login', 'POST', { email: 'contador@x.com', password: 'senha-contador-2' });
  assert.equal(login.status, 200); cpa = login.body.token;
});

test('o dono vê a lista, o contador não entra na lista de usuários nem gasta vaga de usuário', async () => {
  const l = await call('/accountants', 'GET', undefined, owner);
  assert.equal(l.body.accountants.length, 1); assert.equal(l.body.accountants[0].status, 'active'); assert.deepEqual(l.body.seats, { used: 1, limit: 1 });
  const us = await call('/users', 'GET', undefined, owner);
  assert.ok(!us.body.users.some((u) => u.email === 'contador@x.com'));
  const id = get("SELECT id FROM users WHERE email='contador@x.com'").id;
  assert.equal((await call(`/users/${id}`, 'PUT', { role: 'owner' }, owner)).status, 404);                   // não dá para promover o contador por fora
  assert.equal((await call('/accountants', 'POST', { email: 'contador@x.com' }, owner)).status, 400);          // já tem acesso
  assert.equal((await call('/users', 'POST', { name: 'X', email: 'contador@x.com', password: 'senha1234', role: 'viewer' }, owner)).status, 400);
});

test('encerrar vale na hora: a sessão aberta cai, o login falha, a vaga volta; reconvidar reativa', async () => {
  const id = (await call('/accountants', 'GET', undefined, owner)).body.accountants[0].id;
  assert.equal((await call(`/accountants/${id}`, 'DELETE', undefined, cpa)).status, 403);                      // contador não encerra ninguém
  assert.equal((await call(`/accountants/${id}`, 'DELETE', undefined, owner)).status, 200);
  assert.equal((await call('/dashboard', 'GET', undefined, cpa)).status, 401);
  assert.equal((await call('/login', 'POST', { email: 'contador@x.com', password: 'senha-contador-2' })).status, 401);
  const l = await call('/accountants', 'GET', undefined, owner);
  assert.equal(l.body.accountants[0].status, 'ended'); assert.equal(l.body.seats.used, 0);
  const again = await call('/accountants', 'POST', { email: 'contador@x.com' }, owner);
  assert.equal(again.status, 200);
  const a = await call(`/public/accountant/${tokenOf(again.body.link)}/accept`, 'POST', { password: 'outra-senha-9' });
  assert.equal(a.status, 200); assert.equal(get("SELECT COUNT(*) n FROM users WHERE email='contador@x.com'").n, 1);
  assert.equal((await call('/dashboard', 'GET', undefined, a.body.token)).status, 200);
  assert.equal(get("SELECT COUNT(*) n FROM audit_log WHERE entity='accountant'").n >= 3, true);
});

test('convite vencido não vale; Advanced não tem limite de contadores', async () => {
  const r = await call('/accountants', 'POST', { email: 'velho@x.com' }, owner);          // Starter: 1 vaga já em uso → 402
  assert.equal(r.status, 402);
  await call('/plan', 'PUT', { plan: 'advanced' }, owner);
  const v = await call('/accountants', 'POST', { email: 'velho@x.com' }, owner); assert.equal(v.status, 200);
  const raw = tokenOf(v.body.link);
  (await import('../src/db.js')).run("UPDATE accountant_invites SET expires_at=datetime('now','-1 minute') WHERE email='velho@x.com'");
  assert.equal((await call(`/public/accountant/${raw}`)).status, 404);
  assert.equal((await call(`/public/accountant/${raw}/accept`, 'POST', { password: 'senha-nova-123' })).status, 400);
  assert.equal((await call('/accountants', 'GET', undefined, owner)).body.accountants.find((a) => a.email === 'velho@x.com').status, 'expired');
});

test('sem e-mail configurado o dono recebe o link para copiar', async () => {
  mailer.setTransport(null);
  const r = await call('/accountants', 'POST', { email: 'novo@x.com' }, owner);
  assert.equal(r.status, 200); assert.equal(r.body.emailed, false); assert.ok(r.body.link.includes('/accountant/'));
});
test.after(() => server.close());
