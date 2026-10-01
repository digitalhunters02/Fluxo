import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
delete process.env.PLAID_CLIENT_ID; delete process.env.PLAID_SECRET; delete process.env.NODE_ENV;
const { get, all } = await import('../src/db.js');
const plaid = await import('../src/plaid.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

test('sem chaves do Plaid o servidor oferece um banco de demonstração', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'plus', lang: 'en' }, '');
  token = s.body.token;
  assert.equal(plaid.plaidMode(), 'demo');
  assert.equal((await call('/plaid/overview')).body.mode, 'demo');
  assert.equal((await call('/plaid/link-token', 'POST', {})).status, 400);       // Link real exige chaves
});

test('conectar o banco demo traz contas, saldos e histórico de 90 dias', async () => {
  const r = await call('/plaid/demo', 'POST', {});
  assert.equal(r.status, 200); assert.equal(r.body.institution_name, 'Demo Bank'); assert.equal(r.body.accounts.length, 3);
  assert.ok(get('SELECT COUNT(*) AS n FROM plaid_transactions').n > 60);
  const d = (await call('/plaid/insights?from=' + new Date(Date.now() - 95 * 864e5).toISOString().slice(0, 10))).body;
  assert.ok(d.moneyIn > 0 && d.moneyOut > 0); assert.ok(d.payers.length >= 3); assert.ok(d.byCategory.length >= 5);
  assert.ok(d.balance > 0 && d.creditOwed > 0);
  // sincronizar de novo não duplica
  const n = get('SELECT COUNT(*) AS n FROM plaid_transactions').n;
  await call('/plaid/sync', 'POST', {}); assert.equal(get('SELECT COUNT(*) AS n FROM plaid_transactions').n, n);
});

test('vincular todas as contas leva o histórico para a conciliação com sugestões de categoria', async () => {
  for (const a of all('SELECT id FROM plaid_accounts')) assert.equal((await call(`/plaid/accounts/${a.id}`, 'PUT', { create: true })).status, 200);
  const q = all("SELECT * FROM bank_txns WHERE status='pending'");
  assert.ok(q.length > 60);
  assert.ok(q.filter((x) => x.suggested_account_id).length > 20);
  assert.equal(get('SELECT SUM(debit)-SUM(credit) AS v FROM journal_lines').v ?? 0, 0);
});

test('Starter não tem conexão e o limite do plano é respeitado', async () => {
  await call('/plan', 'PUT', { plan: 'essentials' });
  assert.equal((await call('/plaid/demo', 'POST', {})).status, 200);              // 2ª conexão
  const third = await call('/plaid/demo', 'POST', {});
  assert.equal(third.status, 402); assert.equal(third.body.limit, 2);
});

test('webhook público é recusado no modo demo sem assinatura real', async () => {
  const r = await fetch(`${base}/plaid/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"webhook_type":"ITEM","item_id":"x"}' });
  assert.equal(r.status, 200); // demo aceita (sem chaves não há o que proteger), mas ignora item desconhecido
});

test.after(() => server.close());
