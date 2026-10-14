// Enterprise: a partir de US$ 900/mês com 10 empresas no grupo incluídas; cada empresa a mais soma US$ 100/mês.
// Business continua com o limite de 5 empresas e sem essa cobrança.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1';
process.env.APP_URL = 'https://app.fluxo.test';

const plans = await import('../src/plans.js');
const auth = await import('../src/auth.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(`${root}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, body: json, text };
};
after(() => server.close());
const T = {};
async function company(key, plan) {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) auth.clearAttempts(`signup|${ip}`);
  const r = await call('/setup', 'POST', { company_name: `Co ${key}`, name: key.toUpperCase(), email: `${key}@x.com`, password: 'senha1234', lang: 'en' });
  assert.equal(r.status, 200, r.text); T[key] = r.body.token;
  assert.equal((await call('/plan', 'PUT', { plan, payroll: false }, T[key])).status, 200);
}
const join = async (owner, key) => { const inv = await call('/group/invite', 'POST', {}, T[owner]); assert.equal(inv.status, 200, inv.text); const j = await call('/group/join', 'POST', { code: inv.body.code }, T[key]); assert.equal(j.status, 200, j.text); return j; };

test('a conta do preço: US$ 900 com 10 empresas, +US$ 100 por empresa a mais', () => {
  assert.equal(plans.ENTERPRISE_FROM, 900); assert.equal(plans.ENTERPRISE_INCLUDED_COMPANIES, 10); assert.equal(plans.ENTERPRISE_EXTRA_COMPANY, 100);
  for (const [n, v] of [[0, 900], [1, 900], [5, 900], [10, 900], [11, 1000], [12, 1100], [20, 1900]]) assert.equal(plans.enterpriseMonthly(n), v, `${n} empresas`);
});

test('a página de planos mostra o preço novo', async () => {
  const r = await call('/public/plans');
  assert.equal(r.status, 200); assert.equal(r.body.enterpriseFrom, 900); assert.equal(r.body.enterpriseIncluded, 10); assert.equal(r.body.enterpriseExtra, 100);
  assert.equal(r.body.prices.business, 599); assert.equal(r.body.prices.enterprise, null);
});

test('Business: limite de 5 e sem cobrança por empresa extra', async () => {
  await company('biz', 'business'); await call('/group', 'POST', { name: 'G' }, T.biz);
  assert.equal((await call('/group', 'GET', undefined, T.biz)).body.group.billing, null);
  for (let i = 1; i <= 4; i++) { await company(`b${i}`, 'free'); await join('biz', `b${i}`); }
  assert.equal((await call('/group/invite', 'POST', {}, T.biz)).status, 402, 'a 6ª empresa não entra no Business');
});

test('Enterprise: 10 incluídas; da 11ª em diante soma US$ 100 cada, sem limite', async () => {
  await company('ent', 'enterprise');
  const g = await call('/group', 'POST', { name: 'Holding' }, T.ent);
  assert.equal(g.status, 200, g.text); assert.equal(g.body.group.limit, null);
  assert.deepEqual(g.body.group.billing, { included: 10, extra: 0, perCompany: 100, monthly: 900 });
  for (let i = 1; i <= 9; i++) { await company(`e${i}`, 'free'); await join('ent', `e${i}`); }
  let b = (await call('/group', 'GET', undefined, T.ent)).body.group;
  assert.equal(b.members.length, 10); assert.deepEqual(b.billing, { included: 10, extra: 0, perCompany: 100, monthly: 900 });
  for (let i = 10; i <= 11; i++) { await company(`e${i}`, 'free'); await join('ent', `e${i}`); }
  b = (await call('/group', 'GET', undefined, T.ent)).body.group;
  assert.equal(b.members.length, 12);
  assert.deepEqual(b.billing, { included: 10, extra: 2, perCompany: 100, monthly: 1100 });
  const asMember = (await call('/group', 'GET', undefined, T.e1)).body.group;
  assert.equal(asMember.isOwner, false); assert.equal(asMember.billing.monthly, 1100, 'o membro vê o mesmo grupo');
});
