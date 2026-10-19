import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1'; process.env.APP_URL = 'https://app.fluxo.test';
const mailer = await import('../src/mailer.js');
const { get, run } = await import('../src/db.js');
const tenants = await import('../src/tenants.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sent = [];
const linkOf = (m) => decodeURIComponent(/token=([^\s]+)/.exec(m.text)[1]);
const invoice = (tk, n = 1000) => call('/docs/invoice', 'POST', { contact_id: 1, issue_date: '2026-01-10', due_date: '2026-01-20', post: true, lines: [{ description: 's', qty: 1, unit_price: n }] }, tk);
let A = '';

test('sem provedor de e-mail: o cadastro funciona, nada é limitado e o servidor avisa que a confirmação está desligada', async () => {
  assert.equal((await call('/status')).body.confirmEmail, false);
  const r = await call('/setup', 'POST', { company_name: 'Sem Email', name: 'Ana', email: 'ana@x.com', password: 'senha1234', lang: 'pt' });
  assert.equal(r.status, 200); assert.equal(r.body.emailConfirmation, 'unavailable');
  const me = await call('/me', 'GET', undefined, r.body.token);
  assert.deepEqual([me.body.emailConfirm.confirmed, me.body.emailConfirm.available, me.body.emailConfirm.limited], [false, false, false]);
  await call('/contacts', 'POST', { kind: 'customer', name: 'C' }, r.body.token);
  for (let i = 0; i < 5; i++) assert.equal((await invoice(r.body.token)).status, 200, `fatura ${i + 1} sem limite de confirmação`);   // vale só o limite normal do Free (5)
  const resend = await call('/me/email/resend', 'POST', {}, r.body.token);
  assert.equal(resend.status, 503); assert.match(resend.body.error, /not set up/);                                                  // nunca finge que enviou
});

test('com e-mail: o cadastro Free manda o link, a conta fica limitada a 3 faturas e o link libera tudo', async () => {
  mailer.setTransport(async (m) => { sent.push(m); });
  assert.equal((await call('/status')).body.confirmEmail, true);
  const r = await call('/setup', 'POST', { company_name: 'Com Email', name: 'Bia', email: 'bia@x.com', password: 'senha1234', lang: 'pt' });
  assert.equal(r.status, 200); assert.equal(r.body.emailConfirmation, 'sent'); A = r.body.token;
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'bia@x.com'); assert.match(sent[0].subject, /Confirme/); assert.match(sent[0].text, /^https:\/\/app\.fluxo\.test\/confirm-email\?token=com-email\./m);
  const me = await call('/me', 'GET', undefined, A);
  assert.deepEqual([me.body.emailConfirm.confirmed, me.body.emailConfirm.limited, me.body.emailConfirm.invoiceCap], [false, true, 3]);
  assert.ok(me.body.emailConfirm.lastSentAt);
  await call('/contacts', 'POST', { kind: 'customer', name: 'C' }, A);
  for (let i = 0; i < 3; i++) assert.equal((await invoice(A)).status, 200);
  const blocked = await invoice(A);
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'email_unconfirmed'); assert.match(blocked.body.error, /Confirm your email/);
  // o token fica guardado só como resumo
  assert.equal(tenants.inTenant('com-email', () => get('SELECT COUNT(*) n FROM email_verifications WHERE token_hash=?', linkOf(sent[0]).split('.')[1]).n), 0);
});

