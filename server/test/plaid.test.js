import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

/* ---------- simulador da API do Plaid ---------- */
const calls = [];
const state = { pages: [], remove: [], accountsFail: null };
const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KID = 'test-key-1';
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const body = b ? JSON.parse(b) : {}; calls.push({ path: req.url, body, headers: req.headers });
    const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url === '/link/token/create') return send(200, { link_token: 'link-sandbox-123', expiration: 'x' });
    if (req.url === '/item/public_token/exchange') return send(200, { access_token: 'access-sandbox-SECRET-TOKEN', item_id: 'item-1' });
    if (req.url === '/accounts/get') {
      if (state.accountsFail) return send(400, { error_type: 'ITEM_ERROR', error_code: state.accountsFail, error_message: 'login required' });
      return send(200, { accounts: [
        { account_id: 'a-chk', name: 'Checking', official_name: 'Plaid Checking', mask: '0000', type: 'depository', subtype: 'checking', balances: { current: 1500.5, available: 1400, iso_currency_code: 'USD' } },
        { account_id: 'a-cc', name: 'Credit Card', mask: '3333', type: 'credit', subtype: 'credit card', balances: { current: 410.25, available: null, iso_currency_code: 'USD' } },
      ] });
    }
    if (req.url === '/transactions/sync') { const page = state.pages.shift() || { added: [], modified: [], removed: [], next_cursor: body.cursor || 'c0', has_more: false }; return send(200, page); }
    if (req.url === '/item/remove') { state.remove.push(body.access_token); return send(200, { request_id: 'r' }); }
    if (req.url === '/webhook_verification_key/get') return send(200, { key: { ...kp.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' } });
    send(404, { error_code: 'NOT_FOUND', error_message: req.url });
  });
});
await new Promise((r) => mock.listen(0, r));
process.env.FLUXO_DB = ':memory:';
process.env.PLAID_CLIENT_ID = 'cid'; process.env.PLAID_SECRET = 'sec'; process.env.PLAID_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

const { get, all, insert } = await import('../src/db.js');
const plaid = await import('../src/plaid.js');
const acc = await import('../src/accounting.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const t = acc.today();
const tx = (id, account_id, date, name, amount, primary, extra = {}) => ({ transaction_id: id, account_id, date, name, merchant_name: extra.merchant || name, amount, pending: !!extra.pending, iso_currency_code: 'USD', personal_finance_category: { primary, detailed: extra.detailed || primary } });

test('configuração e login', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'essentials', lang: 'en' }, '');
  token = s.body.token; assert.equal(s.status, 200);
  const o = await call('/plaid/overview'); assert.equal(o.status, 200);
  assert.equal(o.body.mode, 'live'); assert.equal(o.body.limit, 2);
});

test('plano Starter não tem conexão bancária', async () => {
  await call('/plan', 'PUT', { plan: 'starter' });
  assert.equal((await call('/plaid/overview')).status, 402);
  await call('/plan', 'PUT', { plan: 'essentials' });
});

test('link token é criado com as credenciais, sem expor o segredo ao navegador', async () => {
  const r = await call('/plaid/link-token', 'POST', {});
  assert.equal(r.body.link_token, 'link-sandbox-123');
  const c = calls.find((x) => x.path === '/link/token/create');
  assert.deepEqual(c.body.products, ['transactions']); assert.deepEqual(c.body.country_codes, ['US']);
  assert.equal(c.headers['plaid-secret'], 'sec');
  assert.ok(!JSON.stringify(r.body).includes('sec"'));
});

