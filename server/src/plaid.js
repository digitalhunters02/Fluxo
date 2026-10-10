// Conexão bancária via Plaid: saldos, histórico, quem pagou, gastos por categoria. Também há um provedor "demo" sem chaves.
import crypto from 'node:crypto';
import { all, get, run, insert, tx, getSetting } from './db.js';
import { link as linkTenant } from './tenants.js';
import { HttpError, today, addDays, isDate, getAccount } from './accounting.js';
import { encrypt, decrypt } from './secure.js';
import { importTxns, isBankAccount } from './banking.js';
import { limitFor } from './plans.js';

const bad = (m) => new HttpError(400, m);
const toCents = (v) => Math.round(Number(v) * 100);

/* --------------------------------- configuração --------------------------------- */
const env = () => process.env;
export const plaidConfigured = () => !!(env().PLAID_CLIENT_ID && env().PLAID_SECRET);
/** Sem chaves, o modo demo fica disponível fora de produção (ou com PLAID_DEMO=1). */
export const demoAllowed = () => env().PLAID_DEMO === '1' || (!plaidConfigured() && env().NODE_ENV !== 'production');
const baseUrl = () => env().PLAID_BASE_URL || (env().PLAID_ENV === 'production' ? 'https://production.plaid.com' : 'https://sandbox.plaid.com');
export const plaidMode = () => (plaidConfigured() ? 'live' : demoAllowed() ? 'demo' : 'off');

