// "Importar de foto" no Pulso (um banco por clínica): IA e Stripe simulados, servidor de verdade em memória (modo multi-clínica).
// Essentials inclui 100/mês (+100 nos primeiros 30 dias); Free e Starter não; uso e crédito por clínica; extras viram UMA linha no Stripe da clínica certa.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

// Sobe o servidor em memória no modo multiempresa (um banco por empresa).
async function boot({ multi = false, env = {} } = {}) {
  process.env.FLUXO_DB = ':memory:';
  if (multi) process.env.FLUXO_MULTI = '1';
  Object.assign(process.env, env);
  const { app } = await import('../src/index.js');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (p, method = 'GET', body, tk = '', headers = {}) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { /* vazio */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  return { call, server, base, close: () => server.close() };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-photo-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const listen = (h) => new Promise((r) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => r(s)); });
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });

let reply = { records: [], note: null };
const aiSeen = []; const stripeSeen = []; const items = new Map();
const ai = await listen(async (req, res) => {
  const raw = await readBody(req); const body = raw ? JSON.parse(raw) : {};
  aiSeen.push({ key: req.headers['x-api-key'], body });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: 'tool_use', stop_sequence: null, content: [{ type: 'tool_use', id: 't', name: 'record_import', input: reply }], usage: { input_tokens: 5, output_tokens: 5 } }));
});
const stripe = await listen(async (req, res) => {
  const raw = await readBody(req); const body = Object.fromEntries(new URLSearchParams(raw)); const key = req.headers['idempotency-key'];
  stripeSeen.push({ url: req.url, key, body });
  res.setHeader('content-type', 'application/json');
  if (req.url === '/v1/invoiceitems') {
    if (key && items.has(key)) return res.end(JSON.stringify(items.get(key)));
    const item = { id: `ii_${items.size + 1}`, object: 'invoiceitem', ...body }; if (key) items.set(key, item);
    return res.end(JSON.stringify(item));
  }
  res.statusCode = 404; res.end('{}');
});

const { call, base, close } = await boot({ multi: true, env: { FLUXO_DB: path.join(dir, 'control.db'), FLUXO_ADMIN_EMAIL: 'root@x.com', FLUXO_ADMIN_PASSWORD: 'admin-password-123' } });
const dbm = await import('../src/db.js');
const tenants = await import('../src/tenants.js');
const plans = await import('../src/plans.js');
const { billExtras } = await import('../src/photoImportRouter.js');
const rootBase = base.replace(/\/api$/, '');
test.after(() => { close(); ai.closeAllConnections?.(); ai.close(); stripe.closeAllConnections?.(); stripe.close(); });

