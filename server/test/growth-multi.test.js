// Pacote de crescimento no modo multiempresa: isolamento das chaves de API, grupo de empresas com consolidação e eliminação
// entre empresas, roteamento do webhook do Stripe Connect e login único (SSO) por empresa.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createStripeMock } from './mocks/stripe.js';

const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plat'; process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.APP_URL = 'https://app.fluxo.test'; process.env.WEBHOOK_ALLOW_INSECURE = '1';

const acc = await import('../src/accounting.js');
const tenants = await import('../src/tenants.js');
const { get, insert } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}`;
const call = async (p, method = 'GET', body, tk = '', headers = {}) => {
  const r = await fetch(`${root}/api${p}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* texto */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const t = acc.today();
const T = {};
const slugOf = (tk) => tk.split('.')[0];
async function company(key, plan, name = key) {
  const r = await call('/setup', 'POST', { company_name: `Co ${name}`, name: name.toUpperCase(), email: `${key}@x.com`, password: 'senha1234', lang: 'en' });
  assert.equal(r.status, 200, r.text);
  T[key] = r.body.token;
  assert.equal((await call('/plan', 'PUT', { plan, payroll: false }, T[key])).status, 200);
  return T[key];
}
const acct = async (tk, code, name, type) => (await call('/accounts', 'POST', { code, name, type }, tk)).body.id;
const lookup = async (tk, code) => (await call('/accounts/lookup', 'GET', undefined, tk)).body.find((a) => a.code === code).id;
const journal = (tk, lines, memo = 'x') => call('/journal', 'POST', { date: t, memo, lines }, tk);

test('empresas de teste', async () => {
  await company('a', 'business'); await company('b', 'free'); await company('c', 'free'); await company('d', 'free');
  assert.notEqual(slugOf(T.a), slugOf(T.b));
});

test('chave de API leva a empresa certa e não vaza entre empresas', async () => {
  await call('/plan', 'PUT', { plan: 'advanced', payroll: false }, T.a);
  await call('/plan', 'PUT', { plan: 'advanced', payroll: false }, T.b);
  const ka = await call('/integrations/keys', 'POST', { name: 'A' }, T.a), kb = await call('/integrations/keys', 'POST', { name: 'B' }, T.b);
  assert.match(ka.body.key, new RegExp(`^flx_live_${slugOf(T.a)}\\.`));
  const v1 = (key, p, m = 'GET', b) => call(`/v1${p}`, m, b, '', { authorization: `Bearer ${key}` });
  await v1(ka.body.key, '/customers', 'POST', { name: 'Only A', externalId: 'x1' });
  await v1(kb.body.key, '/customers', 'POST', { name: 'Only B', externalId: 'x1' });
  assert.deepEqual((await v1(ka.body.key, '/customers')).body.customers.map((c) => c.name), ['Only A']);
  assert.deepEqual((await v1(kb.body.key, '/customers')).body.customers.map((c) => c.name), ['Only B']);
  const secretA = ka.body.key.split('.')[1];
  assert.equal((await v1(`flx_live_${slugOf(T.b)}.${secretA}`, '/customers')).status, 401, 'o segredo de A não abre a empresa B');
  assert.equal((await v1('flx_live_nonexistent.abc', '/customers')).status, 401);
  assert.equal((await v1(`flx_live_.${secretA}`, '/customers')).status, 401);
  await call('/plan', 'PUT', { plan: 'business', payroll: false }, T.a);
});

