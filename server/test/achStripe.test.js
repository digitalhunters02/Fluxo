// Pagamento por banco (ACH) pelo Stripe Connect: ligar, esperar o Stripe ativar, cobrar, não pagar duas vezes e tratar a falha.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStripeMock } from './mocks/stripe.js';

const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plat'; process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.APP_URL = 'https://app.fluxo.test';

const { get, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}`;
let token = '';
const call = async (p, method = 'GET', body, tk = token, headers = {}) => {
  const r = await fetch(`${root}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const t = acc.today();
const sig = (raw, secret, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
const hook = (event) => { const raw = JSON.stringify(event); return call('/stripe/connect-webhook', 'POST', raw, '', { 'stripe-signature': sig(raw, 'whsec_connect') }); };
const invoice = (amount = 20000) => acc.saveDoc({ type: 'invoice', contact_id: get("SELECT id FROM contacts WHERE name='Acme Co'")?.id ?? insert("INSERT INTO contacts(kind,name,email) VALUES('customer','Acme Co','acme@example.com')"), issue_date: t, due_date: acc.addDays(t, 15), post: true, lines: [{ description: 'service', qty: 1, unit_price: amount }] }, null);
const tokenOf = (id) => get('SELECT share_token FROM docs WHERE id=?', id).share_token;
const pub = async (id) => (await call(`/public/doc/${tokenOf(id)}`, 'GET', undefined, '')).body;
let acct;

test('ligar o ACH: pede a capacidade ao Stripe e só oferece "banco" quando ela estiver ativa', async () => {
  token = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en', demo: false })).body.token;
  assert.equal((await call('/connect/ach', 'PUT', { enabled: true })).status, 400, 'sem Stripe conectado');
  await call('/connect/onboard', 'POST', {});
  acct = get("SELECT value FROM settings WHERE key='connect_account_id'").value;
  S.accounts[acct].charges_enabled = true;
  await hook({ id: 'e1', type: 'account.updated', account: acct, data: { object: { id: acct, charges_enabled: true, capabilities: {} } } });
  const inv = invoice();
  let sess;
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  sess = Object.values(S.sessions).at(-1);
  assert.equal(sess.params.payment_method_types, undefined, 'sem ACH: link só como antes');
  const on = await call('/connect/ach', 'PUT', { enabled: true });
  assert.equal(on.status, 200); assert.deepEqual(on.body.ach, { enabled: true, ready: false });
  assert.equal(S.accounts[acct].lastUpdate.capabilities.us_bank_account_ach_payments.requested, 'true');
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  assert.equal(Object.values(S.sessions).at(-1).params.payment_method_types, undefined, 'ligado, mas o Stripe ainda não ativou: sem banco');
  // o Stripe ativa a capacidade e avisa
  S.accounts[acct].capabilities.us_bank_account_ach_payments = 'active';
  await hook({ id: 'e2', type: 'account.updated', account: acct, data: { object: { id: acct, charges_enabled: true, capabilities: { us_bank_account_ach_payments: 'active' } } } });
  assert.deepEqual((await call('/connect/status')).body.ach, { enabled: true, ready: true });
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  sess = Object.values(S.sessions).at(-1);
  assert.deepEqual(Object.values(sess.params.payment_method_types), ['card', 'us_bank_account']);
  assert.equal(sess.params.payment_method_options.us_bank_account.verification_method, 'instant');
});

test('pagamento por banco é lento: não baixa na hora, não oferece de novo e baixa quando o Stripe confirma', async () => {
  const inv = invoice(30000);
  const r = await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  assert.equal(r.status, 200);
  const sess = Object.values(S.sessions).at(-1);
  const meta = { fluxo_doc_id: String(inv.id) };
  const started = await hook({ id: 'p1', type: 'checkout.session.completed', account: acct, data: { object: { id: sess.id, payment_status: 'unpaid', amount_total: 30000, metadata: meta } } });
  assert.equal(started.body.handled, 'ach_processing');
  assert.equal(acc.loadDoc(inv.id).payments.length, 0, 'ainda não é dinheiro');
  const p = await pub(inv.id);
  assert.equal(p.payOnline, false); assert.equal(p.achPending, true);
  assert.equal((await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '')).status, 400, 'não deixa pagar em dobro');
  const ok = await hook({ id: 'p2', type: 'checkout.session.async_payment_succeeded', account: acct, data: { object: { id: sess.id, payment_status: 'paid', amount_total: 30000, metadata: meta } } });
  assert.equal(ok.body.handled, 'checkout.session.async_payment_succeeded');
  const d = acc.loadDoc(inv.id);
  assert.equal(d.status, 'paid'); assert.equal(d.payments.length, 1); assert.equal(d.payments[0].method, 'ACH (online)');
  assert.equal((await hook({ id: 'p3', type: 'checkout.session.async_payment_succeeded', account: acct, data: { object: { id: sess.id, payment_status: 'paid', amount_total: 30000, metadata: meta } } })).body.handled, 'already_recorded');
  assert.equal(acc.loadDoc(inv.id).payments.length, 1, 'nunca duas vezes');
  assert.equal((await pub(inv.id)).achPending, false);
});

test('pagamento por banco que falha: some o "em andamento", vira lembrete e o link volta', async () => {
  const inv = invoice(5000);
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  const sess = Object.values(S.sessions).at(-1);
  const meta = { fluxo_doc_id: String(inv.id) };
  await hook({ id: 'f1', type: 'checkout.session.completed', account: acct, data: { object: { id: sess.id, payment_status: 'unpaid', metadata: meta } } });
  assert.equal((await pub(inv.id)).achPending, true);
  const failed = await hook({ id: 'f2', type: 'checkout.session.async_payment_failed', account: acct, data: { object: { id: sess.id, metadata: meta } } });
  assert.equal(failed.body.handled, 'ach_failed');
  assert.equal(acc.loadDoc(inv.id).payments.length, 0); assert.equal(acc.loadDoc(inv.id).status, 'sent');
  const p = await pub(inv.id); assert.equal(p.achPending, false); assert.equal(p.payOnline, true, 'pode tentar de novo');
  const rem = get("SELECT * FROM reminders WHERE kind='payment_failed'");
  assert.ok(rem); assert.equal(JSON.parse(rem.data).number, inv.number); assert.equal(rem.link, `/document/${inv.id}`);
  assert.equal((await hook({ id: 'f3', type: 'checkout.session.async_payment_failed', account: acct, data: { object: { id: sess.id, metadata: meta } } })).status, 200);
  assert.equal(get("SELECT COUNT(*) n FROM reminders WHERE kind='payment_failed'").n, 1, 'um aviso só');
});

test('só o dono liga; desligar tira o banco do link; plano abaixo do Advanced não tem', async () => {
  await call('/users', 'POST', { name: 'Vera', email: 'v@x.com', password: 'senha1234', role: 'viewer' });
  const vt = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' }, '')).body.token;
  assert.equal((await call('/connect/ach', 'PUT', { enabled: false }, vt)).status, 403);
  const off = await call('/connect/ach', 'PUT', { enabled: false });
  assert.equal(off.body.ach.enabled, false);
  const inv = invoice(1000);
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  assert.equal(Object.values(S.sessions).at(-1).params.payment_method_types, undefined);
  await call('/plan', 'PUT', { plan: 'plus' });
  assert.equal((await call('/connect/ach', 'PUT', { enabled: true })).status, 402);
});
test.after(() => { server.close(); mock.close(); });
