import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createStripeMock } from './mocks/stripe.js';
const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1'; process.env.FLUXO_REQUIRE_PAYMENT = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.APP_URL = 'https://app.fluxo.test';

const { get } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const tenants = await import('../src/tenants.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, method = 'GET', body, tk = '', headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sign = (raw, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}`;
const hook = (event) => { const raw = JSON.stringify(event); return call('/stripe/webhook', 'POST', raw, '', { 'stripe-signature': sign(raw) }); };
let evId = 0;
const invoice = (tk, n = 1000) => call('/docs/invoice', 'POST', { contact_id: 1, issue_date: '2026-01-10', due_date: '2026-01-20', post: true, lines: [{ description: 'serviço', qty: 1, unit_price: n }] }, tk);
const customer = (tk, name) => call('/contacts', 'POST', { kind: 'customer', name }, tk);
const tokens = {};

test('o servidor informa o modo multi-empresa e o login não depende de empresa única', async () => {
  const s = await call('/status');
  assert.equal(s.body.multi, true); assert.equal(s.body.needsSetup, false);
  assert.equal((await call('/login', 'POST', { email: 'ninguem@x.com', password: 'senha1234' })).status, 401);
});

test('cadastro gratuito cria uma empresa isolada; sem pagamento nunca vale plano pago', async () => {
  for (const [key, company, email] of [['a', 'Alfa Ltda', 'a@alfa.com'], ['b', 'Beta Inc', 'b@beta.com']]) {
    const r = await call('/setup', 'POST', { company_name: company, name: key, email, password: 'senha1234', plan: 'advanced', lang: 'en' });
    assert.equal(r.status, 200, JSON.stringify(r.body)); tokens[key] = r.body.token;
    assert.match(r.body.token, new RegExp(`^${tenants.slugify(company)}\\.[0-9a-f]{64}$`));
    const me = await call('/me', 'GET', undefined, r.body.token);
    assert.equal(me.body.planInfo.plan, 'free'); assert.equal(me.body.tenant, tenants.slugify(company));   // o plano do formulário foi ignorado
  }
  assert.equal((await call('/setup', 'POST', { company_name: 'Outra', name: 'x', email: 'A@alfa.com', password: 'senha1234' })).status, 409);   // e-mail já tem empresa
  assert.equal((await call('/setup', 'POST', { name: 'x', email: 'sem-arroba', password: 'senha1234' })).status, 400);
  assert.equal(tenants.allSlugs().length, 2);                                                                                                    // a tentativa inválida não deixou empresa órfã
});

test('cada empresa só enxerga os próprios dados', async () => {
  assert.equal((await customer(tokens.a, 'Cliente da Alfa')).status, 200);
  assert.equal((await invoice(tokens.a)).status, 200);
  const a = await call('/docs/invoice', 'GET', undefined, tokens.a), b = await call('/docs/invoice', 'GET', undefined, tokens.b);
  assert.equal(a.body.length, 1); assert.equal(b.body.length, 0);
  assert.deepEqual((await call('/contacts', 'GET', undefined, tokens.b)).body.filter((c) => c.name === 'Cliente da Alfa'), []);
  assert.equal(get('SELECT COUNT(*) AS n FROM docs').n, 0);                                         // o banco padrão não recebe nada de ninguém
  // o token de uma empresa não abre a outra, mesmo trocando o prefixo
  const forged = `${tenants.slugify('Beta Inc')}.${tokens.a.split('.')[1]}`;
  assert.equal((await call('/me', 'GET', undefined, forged)).status, 401);
});

test('limites do plano valem por empresa (5 faturas no Free)', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await invoice(tokens.a)).status, 200);
  assert.equal((await invoice(tokens.a)).status, 402);                       // a sexta da Alfa
  await customer(tokens.b, 'Cliente da Beta');
  assert.equal((await invoice(tokens.b)).status, 200);                       // a Beta continua com a cota inteira
});

