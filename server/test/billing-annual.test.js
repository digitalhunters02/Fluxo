// Plano anual do Fluxo: mensal = preço cheio; anual = 12 mensalidades com 10% de desconto, pago uma vez.
// O complemento de folha (base + por funcionário) também tem preço anual: uma assinatura não mistura períodos.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createStripeMock } from './mocks/stripe.js';
const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.APP_URL = 'https://app.fluxo.test';

const { get, insert } = await import('../src/db.js');
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
const sign = (raw) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`; };
const hook = (event) => { const raw = JSON.stringify(event); return call('/stripe/webhook', 'POST', raw, '', { 'stripe-signature': sign(raw) }); };
let evId = 0; const ev = (type, object) => ({ id: `evt_annual_${++evId}`, type, data: { object } });

test('preços de tabela: anual = 12 × mensal × 0,90, ao centavo (planos e folha)', async () => {
  const r = (await call('/public/plans', 'GET', undefined, '')).body;
  assert.equal(r.annualDiscount, 0.1);
  assert.deepEqual(r.yearlyPrices, { free: 0, starter: 313.2, essentials: 702, plus: 1177.2, advanced: 2905.2, business: 6469.2, enterprise: 9720 });
  assert.deepEqual(r.payrollYearlyPrice, { base: 378, perEmployee: 54 });
  assert.deepEqual(r.prices, { free: 0, starter: 29, essentials: 65, plus: 109, advanced: 269, business: 599, enterprise: 900 }, 'o mensal continua o preço cheio');
});

test('Enterprise anual: US$ 9.720 por ano (900 × 12 × 0,90) e a empresa extra do grupo também tem preço anual', async () => {
  const r = await call('/public/checkout', 'POST', { plan: 'enterprise', interval: 'year', email: 'grande@anual.com' }, '');
  assert.equal(r.status, 200);
  assert.equal(priceByKey('fluxo_plan_enterprise_yearly').unit_amount, 972000);
  assert.equal(priceByKey('fluxo_plan_enterprise_yearly').recurring.interval, 'year');
  assert.equal((await call('/public/plans', 'GET', undefined, '')).body.enterpriseExtraYearly, 1080);
});

test('checkout anual cria os preços anuais (plano + folha), uma vez, e leva a etiqueta do produto', async () => {
  const r = await call('/public/checkout', 'POST', { plan: 'plus', payroll: true, interval: 'year', email: 'ana@anual.com' }, '');
  assert.equal(r.status, 200);
  assert.equal(priceByKey('fluxo_plan_plus_yearly').unit_amount, 117720); assert.equal(priceByKey('fluxo_plan_plus_yearly').recurring.interval, 'year');
  assert.equal(priceByKey('fluxo_payroll_base_yearly').unit_amount, 37800); assert.equal(priceByKey('fluxo_payroll_seat_yearly').unit_amount, 5400);
  const p = S.sessions[r.body.id].params;
  assert.equal(Object.values(p.line_items)[0].price, priceByKey('fluxo_plan_plus_yearly').id);
  assert.equal(p.metadata.interval, 'year'); assert.equal(p.subscription_data.metadata.fluxo_interval, 'year');
  assert.equal(p.metadata.product, 'fluxo'); assert.equal(p.subscription_data.metadata.product, 'fluxo');
  const n = S.prices.length; await call('/public/checkout', 'POST', { plan: 'plus', payroll: true, interval: 'year' }, ''); assert.equal(S.prices.length, n, 'repetir não cria preço de novo');
  // intervalo desconhecido vira mensal; o mensal usa o preço cheio
  const m = await call('/public/checkout', 'POST', { plan: 'starter', interval: 'weekly' }, '');
  assert.equal(S.sessions[m.body.id].params.metadata.interval, 'month'); assert.equal(priceByKey('fluxo_plan_starter_monthly').unit_amount, 2900);
});

test('depois do pagamento anual o plano e o período anual ficam gravados', async () => {
  const co = await call('/public/checkout', 'POST', { plan: 'essentials', payroll: true, interval: 'year', email: 'bia@anual.com' }, '');
  S.subs.sub_y = subObj('sub_y', 'active', [['fluxo_plan_essentials_yearly'], ['fluxo_payroll_base_yearly']]);
  Object.assign(S.sessions[co.body.id], { status: 'complete', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_y', customer_details: { email: 'bia@anual.com' } });
  const v = await call(`/public/signup?session_id=${co.body.id}`, 'GET', undefined, '');
  assert.equal(v.body.plan, 'essentials'); assert.equal(v.body.payroll, true);
  const s = await call('/setup', 'POST', { name: 'Bia', email: 'bia@anual.com', password: 'senha1234', checkout_session_id: co.body.id }, '');
  assert.equal(s.status, 200); token = s.body.token;
  assert.equal(setting('plan'), 'essentials'); assert.equal(setting('addon_payroll'), '1'); assert.equal(setting('billing_interval'), 'year');
  const me = (await call('/me')).body.planInfo;
  assert.equal(me.billing.interval, 'year'); assert.deepEqual(me.yearlyPrices.plus, 1177.2); assert.equal(me.annualDiscount, 0.1);
});

test('trocar de plano e ligar/desligar a folha mantém o período anual', async () => {
  for (const p of ['plus']) await billing.planPrice(p, 'year');
  const up = await call('/billing/change', 'POST', { plan: 'plus' });
  assert.equal(up.status, 200); assert.equal(up.body.plan, 'plus');
  const planItem = S.subs.sub_y.items.data.find((i) => i.price.lookup_key.startsWith('fluxo_plan_'));
  assert.equal(planItem.price.lookup_key, 'fluxo_plan_plus_yearly', 'continua anual ao subir de plano');
  assert.equal(setting('billing_interval'), 'year');
  // com funcionários, ligar a folha de novo usa o preço anual da base e do funcionário
  await call('/billing/change', 'POST', { payroll: false });
  assert.equal(S.subs.sub_y.items.data.length, 1);
  insert("INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status) VALUES('A','2026-01-01','year',6000000,'monthly','single')");
  insert("INSERT INTO employees(name,hire_date,pay_basis,pay_rate,frequency,filing_status) VALUES('B','2026-01-01','year',6000000,'monthly','single')");
  const on = await call('/billing/change', 'POST', { payroll: true }); assert.equal(on.body.payroll, true);
  assert.deepEqual(S.subs.sub_y.items.data.map((i) => i.price.lookup_key).sort(), ['fluxo_payroll_base_yearly', 'fluxo_payroll_seat_yearly', 'fluxo_plan_plus_yearly']);
  assert.equal(S.subs.sub_y.items.data.find((i) => i.price.lookup_key === 'fluxo_payroll_seat_yearly').quantity, 2);
  // novo funcionário: a quantidade cobrada sobe, no preço anual
  const emp = { name: 'Cy', hire_date: '2026-02-01', pay_basis: 'year', pay_rate: 6000000, frequency: 'monthly', filing_status: 'single' };
  assert.equal((await call('/payroll/employees', 'POST', emp)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(S.subs.sub_y.items.data.find((i) => i.price.lookup_key === 'fluxo_payroll_seat_yearly').quantity, 3);
  assert.equal(S.subs.sub_y.items.data.some((i) => i.price.lookup_key === 'fluxo_payroll_seat_monthly'), false, 'nunca mistura mensal com anual');
});

test('quem já paga mensal continua mensal; o resumo do Harbor mostra o valor do período', async () => {
  S.subs.sub_y = subObj('sub_y', 'active', [['fluxo_plan_plus_yearly']]); billing.applySubscription(S.subs.sub_y);
  assert.equal(setting('billing_interval'), 'year');
  S.subs.sub_m = subObj('sub_m', 'active', [['fluxo_plan_starter_monthly']]);
  await billing.planPrice('starter', 'month'); S.subs.sub_m = subObj('sub_m', 'active', [['fluxo_plan_starter_monthly']]);
  billing.applySubscription(S.subs.sub_m);
  assert.equal(setting('billing_interval'), 'month');
  process.env.ADMIN_SUMMARY_KEY = 'k'.repeat(24);
  let sum = (await call('/admin-summary', 'GET', undefined, '', { 'x-admin-key': 'k'.repeat(24) })).body.subscribers[0];
  assert.equal(sum.interval, 'month'); assert.equal(sum.amount, 29);
  billing.applySubscription(S.subs.sub_y);
  sum = (await call('/admin-summary', 'GET', undefined, '', { 'x-admin-key': 'k'.repeat(24) })).body.subscribers[0];
  assert.equal(sum.interval, 'year'); assert.equal(sum.amount, 1177.2);
});

test('etiqueta de produto: checkout e assinaturas de OUTRO produto da mesma conta do Stripe são ignorados', async () => {
  billing.applySubscription(S.subs.sub_y); // plus anual ativo
  const before = { plan: setting('plan'), sub: setting('stripe_subscription_id'), interval: setting('billing_interval') };
  S.priceOther = { id: 'price_other', unit_amount: 7900, lookup_key: 'impact_binder_basico_month', active: true, recurring: { interval: 'month' } };
  S.prices.push(S.priceOther);
  const foreign = { id: 'sub_f', customer: 'cus_f', status: 'active', metadata: { product: 'binder' }, items: { data: [{ id: 'si_f', quantity: 1, price: S.priceOther }] } };
  S.subs.sub_f = foreign;
  const untagged = { id: 'sub_u', customer: 'cus_u', status: 'active', items: { data: [{ id: 'si_u', quantity: 1, price: S.priceOther }] } };
  S.subs.sub_u = untagged;
  const slug = 'fluxo';
  assert.equal((await hook(ev('checkout.session.completed', { id: 'cs_f', mode: 'subscription', subscription: 'sub_f', customer: 'cus_f', client_reference_id: slug, metadata: { product: 'binder' } }))).status, 200);
  assert.equal((await hook(ev('checkout.session.completed', { id: 'cs_u', mode: 'subscription', subscription: 'sub_u', customer: 'cus_u', client_reference_id: slug }))).status, 200);
  assert.equal((await hook(ev('customer.subscription.updated', { ...foreign, id: setting('stripe_subscription_id'), customer: setting('stripe_customer_id'), status: 'canceled' }))).status, 200);
  assert.deepEqual({ plan: setting('plan'), sub: setting('stripe_subscription_id'), interval: setting('billing_interval') }, before, 'nada mudou');
  assert.equal(setting('subscription_status'), 'active');
  // o próprio produto continua funcionando
  S.subs.sub_own = subObj('sub_own', 'active', [['fluxo_plan_starter_yearly']].filter(([k]) => priceByKey(k)).length ? [['fluxo_plan_starter_yearly']] : [['fluxo_plan_plus_yearly']], { metadata: { product: 'fluxo' } });
  assert.equal((await hook(ev('checkout.session.completed', { id: 'cs_own', mode: 'subscription', subscription: 'sub_own', customer: 'cus_1', client_reference_id: slug, metadata: { product: 'fluxo' } }))).status, 200);
  assert.equal(setting('stripe_subscription_id'), 'sub_own');
});

test.after(() => { server.close(); mock.close(); });
