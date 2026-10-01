import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createStripeMock } from './mocks/stripe.js';
const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.APP_URL = 'https://app.fluxo.test';

const { get, all, insert } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const billing = await import('../src/billing.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const setting = (k) => get('SELECT value FROM settings WHERE key=?', k)?.value;
const priceByKey = (k) => S.prices.find((p) => p.lookup_key === k);
const subObj = (id, status, keys, extra = {}) => ({ id, customer: 'cus_1', status, current_period_end: 1893456000, cancel_at_period_end: false, items: { data: keys.map(([k, q], i) => ({ id: `si_${id}_${i}`, quantity: q ?? 1, price: priceByKey(k) })) }, ...extra });
const sign = (raw, { secret = 'whsec_test', t = Math.floor(Date.now() / 1000) } = {}) => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
const hook = (event, opts) => { const raw = JSON.stringify(event); return call('/stripe/webhook', 'POST', raw, '', { 'stripe-signature': sign(raw, opts) }); };
let evId = 0; const ev = (type, object) => ({ id: `evt_${++evId}`, type, data: { object } });

test('a página de preços pública informa os valores e que a cobrança está configurada', async () => {
  const r = await call('/public/plans', 'GET', undefined, '');
  assert.equal(r.status, 200); assert.equal(r.body.configured, true); assert.equal(r.body.needsSetup, true);
  assert.deepEqual(r.body.prices, { free: 0, starter: 29, essentials: 65, plus: 109, advanced: 269 });
});

test('checkout público cria os preços sob demanda e abre uma assinatura mensal', async () => {
  const r = await call('/public/checkout', 'POST', { plan: 'plus', payroll: true, email: 'Ana@Cliente.com' }, '');
  assert.equal(r.status, 200); assert.match(r.body.url, /^https:\/\/checkout\.stripe\.test\/c\/cs_test_/);
  assert.equal(priceByKey('fluxo_plan_plus_monthly').unit_amount, 10900);            // US$ 109 em centavos
  assert.equal(priceByKey('fluxo_payroll_base_monthly').unit_amount, 3500);
  assert.equal(priceByKey('fluxo_payroll_seat_monthly').unit_amount, 500);
  const p = S.sessions[r.body.id].params;
  assert.equal(p.mode, 'subscription'); assert.equal(p.customer_email, 'ana@cliente.com');
  assert.equal(p.success_url, 'https://app.fluxo.test/welcome?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.cancel_url, 'https://app.fluxo.test/pricing?canceled=1');
  assert.equal(Object.values(p.line_items).length, 2);                                // plano + base da folha (sem funcionários ainda)
  assert.equal(p.metadata.plan, 'plus');
  // preço já existente é reaproveitado, não recriado
  const before = S.prices.length; await call('/public/checkout', 'POST', { plan: 'plus' }, ''); assert.equal(S.prices.length, before);
  assert.equal(S.calls.at(-1).auth, 'Bearer sk_test_123');
  assert.equal((await call('/public/checkout', 'POST', { plan: 'enterprise' }, '')).status, 400);
  assert.equal((await call('/public/checkout', 'POST', { plan: 'plus', email: 'nao-e-email' }, '')).status, 400);
});

test('depois do pagamento o cliente cria a conta e já entra no plano que comprou', async () => {
  const co = await call('/public/checkout', 'POST', { plan: 'plus', payroll: true, email: 'ana@cliente.com' }, '');
  const id = co.body.id;
  assert.equal((await call(`/public/signup?session_id=${id}`, 'GET', undefined, '')).status, 402);      // ainda não pago
  assert.equal((await call('/public/signup?session_id=../etc', 'GET', undefined, '')).status, 400);
  S.subs.sub_1 = subObj('sub_1', 'active', [['fluxo_plan_plus_monthly'], ['fluxo_payroll_base_monthly']]);
  Object.assign(S.sessions[id], { status: 'complete', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', customer_details: { email: 'ana@cliente.com' } });
  const v = await call(`/public/signup?session_id=${id}`, 'GET', undefined, '');
  assert.deepEqual(v.body, { email: 'ana@cliente.com', plan: 'plus', payroll: true });
  // sem sessão paga, nada de plano de graça
  assert.equal((await call('/setup', 'POST', { name: 'Ana', email: 'ana@cliente.com', password: 'senha1234', checkout_session_id: 'cs_test_9999' }, '')).status, 502);
  const s = await call('/setup', 'POST', { name: 'Ana', email: 'ana@cliente.com', password: 'senha1234', plan: 'starter', demo: true, checkout_session_id: id }, '');
  assert.equal(s.status, 200); token = s.body.token;
  assert.equal(setting('plan'), 'plus'); assert.equal(setting('addon_payroll'), '1');           // vale o plano pago, não o que veio no formulário
  assert.equal(setting('billing_managed'), '1'); assert.equal(setting('stripe_customer_id'), 'cus_1'); assert.equal(setting('stripe_subscription_id'), 'sub_1');
  assert.equal(setting('subscription_period_end'), '2030-01-01');
  assert.equal(get('SELECT COUNT(*) AS n FROM docs').n, 0);                                         // cliente pago não recebe dados de exemplo
  assert.equal((await call(`/public/signup?session_id=${id}`, 'GET', undefined, '')).body.alreadySetup, true);
  assert.equal((await call('/public/checkout', 'POST', { plan: 'plus' }, '')).status, 403);        // instalação já tem dono
});

test('com a assinatura ativa o plano não é trocado à mão', async () => {
  const r = await call('/plan', 'PUT', { plan: 'advanced' });
  assert.equal(r.status, 403); assert.equal(setting('plan'), 'plus');
  const me = (await call('/me')).body.planInfo;
  assert.equal(me.billing.managed, true); assert.equal(me.billing.status, 'active'); assert.equal(me.plan, 'plus');
});

test('webhook: só aceita eventos com assinatura HMAC válida e recente', async () => {
  const e = ev('invoice.payment_failed', { customer: 'cus_1' });
  const raw = JSON.stringify(e);
  assert.equal((await call('/stripe/webhook', 'POST', raw, '', {})).status, 400);                                                    // sem assinatura
  assert.equal((await call('/stripe/webhook', 'POST', raw, '', { 'stripe-signature': sign(raw, { secret: 'whsec_outro' }) })).status, 400);   // segredo errado
  assert.equal((await call('/stripe/webhook', 'POST', raw + ' ', '', { 'stripe-signature': sign(raw) })).status, 400);                // corpo adulterado
  assert.equal((await call('/stripe/webhook', 'POST', raw, '', { 'stripe-signature': sign(raw, { t: Math.floor(Date.now() / 1000) - 3600 }) })).status, 400);  // antiga
  assert.equal(setting('subscription_status'), 'active');                                                                              // nada mudou
  assert.equal((await hook(e)).status, 200);
  assert.equal(setting('subscription_status'), 'past_due');
  assert.equal(setting('plan'), 'plus');                                                                                                // inadimplente mantém o plano (carência)
  assert.equal((await hook(e)).body.duplicate, true);                                                                                    // mesmo evento: idempotente
  await hook(ev('invoice.paid', { customer: 'cus_1' }));
  assert.equal(setting('subscription_status'), 'active');
});

test('webhook: mudança de assinatura no Stripe atualiza o plano; cancelamento volta ao plano gratuito', async () => {
  await billing.planPrice('advanced');
  S.subs.sub_1 = subObj('sub_1', 'active', [['fluxo_plan_advanced_monthly']], { cancel_at_period_end: true });
  await hook(ev('customer.subscription.updated', S.subs.sub_1));
  assert.equal(setting('plan'), 'advanced'); assert.equal(setting('addon_payroll'), '0'); assert.equal(setting('subscription_cancel_at_end'), '1');
  // eventos de outra assinatura/cliente são ignorados
  await hook(ev('customer.subscription.updated', subObj('sub_x', 'active', [['fluxo_plan_starter_monthly']], { customer: 'cus_outro' })));
  assert.equal(setting('plan'), 'advanced');
  await hook(ev('customer.subscription.deleted', S.subs.sub_1));
  assert.equal(setting('plan'), 'free'); assert.equal(setting('subscription_status'), 'canceled');
  assert.equal((await call('/plaid/overview')).status, 402);                                                                          // recursos do plano superior foram travados
});

test('upgrade e downgrade na própria tela: troca o preço com cobrança proporcional', async () => {
  for (const p of ['starter', 'essentials', 'plus']) await billing.planPrice(p);
  S.subs.sub_1 = subObj('sub_1', 'active', [['fluxo_plan_starter_monthly']]); billing.applySubscription(S.subs.sub_1);
  assert.equal(setting('plan'), 'starter');
  const up = await call('/billing/change', 'POST', { plan: 'plus' });
  assert.equal(up.status, 200); assert.equal(up.body.plan, 'plus');
  const upd = S.calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1').at(-1).params;
  assert.equal(upd.proration_behavior, 'create_prorations'); assert.equal(Object.values(upd.items)[0].price, priceByKey('fluxo_plan_plus_monthly').id);
  assert.equal(setting('plan'), 'plus');
  const down = await call('/billing/change', 'POST', { plan: 'essentials' }); assert.equal(down.body.plan, 'essentials');
  // ligar a folha adiciona a base e, havendo funcionários, a cobrança por funcionário
  insert("INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status) VALUES('A','2026-01-01','year',6000000,'monthly','single')");
  insert("INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status) VALUES('B','2026-01-01','year',6000000,'monthly','single')");
  const on = await call('/billing/change', 'POST', { payroll: true }); assert.equal(on.body.payroll, true);
  const seat = S.subs.sub_1.items.data.find((i) => i.price.lookup_key === 'fluxo_payroll_seat_monthly'); assert.equal(seat.quantity, 2);
  const off = await call('/billing/change', 'POST', { payroll: false }); assert.equal(off.body.payroll, false);
  assert.equal(S.subs.sub_1.items.data.length, 1);                                                  // só sobrou o plano
  assert.equal((await call('/billing/change', 'POST', { plan: 'enterprise' })).status, 400);
});

test('novo funcionário atualiza a quantidade cobrada da folha', async () => {
  await call('/billing/change', 'POST', { payroll: true });
  const emp = { name: 'Cy', hire_date: '2026-02-01', pay_basis: 'year', pay_rate: 6000000, frequency: 'monthly', filing_status: 'single' };
  assert.equal((await call('/payroll/employees', 'POST', emp)).status, 200);
  await new Promise((r) => setTimeout(r, 150));                                                      // o ajuste roda em segundo plano
  const seat = S.subs.sub_1.items.data.find((i) => i.price.lookup_key === 'fluxo_payroll_seat_monthly');
  assert.equal(seat.quantity, 3);
});

test('portal do cliente e permissões', async () => {
  const p = await call('/billing/portal', 'POST', {});
  assert.equal(p.status, 200); assert.match(p.body.url, /billing\.stripe\.test/);
  const calls = S.calls.filter((c) => c.path === '/v1/billing_portal/sessions').at(-1).params;
  assert.equal(calls.customer, 'cus_1'); assert.equal(calls.return_url, 'https://app.fluxo.test/settings/plan');
  await call('/users', 'POST', { name: 'Vend', email: 'v@x.com', password: 'senha1234', role: 'sales' });
  const sales = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' }, '')).body.token;
  for (const [path, method] of [['/billing', 'GET'], ['/billing/checkout', 'POST'], ['/billing/change', 'POST'], ['/billing/portal', 'POST']]) assert.equal((await call(path, method, method === 'GET' ? undefined : {}, sales)).status, 403, path);
});

test('checkout de quem já tem conta reaproveita o cliente do Stripe', async () => {
  const r = await call('/billing/checkout', 'POST', { plan: 'advanced' });
  assert.equal(r.status, 200);
  const p = S.sessions[r.body.id].params;
  assert.equal(p.customer, 'cus_1'); assert.equal(p.customer_email, undefined);
  assert.equal(p.success_url, 'https://app.fluxo.test/settings/plan?checkout=success');
});

test('mudança de valor do plano cria preço novo e transfere a lookup key', async () => {
  billing._resetPriceCache();
  const old = priceByKey('fluxo_plan_starter_monthly'); old.unit_amount = 1900;       // simula preço antigo no Stripe
  const fresh = await billing.planPrice('starter');
  assert.equal(fresh.unit_amount, 2900); assert.notEqual(fresh.id, old.id);
  assert.equal(old.active, false); assert.equal(priceByKey('fluxo_plan_starter_monthly').id, fresh.id);
});

test('sem chave do Stripe a cobrança responde 503', async () => {
  const key = process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_SECRET_KEY;
  assert.equal((await call('/billing/portal', 'POST', {})).status, 503);
  assert.equal((await call('/public/plans', 'GET', undefined, '')).body.configured, false);
  process.env.STRIPE_SECRET_KEY = key;
});

test.after(() => { server.close(); mock.close(); });