async function plaid(path, body = {}) {
  const res = await fetch(baseUrl() + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'PLAID-CLIENT-ID': env().PLAID_CLIENT_ID, 'PLAID-SECRET': env().PLAID_SECRET },
    body: JSON.stringify({ client_id: env().PLAID_CLIENT_ID, secret: env().PLAID_SECRET, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new HttpError(res.status === 400 ? 400 : 502, data.error_message || data.display_message || 'The bank connection service returned an error', { plaid_error: data.error_code || '' });
    e.plaidCode = data.error_code || '';
    throw e;
  }
  return data;
}

/* --------------------------------- provedor demo --------------------------------- */
// Gera um banco fictício determinístico (3 contas e ~90 dias de movimento) para testar a experiência sem chaves.
function prng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
const DEMO_PAYERS = ['Brightside Dental', 'Harbor Coffee Co.', 'Summit Fitness', 'Maple Street Bakery', 'Northwind Realty'];
const DEMO_SPEND = [
  ['Cedar Properties', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_RENT', 3200, 1], ['CloudNine Hosting', 'GENERAL_SERVICES', 'GENERAL_SERVICES_OTHER_GENERAL_SERVICES', 480, 1],
  ['AdBoost Marketing', 'GENERAL_SERVICES', 'GENERAL_SERVICES_ADVERTISING_AND_MARKETING', 1200, 1], ['City Power & Light', 'RENT_AND_UTILITIES', 'RENT_AND_UTILITIES_GAS_AND_ELECTRICITY', 310, 1],
  ['Office Depot', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_OFFICE_SUPPLIES', 86, 3], ['Uber', 'TRANSPORTATION', 'TRANSPORTATION_TAXIS_AND_RIDE_SHARES', 34, 4],
  ['Starbucks', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_COFFEE', 12, 9], ['Chipotle', 'FOOD_AND_DRINK', 'FOOD_AND_DRINK_FAST_FOOD', 24, 6], ['Delta Air Lines', 'TRAVEL', 'TRAVEL_FLIGHTS', 420, 1],
  ['Bank service fee', 'BANK_FEES', 'BANK_FEES_ACCOUNT_FEES', 24.9, 1], ['Amazon', 'GENERAL_MERCHANDISE', 'GENERAL_MERCHANDISE_ONLINE_MARKETPLACES', 64, 4],
];
function demoData(itemSeed) {
  const rand = prng(itemSeed);
  const accounts = [
    { account_id: `demo-chk-${itemSeed}`, name: 'Business Checking', official_name: 'Demo Bank Business Checking', mask: '4821', type: 'depository', subtype: 'checking', balances: { current: 18432.55, available: 18102.55, iso_currency_code: 'USD' } },
    { account_id: `demo-sav-${itemSeed}`, name: 'Business Savings', official_name: 'Demo Bank Savings', mask: '9910', type: 'depository', subtype: 'savings', balances: { current: 25000, available: 25000, iso_currency_code: 'USD' } },
    { account_id: `demo-cc-${itemSeed}`, name: 'Business Credit Card', official_name: 'Demo Bank Platinum Card', mask: '0044', type: 'credit', subtype: 'credit card', balances: { current: 1284.1, available: 8715.9, iso_currency_code: 'USD' } },
  ];
  const txns = [];
  let n = 0;
  const push = (account, date, name, merchant, amount, primary, detailed) => txns.push({ transaction_id: `demo-${itemSeed}-${n++}`, account_id: account.account_id, date, name, merchant_name: merchant, amount, pending: false, iso_currency_code: 'USD', personal_finance_category: { primary, detailed } });
  for (let d = 90; d >= 0; d--) {
    const date = addDays(today(), -d), dom = Number(date.slice(8, 10));
    if (d % 4 === 1) { const payer = DEMO_PAYERS[Math.floor(rand() * DEMO_PAYERS.length)]; push(accounts[0], date, `ACH DEPOSIT ${payer.toUpperCase()}`, payer, -Math.round((900 + rand() * 4200) * 100) / 100, 'INCOME', 'INCOME_OTHER_INCOME'); }
    for (const [merchant, primary, detailed, base, every] of DEMO_SPEND) {
      const monthly = every === 1;
      if (monthly ? dom === 3 + (merchant.length % 20) : (d + merchant.length) % (every * 2) === 0) {
        const card = ['FOOD_AND_DRINK', 'TRANSPORTATION', 'GENERAL_MERCHANDISE', 'TRAVEL'].includes(primary);
        push(card ? accounts[2] : accounts[0], date, merchant.toUpperCase(), merchant, Math.round(base * (0.85 + rand() * 0.3) * 100) / 100, primary, detailed);
      }
    }
  }
  return { accounts, txns };
}
const demoSeedOf = (accessToken) => Number(String(accessToken).replace(/\D/g, '')) || 1;

/* ----------------------------------- chamadas ----------------------------------- */
function client(item) {
  const demo = !!item?.demo;
  return {
    demo,
    async accounts(token) {
      if (demo) return { accounts: demoData(demoSeedOf(token)).accounts };
      return plaid('/accounts/get', { access_token: token });
    },
    async sync(token, cursor) {
      if (demo) {
        if (cursor) return { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false };
        return { added: demoData(demoSeedOf(token)).txns, modified: [], removed: [], next_cursor: 'demo-done', has_more: false };
      }
      return plaid('/transactions/sync', { access_token: token, ...(cursor ? { cursor } : {}), count: 500 });
    },
    async remove(token) { if (!demo) await plaid('/item/remove', { access_token: token }); },
  };
}

export async function createLinkToken(user, itemId = null) {
  if (plaidMode() !== 'live') throw bad('Bank connections are not configured on this server');
  const body = { client_name: getSetting('company_name', 'Fluxo'), language: 'en', country_codes: ['US'], user: { client_user_id: `fluxo-${user.id}` } };
  if (itemId) { // modo de atualização: reautenticar uma conexão existente
    const it = get('SELECT * FROM plaid_items WHERE item_id=?', itemId);
    if (!it) throw new HttpError(404, 'Connection not found');
    body.access_token = decrypt(it.access_token_enc);
  } else body.products = ['transactions'];
  if (env().PLAID_WEBHOOK_URL) body.webhook = env().PLAID_WEBHOOK_URL;
  // Sem isto o Plaid traz só 90 dias de histórico. Pedimos até 24 meses (PLAID_HISTORY_DAYS, 30 a 730);
  // vale para bancos conectados depois desta mudança — o valor é fixado na conexão.
  if (!itemId) {
    const days = Math.min(730, Math.max(30, parseInt(env().PLAID_HISTORY_DAYS || '730', 10) || 730));
    try { return (await plaid('/link/token/create', { ...body, transactions: { days_requested: days } })).link_token; }
    catch (e) { if (e.status !== 400) throw e; /* recusado: conecta com o padrão do Plaid */ }
  }
  return (await plaid('/link/token/create', body)).link_token;
}

const connectionCount = () => get('SELECT COUNT(*) AS n FROM plaid_items').n;
function assertCanAddConnection() {
  const limit = limitFor('bank_connections');
  if (connectionCount() >= limit) throw new HttpError(402, 'Your plan reached its bank connection limit', { feature: 'bank_connections', limit });
}

function storeItem({ item_id, access_token, institution_name, institution_id, demo }, user) {
  linkTenant('plaid_item', item_id);
  const existing = get('SELECT id FROM plaid_items WHERE item_id=?', item_id);
  if (existing) { run('UPDATE plaid_items SET access_token_enc=?, status=\'ok\', error_code=\'\' WHERE item_id=?', encrypt(access_token), item_id); return item_id; }
  insert('INSERT INTO plaid_items(item_id,access_token_enc,institution_name,institution_id,demo,created_by) VALUES(?,?,?,?,?,?)', item_id, encrypt(access_token), institution_name || '', institution_id || '', demo ? 1 : 0, user?.id ?? null);
  return item_id;
}

/** Troca o public_token do Plaid Link por um access_token, guarda a conexão e faz a primeira sincronização. */
export async function exchangePublicToken({ public_token, institution }, user) {
  if (plaidMode() !== 'live') throw bad('Bank connections are not configured on this server');
  assertCanAddConnection();
  if (!public_token) throw bad('Missing bank connection token');
  const ex = await plaid('/item/public_token/exchange', { public_token });
  const itemId = storeItem({ item_id: ex.item_id, access_token: ex.access_token, institution_name: institution?.name, institution_id: institution?.institution_id }, user);
  await syncItem(itemId);
  return connectionView(itemId);
}

export async function connectDemo(user) {
  if (!demoAllowed()) throw bad('Demo bank is not available');
  assertCanAddConnection();
  const seed = connectionCount() + 1;
  const itemId = storeItem({ item_id: `demo-item-${seed}-${crypto.randomBytes(3).toString('hex')}`, access_token: `demo-token-${seed}`, institution_name: 'Demo Bank', institution_id: 'ins_demo', demo: true }, user);
  await syncItem(itemId);
  return connectionView(itemId);
}

/* ----------------------------------- sincronização ----------------------------------- */
const cat = (t) => ({ primary: t.personal_finance_category?.primary || '', detailed: t.personal_finance_category?.detailed || '' });

export async function syncItem(itemId) {
  const item = get('SELECT * FROM plaid_items WHERE item_id=?', itemId);
  if (!item) throw new HttpError(404, 'Connection not found');
  const token = decrypt(item.access_token_enc), c = client(item);
  try {
    // contas e saldos
    const acc = await c.accounts(token);
    for (const a of acc.accounts) {
      const cur = a.balances?.current, avail = a.balances?.available;
      const vals = [item.item_id, a.account_id, a.name, a.official_name || '', a.mask || '', a.type || '', a.subtype || '', cur == null ? null : toCents(cur), avail == null ? null : toCents(avail), a.balances?.iso_currency_code || 'USD', new Date().toISOString()];
      if (get('SELECT 1 FROM plaid_accounts WHERE account_id=?', a.account_id)) {
        run('UPDATE plaid_accounts SET name=?, official_name=?, mask=?, type=?, subtype=?, balance_current=?, balance_available=?, currency=?, balance_at=? WHERE account_id=?', ...vals.slice(2), a.account_id);
      } else run('INSERT INTO plaid_accounts(item_id,account_id,name,official_name,mask,type,subtype,balance_current,balance_available,currency,balance_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', ...vals);
    }
    // transações (cursor só é gravado depois de aplicar tudo)
    let cursor = item.cursor || null, more = true, pages = 0, added = 0;
    const batches = [];
    while (more && pages++ < 40) {
      const r = await c.sync(token, cursor);
      batches.push(r); cursor = r.next_cursor; more = r.has_more;
    }
    tx(() => {
      for (const r of batches) {
        for (const t of [...r.added, ...(r.modified || [])]) {
          const k = cat(t);
          run(`INSERT INTO plaid_transactions(transaction_id,account_id,date,name,merchant,amount,category_primary,category_detailed,pending,currency) VALUES(?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(transaction_id) DO UPDATE SET date=excluded.date, name=excluded.name, merchant=excluded.merchant, amount=excluded.amount, category_primary=excluded.category_primary, category_detailed=excluded.category_detailed, pending=excluded.pending`,
          t.transaction_id, t.account_id, t.date, t.name || t.merchant_name || '', t.merchant_name || '', toCents(t.amount), k.primary, k.detailed, t.pending ? 1 : 0, t.iso_currency_code || 'USD');
          added++;
        }
        for (const rm of r.removed || []) {
          run('DELETE FROM plaid_transactions WHERE transaction_id=?', rm.transaction_id);
          run("DELETE FROM bank_txns WHERE hash=? AND status='pending'", `plaid:${rm.transaction_id}`);
        }
      }
      run('UPDATE plaid_items SET cursor=?, last_sync=?, status=\'ok\', error_code=\'\' WHERE item_id=?', cursor, new Date().toISOString(), item.item_id);
    });
    const imported = pushToBookkeeping(item.item_id);
    return { added, imported };
  } catch (e) {
    if (e.plaidCode === 'ITEM_LOGIN_REQUIRED') run("UPDATE plaid_items SET status='login_required', error_code=? WHERE item_id=?", e.plaidCode, item.item_id);
    else if (e.plaidCode) run("UPDATE plaid_items SET status='error', error_code=? WHERE item_id=?", e.plaidCode, item.item_id);
    throw e;
  }
}

export async function syncAll() {
  const out = [];
  for (const it of all('SELECT item_id FROM plaid_items')) { try { out.push({ item_id: it.item_id, ...(await syncItem(it.item_id)) }); } catch (e) { out.push({ item_id: it.item_id, error: e.message }); } }
  return out;
}

/* ------------------------- integração com a contabilidade ------------------------- */
// Categoria do Plaid -> despesa do plano de contas (apenas sugestão; regras e histórico do usuário têm prioridade).
const CATEGORY_TO_CODE = {
  TRANSPORTATION: '6600', TRAVEL: '6600', RENT_AND_UTILITIES: '6500', RENT_AND_UTILITIES_RENT: '6000', GENERAL_SERVICES: '6400', GENERAL_SERVICES_ADVERTISING_AND_MARKETING: '6200',
  BANK_FEES: '6800', GOVERNMENT_AND_NON_PROFIT: '6900', GENERAL_MERCHANDISE: '6700', FOOD_AND_DRINK: '6990', INCOME: '4900',
};
const suggestionFor = (t) => { const code = CATEGORY_TO_CODE[t.category_detailed] || CATEGORY_TO_CODE[t.category_primary]; return code ? get('SELECT id FROM accounts WHERE code=? AND active=1', code)?.id ?? null : null; };

/** Leva as transações das contas vinculadas para a fila de conciliação (sem duplicar, ignorando pendentes). */
export function pushToBookkeeping(itemId = null) {
  let total = 0;
  const accounts = all(`SELECT pa.* FROM plaid_accounts pa WHERE pa.linked_account_id IS NOT NULL ${itemId ? 'AND pa.item_id=?' : ''}`, ...(itemId ? [itemId] : []));
  for (const pa of accounts) {
    const rows = all('SELECT * FROM plaid_transactions WHERE account_id=? AND pending=0 AND imported=0 ORDER BY date, transaction_id', pa.account_id);
    if (!rows.length) continue;
    const res = importTxns(pa.linked_account_id, rows.map((t) => ({
      date: t.date, description: t.merchant || t.name, amount: -t.amount, external_id: `plaid:${t.transaction_id}`, suggested_account_id: suggestionFor(t),
    })));
    run('UPDATE plaid_transactions SET imported=1 WHERE account_id=? AND pending=0 AND imported=0', pa.account_id);
    total += res.added;
  }
  return total;
}

const nextCode = (type, subtype) => {
  const [lo, hi] = subtype === 'credit_card' ? [2100, 2190] : [1010, 1090];
  for (let c = lo; c <= hi; c++) if (!get('SELECT 1 FROM accounts WHERE code=?', String(c))) return String(c);
  throw bad('No free account code in the bank range');
};

/** Vincula uma conta do banco a uma conta contábil (existente ou nova) e importa o histórico para conciliação. */
export function linkAccount(plaidAccountRowId, { linked_account_id, create }) {
  const pa = get('SELECT * FROM plaid_accounts WHERE id=?', plaidAccountRowId);
  if (!pa) throw new HttpError(404, 'Bank account not found');
  let target = null;
  if (linked_account_id === null || (linked_account_id === undefined && !create)) {
    run('UPDATE plaid_accounts SET linked_account_id=NULL WHERE id=?', pa.id);
    return connectionAccounts();
  }
  if (create) {
    const credit = pa.type === 'credit';
    const name = `${get('SELECT institution_name FROM plaid_items WHERE item_id=?', pa.item_id)?.institution_name || 'Bank'} ${pa.name}${pa.mask ? ` ••${pa.mask}` : ''}`.slice(0, 80);
    const subtype = credit ? 'credit_card' : 'bank';
    const id = insert('INSERT INTO accounts(code,name,type,subtype) VALUES(?,?,?,?)', nextCode(credit ? 'liability' : 'asset', subtype), name, credit ? 'liability' : 'asset', subtype);
    target = getAccount(id);
  } else {
    target = getAccount(linked_account_id);
    if (!isBankAccount(target)) throw bad('The selected account is not a bank or card account');
    if (get('SELECT 1 FROM plaid_accounts WHERE linked_account_id=? AND id<>?', target.id, pa.id)) throw bad('That account is already linked to another bank account');
  }
  tx(() => {
    run('UPDATE plaid_accounts SET linked_account_id=? WHERE id=?', target.id, pa.id);
    run('UPDATE plaid_transactions SET imported=0 WHERE account_id=?', pa.account_id); // reimporta caso a conta tenha sido vinculada de novo
    pushToBookkeeping(pa.item_id);
  });
  return connectionAccounts();
}

export async function removeItem(itemId) {
  const item = get('SELECT * FROM plaid_items WHERE item_id=?', itemId);
  if (!item) throw new HttpError(404, 'Connection not found');
  try { await client(item).remove(decrypt(item.access_token_enc)); } catch { /* segue: a remoção local é o que importa */ }
  tx(() => {
    const ids = all('SELECT account_id FROM plaid_accounts WHERE item_id=?', itemId).map((a) => a.account_id);
    for (const id of ids) run('DELETE FROM plaid_transactions WHERE account_id=?', id);
    run('DELETE FROM plaid_accounts WHERE item_id=?', itemId);
    run('DELETE FROM plaid_items WHERE item_id=?', itemId);
  });
}

/* ------------------------------------- consultas ------------------------------------- */
export function connectionAccounts() {
  return all(`SELECT pa.*, a.name AS linked_name, i.institution_name, i.status AS item_status FROM plaid_accounts pa JOIN plaid_items i ON i.item_id=pa.item_id
    LEFT JOIN accounts a ON a.id=pa.linked_account_id ORDER BY i.institution_name, pa.name`)
    .map((a) => ({ ...a, is_credit: a.type === 'credit' }));
}
export function connectionView(itemId) {
  const item = get('SELECT id,item_id,institution_name,status,error_code,last_sync,demo,created_at FROM plaid_items WHERE item_id=?', itemId);
  return { ...item, accounts: connectionAccounts().filter((a) => a.item_id === itemId) };
}
export function listConnections() {
  const accounts = connectionAccounts();
  return all('SELECT id,item_id,institution_name,status,error_code,last_sync,demo,created_at FROM plaid_items ORDER BY id').map((i) => ({ ...i, accounts: accounts.filter((a) => a.item_id === i.item_id) }));
}

const flt = (q) => {
  const where = ['t.pending=0']; const p = [];
  if (q.from && isDate(q.from)) { where.push('t.date>=?'); p.push(q.from); }
  if (q.to && isDate(q.to)) { where.push('t.date<=?'); p.push(q.to); }
  if (q.account_id) { where.push('t.account_id=?'); p.push(String(q.account_id)); }
  return [where.join(' AND '), p];
};

/** Histórico completo com filtros: conta, categoria, direção (in/out), busca. */
export function activity(q = {}) {
  const [where, p] = flt(q);
  const w = [where];
  if (q.category) { w.push('t.category_primary=?'); p.push(String(q.category)); }
  if (q.direction === 'in') w.push('t.amount<0'); else if (q.direction === 'out') w.push('t.amount>0');
  if (q.q) { w.push('(LOWER(t.name) LIKE ? OR LOWER(t.merchant) LIKE ?)'); const like = `%${String(q.q).toLowerCase()}%`; p.push(like, like); }
  const limit = Math.min(Number(q.limit) || 200, 1000);
  return all(`SELECT t.transaction_id, t.date, t.name, t.merchant, -t.amount AS amount, t.category_primary, t.category_detailed, t.imported, pa.name AS account_name, pa.mask, i.institution_name
    FROM plaid_transactions t JOIN plaid_accounts pa ON pa.account_id=t.account_id JOIN plaid_items i ON i.item_id=pa.item_id WHERE ${w.join(' AND ')} ORDER BY t.date DESC, t.transaction_id LIMIT ${limit}`, ...p);
}

/** Resumo do período: entradas, saídas, gastos por categoria, maiores estabelecimentos e quem pagou (por pagador). */
export function insights(q = {}) {
  const from = q.from && isDate(q.from) ? q.from : addDays(today(), -29), to = q.to && isDate(q.to) ? q.to : today();
  const [where, p] = flt({ ...q, from, to });
  const base = `FROM plaid_transactions t JOIN plaid_accounts pa ON pa.account_id=t.account_id WHERE ${where}`;
  // transferências entre contas próprias não são receita nem gasto
  const real = "t.category_primary NOT IN ('TRANSFER_IN','TRANSFER_OUT','LOAN_PAYMENTS')";
  const totals = get(`SELECT COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount END),0) AS money_in, COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount END),0) AS money_out ${base} AND ${real}`, ...p);
  const byCategory = all(`SELECT t.category_primary AS category, SUM(t.amount) AS total, COUNT(*) AS count ${base} AND t.amount>0 AND ${real} GROUP BY t.category_primary ORDER BY total DESC`, ...p);
  const topMerchants = all(`SELECT COALESCE(NULLIF(t.merchant,''), t.name) AS name, t.category_primary AS category, SUM(t.amount) AS total, COUNT(*) AS count ${base} AND t.amount>0 AND ${real} GROUP BY 1 ORDER BY total DESC LIMIT 8`, ...p);
  const payers = all(`SELECT COALESCE(NULLIF(t.merchant,''), t.name) AS name, SUM(-t.amount) AS total, COUNT(*) AS count, MAX(t.date) AS last_date ${base} AND t.amount<0 AND ${real} GROUP BY 1 ORDER BY total DESC LIMIT 10`, ...p);
  const monthly = all(`SELECT substr(t.date,1,7) AS month, COALESCE(SUM(CASE WHEN t.amount<0 THEN -t.amount END),0) AS money_in, COALESCE(SUM(CASE WHEN t.amount>0 THEN t.amount END),0) AS money_out ${base} AND ${real} GROUP BY 1 ORDER BY 1`, ...p);
  const accounts = connectionAccounts();
  const cash = accounts.filter((a) => !a.is_credit).reduce((s, a) => s + (a.balance_current || 0), 0);
  const owed = accounts.filter((a) => a.is_credit).reduce((s, a) => s + (a.balance_current || 0), 0);
  return { from, to, balance: cash, creditOwed: owed, moneyIn: totals.money_in, moneyOut: totals.money_out, byCategory, topMerchants, payers, monthly };
}

/* -------------------------------------- webhook -------------------------------------- */
let keyCache = new Map();
const b64u = (s) => Buffer.from(s, 'base64url');

/** Valida o JWT ES256 do cabeçalho Plaid-Verification contra a chave pública do Plaid e o hash do corpo. */
export async function verifyWebhook(rawBody, jwt) {
  if (!jwt) throw new HttpError(401, 'Missing webhook signature');
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Invalid webhook signature');
  const header = JSON.parse(b64u(parts[0]).toString()), claims = JSON.parse(b64u(parts[1]).toString());
  if (header.alg !== 'ES256' || !header.kid) throw new HttpError(401, 'Invalid webhook signature');
  let jwk = keyCache.get(header.kid);
  if (!jwk) { jwk = (await plaid('/webhook_verification_key/get', { key_id: header.kid })).key; keyCache.set(header.kid, jwk); }
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const okSig = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: pub, dsaEncoding: 'ieee-p1363' }, b64u(parts[2]));
  if (!okSig) throw new HttpError(401, 'Invalid webhook signature');
  if (!claims.iat || Math.abs(Date.now() / 1000 - claims.iat) > 300) throw new HttpError(401, 'Webhook signature expired');
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const a = Buffer.from(hash), b = Buffer.from(String(claims.request_body_sha256 || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Invalid webhook signature');
}
export const _resetKeyCache = () => { keyCache = new Map(); };

export async function handleWebhook(payload) {
  const itemId = payload.item_id;
  if (!itemId || !get('SELECT 1 FROM plaid_items WHERE item_id=?', itemId)) return { ignored: true };
  if (payload.webhook_type === 'TRANSACTIONS' && ['SYNC_UPDATES_AVAILABLE', 'DEFAULT_UPDATE', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE'].includes(payload.webhook_code)) {
    return { synced: await syncItem(itemId) };
  }
  if (payload.webhook_type === 'ITEM') {
    if (payload.webhook_code === 'ERROR' && payload.error?.error_code === 'ITEM_LOGIN_REQUIRED') run("UPDATE plaid_items SET status='login_required', error_code='ITEM_LOGIN_REQUIRED' WHERE item_id=?", itemId);
    else if (payload.webhook_code === 'PENDING_EXPIRATION') run("UPDATE plaid_items SET status='login_required', error_code='PENDING_EXPIRATION' WHERE item_id=?", itemId);
    else if (payload.webhook_code === 'USER_PERMISSION_REVOKED') run("UPDATE plaid_items SET status='revoked', error_code='USER_PERMISSION_REVOKED' WHERE item_id=?", itemId);
    else if (payload.webhook_code === 'LOGIN_REPAIRED') run("UPDATE plaid_items SET status='ok', error_code='' WHERE item_id=?", itemId);
  }
  return { handled: true };
}
