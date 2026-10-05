import test from 'node:test';
import assert from 'node:assert/strict';

const KEY = 'k'.repeat(40);
process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1';
process.env.HARBOR_API_URL = 'https://harbor-api.example.test';
const harborCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://harbor-api.example.test')) { harborCalls.push({ url: String(url), init }); return { ok: true, status: 201 }; }
  return realFetch(url, init);
};
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, method = 'GET', body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const signup = (company, email) => call('/setup', 'POST', { company_name: company, name: 'Owner', email, password: 'senha-1234', plan: 'free' });
test.after(() => server.close());

test('admin-summary: 503 without the key configured, 401 wrong/missing key', async () => {
  delete process.env.ADMIN_SUMMARY_KEY;
  assert.equal((await call('/admin-summary', 'GET', undefined, { 'x-admin-key': KEY })).status, 503);
  process.env.ADMIN_SUMMARY_KEY = KEY;
  assert.equal((await call('/admin-summary')).status, 401);
  assert.equal((await call('/admin-summary', 'GET', undefined, { 'x-admin-key': 'nope' })).status, 401);
});

test('admin-summary: lists every company with plan/status/amount; signup posts a Harbor lead (no password)', async () => {
  process.env.ADMIN_SUMMARY_KEY = KEY;
  assert.equal((await signup('Acme A', 'a@x.com')).status, 200);
  assert.equal((await signup('Acme B', 'b@x.com')).status, 200);
  assert.equal((await signup('Dup', 'a@x.com')).status, 409);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(harborCalls.length, 2);
  const c = harborCalls[0];
  assert.equal(c.url, 'https://harbor-api.example.test/api/public/leads');
  assert.equal(c.init.headers['X-Capture-Key'], KEY);
  const body = JSON.parse(c.init.body);
  assert.equal(body.product, 'Fluxo');
  assert.equal(body.source, 'Trial signup');
  assert.equal(body.email, 'a@x.com');
  assert.equal(body.company, 'Acme A');
  assert.ok(!c.init.body.includes('senha-1234'));

  const r = await call('/admin-summary', 'GET', undefined, { 'x-admin-key': KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.subscribers.length, 2);
  const a = r.body.subscribers.find((s) => s.email === 'a@x.com');
  assert.equal(a.company, 'Acme A');
  assert.equal(a.plan, 'free');
  assert.equal(a.amount, 0);
  assert.ok('billingEnabled' in r.body);
});