test('reenvio: espera de 1 minuto, link novo invalida o antigo, e o link confirma uma vez só (clicar de novo não dá erro)', async () => {
  assert.equal((await call('/me/email/resend', 'POST', {}, A)).status, 429);                      // acabou de mandar no cadastro
  tenants.inTenant('com-email', () => run("UPDATE email_verifications SET created_at=datetime('now','-2 minutes')"));
  const again = await call('/me/email/resend', 'POST', {}, A);
  assert.equal(again.status, 200); assert.equal(again.body.sentTo, 'bia@x.com'); assert.equal(sent.length, 2);
  assert.equal((await call('/confirm-email', 'POST', { token: linkOf(sent[0]) })).status, 400);   // o link antigo foi trocado
  assert.equal((await call('/confirm-email', 'POST', { token: 'com-email.' + 'a'.repeat(64) })).status, 400);
  assert.equal((await call('/confirm-email', 'POST', { token: 'nao-existe.' + 'a'.repeat(64) })).status, 400);
  const ok = await call('/confirm-email', 'POST', { token: linkOf(sent[1]) });
  assert.equal(ok.status, 200); assert.equal(ok.body.already, false);
  assert.equal((await call('/confirm-email', 'POST', { token: linkOf(sent[1]) })).body.already, true);
  const me = await call('/me', 'GET', undefined, A);
  assert.deepEqual([me.body.emailConfirm.confirmed, me.body.emailConfirm.limited], [true, false]);
  assert.equal((await invoice(A)).status, 200);                                                       // 4ª fatura liberada
  assert.equal((await call('/me/email/resend', 'POST', {}, A)).body.confirmed, true);                // já confirmado: nada a enviar
});

test('link vencido não vale; se o envio falhar o usuário é avisado e pode tentar de novo', async () => {
  const r = await call('/setup', 'POST', { company_name: 'Falha Co', name: 'Caio', email: 'caio@x.com', password: 'senha1234', lang: 'en' });
  const tk = r.body.token, link = linkOf(sent.at(-1));
  tenants.inTenant('falha-co', () => run("UPDATE email_verifications SET expires_at=datetime('now','-1 minute'), created_at=datetime('now','-5 minutes')"));
  assert.equal((await call('/confirm-email', 'POST', { token: link })).status, 400);
  mailer.setTransport(async () => { throw new Error('smtp down'); });
  const f = await call('/me/email/resend', 'POST', {}, tk);
  assert.equal(f.status, 502); assert.match(f.body.error, /could not send/);
  mailer.setTransport(async (m) => { sent.push(m); });
  assert.equal((await call('/me/email/resend', 'POST', {}, tk)).status, 200);                        // a tentativa que falhou não gasta a espera
  const down = await call('/setup', 'POST', { company_name: 'Offline Co', name: 'Dora', email: 'dora@x.com', password: 'senha1234', lang: 'en' });
  assert.equal(down.status, 200);
});

test('quem paga, quem o dono cria e quem já existia nunca ficam limitados', async () => {
  const { createTenant, inTenant } = tenants;
  const slug = createTenant({ name: 'Paga Co', ownerEmail: 'paga@x.com' });
  inTenant(slug, () => {
    run("INSERT INTO users(name,email,password_hash,role) VALUES('Paga','paga@x.com','x:y','owner')");           // dono não confirmado...
    run("UPDATE settings SET value='starter' WHERE key='plan'");                                                  // ...mas em plano pago
  });
  assert.equal(inTenant(slug, () => get("SELECT email_verified_at v FROM users WHERE email='paga@x.com'").v), null);
  const { restriction } = await import('../src/emailConfirm.js');
  assert.equal(inTenant(slug, () => restriction()), null);                                                      // plano pago: sem limite
  // empresa criada pelo dono (POST /users) já nasce confirmada
  const u = await call('/users', 'POST', { name: 'Func', email: 'func@x.com', password: 'senha1234', role: 'viewer' }, A);
  assert.equal(u.status, 402);                                                                                  // Free tem 1 usuário; o ponto é a coluna, testada abaixo
  assert.equal(tenants.inTenant('com-email', () => get("SELECT COUNT(*) n FROM users WHERE email_verified_at IS NULL").n), 0);
});

test('bancos antigos: quem já existia fica confirmado na atualização', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { openDb } = await import('../src/db.js');
  const os = await import('node:os'), path = await import('node:path'), fs = await import('node:fs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-old-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', custom_role_id INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  old.exec("INSERT INTO users(name,email,password_hash,role) VALUES('Velho','velho@x.com','x:y','owner')");
  old.close();
  const d = openDb(file);
  assert.ok(d.prepare("SELECT email_verified_at v FROM users WHERE email='velho@x.com'").get().v);
  d.close();
});
test.after(() => server.close());