let ip = 0;
const signup = async (name, email, plan) => {
  const r = await call('/setup', 'POST', { company_name: name, name: 'Owner', email, password: 'senha-1234' }, '', { 'x-forwarded-for': `10.0.0.${++ip}` });
  assert.equal(r.status, 200, r.text);
  const token = r.body.token; const slug = token.split('.')[0];
  if (plan) tenants.inTenant(slug, () => plans.setPlan({ plan }));
  return { token, slug };
};
const photo = async (token, { kind = 'clients', file = PNG, lang = 'en' } = {}) => {
  const fd = new FormData(); if (kind) fd.append('kind', kind); fd.append('lang', lang); if (file) fd.append('file', new Blob([file]), 'print.png');
  const r = await fetch(`${base}/photo-import`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const status = async (token) => (await call('/photo-import/status', 'GET', undefined, token)).body;
const addUsed = (slug, n, extra = 0) => tenants.inTenant(slug, () => { for (let i = 0; i < n; i++) dbm.run("INSERT INTO photo_imports (kind, records, extra_cents) VALUES ('clients', 1, ?)", extra); });

let A; let B; let C;
test('sem login 401; sem chave da IA 503; Free e Starter não incluem (402)', async () => {
  assert.equal((await photo(undefined)).status, 401);
  A = await signup('Co A', 'a@x.com', 'essentials'); B = await signup('Co B', 'b@x.com', 'essentials'); C = await signup('Co C', 'c@x.com', 'starter');
  let r = await photo(A.token);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'ai_not_configured');
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'; process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${ai.address().port}`;
  r = await photo(C.token);
  assert.equal(r.status, 402); assert.equal(r.body.code, 'plan_limit');
  const free = await signup('Co F', 'f@x.com');
  assert.equal((await photo(free.token)).status, 402);
  assert.equal(aiSeen.length, 0, 'plano que não inclui nem chama a IA');
  assert.equal((await status(C.token)).credit.eligible, false);
});

test('Essentials lê: normaliza, não guarda a imagem, pacote de migração e isolamento entre clínicas', async () => {
  const st = await status(A.token);
  assert.equal(st.limit, 200, '100 do plano + 100 do pacote de migração'); assert.equal(st.migrationBonus, 100);
  reply = { records: [
    { name: '  Maria   Silva ', phone: '(407) 555-0142', email: 'MARIA@Email.com', address: '12 Oak St', type: 'customer', notes: 'x', unclear_fields: ['phone'] },
    { name: null, phone: null, email: null, address: 'só endereço', type: null, notes: null, unclear_fields: [] },
  ], note: 'ok' };
  const r = await photo(A.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.records.length, 1); assert.equal(r.body.records[0].name, 'Maria Silva'); assert.equal(r.body.records[0].email, 'maria@email.com');
  assert.equal(aiSeen.at(-1).key, 'sk-test-key'); assert.deepEqual(aiSeen.at(-1).body.tool_choice, { type: 'tool', name: 'record_import' });
  const row = tenants.inTenant(A.slug, () => dbm.get('SELECT * FROM photo_imports'));
  assert.equal(row.records, 1); assert.ok(!Object.keys(row).some((k) => /image|text|content/.test(k)));
  assert.equal((await status(A.token)).used, 1); assert.equal((await status(B.token)).used, 0, 'o uso da clínica A não aparece na B');
  assert.equal((await photo(A.token, { kind: 'expense' })).body.code, 'bad_kind');
  assert.equal((await photo(A.token, { file: Buffer.from('isto não é uma imagem, só texto comprido') })).body.code, 'bad_image');
});

test('só dono/administrador mexe no uso extra; recepção não', async () => {
  const mk = async (email, role) => { const r = await call('/users', 'POST', { name: role, email, password: 'senha-1234', role }, A.token); assert.equal(r.status, 200, r.text); return (await call('/login', 'POST', { email, password: 'senha-1234' })).body.token; };
  const fd = await mk('sales@x.com', 'sales');
  assert.equal((await call('/photo-import/credit', 'PUT', { accept: true, capCents: 1000 }, fd)).status, 403);
  assert.equal((await status(fd)).credit.isOwner, false);
  assert.equal((await status(A.token)).credit.isOwner, true);
});

test('uso extra: aceite + teto por clínica, cobrança única no Stripe da clínica certa, sem repetir', async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${stripe.address().port}`; process.env.PHOTO_EXTRA_CAPS_CENTS = '20,1000';
  reply = { records: [{ name: 'Lia', phone: '', email: '', address: '', type: 'customer', notes: null, unclear_fields: [] }], note: null };
  await addUsed(A.slug, 198); // 1 já usada + 198 = 199; a próxima leitura é a 200 (= limite)
  assert.equal((await photo(A.token)).body.warn, '100');
  assert.equal((await photo(A.token)).status, 402);
  assert.equal((await call('/photo-import/credit', 'PUT', { capCents: 20 }, A.token)).body.code, 'accept_required');
  assert.equal((await call('/photo-import/credit', 'PUT', { accept: true, capCents: 20 }, A.token)).body.code, 'no_billing', 'sem cliente do Stripe não liga');
  tenants.inTenant(A.slug, () => { dbm.setSetting('stripe_customer_id', 'cus_A'); dbm.setSetting('stripe_subscription_id', 'sub_A'); });
  tenants.inTenant(B.slug, () => { dbm.setSetting('stripe_customer_id', 'cus_B'); dbm.setSetting('stripe_subscription_id', 'sub_B'); });
  let r = await call('/photo-import/credit', 'PUT', { accept: true, capCents: 20 }, A.token);
  assert.equal(r.status, 200, r.text); assert.equal(r.body.credit.enabled, true); assert.equal(r.body.credit.priceCents, 10);
  assert.equal((await photo(A.token)).body.extra, true);
  assert.equal((await photo(A.token)).body.extra, true);
  r = await photo(A.token);
  assert.equal(r.status, 402); assert.equal(r.body.code, 'credit_limit');
  assert.equal((await status(B.token)).credit.enabled, false);
  await tenants.eachTenant(() => billExtras({ pool: null, getSubscription: null }).catch(() => {})); // sem pool: só garante que não derruba o laço
  const { sqlitePoolFrom } = await import('../src/sqlitePool.js');
  const pool = sqlitePoolFrom({ all: dbm.all, run: dbm.run });
  const sub = async () => ({ stripe_customer_id: dbm.getSetting('stripe_customer_id', ''), stripe_subscription_id: dbm.getSetting('stripe_subscription_id', '') });
  await tenants.eachTenant(() => billExtras({ pool, getSubscription: sub, envBilling: false }));
  const lines = stripeSeen.filter((s) => s.url === '/v1/invoiceitems');
  assert.equal(lines.length, 1, JSON.stringify(lines));
  assert.equal(lines[0].body.customer, 'cus_A'); assert.equal(lines[0].body.subscription, 'sub_A'); assert.equal(lines[0].body.amount, '20');
  await tenants.eachTenant(() => billExtras({ pool, getSubscription: sub, envBilling: false }));
  assert.equal(stripeSeen.filter((s) => s.url === '/v1/invoiceitems').length, 1, 'linhas já cobradas não são cobradas de novo');
  assert.equal(tenants.inTenant(A.slug, () => dbm.get('SELECT COUNT(*) n FROM photo_imports WHERE extra_cents > 0 AND billed_at IS NULL').n), 0);
  assert.equal((await call('/photo-import/credit', 'PUT', { enabled: false }, A.token)).body.credit.enabled, false);
  assert.ok(rootBase);
});