test('troca o public_token, guarda o access_token criptografado e sincroniza com paginação', async () => {
  state.pages = [
    { added: [tx('t1', 'a-chk', t, 'ACH DEPOSIT BRIGHTSIDE', -2500, 'INCOME', { merchant: 'Brightside Dental' }), tx('t2', 'a-chk', t, 'UBER 063015', 18.4, 'TRANSPORTATION', { merchant: 'Uber', detailed: 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES' })], modified: [], removed: [], next_cursor: 'cur1', has_more: true },
    { added: [tx('t3', 'a-cc', t, 'STARBUCKS', 6.5, 'FOOD_AND_DRINK', { merchant: 'Starbucks' }), tx('t4', 'a-chk', t, 'PENDING STORE', 40, 'GENERAL_MERCHANDISE', { pending: true })], modified: [], removed: [], next_cursor: 'cur2', has_more: false },
  ];
  const r = await call('/plaid/exchange', 'POST', { public_token: 'public-sandbox-xyz', institution: { name: 'First Platypus Bank', institution_id: 'ins_1' } });
  assert.equal(r.status, 200); assert.equal(r.body.institution_name, 'First Platypus Bank');
  const row = get('SELECT * FROM plaid_items WHERE item_id=?', 'item-1');
  assert.ok(!row.access_token_enc.includes('SECRET-TOKEN'), 'o token não pode ficar em texto puro');
  assert.equal(row.cursor, 'cur2');
  assert.equal(get('SELECT COUNT(*) AS n FROM plaid_transactions').n, 4);           // as 2 páginas foram aplicadas
  assert.equal(get("SELECT amount FROM plaid_transactions WHERE transaction_id='t2'").amount, 1840);   // Plaid: positivo = saída
  assert.equal(r.body.accounts.length, 2);
  assert.equal(r.body.accounts.find((a) => a.account_id === 'a-chk').balance_current, 150050);
  // a segunda chamada de sync enviou o cursor da primeira página
  const syncs = calls.filter((c) => c.path === '/transactions/sync');
  assert.equal(syncs[1].body.cursor, 'cur1');
});

test('vincular conta cria a conta contábil e leva só transações postadas para a conciliação', () => {
  const pa = get("SELECT id FROM plaid_accounts WHERE account_id='a-chk'");
  plaid.linkAccount(pa.id, { create: true });
  const linked = get("SELECT linked_account_id FROM plaid_accounts WHERE account_id='a-chk'").linked_account_id;
  const a = get('SELECT * FROM accounts WHERE id=?', linked);
  assert.equal(a.subtype, 'bank'); assert.ok(a.name.includes('First Platypus Bank'));
  const rows = all("SELECT * FROM bank_txns WHERE account_id=? ORDER BY id", linked);
  assert.equal(rows.length, 2);                                                       // pendente (t4) ficou de fora
  const deposit = rows.find((r) => r.description === 'Brightside Dental'), uber = rows.find((r) => r.description === 'Uber');
  assert.equal(deposit.amount, 250000); assert.equal(uber.amount, -1840);              // sinais do Fluxo: entrada +, saída −
  assert.equal(uber.suggested_account_id, get("SELECT id FROM accounts WHERE code='6600'").id);   // categoria do banco vira sugestão
  assert.equal(uber.suggestion_source, 'category');
  // importar de novo não duplica
  plaid.pushToBookkeeping(); plaid.linkAccount(pa.id, { linked_account_id: linked });
  assert.equal(all("SELECT 1 FROM bank_txns WHERE account_id=?", linked).length, 2);
  // cartão de crédito vira passivo
  const cc = get("SELECT id FROM plaid_accounts WHERE account_id='a-cc'");
  plaid.linkAccount(cc.id, { create: true });
  assert.equal(get('SELECT a.type, a.subtype FROM plaid_accounts p JOIN accounts a ON a.id=p.linked_account_id WHERE p.account_id=?', 'a-cc').subtype, 'credit_card');
  assert.throws(() => plaid.linkAccount(cc.id, { linked_account_id: linked }), /already linked/);
});

test('sync incremental: modificadas, removidas e pendente que vira postada', async () => {
  state.pages = [{ added: [tx('t5', 'a-chk', t, 'AMAZON', 64, 'GENERAL_MERCHANDISE', { merchant: 'Amazon' })], modified: [tx('t4', 'a-chk', t, 'PENDING STORE', 41, 'GENERAL_MERCHANDISE', { merchant: 'Corner Store' })], removed: [{ transaction_id: 't3' }], next_cursor: 'cur3', has_more: false }];
  const r = await call('/plaid/sync', 'POST', { item_id: 'item-1' });
  assert.equal(r.status, 200);
  assert.equal(get("SELECT COUNT(*) AS n FROM plaid_transactions WHERE transaction_id='t3'").n, 0);   // removida
  assert.equal(get("SELECT pending FROM plaid_transactions WHERE transaction_id='t4'").pending, 0);
  const linked = get("SELECT linked_account_id FROM plaid_accounts WHERE account_id='a-chk'").linked_account_id;
  assert.equal(all('SELECT 1 FROM bank_txns WHERE account_id=?', linked).length, 4);                    // t1, t2, t4(agora postada) e t5
  assert.equal(get('SELECT cursor FROM plaid_items').cursor, 'cur3');
  // a transação removida que ainda estava pendente na fila some também
  const ccLinked = get("SELECT linked_account_id FROM plaid_accounts WHERE account_id='a-cc'").linked_account_id;
  assert.equal(all("SELECT 1 FROM bank_txns WHERE account_id=? AND status='pending'", ccLinked).length, 0);
});

test('visão geral: saldo, quem pagou, gastos por categoria e histórico', async () => {
  const i = await call('/plaid/insights'); assert.equal(i.status, 200);
  const d = i.body;
  assert.equal(d.balance, 150050); assert.equal(d.creditOwed, 41025);
  assert.equal(d.moneyIn, 250000); assert.equal(d.moneyOut, 1840 + 6400 + 4100);        // t2 + t5 + t4 (t3 foi removida)
  assert.deepEqual(d.payers.map((p) => [p.name, p.total]), [['Brightside Dental', 250000]]);
  assert.ok(d.byCategory.find((c) => c.category === 'TRANSPORTATION'));
  assert.equal(d.byCategory[0].category, 'GENERAL_MERCHANDISE');                         // maior gasto primeiro
  assert.ok(d.topMerchants.length >= 2);
  const all1 = (await call('/plaid/activity')).body;
  assert.equal(all1.length, 4); assert.ok(all1.find((x) => x.name === 'ACH DEPOSIT BRIGHTSIDE').amount === 250000);   // entrada positiva na visão do usuário
  assert.equal((await call('/plaid/activity?direction=in')).body.length, 1);
  assert.equal((await call('/plaid/activity?q=uber')).body.length, 1);
  assert.equal((await call('/plaid/activity?category=TRANSPORTATION')).body.length, 1);
  assert.equal((await call(`/plaid/activity?from=${acc.addDays(t, 5)}`)).body.length, 0);
});

test('transferências entre contas não contam como receita nem gasto', async () => {
  state.pages = [{ added: [tx('t6', 'a-chk', t, 'TRANSFER TO SAVINGS', 5000, 'TRANSFER_OUT'), tx('t7', 'a-chk', t, 'CARD PAYMENT', 300, 'LOAN_PAYMENTS')], modified: [], removed: [], next_cursor: 'cur4', has_more: false }];
  await call('/plaid/sync', 'POST', { item_id: 'item-1' });
  const d = (await call('/plaid/insights')).body;
  assert.equal(d.moneyOut, 1840 + 6400 + 4100);
});

test('limite de conexões do plano', async () => {
  assert.equal((await call('/plaid/exchange', 'POST', { public_token: 'p2' })).status, 200);   // 2ª conexão (Essentials permite 2); mesmo item_id reaproveitado
  const r = await plaid.exchangePublicToken({ public_token: 'p3' }, null).then(() => 'ok', (e) => e);
  // o simulador sempre devolve o mesmo item_id; força uma terceira conexão distinta
  insert("INSERT INTO plaid_items(item_id,access_token_enc,institution_name) VALUES('item-2','x','B')");
  insert("INSERT INTO plaid_items(item_id,access_token_enc,institution_name) VALUES('item-3','x','C')");
  const over = await call('/plaid/exchange', 'POST', { public_token: 'p4' });
  assert.equal(over.status, 402); assert.equal(over.body.feature, 'bank_connections');
  assert.ok(r);
  all('SELECT item_id FROM plaid_items').filter((i) => i.item_id !== 'item-1').forEach((i) => get('SELECT 1') && insert("DELETE FROM plaid_items WHERE item_id=?", i.item_id));
});

test('login expirado marca a conexão para reautenticar', async () => {
  state.accountsFail = 'ITEM_LOGIN_REQUIRED';
  await assert.rejects(() => plaid.syncItem('item-1'));
  assert.equal(get('SELECT status FROM plaid_items WHERE item_id=?', 'item-1').status, 'login_required');
  state.accountsFail = null;
  await call('/plaid/sync', 'POST', { item_id: 'item-1' });
  assert.equal(get('SELECT status FROM plaid_items WHERE item_id=?', 'item-1').status, 'ok');
});

/* ---------- webhook com assinatura ES256 real ---------- */
const signHook = (raw, { alg = 'ES256', iat = Math.floor(Date.now() / 1000), hash } = {}) => {
  const h = Buffer.from(JSON.stringify({ alg, kid: KID, typ: 'JWT' })).toString('base64url');
  const c = Buffer.from(JSON.stringify({ iat, request_body_sha256: hash ?? crypto.createHash('sha256').update(raw).digest('hex') })).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(`${h}.${c}`), { key: kp.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${h}.${c}.${sig}`;
};
const hook = async (payload, jwt) => { const raw = JSON.stringify(payload); return call('/plaid/webhook', 'POST', raw, '', jwt === null ? {} : { 'plaid-verification': jwt ?? signHook(raw) }); };

test('webhook: assinatura válida dispara sync; inválidas são recusadas', async () => {
  state.pages = [{ added: [tx('t8', 'a-chk', t, 'NEW COFFEE', 4, 'FOOD_AND_DRINK')], modified: [], removed: [], next_cursor: 'cur5', has_more: false }];
  const ok = await hook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' });
  assert.equal(ok.status, 200); assert.equal(get("SELECT COUNT(*) AS n FROM plaid_transactions WHERE transaction_id='t8'").n, 1);
  assert.equal((await hook({ webhook_type: 'TRANSACTIONS', item_id: 'item-1' }, null)).status, 401);                 // sem assinatura
  const raw = JSON.stringify({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-1' });
  assert.equal((await call('/plaid/webhook', 'POST', raw + ' ', '', { 'plaid-verification': signHook(raw) })).status, 401);  // corpo adulterado
  assert.equal((await hook({ a: 1 }, signHook(JSON.stringify({ a: 1 }), { iat: Math.floor(Date.now() / 1000) - 1000 }))).status, 401);   // expirada
  assert.equal((await hook({ a: 1 }, signHook(JSON.stringify({ a: 1 }), { alg: 'HS256' }))).status, 401);               // algoritmo errado
  const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const forged = (() => { const raw2 = JSON.stringify({ a: 2 }); const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: KID })).toString('base64url'); const c = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000), request_body_sha256: crypto.createHash('sha256').update(raw2).digest('hex') })).toString('base64url'); return `${h}.${c}.${crypto.sign('sha256', Buffer.from(`${h}.${c}`), { key: other.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; })();
  assert.equal((await call('/plaid/webhook', 'POST', JSON.stringify({ a: 2 }), '', { 'plaid-verification': forged })).status, 401);   // chave errada
});

test('webhook de erro do item marca reautenticação', async () => {
  await hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'item-1', error: { error_code: 'ITEM_LOGIN_REQUIRED' } });
  assert.equal(get('SELECT status FROM plaid_items WHERE item_id=?', 'item-1').status, 'login_required');
  await hook({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-1' });
  assert.equal(get('SELECT status FROM plaid_items WHERE item_id=?', 'item-1').status, 'ok');
  assert.deepEqual((await hook({ webhook_type: 'ITEM', webhook_code: 'ERROR', item_id: 'desconhecido' })).body, { ignored: true });
});

test('desconectar remove a conexão e os dados do banco, mas preserva o que já foi para a contabilidade', async () => {
  const before = get('SELECT COUNT(*) AS n FROM bank_txns').n;
  assert.equal((await call('/plaid/items/item-1', 'DELETE')).status, 200);
  assert.deepEqual(state.remove, ['access-sandbox-SECRET-TOKEN']);                 // o Plaid foi avisado com o token descriptografado
  assert.equal(get('SELECT COUNT(*) AS n FROM plaid_items').n, 0); assert.equal(get('SELECT COUNT(*) AS n FROM plaid_transactions').n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM bank_txns').n, before);
});

test.after(() => { server.close(); mock.close(); });
