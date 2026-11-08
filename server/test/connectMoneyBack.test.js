// Conta conectada no formato novo (Accounts v2), reembolso (total e parcial) e contestação das faturas pagas online.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createStripeMock } from './mocks/stripe.js';

const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plat'; process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.APP_URL = 'https://app.fluxo.test';

const { get, all, insert } = await import('../src/db.js');
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

const payOnline = async (inv, pi, amount = 20000) => {
  await call(`/public/doc/${tokenOf(inv.id)}/pay`, 'POST', {}, '');
  const sess = Object.values(S.sessions).at(-1);
  const ev = await hook({ id: 'pay_' + pi, type: 'checkout.session.completed', account: acct, data: { object: { id: sess.id, payment_status: 'paid', payment_intent: pi, amount_total: amount, metadata: { fluxo_doc_id: String(inv.id) } } } });
  assert.equal(ev.body.handled, 'checkout.session.completed', JSON.stringify(ev.body));
  return acc.loadDoc(inv.id);
};
const reminders = (kind) => all('SELECT * FROM reminders WHERE kind=?', kind);

test('conectar cria a conta no formato novo: Stripe responde por estornos e contestações, painel completo', async () => {
  token = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en', demo: false })).body.token;
  const r = await call('/connect/onboard', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  acct = get("SELECT value FROM settings WHERE key='connect_account_id'").value;
  const created = S.accounts[acct];
  assert.equal(created.v2, true, 'usou /v2/core/accounts, não o formato antigo');
  assert.equal(created.params.dashboard, 'full');
  assert.equal(created.params.defaults.responsibilities.fees_collector, 'stripe');
  assert.equal(created.params.defaults.responsibilities.losses_collector, 'stripe');
  assert.equal(created.params.configuration.merchant.capabilities.card_payments.requested, true);
  assert.match(r.body.url, /connect\.stripe\.test\/setup\//);
  assert.equal((await call('/connect/status')).body.ready, false);
  S.accounts[acct].charges_enabled = true; S.accounts[acct].details_submitted = true;
  const st = (await call('/connect/status')).body;
  assert.equal(st.ready, true); assert.equal(st.detailsSubmitted, true);
});

test('conta guardada que o Stripe não conhece mais: vira "não conectado" e conecta de novo', async () => {
  const old = acct;
  delete S.accounts[old];
  const st = (await call('/connect/status')).body;
  assert.equal(st.connected, false);
  const r = await call('/connect/onboard', 'POST', {});
  assert.equal(r.status, 200);
  acct = get("SELECT value FROM settings WHERE key='connect_account_id'").value;
  assert.notEqual(acct, old);
  S.accounts[acct].charges_enabled = true; S.accounts[acct].details_submitted = true;
  await call('/connect/status');
});

test('reembolso parcial reduz o pagamento (e repetir o aviso não desconta de novo); total remove e reabre a fatura', async () => {
  const inv = invoice(20000);
  let d = await payOnline(inv, 'pi_part');
  assert.equal(d.status, 'paid'); assert.equal(d.payments[0].amount, 20000);
  const ev = (id, refunded, full = false) => ({ id, type: 'charge.refunded', account: acct, data: { object: { id: 'ch_1', payment_intent: 'pi_part', refunded: full, amount_refunded: refunded } } });
  assert.equal((await hook(ev('r1', 5000))).body.handled, 'partial_refund');
  d = acc.loadDoc(inv.id);
  assert.equal(d.payments.length, 1); assert.equal(d.payments[0].amount, 15000);
  assert.equal(d.balance, 5000); assert.equal(d.status, 'partial');
  assert.equal((await hook(ev('r1b', 5000))).body.handled, 'already_applied', 'mesmo total acumulado: não desconta de novo');
  assert.equal(acc.loadDoc(inv.id).payments[0].amount, 15000);
  assert.equal((await hook(ev('r2', 20000, true))).body.handled, 'refunded');
  d = acc.loadDoc(inv.id);
  assert.equal(d.payments.length, 0); assert.equal(d.balance, 20000); assert.notEqual(d.status, 'paid');
  assert.ok(reminders('refund').length >= 2, 'avisou o dono na lista de lembretes');
});

test('contestação: aberta só avisa; perdida remove o pagamento; ganha só avisa; conta errada é ignorada', async () => {
  const inv = invoice(12000);
  await payOnline(inv, 'pi_disp', 12000);
  const dsp = (id, type, status, account = acct) => ({ id, type, account, data: { object: { id: 'dp_1', payment_intent: 'pi_disp', amount: 12000, status } } });
  assert.equal((await hook(dsp('d1', 'charge.dispute.created', 'needs_response'))).body.handled, 'dispute_open');
  assert.equal(acc.loadDoc(inv.id).status, 'paid');
  assert.equal((await hook(dsp('d2', 'charge.dispute.closed', 'won'))).body.handled, 'dispute_won');
  assert.equal(acc.loadDoc(inv.id).status, 'paid');
  assert.equal((await hook(dsp('d3', 'charge.dispute.closed', 'lost', 'acct_outra'))).body.handled, 'other_account');
  assert.equal(acc.loadDoc(inv.id).status, 'paid', 'evento de outra conta não mexe');
  assert.equal((await hook(dsp('d4', 'charge.dispute.closed', 'lost'))).body.handled, 'dispute_lost');
  const d = acc.loadDoc(inv.id);
  assert.equal(d.payments.length, 0); assert.notEqual(d.status, 'paid');
  assert.ok(reminders('dispute').length >= 3);
});

test('reembolso de pagamento que não está ligado a uma fatura (feito antes desta versão): só avisa para conferir à mão', async () => {
  const r = await hook({ id: 'u1', type: 'charge.refunded', account: acct, data: { object: { id: 'ch_x', payment_intent: 'pi_desconhecido', refunded: true, amount_refunded: 999 } } });
  assert.equal(r.body.handled, 'unlinked');
  assert.equal(reminders('stripe_review').length, 1);
});

after(() => { server.closeAllConnections?.(); server.close(); mock.closeAllConnections?.(); mock.close(); });