test('grupo: criar, convidar, entrar, limites e saída', async () => {
  assert.equal((await call('/group', 'POST', { name: 'Free group' }, T.b)).status, 402, 'só Business cria grupo');
  assert.equal((await call('/group', 'GET', undefined, T.a)).body.group, null);
  const g = await call('/group', 'POST', { name: 'Holding' }, T.a);
  assert.equal(g.status, 200, g.text); assert.equal(g.body.group.members.length, 1); assert.equal(g.body.group.limit, 5);
  assert.equal((await call('/group', 'POST', { name: 'Again' }, T.a)).status, 409);
  assert.equal((await call('/group/invite', 'POST', {}, T.b)).status, 403, 'quem não está no grupo não convida');
  const inv = await call('/group/invite', 'POST', {}, T.a);
  assert.match(inv.body.code, /^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal((await call('/group/join', 'POST', { code: 'WRONG-CODE' }, T.b)).status, 400);
  const j = await call('/group/join', 'POST', { code: inv.body.code }, T.b);
  assert.equal(j.status, 200, j.text); assert.equal(j.body.group.members.length, 2); assert.equal(j.body.group.isOwner, false);
  assert.equal((await call('/group/join', 'POST', { code: inv.body.code }, T.c)).status, 400, 'o código só vale uma vez');
  assert.equal((await call('/group/invite', 'POST', {}, T.b)).status, 403, 'membro não convida');
  const inv2 = await call('/group/invite', 'POST', {}, T.a);
  assert.equal((await call('/group/join', 'POST', { code: inv2.body.code }, T.b)).status, 400, 'já está num grupo');
  assert.equal((await call('/group/join', 'POST', { code: inv2.body.code }, T.c)).status, 200);
  assert.equal((await call('/group', 'GET', undefined, T.d)).body.group, null);
  assert.equal((await call('/group/reports/pnl', 'GET', undefined, T.d)).status, 404, 'quem está fora não vê o consolidado');
  // limite do plano do dono (Business = 5 empresas): enche até 5 e o 6º é recusado
  const extra = [];
  for (const k of ['e1', 'e2']) { await company(k, 'free'); extra.push(k); const ic = await call('/group/invite', 'POST', {}, T.a); assert.equal((await call('/group/join', 'POST', { code: ic.body.code }, T[k])).status, 200); }
  assert.equal((await call('/group', 'GET', undefined, T.a)).body.group.members.length, 5);
  assert.equal((await call('/group/invite', 'POST', {}, T.a)).status, 402, 'sem convites além do limite');
  await call('/group/leave', 'POST', {}, T.e2);
  await call('/group/leave', 'POST', {}, T.e1);
  assert.equal((await call('/group', 'GET', undefined, T.a)).body.group.members.length, 3);
});

test('relatórios consolidados somam as empresas e eliminam o que é entre elas', async () => {
  // A (dono do grupo) e B (membro) e C (membro)
  const aIcRec = await acct(T.a, '1801', 'Intercompany Receivable', 'asset'), aIcRev = await acct(T.a, '4801', 'Intercompany Revenue', 'income');
  const bIcPay = await acct(T.b, '2801', 'Intercompany Payable', 'liability'), bIcExp = await acct(T.b, '6801', 'Intercompany Expense', 'expense');
  const a = (c) => lookup(T.a, c), b = (c) => lookup(T.b, c);
  assert.equal((await journal(T.a, [{ account_id: await a('1010'), debit: 100000 }, { account_id: await a('4100'), credit: 100000 }])).status, 200);
  assert.equal((await journal(T.a, [{ account_id: aIcRec, debit: 20000 }, { account_id: aIcRev, credit: 20000 }])).status, 200);
  assert.equal((await journal(T.b, [{ account_id: await b('1010'), debit: 50000 }, { account_id: await b('4000'), credit: 50000 }])).status, 200);
  assert.equal((await journal(T.b, [{ account_id: bIcExp, debit: 20000 }, { account_id: bIcPay, credit: 20000 }])).status, 200);
  assert.equal((await journal(T.b, [{ account_id: await b('6000'), debit: 10000 }, { account_id: await b('1010'), credit: 10000 }])).status, 200);
  const pnl = await call(`/group/reports/pnl?from=${t.slice(0, 4)}-01-01&to=${t}`, 'GET', undefined, T.b); // um membro também vê
  assert.equal(pnl.status, 200, pnl.text);
  assert.equal(pnl.body.totalIncome, 150000);
  assert.equal(pnl.body.totalOpex, 10000);
  assert.equal(pnl.body.netIncome, 140000);
  assert.deepEqual(pnl.body.eliminated, { income: 20000, expense: 20000, difference: 0 });
  assert.equal(pnl.body.companies.length, 3);
  assert.deepEqual(pnl.body.companies.map((c) => c.netIncome).sort((x, y) => x - y), [0, 20000, 120000]);
  const svc = pnl.body.income.find((r) => r.name === 'Service Revenue');
  assert.equal(svc.total, 100000); assert.equal(svc.byCompany[slugOf(T.a)], 100000);
  const bs = await call(`/group/reports/balance-sheet?asof=${t}`, 'GET', undefined, T.a);
  assert.equal(bs.body.totalAssets, 140000); // caixa 100000 + 40000, sem o a receber entre empresas
  assert.equal(bs.body.totalLiabilities, 0);
  assert.equal(bs.body.currentEarnings, 140000);
  assert.deepEqual(bs.body.eliminated, { assets: 20000, liabilities: 20000, difference: 0 });
  assert.equal(bs.body.balanced, true);
  // se a conta entre empresas não fecha, o relatório mostra a diferença
  assert.equal((await journal(T.a, [{ account_id: aIcRec, debit: 5000 }, { account_id: aIcRev, credit: 5000 }])).status, 200);
  const off = await call(`/group/reports/pnl?from=${t.slice(0, 4)}-01-01&to=${t}`, 'GET', undefined, T.a);
  assert.equal(off.body.eliminated.difference, 5000);
  // sair do grupo
  assert.equal((await call('/group/leave', 'POST', {}, T.c)).status, 200);
  assert.equal((await call('/group/reports/pnl', 'GET', undefined, T.c)).status, 404);
  assert.equal((await call('/group/leave', 'POST', {}, T.a)).status, 200, 'o dono sair desfaz o grupo');
  assert.equal((await call('/group', 'GET', undefined, T.b)).body.group, null);
});

test('webhook do Stripe Connect chega na empresa certa', async () => {
  await call('/plan', 'PUT', { plan: 'advanced', payroll: false }, T.a);
  await call('/plan', 'PUT', { plan: 'advanced', payroll: false }, T.b);
  const sig = (raw) => { const ts = Math.floor(Date.now() / 1000); return `t=${ts},v1=${crypto.createHmac('sha256', 'whsec_connect').update(`${ts}.${raw}`).digest('hex')}`; };
  const hook = (ev) => { const raw = JSON.stringify(ev); return call('/stripe/connect-webhook', 'POST', raw, '', { 'stripe-signature': sig(raw) }); };
  assert.equal((await call('/connect/onboard', 'POST', {}, T.a)).status, 200);
  assert.equal((await call('/connect/onboard', 'POST', {}, T.b)).status, 200);
  const acctA = tenants.inTenant(slugOf(T.a), () => get("SELECT value FROM settings WHERE key='connect_account_id'").value);
  const acctB = tenants.inTenant(slugOf(T.b), () => get("SELECT value FROM settings WHERE key='connect_account_id'").value);
  assert.notEqual(acctA, acctB);
  for (const [a, tk] of [[acctA, 'a'], [acctB, 'b']]) { S.accounts[a].charges_enabled = true; await hook({ id: `evt_${tk}`, type: 'account.updated', account: a, data: { object: { id: a, charges_enabled: true } } }); }
  const mk = (slug) => tenants.inTenant(slug, () => { const c = insert("INSERT INTO contacts(kind,name,email) VALUES('customer','Cust','c@x.com')"); return acc.saveDoc({ type: 'invoice', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 's', qty: 1, unit_price: 9000 }] }, null); });
  const invA = mk(slugOf(T.a)), invB = mk(slugOf(T.b));
  const ev = { id: 'evt_pay_a', type: 'checkout.session.completed', account: acctA, data: { object: { id: 'cs_a', payment_status: 'paid', amount_total: 9000, metadata: { fluxo_doc_id: String(invA.id) } } } };
  assert.equal((await hook(ev)).status, 200);
  const paid = (slug, id) => tenants.inTenant(slug, () => acc.loadDoc(id).status);
  assert.equal(paid(slugOf(T.a), invA.id), 'paid');
  assert.equal(paid(slugOf(T.b), invB.id), 'sent', 'a outra empresa não é tocada');
  assert.equal((await hook({ id: 'evt_unknown', type: 'checkout.session.completed', account: 'acct_unknown', data: { object: { id: 'cs_x', payment_status: 'paid', amount_total: 1, metadata: {} } } })).body.ignored, true);
});

