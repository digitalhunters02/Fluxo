// Enterprise cobrado pelo Stripe: US$ 900/mês + US$ 100/mês por empresa do grupo além das 10 incluídas (item de quantidade).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeMock } from './mocks/stripe.js';

const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.APP_URL = 'https://app.fluxo.test';
delete process.env.FLUXO_ALLOW_MANUAL_PLAN;

const auth = await import('../src/auth.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
after(() => { server.close(); mock.close(); });
const root = `http://127.0.0.1:${server.address().port}`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(`${root}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, body: json, text };
};
const T = {};
const resetRate = () => { for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) auth.clearAttempts(`signup|${ip}`); };
async function freeCompany(key) {
  resetRate();
  const r = await call('/setup', 'POST', { company_name: `Co ${key}`, name: key.toUpperCase(), email: `${key}@x.com`, password: 'senha1234', lang: 'en' });
  assert.equal(r.status, 200, r.text); T[key] = r.body.token;
}
const extraItem = (sub) => sub.items.data.find((i) => i.price.lookup_key === 'fluxo_enterprise_extra_company_monthly');
const settle = () => new Promise((r) => setTimeout(r, 150)); // a sincronização com o Stripe roda em segundo plano

test('o plano Enterprise aparece com preço de US$ 900 e o checkout cobra só a base', async () => {
  const plans = await call('/public/plans');
  assert.equal(plans.body.prices.enterprise, 900); assert.equal(plans.body.enterpriseIncluded, 10); assert.equal(plans.body.enterpriseExtra, 100);
  const co = await call('/public/checkout', 'POST', { plan: 'enterprise', email: 'dona@holding.com' });
  assert.equal(co.status, 200, co.text);
  const items = Object.values(S.sessions[co.body.id].params.line_items);
  assert.equal(items.length, 1); assert.equal(S.prices.find((p) => p.id === items[0].price).unit_amount, 90000);
  assert.equal(S.prices.find((p) => p.id === items[0].price).lookup_key, 'fluxo_plan_enterprise_monthly');
  // compra concluída → o cadastro entra direto no Enterprise
  await fetch(`http://127.0.0.1:${mock.address().port}/__complete/${co.body.id}`);
  resetRate();
  const s = await call('/setup', 'POST', { company_name: 'Holding', name: 'Dona', email: 'dona@holding.com', password: 'senha1234', checkout_session_id: co.body.id });
  assert.equal(s.status, 200, s.text); T.ent = s.body.token;
  assert.equal((await call('/plan', 'GET', undefined, T.ent)).body.plan, 'enterprise');
});

test('ninguém sobe de plano sozinho sem assinar (descer para o Free pode)', async () => {
  await freeCompany('semfundos');
  const r = await call('/plan', 'PUT', { plan: 'enterprise', payroll: false }, T.semfundos);
  assert.equal(r.status, 402, r.text);
  assert.equal((await call('/plan', 'PUT', { plan: 'business', payroll: false }, T.semfundos)).status, 402);
  assert.equal((await call('/plan', 'GET', undefined, T.semfundos)).body.plan, 'free');
  assert.equal((await call('/plan', 'PUT', { plan: 'free', payroll: false }, T.semfundos)).status, 200);
});

test('grupo Enterprise: as 10 primeiras empresas não pagam extra; da 11ª em diante entra US$ 100 por empresa', async () => {
  const sub = Object.values(S.subs).at(-1);
  assert.equal(extraItem(sub), undefined);
  assert.equal((await call('/group', 'POST', { name: 'Holding' }, T.ent)).status, 200);
  for (let i = 1; i <= 9; i++) { await freeCompany(`m${i}`); const inv = await call('/group/invite', 'POST', {}, T.ent); assert.equal((await call('/group/join', 'POST', { code: inv.body.code }, T[`m${i}`])).status, 200); }
  await settle();
  assert.equal(extraItem(sub), undefined, '10 empresas: nada a mais');
  await freeCompany('m10'); let inv = await call('/group/invite', 'POST', {}, T.ent); await call('/group/join', 'POST', { code: inv.body.code }, T.m10);
  await settle();
  assert.equal(extraItem(sub).quantity, 1, 'a 11ª empresa soma uma extra');
  assert.equal(extraItem(sub).price.unit_amount, 10000);
  await freeCompany('m11'); inv = await call('/group/invite', 'POST', {}, T.ent); await call('/group/join', 'POST', { code: inv.body.code }, T.m11);
  await settle();
  assert.equal(extraItem(sub).quantity, 2);
  assert.equal((await call('/group', 'GET', undefined, T.ent)).body.group.billing.monthly, 1100);
  // uma empresa sai: a cobrança desce
  assert.equal((await call('/group/leave', 'POST', {}, T.m11)).status, 200);
  await settle();
  assert.equal(extraItem(sub).quantity, 1);
  assert.equal((await call('/group/leave', 'POST', {}, T.m10)).status, 200);
  await settle();
  assert.equal(extraItem(sub), undefined, 'voltou a 10 empresas: item de extra removido');
});

test('trocar para o Enterprise numa assinatura existente leva as empresas extras junto', async () => {
  // dona de outro grupo: assina o Business, junta 11 empresas na mão e troca para o Enterprise
  resetRate();
  const co = await call('/public/checkout', 'POST', { plan: 'business', email: 'biz@x.com' });
  await fetch(`http://127.0.0.1:${mock.address().port}/__complete/${co.body.id}`);
  S.sessions[co.body.id].customer = 'cus_biz'; S.subs[S.sessions[co.body.id].subscription].customer = 'cus_biz'; // o mock usa o mesmo cliente para toda compra
  const s = await call('/setup', 'POST', { company_name: 'Biz', name: 'Biz', email: 'biz@x.com', password: 'senha1234', checkout_session_id: co.body.id });
  assert.equal(s.status, 200, s.text); T.biz = s.body.token;
  const sub = Object.values(S.subs).at(-1);
  const ch = await call('/billing/change', 'POST', { plan: 'enterprise' }, T.biz);
  assert.equal(ch.status, 200, ch.text); assert.equal(ch.body.plan, 'enterprise');
  assert.equal(sub.items.data.find((i) => i.price.lookup_key === 'fluxo_plan_enterprise_monthly').price.unit_amount, 90000);
  assert.equal(extraItem(sub), undefined);
  const back = await call('/billing/change', 'POST', { plan: 'business' }, T.biz);
  assert.equal(back.status, 200); assert.equal(extraItem(sub), undefined);
});