test('login por e-mail encontra a empresa; usuário novo não pode repetir e-mail de outra empresa', async () => {
  const l = await call('/login', 'POST', { email: 'B@beta.com', password: 'senha1234' });
  assert.equal(l.status, 200); assert.match(l.body.token, /^beta-inc\./);
  assert.equal((await call('/login', 'POST', { email: 'b@beta.com', password: 'errada123' })).status, 401);
  await call('/plan', 'PUT', { plan: 'starter' }, tokens.b);
  assert.equal((await call('/users', 'POST', { name: 'Intruso', email: 'a@alfa.com', password: 'senha1234', role: 'viewer' }, tokens.b)).status, 400);
  assert.equal((await call('/users', 'POST', { name: 'Colega', email: 'colega@beta.com', password: 'senha1234', role: 'viewer' }, tokens.b)).status, 200);
  assert.equal((await call('/login', 'POST', { email: 'colega@beta.com', password: 'senha1234' })).body.token.split('.')[0], 'beta-inc');
});

test('link público do documento leva a empresa junto e não abre em outra', async () => {
  const d = (await call('/docs/invoice', 'GET', undefined, tokens.a)).body[0];
  const full = (await call(`/doc/${d.id}`, 'GET', undefined, tokens.a)).body;
  const ref = `alfa-ltda.${full.share_token}`;
  const ok = await call(`/public/doc/${ref}`);
  assert.equal(ok.status, 200); assert.equal(ok.body.company.company_name, 'Alfa Ltda');
  assert.equal((await call(`/public/doc/beta-inc.${full.share_token}`)).status, 404);   // mesmo token na empresa errada
  assert.equal((await call(`/public/doc/${full.share_token}`)).status, 404);            // sem empresa, não existe
});

test('compra pelo Stripe: o cadastro aplica a assinatura e os webhooks caem na empresa certa', async () => {
  const c = await call('/public/checkout', 'POST', { plan: 'plus', email: 'dona@gama.com' });
  assert.equal(c.status, 200);
  Object.assign(S.sessions[c.body.id], { status: 'complete', payment_status: 'paid', customer: 'cus_g', subscription: 'sub_g', customer_details: { email: 'dona@gama.com' } });
  S.subs.sub_g = { id: 'sub_g', customer: 'cus_g', status: 'active', current_period_end: 1893456000, cancel_at_period_end: false, items: { data: [{ id: 'si_g', price: { lookup_key: 'fluxo_plan_plus_monthly' } }] } };
  const s = await call('/setup', 'POST', { company_name: 'Gama SA', name: 'Dona', email: 'dona@gama.com', password: 'senha1234', checkout_session_id: c.body.id });
  assert.equal(s.status, 200, JSON.stringify(s.body)); tokens.g = s.body.token;
  assert.equal((await call('/me', 'GET', undefined, tokens.g)).body.planInfo.plan, 'plus');
  // o mesmo pagamento não cria uma segunda empresa
  assert.equal((await call('/setup', 'POST', { company_name: 'Gama 2', name: 'x', email: 'outra@gama.com', password: 'senha1234', checkout_session_id: c.body.id })).status, 409);
  assert.equal((await call(`/public/signup?session_id=${c.body.id}`)).body.alreadySetup, true);
  // cancelamento chega por webhook: só a Gama volta ao Free
  const ev = { id: `evt_m${++evId}`, type: 'customer.subscription.deleted', data: { object: { ...S.subs.sub_g, status: 'canceled' } } };
  assert.equal((await hook(ev)).status, 200);
  assert.equal((await call('/me', 'GET', undefined, tokens.g)).body.planInfo.plan, 'free');
  assert.equal((await call('/me', 'GET', undefined, tokens.b)).body.planInfo.plan, 'starter');   // as outras empresas não mudaram
  // evento de quem não tem empresa é ignorado sem erro
  assert.equal((await hook({ id: `evt_m${++evId}`, type: 'customer.subscription.updated', data: { object: { id: 'sub_zz', customer: 'cus_zz', status: 'active', items: { data: [] } } } })).body.ignored, true);
});

test('tarefas em segundo plano percorrem cada empresa', async () => {
  const seen = [];
  await tenants.eachTenant(() => { seen.push(tenants.currentSlug()); });
  assert.deepEqual(seen.sort(), ['alfa-ltda', 'beta-inc', 'gama-sa']);
});

test.after(() => { server.close(); mock.close(); });