test('SSO por empresa: configurar, entrar, regras de segurança', async () => {
  const idp = { email: 'sam@co-a.com', sub: 'sub-sam', verified: true };
  let idpUrl;
  const idpSrv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/.well-known')) return res.end(JSON.stringify({ authorization_endpoint: `${idpUrl}/authorize`, token_endpoint: `${idpUrl}/token`, userinfo_endpoint: `${idpUrl}/userinfo` }));
    if (req.url.startsWith('/token')) { req.resume(); return res.end(JSON.stringify({ access_token: 'at' })); }
    if (req.url.startsWith('/userinfo')) return res.end(JSON.stringify({ sub: idp.sub, email: idp.email, email_verified: idp.verified, name: 'Sam' }));
    res.statusCode = 404; res.end('{}');
  });
  await new Promise((r) => idpSrv.listen(0, '127.0.0.1', r));
  idpUrl = `http://127.0.0.1:${idpSrv.address().port}`;
  const slug = slugOf(T.a);
  assert.equal((await call('/sso/settings', 'PUT', { issuer: idpUrl, client_id: 'cid', client_secret: 'csecret', enabled: true }, T.a)).status, 402, 'SSO é Enterprise');
  await call('/plan', 'PUT', { plan: 'enterprise', payroll: false }, T.a);
  assert.equal((await call('/sso/settings', 'PUT', { enabled: true }, T.a)).status, 400, 'não liga sem preencher');
  const saved = await call('/sso/settings', 'PUT', { issuer: idpUrl, client_id: 'cid', client_secret: 'csecret', domains: 'co-a.com', enabled: true }, T.a);
  assert.equal(saved.status, 200, saved.text); assert.equal(saved.body.has_secret, true); assert.ok(!('client_secret' in saved.body));
  const stored = tenants.inTenant(slug, () => get("SELECT value FROM settings WHERE key='sso_client_secret'").value);
  assert.match(stored, /^v1:/); assert.ok(!stored.includes('csecret'), 'o segredo fica criptografado');
  const u = await call('/users', 'POST', { name: 'Sam', email: 'sam@co-a.com', password: 'senha1234', role: 'accountant' }, T.a);
  assert.equal(u.status, 200, u.text);
  const start = await call(`/sso/start?email=${encodeURIComponent('sam@co-a.com')}`);
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin, idpUrl); assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://app.fluxo.test/api/sso/callback');
  const state = loc.searchParams.get('state');
  const cb = (st, code = 'c') => call(`/sso/callback?code=${code}&state=${encodeURIComponent(st)}`);
  const ok = await cb(state);
  assert.equal(ok.status, 302);
  const dest = ok.headers.get('location');
  assert.match(dest, new RegExp(`^https://app\\.fluxo\\.test/#sso_token=${slug}\\.`));
  const tk = dest.split('#sso_token=')[1];
  const me = await call('/me', 'GET', undefined, tk);
  assert.equal(me.status, 200); assert.equal(me.body.email, 'sam@co-a.com');
  // regras
  const bad = async (st) => (await cb(st)).headers.get('location');
  assert.match(await bad('garbage'), /sso_error=/);
  idp.sub = 'someone-else';
  assert.match(await bad(state), /sso_error=.*different%20identity/);
  idp.sub = 'sub-sam'; idp.verified = false;
  assert.match(await bad(state), /sso_error=.*not%20verified/);
  idp.verified = true; idp.email = 'other@co-a.com';
  assert.match(await bad(state), /sso_error=.*different%20email/);
  idp.email = 'sam@co-a.com';
  // domínio não permitido
  await call('/sso/settings', 'PUT', { domains: 'other.com' }, T.a);
  assert.match(await bad(state), /sso_error=.*domain/);
  await call('/sso/settings', 'PUT', { domains: '' }, T.a);
  // usuário desativado e e-mails sem conta: mesma mensagem genérica, sem revelar nada
  const unknown = await call(`/sso/start?email=${encodeURIComponent('nobody@nowhere.com')}`);
  const noSso = await call(`/sso/start?email=${encodeURIComponent('b@x.com')}`);
  assert.equal(unknown.headers.get('location'), noSso.headers.get('location'));
  assert.match(unknown.headers.get('location'), /sso_error=Single%20sign-on%20is%20not%20set%20up/);
  // sem Enterprise o login único para
  await call('/plan', 'PUT', { plan: 'business', payroll: false }, T.a);
  assert.match((await call(`/sso/start?email=${encodeURIComponent('sam@co-a.com')}`)).headers.get('location'), /sso_error=/);
  idpSrv.close();
});

test.after(() => { server.close(); mock.close(); setTimeout(() => process.exit(0), 100).unref(); });
