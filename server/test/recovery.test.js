import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.FLUXO_DB = ':memory:'; process.env.APP_URL = 'https://app.fluxo.test';
const { get, run } = await import('../src/db.js');
const mailer = await import('../src/mailer.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '', ip) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sent = [];
mailer.setTransport(async (m) => { sent.push(m); });
const wait = () => new Promise((r) => setTimeout(r, 60));          // o envio roda logo depois da resposta
const tokenOf = (m) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)[1]);
let owner = '';

test('setup', async () => { owner = (await call('/setup', 'POST', { name: 'Dono', email: 'dono@x.com', password: 'senha-antiga-1', plan: 'advanced', lang: 'pt' })).body.token; assert.ok(owner); });

test('a resposta é igual para e-mail existente e inexistente, e só existente recebe e-mail', async () => {
  const a = await call('/forgot', 'POST', { email: 'ninguem@x.com' }), b = await call('/forgot', 'POST', { email: 'DONO@x.com' });
  assert.deepEqual([a.status, a.body], [b.status, b.body]); await wait();
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'dono@x.com');
  assert.match(sent[0].text, /^Alguém pediu/);                                    // no idioma da empresa
  assert.match(sent[0].text, /^https:\/\/app\.fluxo\.test\/reset\?token=/m);       // usa APP_URL, nunca o cabeçalho Host
  assert.match(sent[0].subject, /Redefina/);
});

test('o token é guardado só como hash e funciona uma única vez; a senha antiga e as sessões caem', async () => {
  const token = tokenOf(sent[0]);
  assert.equal(get('SELECT COUNT(*) n FROM password_resets WHERE token_hash=?', token).n, 0);           // o banco não guarda o token puro
  assert.equal(get('SELECT COUNT(*) n FROM password_resets WHERE token_hash=?', crypto.createHash('sha256').update(token).digest('hex')).n, 1);
  assert.equal((await call('/reset', 'POST', { token, password: 'curta' })).status, 400);               // senha curta não gasta o token
  assert.equal((await call('/reset', 'POST', { token: 'a'.repeat(64), password: 'nova-senha-123' })).status, 400);
  const r = await call('/reset', 'POST', { token, password: 'nova-senha-123' });
  assert.equal(r.status, 200);
  assert.equal((await call('/login', 'POST', { email: 'dono@x.com', password: 'senha-antiga-1' })).status, 401);
  assert.equal((await call('/login', 'POST', { email: 'dono@x.com', password: 'nova-senha-123' })).status, 200);
  assert.equal((await call('/me', 'GET', undefined, owner)).status, 401);                                // a sessão antiga foi encerrada
  assert.equal((await call('/reset', 'POST', { token, password: 'outra-senha-456' })).status, 400);      // não dá para reutilizar
});

test('link vencido não funciona; usuário inativo não recebe; um novo pedido invalida o anterior', async () => {
  sent.length = 0;
  await call('/forgot', 'POST', { email: 'dono@x.com' }); await wait();
  const t1 = tokenOf(sent[0]);
  await call('/forgot', 'POST', { email: 'dono@x.com' }); await wait();
  const t2 = tokenOf(sent[1]);
  assert.equal((await call('/reset', 'POST', { token: t1, password: 'qualquer-senha-1' })).status, 400);  // o 1º foi substituído
  run("UPDATE password_resets SET expires_at=datetime('now','-1 minute')");
  assert.equal((await call('/reset', 'POST', { token: t2, password: 'qualquer-senha-1' })).status, 400);  // vencido
  run("UPDATE users SET active=0 WHERE email='dono@x.com'");
  sent.length = 0; await call('/forgot', 'POST', { email: 'dono@x.com' }); await wait();
  assert.equal(sent.length, 0);
  run("UPDATE users SET active=1 WHERE email='dono@x.com'");
});

test('sem provedor de e-mail ou APP_URL, nada é enviado e o servidor informa que a recuperação está desligada', async () => {
  assert.equal((await call('/status')).body.recovery, true);
  const keep = process.env.APP_URL; process.env.APP_URL = '';
  sent.length = 0; assert.equal((await call('/status')).body.recovery, false);
  await call('/forgot', 'POST', { email: 'dono@x.com' }); await wait(); assert.equal(sent.length, 0);   // sem APP_URL não manda link (evita Host forjado)
  process.env.APP_URL = keep;
});

test('limite de pedidos por e-mail', async () => {
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await call('/forgot', 'POST', { email: 'spam@x.com' })).status;
  assert.equal(last, 429);
});
test.after(() => server.close());
