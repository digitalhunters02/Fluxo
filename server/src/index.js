import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { all, get, run, insert, tx, getSetting, setSetting, db, applyLanguage, LANGS } from './db.js';
import * as acc from './accounting.js';
import * as bank from './banking.js';
import * as rep from './reports.js';
import * as pay from './payroll.js';
import { assertFeature, requireFeature, hasFeature, featureMap, currentPlan, hasAddon, setPlan, FEATURES, PLAN_ORDER, PLAN_PRICES, PAYROLL_ADDON_PRICE } from './plans.js';
import { authenticate, requireAuth, can, audit, MODULES, effectivePerms, hashPassword, verifyPassword, createSession, publicUser, ROLES, rateLimitLogin, clearAttempts, listUsers } from './auth.js';

const { HttpError, today, isDate, cents } = acc;
const bad = (m) => new HttpError(400, m);
export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));
app.use(authenticate);

const api = express.Router();
const wrap = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res)).catch(next); } catch (e) { next(e); } };
const ok = (res, data) => res.json(data);
const id = (req) => { const n = Number(req.params.id); if (!Number.isInteger(n)) throw bad('Invalid ID'); return n; };
const need = (v, msg) => { if (v === undefined || v === null || String(v).trim() === '') throw bad(msg); return v; };
const range = (req) => {
  const t = today();
  const from = req.query.from || t.slice(0, 4) + '-01-01', to = req.query.to || t;
  if (!isDate(from) || !isDate(to) || from > to) throw bad('Invalid period');
  return [from, to];
};

/* ---------------------------------- auth ---------------------------------- */
api.get('/status', wrap((_req, res) => ok(res, { needsSetup: !get('SELECT 1 FROM users LIMIT 1'), company: getSetting('company_name') })));

api.post('/setup', wrap((req, res) => {
  if (get('SELECT 1 FROM users LIMIT 1')) throw new HttpError(403, 'System is already set up');
  const { company_name, name, email, password, demo, currency } = req.body;
  if (req.body.plan) setPlan({ plan: req.body.plan });
  const lang = LANGS.includes(req.body.lang) ? req.body.lang : 'en';
  need(name, 'Enter your name'); need(email, 'Enter the email');
  if (!password || password.length < 8) throw bad('The password must be at least 8 characters');
  applyLanguage(lang, { currency: ['USD', 'EUR', 'GBP', 'CAD', 'MXN'].includes(currency) ? currency : undefined });
  if (company_name) setSetting('company_name', company_name);
  const uid = insert('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,\'owner\')', name.trim(), email.trim().toLowerCase(), hashPassword(password));
  if (demo) import('./seed.js').then((m) => m.loadDemo(lang)).catch((e) => console.error('seed', e));
  ok(res, { token: createSession(uid), user: publicUser(get('SELECT * FROM users WHERE id=?', uid)) });
}));

api.post('/login', wrap((req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  rateLimitLogin(email + '|' + req.ip);
  const u = get('SELECT * FROM users WHERE email=? AND active=1', email);
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) throw new HttpError(401, 'Incorrect email or password');
  clearAttempts(email + '|' + req.ip);
  ok(res, { token: createSession(u.id), user: publicUser(u) });
}));

// visualização pública de documento (link compartilhável)
api.get('/public/doc/:token', wrap((req, res) => {
  const row = get("SELECT id FROM docs WHERE share_token=? AND type IN ('invoice','estimate','credit')", req.params.token);
  if (!row) throw new HttpError(404, 'Document not found');
  const d = acc.loadDoc(row.id);
  const c = get('SELECT name,email,phone,tax_id,address FROM contacts WHERE id=?', d.contact_id);
  const company = Object.fromEntries(all('SELECT key,value FROM settings').filter((s) => ['company_name', 'currency', 'locale', 'invoice_footer', 'company_tax_id', 'company_address', 'company_email', 'company_phone', 'company_logo', 'brand_color'].includes(s.key)).map((s) => [s.key, s.value]));
  const { share_token, created_by, ...safe } = d;
  ok(res, { doc: safe, customer: c, company });
}));

// o cliente aceita um orçamento pelo link público (assinatura digitada)
api.post('/public/doc/:token/accept', wrap((req, res) => {
  rateLimitLogin(`accept|${req.params.token}|${req.ip}`);
  const row = get("SELECT id,status,number FROM docs WHERE share_token=? AND type='estimate'", req.params.token);
  if (!row) throw new HttpError(404, 'Document not found');
  const who = String(req.body.name || '').trim().slice(0, 120);
  if (who.length < 2) throw bad('Type your full name to accept');
  if (!['sent', 'draft'].includes(row.status)) throw bad('This estimate can no longer be accepted');
  run("UPDATE docs SET status='accepted', accepted_by=?, accepted_at=? WHERE id=?", who, new Date().toISOString(), row.id);
  run("INSERT INTO audit_log(user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?)", who, 'accept', 'estimate', row.id, `${row.number} (public link)`);
  ok(res, { status: 'accepted' });
}));

api.use(requireAuth);
api.post('/logout', wrap((req, res) => { run('DELETE FROM sessions WHERE token=?', req.headers.authorization.slice(7)); ok(res, {}); }));
const planInfo = () => ({ plan: currentPlan(), payroll: hasAddon('payroll'), features: featureMap(), minimum: FEATURES, order: PLAN_ORDER, prices: PLAN_PRICES, payrollPrice: PAYROLL_ADDON_PRICE, lockDate: getSetting('lock_date', '') });
api.get('/me', wrap((req, res) => ok(res, { ...publicUser(req.user), planInfo: planInfo() })));
api.get('/plan', wrap((_req, res) => ok(res, planInfo())));
api.put('/plan', can('users', true), wrap((req, res) => { setPlan({ plan: req.body.plan, payroll: req.body.payroll }); audit(req, 'update', 'settings', null, `plan ${currentPlan()}`); ok(res, planInfo()); }));
api.post('/me/password', wrap((req, res) => {
  if (!verifyPassword(String(req.body.current || ''), req.user.password_hash)) throw bad('Current password is incorrect');
  if (!req.body.next || req.body.next.length < 8) throw bad('The new password must be at least 8 characters');
  run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(req.body.next), req.user.id);
  audit(req, 'password', 'user', req.user.id);
  ok(res, {});
}));

/* ------------------------------- configurações ---------------------------- */
const PUBLIC_SETTINGS = ['lock_date', 'company_logo', 'brand_color', 'lang', 'payroll_suta_rate', 'payroll_suta_base', 'company_name', 'company_tax_id', 'company_address', 'company_email', 'company_phone', 'currency', 'locale', 'invoice_prefix', 'estimate_prefix', 'bill_prefix', 'default_tax_rate', 'default_terms_days', 'invoice_footer'];
api.get('/settings', can('settings'), wrap((_req, res) => ok(res, Object.fromEntries(PUBLIC_SETTINGS.map((k) => [k, getSetting(k)])))));
api.put('/settings', can('settings', true), wrap((req, res) => {
  if ('company_logo' in req.body && req.body.company_logo !== '' && !(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.company_logo) && req.body.company_logo.length <= 400_000)) throw bad('Logo must be a PNG, JPEG or WebP under 300 KB');
  if ('brand_color' in req.body && !/^#[0-9a-fA-F]{6}$/.test(req.body.brand_color)) throw bad('Invalid color');
  for (const k of PUBLIC_SETTINGS) if (k !== 'lock_date' && k in req.body) setSetting(k, req.body[k]);
  audit(req, 'update', 'settings'); ok(res, {});
}));

api.get('/users', can('users'), wrap((_req, res) => ok(res, { users: listUsers(), roles: ROLES, customRoles: hasFeature('custom_roles') ? all('SELECT id,name FROM roles ORDER BY name') : [] })));
api.post('/users', can('users', true), wrap((req, res) => {
  const { name, email, password } = req.body;
  const custom = req.body.custom_role_id ? Number(req.body.custom_role_id) : null;
  if (custom) { assertFeature('custom_roles'); if (!get('SELECT 1 FROM roles WHERE id=?', custom)) throw bad('Invalid role'); }
  const role = custom ? 'viewer' : req.body.role;
  need(name, 'Enter the name'); need(email, 'Enter the email');
  if (!ROLES[role]) throw bad('Invalid role');
  if (!password || password.length < 8) throw bad('Password must be at least 8 characters');
  if (get('SELECT 1 FROM users WHERE email=?', email.trim().toLowerCase())) throw bad('Email already registered');
  const uid = insert('INSERT INTO users(name,email,password_hash,role,custom_role_id) VALUES(?,?,?,?,?)', name.trim(), email.trim().toLowerCase(), hashPassword(password), role, custom);
  audit(req, 'create', 'user', uid, `${email} (${role})`); ok(res, publicUser(get('SELECT * FROM users WHERE id=?', uid)));
}));
api.put('/users/:id', can('users', true), wrap((req, res) => {
  const uid = id(req); const u = get('SELECT * FROM users WHERE id=?', uid);
  if (!u) throw new HttpError(404, 'User not found');
  let custom = u.custom_role_id;
  if ('custom_role_id' in req.body) { custom = req.body.custom_role_id ? Number(req.body.custom_role_id) : null; if (custom) { assertFeature('custom_roles'); if (!get('SELECT 1 FROM roles WHERE id=?', custom)) throw bad('Invalid role'); } }
  const role = custom ? 'viewer' : (req.body.role ?? u.role), active = req.body.active ?? !!u.active;
  if (!ROLES[role]) throw bad('Invalid role');
  if (u.role === 'owner' && (role !== 'owner' || !active) && get('SELECT COUNT(*) AS n FROM users WHERE role=\'owner\' AND active=1').n <= 1) throw bad('At least one active owner is required');
  run('UPDATE users SET name=?, role=?, custom_role_id=?, active=? WHERE id=?', req.body.name || u.name, role, custom, active ? 1 : 0, uid);
  if (req.body.password) { if (req.body.password.length < 8) throw bad('Password must be at least 8 characters'); run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(req.body.password), uid); }
  if (!active) run('DELETE FROM sessions WHERE user_id=?', uid);
  audit(req, 'update', 'user', uid, `${u.email} → ${role}${active ? '' : ' (inactive)'}`); ok(res, publicUser(get('SELECT * FROM users WHERE id=?', uid)));
}));
api.get('/audit', can('users'), requireFeature('audit_log'), wrap((_req, res) => ok(res, all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300'))));

/* ---------------------------------- contas -------------------------------- */
api.get('/accounts', can('accounting'), wrap((_req, res) => ok(res, all(`SELECT a.*,
  COALESCE((SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=a.id),0) AS net FROM accounts a ORDER BY code`)
  .map((a) => ({ ...a, balance: ['asset', 'expense'].includes(a.type) ? a.net : -a.net })))));
// listagem leve (sem permissão de contabilidade) para seletores
api.get('/accounts/lookup', wrap((_req, res) => ok(res, all('SELECT id,code,name,type,subtype FROM accounts WHERE active=1 ORDER BY code'))));
api.post('/accounts', can('accounting', true), wrap((req, res) => {
  const { code, name, type, subtype = '' } = req.body;
  need(code, 'Enter the code'); need(name, 'Enter the name');
  if (!['asset', 'liability', 'equity', 'income', 'expense'].includes(type)) throw bad('Invalid type');
  if (get('SELECT 1 FROM accounts WHERE code=?', code)) throw bad('Code already exists');
  const nid = insert('INSERT INTO accounts(code,name,type,subtype) VALUES(?,?,?,?)', code, name, type, ['bank', 'credit_card', 'fixed_asset', 'loan', ''].includes(subtype) ? subtype : '');
  audit(req, 'create', 'account', nid, `${code} ${name}`); ok(res, get('SELECT * FROM accounts WHERE id=?', nid));
}));
api.put('/accounts/:id', can('accounting', true), wrap((req, res) => {
  const aid = id(req); const a = get('SELECT * FROM accounts WHERE id=?', aid);
  if (!a) throw new HttpError(404, 'Account not found');
  const dupe = req.body.code && get('SELECT 1 FROM accounts WHERE code=? AND id<>?', req.body.code, aid);
  if (dupe) throw bad('Code already exists');
  if (a.is_system && req.body.active === false) throw bad('System accounts cannot be deactivated');
  run('UPDATE accounts SET code=?, name=?, active=? WHERE id=?', req.body.code || a.code, req.body.name || a.name, req.body.active === undefined ? a.active : (req.body.active ? 1 : 0), aid);
  audit(req, 'update', 'account', aid); ok(res, get('SELECT * FROM accounts WHERE id=?', aid));
}));
api.delete('/accounts/:id', can('accounting', true), wrap((req, res) => {
  const aid = id(req); const a = get('SELECT * FROM accounts WHERE id=?', aid);
  if (!a) throw new HttpError(404, 'Account not found');
  if (a.is_system) throw bad('System accounts cannot be deleted');
  if (get('SELECT 1 FROM journal_lines WHERE account_id=? LIMIT 1', aid)) throw bad('The account has entries; deactivate it instead of deleting it');
  run('DELETE FROM accounts WHERE id=?', aid); audit(req, 'delete', 'account', aid, a.name); ok(res, {});
}));

api.get('/journal', can('accounting'), wrap((req, res) => {
  const [from, to] = range(req);
  const entries = all('SELECT * FROM journal_entries WHERE date>=? AND date<=? ORDER BY date DESC, id DESC LIMIT 500', from, to);
  for (const e of entries) e.lines = all('SELECT jl.*, a.code, a.name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE entry_id=? ORDER BY jl.id', e.id);
  ok(res, entries);
}));
api.post('/journal', can('accounting', true), wrap((req, res) => {
  const e = acc.postEntry({ date: req.body.date, memo: req.body.memo || '', lines: req.body.lines || [], user_id: req.user.id });
  audit(req, 'create', 'journal', e, req.body.memo); ok(res, { id: e });
}));
api.delete('/journal/:id', can('accounting', true), wrap((req, res) => {
  const jid = id(req); const e = get('SELECT * FROM journal_entries WHERE id=?', jid);
  if (!e) throw new HttpError(404, 'Entry not found');
  if (e.source_type !== 'manual') throw bad('Automatic entries are undone from their source document');
  if (get('SELECT 1 FROM journal_lines WHERE entry_id=? AND reconciliation_id IS NOT NULL', jid)) throw bad('A reconciled entry cannot be deleted');
  run('DELETE FROM journal_entries WHERE id=?', jid); audit(req, 'delete', 'journal', jid, e.memo); ok(res, {});
}));
api.get('/ledger/:id', can('accounting'), wrap((req, res) => { const [from, to] = range(req); const g = rep.generalLedger(id(req), from, to); if (!g) throw new HttpError(404, 'Account not found'); ok(res, g); }));

/* --------------------------------- contatos ------------------------------- */
api.get('/contacts', can('sales'), wrap((req, res) => {
  const kind = req.query.kind;
  const rows = all(`SELECT c.*,
    COALESCE((SELECT SUM(total-paid) FROM docs WHERE contact_id=c.id AND type='invoice' AND status IN ('sent','partial')),0) AS receivable,
    COALESCE((SELECT SUM(total-paid) FROM docs WHERE contact_id=c.id AND type='bill' AND status IN ('open','partial')),0) AS payable
    FROM contacts c WHERE active=1 ORDER BY name`);
  ok(res, kind ? rows.filter((c) => c.kind === kind || c.kind === 'both') : rows);
}));
const contactFields = (b) => { need(b.name, 'Enter the name'); if (!['customer', 'vendor', 'both'].includes(b.kind || 'customer')) throw bad('Invalid type'); return [b.kind || 'customer', b.name.trim(), b.email || '', b.phone || '', b.tax_id || '', b.address || '', b.notes || '', Number.isInteger(+b.terms_days) ? +b.terms_days : 15, b.is_1099 && hasFeature('contractors_1099') ? 1 : 0]; };
api.post('/contacts', can('sales', true), wrap((req, res) => {
  const nid = insert('INSERT INTO contacts(kind,name,email,phone,tax_id,address,notes,terms_days,is_1099) VALUES(?,?,?,?,?,?,?,?,?)', ...contactFields(req.body));
  audit(req, 'create', 'contact', nid, req.body.name); ok(res, get('SELECT * FROM contacts WHERE id=?', nid));
}));
api.put('/contacts/:id', can('sales', true), wrap((req, res) => {
  const cid = id(req); if (!get('SELECT 1 FROM contacts WHERE id=?', cid)) throw new HttpError(404, 'Contact not found');
  run('UPDATE contacts SET kind=?,name=?,email=?,phone=?,tax_id=?,address=?,notes=?,terms_days=?,is_1099=? WHERE id=?', ...contactFields(req.body), cid);
  audit(req, 'update', 'contact', cid); ok(res, get('SELECT * FROM contacts WHERE id=?', cid));
}));
api.delete('/contacts/:id', can('sales', true), wrap((req, res) => {
  const cid = id(req);
  if (get('SELECT 1 FROM docs WHERE contact_id=? LIMIT 1', cid) || get('SELECT 1 FROM journal_lines WHERE contact_id=? LIMIT 1', cid)) { run('UPDATE contacts SET active=0 WHERE id=?', cid); }
  else run('DELETE FROM contacts WHERE id=?', cid);
  audit(req, 'delete', 'contact', cid); ok(res, {});
}));
api.get('/contacts/:id/statement', can('sales'), wrap((req, res) => {
  const cid = id(req);
  ok(res, { contact: get('SELECT * FROM contacts WHERE id=?', cid), docs: all('SELECT id,type,number,issue_date,due_date,status,total,paid FROM docs WHERE contact_id=? ORDER BY issue_date DESC', cid) });
}));

/* ---------------------------------- itens --------------------------------- */
api.get('/items', can('inventory'), wrap((_req, res) => ok(res, all('SELECT * FROM items WHERE active=1 ORDER BY name'))));
api.get('/items/lookup', wrap((_req, res) => ok(res, all('SELECT id,name,sku,kind,price,cost,tax_rate,track_inventory,qty_on_hand,income_account_id FROM items WHERE active=1 ORDER BY name'))));
const itemFields = (b) => {
  need(b.name, 'Enter the name');
  const kind = b.kind === 'product' ? 'product' : 'service';
  if (kind === 'product' && b.track_inventory) assertFeature('inventory');
  return [b.name.trim(), b.sku || '', kind, cents(b.price || 0), cents(b.cost || 0), kind === 'product' && b.track_inventory ? 1 : 0, Number(b.reorder_point || 0), b.income_account_id || null, Number(b.tax_rate || 0)];
};
api.post('/items', can('inventory', true), wrap((req, res) => {
  const f = itemFields(req.body);
  const nid = insert('INSERT INTO items(name,sku,kind,price,cost,track_inventory,reorder_point,income_account_id,tax_rate) VALUES(?,?,?,?,?,?,?,?,?)', ...f);
  const q = Number(req.body.qty_on_hand || 0);
  if (f[5] && q > 0) acc.adjustStock({ item_id: nid, qty_delta: q, date: today(), offset_account_id: get('SELECT id FROM accounts WHERE subtype=\'capital\' ORDER BY code LIMIT 1')?.id }, req.user);
  audit(req, 'create', 'item', nid, req.body.name); ok(res, get('SELECT * FROM items WHERE id=?', nid));
}));
api.put('/items/:id', can('inventory', true), wrap((req, res) => {
  const iid = id(req); const it = get('SELECT * FROM items WHERE id=?', iid);
  if (!it) throw new HttpError(404, 'Item not found');
  const f = itemFields(req.body);
  // não permite desligar o controle de estoque com saldo
  if (it.track_inventory && !f[5] && it.qty_on_hand !== 0) throw bad('Zero the stock before turning tracking off');
  run('UPDATE items SET name=?,sku=?,kind=?,price=?,cost=?,track_inventory=?,reorder_point=?,income_account_id=?,tax_rate=? WHERE id=?', ...f.slice(0, 4), it.track_inventory ? it.cost : f[4], ...f.slice(5), iid);
  audit(req, 'update', 'item', iid); ok(res, get('SELECT * FROM items WHERE id=?', iid));
}));
api.delete('/items/:id', can('inventory', true), wrap((req, res) => { run('UPDATE items SET active=0 WHERE id=?', id(req)); audit(req, 'delete', 'item', id(req)); ok(res, {}); }));
api.post('/items/:id/adjust', can('inventory', true), requireFeature('inventory'), wrap((req, res) => {
  const r = acc.adjustStock({ item_id: id(req), qty_delta: req.body.qty_delta, date: req.body.date, offset_account_id: req.body.offset_account_id }, req.user);
  audit(req, 'adjust', 'item', id(req), `Δ ${req.body.qty_delta}`); ok(res, r);
}));

/* -------------------------------- documentos ------------------------------ */
const docModule = (type) => (['bill', 'po'].includes(type) ? 'purchases' : 'sales');
const TYPE_FEATURE = { bill: 'bills', po: 'purchase_orders' };
const gateType = (type) => { if (TYPE_FEATURE[type]) assertFeature(TYPE_FEATURE[type]); };
api.param('type', (_req, _res, next, val) => { try { gateType(val); next(); } catch (e) { next(e); } });
const typeParam = (req) => { const t = req.params.type; if (!['invoice', 'estimate', 'bill', 'credit', 'po'].includes(t)) throw new HttpError(404, 'Invalid type'); return t; };

api.get('/docs/:type', (req, res, next) => can(docModule(req.params.type))(req, res, next), wrap((req, res) => {
  const t = typeParam(req);
  const rows = all(`SELECT d.id,d.type,d.number,d.contact_id,c.name AS contact_name,d.issue_date,d.due_date,d.status,d.total,d.paid,d.total-d.paid AS balance,d.project_id
    FROM docs d JOIN contacts c ON c.id=d.contact_id WHERE d.type=? ORDER BY d.issue_date DESC, d.id DESC LIMIT 1000`, t);
  const td = today();
  ok(res, rows.map((r) => ({ ...r, overdue: ['invoice', 'bill'].includes(t) && ['sent', 'open', 'partial'].includes(r.status) && r.due_date < td && r.balance > 0 })));
}));
api.get('/doc/:id', wrap((req, res) => {
  const d = acc.loadDoc(id(req));
  if (!d) throw new HttpError(404, 'Document not found');
  gateType(d.type); can(docModule(d.type))(req, res, (e) => { if (e) throw e; });
  ok(res, d);
}));
api.post('/docs/invoice/batch', can('sales', true), requireFeature('batch_invoices'), wrap((req, res) => {
  const ids = acc.batchInvoices(req.body, req.user);
  audit(req, 'create', 'invoice', null, `batch of ${ids.length}`); ok(res, { ids });
}));
api.post('/docs/:type', (req, res, next) => can(docModule(req.params.type), true)(req, res, next), wrap((req, res) => {
  const pay = req.params.type === 'invoice' ? req.body.pay_now : null; // recibo de venda: fatura emitida e paga na hora
  let d = acc.saveDoc({ ...req.body, id: undefined, type: typeParam(req), post: pay ? true : req.body.post }, req.user);
  if (pay) d = acc.addPayment(d.id, { date: pay.date || d.issue_date, amount: d.total, account_id: pay.account_id, method: pay.method || '', ref: pay.ref || '' }, req.user);
  audit(req, 'create', d.type, d.id, d.number); ok(res, d);
}));
api.put('/doc/:id', wrap((req, res) => {
  const cur = get('SELECT type FROM docs WHERE id=?', id(req));
  if (!cur) throw new HttpError(404, 'Document not found');
  gateType(cur.type); can(docModule(cur.type), true)(req, res, (e) => { if (e) throw e; });
  const d = acc.saveDoc({ ...req.body, id: id(req), type: cur.type }, req.user);
  audit(req, 'update', d.type, d.id, d.number); ok(res, d);
}));
const docAction = (action) => wrap((req, res) => {
  const cur = get('SELECT type,number FROM docs WHERE id=?', id(req));
  if (!cur) throw new HttpError(404, 'Document not found');
  gateType(cur.type); can(docModule(cur.type), true)(req, res, (e) => { if (e) throw e; });
  const d = acc.setDocStatus(id(req), action, req.user);
  audit(req, action, cur.type, d.id, cur.number); ok(res, d);
});
for (const a of ['post', 'void', 'accept', 'decline', 'send']) api.post(`/doc/:id/${a}`, docAction(a));
api.delete('/doc/:id', wrap((req, res) => {
  const cur = get('SELECT type,number FROM docs WHERE id=?', id(req));
  if (!cur) throw new HttpError(404, 'Document not found');
  gateType(cur.type); can(docModule(cur.type), true)(req, res, (e) => { if (e) throw e; });
  acc.deleteDoc(id(req)); audit(req, 'delete', cur.type, id(req), cur.number); ok(res, {});
}));
api.post('/doc/:id/convert-po', can('purchases', true), requireFeature('purchase_orders'), wrap((req, res) => { const d = acc.convertPO(id(req), req.user); audit(req, 'convert', 'po', id(req), `→ ${d.number}`); ok(res, d); }));
api.post('/doc/:id/apply-credit', can('sales', true), wrap((req, res) => { const d = acc.applyCredit(id(req), req.body); audit(req, 'apply', 'credit', d.id, d.number); ok(res, d); }));
api.post('/doc/:id/refund', can('sales', true), wrap((req, res) => { const d = acc.refundCredit(id(req), req.body, req.user); audit(req, 'refund', 'credit', d.id, d.number); ok(res, d); }));
api.delete('/credit-applications/:id', can('sales', true), wrap((req, res) => { const d = acc.removeCreditApplication(id(req)); audit(req, 'delete', 'credit', d.id, d.number); ok(res, d); }));
api.post('/doc/:id/convert', can('sales', true), wrap((req, res) => { const d = acc.convertEstimate(id(req), req.user); audit(req, 'convert', 'estimate', id(req), `→ ${d.number}`); ok(res, d); }));
api.post('/doc/:id/payments', wrap((req, res) => {
  const cur = get('SELECT type FROM docs WHERE id=?', id(req));
  if (!cur) throw new HttpError(404, 'Document not found');
  gateType(cur.type); can(docModule(cur.type), true)(req, res, (e) => { if (e) throw e; });
  const d = acc.addPayment(id(req), req.body, req.user);
  audit(req, 'payment', d.type, d.id, `${d.number}: ${req.body.amount}`); ok(res, d);
}));
api.delete('/payments/:id', can('accounting', true), wrap((req, res) => { const d = acc.deletePayment(id(req)); audit(req, 'delete', 'payment', id(req), d.number); ok(res, d); }));

/* ---------------------------------- despesas ------------------------------ */
api.get('/expenses', can('purchases'), wrap((_req, res) => ok(res, all(`SELECT e.id,e.date,e.amount,e.description,e.ref,e.account_id,e.paid_from_id,e.contact_id,e.project_id,
  a.name AS category, f.name AS paid_from, c.name AS contact_name, e.receipt IS NOT NULL AS has_receipt
  FROM expenses e JOIN accounts a ON a.id=e.account_id JOIN accounts f ON f.id=e.paid_from_id LEFT JOIN contacts c ON c.id=e.contact_id ORDER BY e.date DESC, e.id DESC LIMIT 1000`))));
api.get('/expenses/:id/receipt', can('purchases'), wrap((req, res) => { const e = get('SELECT receipt FROM expenses WHERE id=?', id(req)); if (!e?.receipt) throw new HttpError(404, 'No receipt'); ok(res, { receipt: e.receipt }); }));
api.post('/expenses', can('purchases', true), wrap((req, res) => { const e = acc.saveExpense({ ...req.body, id: undefined }, req.user); audit(req, 'create', 'expense', e.id, `${e.amount}`); ok(res, e); }));
api.put('/expenses/:id', can('purchases', true), wrap((req, res) => { const e = acc.saveExpense({ ...req.body, id: id(req) }, req.user); audit(req, 'update', 'expense', e.id); ok(res, e); }));
api.delete('/expenses/:id', can('purchases', true), wrap((req, res) => { acc.deleteExpense(id(req)); audit(req, 'delete', 'expense', id(req)); ok(res, {}); }));

/* ----------------------------------- banco -------------------------------- */
api.get('/banking/accounts', can('banking'), wrap((_req, res) => ok(res, all(`SELECT a.id,a.code,a.name,a.type,a.subtype,
  COALESCE((SELECT SUM(debit-credit) FROM journal_lines WHERE account_id=a.id),0) AS net,
  (SELECT COUNT(*) FROM bank_txns WHERE account_id=a.id AND status='pending') AS pending,
  (SELECT MAX(statement_date) FROM reconciliations WHERE account_id=a.id) AS last_reconciled
  FROM accounts a WHERE a.active=1 AND ((a.type='asset' AND a.subtype='bank') OR a.subtype='credit_card') ORDER BY a.code`)
  .map((a) => ({ ...a, balance: a.type === 'asset' ? a.net : -a.net })))));
api.get('/banking/txns', can('banking'), wrap((req, res) => {
  const status = req.query.status || 'pending';
  const params = [status]; let where = 'b.status=?';
  if (req.query.account_id) { where += ' AND b.account_id=?'; params.push(Number(req.query.account_id)); }
  const rows = all(`SELECT b.*, sa.name AS suggested_account_name, a.name AS account_name FROM bank_txns b JOIN accounts a ON a.id=b.account_id
    LEFT JOIN accounts sa ON sa.id=b.suggested_account_id WHERE ${where} ORDER BY b.date DESC, b.id DESC LIMIT 1000`, ...params);
  for (const r of rows) if (r.suggested_line_id) {
    r.match = get('SELECT je.memo, je.date, je.source_type FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.id=?', r.suggested_line_id) || null;
  }
  ok(res, rows);
}));
api.post('/banking/import', can('banking', true), wrap((req, res) => { const r = bank.importTxns(Number(req.body.account_id), req.body.rows); audit(req, 'import', 'bank', null, `${r.added} novas`); ok(res, r); }));
api.post('/banking/txns/:id/categorize', can('banking', true), wrap((req, res) => ok(res, bank.categorize(id(req), req.body, req.user))));
api.post('/banking/txns/:id/match', can('banking', true), wrap((req, res) => ok(res, bank.matchTxn(id(req), Number(req.body.line_id)))));
api.post('/banking/txns/:id/undo', can('banking', true), wrap((req, res) => { bank.undoTxn(id(req)); ok(res, {}); }));
api.post('/banking/txns/:id/ignore', can('banking', true), wrap((req, res) => { run('UPDATE bank_txns SET status=\'ignored\' WHERE id=? AND status=\'pending\'', id(req)); ok(res, {}); }));
api.post('/banking/accept-all', can('banking', true), wrap((req, res) => { const r = bank.acceptAllSuggestions(req.body.account_id ? Number(req.body.account_id) : null, req.user); audit(req, 'accept-all', 'bank', null, JSON.stringify(r)); ok(res, r); }));
api.get('/banking/rules', can('banking'), wrap((_req, res) => ok(res, all('SELECT r.*, a.name AS account_name FROM bank_rules r JOIN accounts a ON a.id=r.account_id ORDER BY r.id'))));
api.post('/banking/rules', can('banking', true), wrap((req, res) => {
  need(req.body.pattern, 'Enter the text to match'); acc.getAccount(req.body.account_id);
  const nid = insert('INSERT INTO bank_rules(pattern,account_id,contact_id,direction) VALUES(?,?,?,?)', req.body.pattern.trim(), req.body.account_id, req.body.contact_id || null, ['any', 'in', 'out'].includes(req.body.direction) ? req.body.direction : 'any');
  ok(res, { id: nid });
}));
api.delete('/banking/rules/:id', can('banking', true), wrap((req, res) => { run('DELETE FROM bank_rules WHERE id=?', id(req)); ok(res, {}); }));
api.get('/banking/reconcile/:id', can('banking'), wrap((req, res) => ok(res, bank.reconcileState(id(req), req.query.upTo || today()))));
api.post('/banking/reconcile/:id', can('banking', true), wrap((req, res) => { const r = bank.finishReconcile(id(req), req.body, req.user); audit(req, 'reconcile', 'account', id(req), `${r.reconciled} lançamentos`); ok(res, r); }));
api.post('/banking/reconcile/:id/undo', can('banking', true), wrap((req, res) => { ok(res, bank.undoLastReconcile(id(req))); audit(req, 'undo-reconcile', 'account', id(req)); }));
api.post('/transfers', can('banking', true), wrap((req, res) => {
  const amount = cents(req.body.amount); if (amount <= 0) throw bad('Amount must be positive');
  if (req.body.from_id === req.body.to_id) throw bad('Source and destination accounts must be different');
  const e = acc.postEntry({ date: req.body.date || today(), memo: req.body.memo || acc.memoText('transfer'), source_type: 'manual', user_id: req.user.id, lines: [{ account_id: req.body.to_id, debit: amount }, { account_id: req.body.from_id, credit: amount }] });
  audit(req, 'transfer', 'journal', e); ok(res, { id: e });
}));

/* ----------------------------- projetos e tempo --------------------------- */
api.use('/projects', requireFeature('time_tracking'));
api.use('/time', requireFeature('time_tracking'));
api.get('/projects', can('projects'), wrap((_req, res) => ok(res, rep.projectProfitability().map((p) => (hasFeature('project_profit') ? p : { ...p, invoiced: 0, costs: 0, profit: 0, profitHidden: true })))));
const projFields = (b) => { need(b.name, 'Enter the name'); return [b.name.trim(), b.contact_id || null, cents(b.hourly_rate || 0), cents(b.budget || 0), ['active', 'completed', 'archived'].includes(b.status) ? b.status : 'active', b.notes || '']; };
api.post('/projects', can('projects', true), wrap((req, res) => { const nid = insert('INSERT INTO projects(name,contact_id,hourly_rate,budget,status,notes) VALUES(?,?,?,?,?,?)', ...projFields(req.body)); audit(req, 'create', 'project', nid, req.body.name); ok(res, { id: nid }); }));
api.put('/projects/:id', can('projects', true), wrap((req, res) => { run('UPDATE projects SET name=?,contact_id=?,hourly_rate=?,budget=?,status=?,notes=? WHERE id=?', ...projFields(req.body), id(req)); ok(res, {}); }));
api.get('/time', can('projects'), wrap((req, res) => {
  const w = []; const p = [];
  if (req.query.project_id) { w.push('t.project_id=?'); p.push(Number(req.query.project_id)); }
  if (req.query.unbilled) w.push('t.billable=1 AND t.invoice_id IS NULL');
  ok(res, all(`SELECT t.*, p.name AS project_name, p.hourly_rate, p.contact_id, u.name AS user_name FROM time_entries t JOIN projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.user_id
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY t.date DESC, t.id DESC LIMIT 1000`, ...p));
}));
api.post('/time', can('projects', true), wrap((req, res) => {
  const h = Number(req.body.hours); if (!(h > 0 && h <= 24)) throw bad('Hours must be between 0 and 24');
  if (!isDate(req.body.date)) throw bad('Invalid date'); if (!get('SELECT 1 FROM projects WHERE id=?', req.body.project_id)) throw bad('Invalid project');
  ok(res, { id: insert('INSERT INTO time_entries(project_id,user_id,date,hours,description,billable) VALUES(?,?,?,?,?,?)', req.body.project_id, req.user.id, req.body.date, h, req.body.description || '', req.body.billable === false ? 0 : 1) });
}));
api.delete('/time/:id', can('projects', true), wrap((req, res) => { const t = get('SELECT * FROM time_entries WHERE id=?', id(req)); if (t?.invoice_id) throw bad('Hours already invoiced'); run('DELETE FROM time_entries WHERE id=?', id(req)); ok(res, {}); }));
api.post('/projects/:id/invoice-time', can('sales', true), wrap((req, res) => {
  const pid = id(req); const p = get('SELECT * FROM projects WHERE id=?', pid);
  if (!p?.contact_id) throw bad('The project needs a customer');
  const entries = all('SELECT * FROM time_entries WHERE project_id=? AND billable=1 AND invoice_id IS NULL ORDER BY date', pid);
  if (!entries.length) throw bad('There are no hours to invoice');
  if (!p.hourly_rate) throw bad('Set the project hourly rate');
  const terms = get('SELECT terms_days FROM contacts WHERE id=?', p.contact_id).terms_days;
  const d = acc.saveDoc({ type: 'invoice', contact_id: p.contact_id, project_id: pid, issue_date: today(), due_date: acc.addDays(today(), terms), post: false,
    lines: entries.map((t) => ({ description: `${p.name} — ${t.date}${t.description ? ': ' + t.description : ''}`, qty: t.hours, unit_price: p.hourly_rate, tax_rate: Number(getSetting('default_tax_rate', 0)), time_entry_id: t.id })) }, req.user);
  audit(req, 'create', 'invoice', d.id, `horas de ${p.name}`); ok(res, d);
}));

/* ------------------------------- recorrências ----------------------------- */
api.use('/recurring', requireFeature('recurring'));
api.get('/recurring', can('sales'), wrap((_req, res) => ok(res, all('SELECT r.*, c.name AS contact_name FROM recurring r LEFT JOIN contacts c ON c.id=json_extract(r.template,\'$.contact_id\') ORDER BY r.active DESC, r.next_date').map((r) => ({ ...r, template: JSON.parse(r.template) })))));
api.post('/recurring', can('sales', true), wrap((req, res) => {
  const b = req.body; need(b.name, 'Enter a name');
  if (!['weekly', 'monthly', 'quarterly', 'yearly'].includes(b.frequency)) throw bad('Invalid frequency');
  if (!isDate(b.next_date)) throw bad('Invalid next date');
  if (!get('SELECT 1 FROM contacts WHERE id=?', b.template?.contact_id)) throw bad('Select the customer');
  acc.computeLines('invoice', b.template.lines || []);
  if (!b.template.lines?.length) throw bad('Add at least one line');
  const nid = insert('INSERT INTO recurring(name,template,frequency,next_date,end_date,auto_post) VALUES(?,?,?,?,?,?)', b.name, JSON.stringify(b.template), b.frequency, b.next_date, b.end_date || null, b.auto_post ? 1 : 0);
  audit(req, 'create', 'recurring', nid, b.name); ok(res, { id: nid });
}));
api.put('/recurring/:id', can('sales', true), wrap((req, res) => { run('UPDATE recurring SET active=? WHERE id=?', req.body.active ? 1 : 0, id(req)); ok(res, {}); }));
api.delete('/recurring/:id', can('sales', true), wrap((req, res) => { run('DELETE FROM recurring WHERE id=?', id(req)); ok(res, {}); }));
api.post('/recurring/run', can('sales', true), wrap((req, res) => { const c = acc.runRecurring(today(), req.user); ok(res, { created: c.length }); }));


/* ------------------------------ folha de pagamento ------------------------ */
api.use('/payroll', requireFeature('payroll'));
const empFields = (b) => {
  need(b.name, 'Enter the name');
  if (!isDate(b.hire_date)) throw bad('Invalid hire date');
  if (!['hour', 'year'].includes(b.pay_basis)) throw bad('Pay basis must be hourly or annual salary');
  if (!Object.keys(pay.PERIODS).includes(b.frequency)) throw bad('Invalid pay frequency');
  if (!['single', 'married'].includes(b.filing_status)) throw bad('Invalid filing status');
  const rate = cents(b.pay_rate); if (rate <= 0) throw bad('Enter a pay rate');
  const pct = Number(b.state_pct || 0); if (!(pct >= 0 && pct <= 20)) throw bad('State withholding must be between 0% and 20%');
  return [b.name.trim(), b.email || '', b.tax_id || '', b.position || '', b.hire_date, b.pay_basis, rate, b.frequency, b.filing_status, cents(b.credits || 0), cents(b.extra_withholding || 0), pct,
    cents(b.pretax_deduction || 0), cents(b.other_deduction || 0), b.other_deduction_label || ''];
};
api.get('/payroll/employees', can('payroll'), wrap((_req, res) => ok(res, all('SELECT * FROM employees ORDER BY active DESC, name'))));
api.post('/payroll/employees', can('payroll', true), wrap((req, res) => {
  const nid = insert('INSERT INTO employees(name,email,tax_id,position,hire_date,pay_basis,pay_rate,frequency,filing_status,credits,extra_withholding,state_pct,pretax_deduction,other_deduction,other_deduction_label) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', ...empFields(req.body));
  audit(req, 'create', 'employee', nid, req.body.name); ok(res, get('SELECT * FROM employees WHERE id=?', nid));
}));
api.put('/payroll/employees/:id', can('payroll', true), wrap((req, res) => {
  const eid = id(req); if (!get('SELECT 1 FROM employees WHERE id=?', eid)) throw new HttpError(404, 'Employee not found');
  run('UPDATE employees SET name=?,email=?,tax_id=?,position=?,hire_date=?,pay_basis=?,pay_rate=?,frequency=?,filing_status=?,credits=?,extra_withholding=?,state_pct=?,pretax_deduction=?,other_deduction=?,other_deduction_label=?,active=? WHERE id=?', ...empFields(req.body), req.body.active === false ? 0 : 1, eid);
  audit(req, 'update', 'employee', eid); ok(res, get('SELECT * FROM employees WHERE id=?', eid));
}));
api.get('/payroll/runs', can('payroll'), wrap((_req, res) => ok(res, all('SELECT * FROM pay_runs ORDER BY pay_date DESC, id DESC LIMIT 200'))));
api.get('/payroll/runs/:id', can('payroll'), wrap((req, res) => { const r = pay.loadRun(id(req)); if (!r) throw new HttpError(404, 'Pay run not found'); ok(res, r); }));
api.post('/payroll/preview', can('payroll'), wrap((req, res) => ok(res, pay.previewRun(req.body, req.body.id || 0))));
api.post('/payroll/runs', can('payroll', true), wrap((req, res) => { const r = pay.saveRun({ ...req.body, id: undefined }, req.user); audit(req, 'create', 'payroll', r.id, `${r.period_start} – ${r.period_end}`); ok(res, r); }));
api.put('/payroll/runs/:id', can('payroll', true), wrap((req, res) => { const r = pay.saveRun({ ...req.body, id: id(req) }, req.user); audit(req, 'update', 'payroll', r.id); ok(res, r); }));
api.post('/payroll/runs/:id/finalize', can('payroll', true), wrap((req, res) => { const r = pay.finalizeRun(id(req), Number(req.body.paid_from_id), req.user); audit(req, 'finalize', 'payroll', r.id, `${r.gross}`); ok(res, r); }));
api.post('/payroll/runs/:id/void', can('payroll', true), wrap((req, res) => { const r = pay.voidRun(id(req)); audit(req, 'void', 'payroll', r.id); ok(res, r); }));
api.delete('/payroll/runs/:id', can('payroll', true), wrap((req, res) => { pay.deleteRun(id(req)); audit(req, 'delete', 'payroll', id(req)); ok(res, {}); }));
api.get('/payroll/liabilities', can('payroll'), wrap((_req, res) => ok(res, pay.liabilities())));
api.post('/payroll/remit', can('payroll', true), wrap((req, res) => { const r = pay.remit(req.body, req.user); audit(req, 'remit', 'payroll', null, `${r.total}`); ok(res, r); }));
api.get('/payroll/reports/summary', can('payroll'), wrap((req, res) => { const [f, t] = range(req); ok(res, pay.payrollSummary(f, t)); }));
api.get('/payroll/reports/941', can('payroll'), wrap((req, res) => ok(res, pay.form941(Number(req.query.year) || new Date().getFullYear(), Number(req.query.quarter) || 1))));
api.get('/payroll/reports/w2', can('payroll'), wrap((req, res) => ok(res, pay.w2Summary(Number(req.query.year) || new Date().getFullYear()))));
api.get('/reports/1099', can('reports'), requireFeature('contractors_1099'), wrap((req, res) => ok(res, pay.report1099(Number(req.query.year) || new Date().getFullYear()))));

/* ------------------- orçamento, classes, papéis, fechamento -------------------- */
api.get('/budgets', can('accounting'), requireFeature('budgets'), wrap((req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const rows = all("SELECT id, code, name, type FROM accounts WHERE type IN ('income','expense') AND active=1 ORDER BY code").map((a) => {
    const months = Array(12).fill(0);
    for (const b of all('SELECT month, amount FROM budgets WHERE account_id=? AND month LIKE ?', a.id, `${year}-%`)) months[Number(b.month.slice(5, 7)) - 1] = b.amount;
    return { ...a, months };
  });
  ok(res, { year, rows });
}));
api.put('/budgets', can('accounting', true), requireFeature('budgets'), wrap((req, res) => {
  const year = Number(req.body.year); if (!(year >= 2000 && year <= 2100)) throw bad('Invalid period');
  tx(() => {
    for (const r of req.body.rows || []) {
      if (!get("SELECT 1 FROM accounts WHERE id=? AND type IN ('income','expense')", r.account_id)) throw bad('Account not found');
      (r.months || []).slice(0, 12).forEach((v, i) => {
        const month = `${year}-${String(i + 1).padStart(2, '0')}`, amt = cents(v || 0);
        if (amt < 0) throw bad('Amounts cannot be negative');
        if (amt === 0) run('DELETE FROM budgets WHERE account_id=? AND month=?', r.account_id, month);
        else run('INSERT INTO budgets(account_id,month,amount) VALUES(?,?,?) ON CONFLICT(account_id,month) DO UPDATE SET amount=excluded.amount', r.account_id, month, amt);
      });
    }
  });
  audit(req, 'update', 'budget', null, String(year)); ok(res, {});
}));
api.get('/classes', wrap((_req, res) => ok(res, hasFeature('classes') ? all('SELECT * FROM classes ORDER BY name') : [])));
api.post('/classes', can('accounting', true), requireFeature('classes'), wrap((req, res) => {
  need(req.body.name, 'Enter the name');
  if (get('SELECT 1 FROM classes WHERE name=?', req.body.name.trim())) throw bad('A class with this name already exists');
  const nid = insert('INSERT INTO classes(name) VALUES(?)', req.body.name.trim()); audit(req, 'create', 'class', nid, req.body.name); ok(res, get('SELECT * FROM classes WHERE id=?', nid));
}));
api.put('/classes/:id', can('accounting', true), requireFeature('classes'), wrap((req, res) => {
  const c = get('SELECT * FROM classes WHERE id=?', id(req)); if (!c) throw new HttpError(404, 'Class not found');
  run('UPDATE classes SET name=?, active=? WHERE id=?', (req.body.name || c.name).trim(), req.body.active === undefined ? c.active : (req.body.active ? 1 : 0), c.id); ok(res, get('SELECT * FROM classes WHERE id=?', c.id));
}));
const roleBody = (b) => {
  need(b.name, 'Enter the name');
  const clean = (l) => [...new Set((l || []).filter((m) => MODULES.includes(m) && m !== 'settings'))];
  return [b.name.trim(), JSON.stringify(clean(b.read)), JSON.stringify(clean(b.write))];
};
api.get('/roles', can('users'), requireFeature('custom_roles'), wrap((_req, res) => ok(res, { modules: MODULES.filter((m) => m !== 'settings'), roles: all('SELECT * FROM roles ORDER BY name').map((r) => ({ ...r, read: JSON.parse(r.read), write: JSON.parse(r.write) })) })));
api.post('/roles', can('users', true), requireFeature('custom_roles'), wrap((req, res) => {
  const b = roleBody(req.body); if (get('SELECT 1 FROM roles WHERE name=?', b[0])) throw bad('A role with this name already exists');
  const nid = insert('INSERT INTO roles(name,read,write) VALUES(?,?,?)', ...b); audit(req, 'create', 'role', nid, b[0]); ok(res, { id: nid });
}));
api.put('/roles/:id', can('users', true), requireFeature('custom_roles'), wrap((req, res) => {
  if (!get('SELECT 1 FROM roles WHERE id=?', id(req))) throw new HttpError(404, 'Role not found');
  run('UPDATE roles SET name=?, read=?, write=? WHERE id=?', ...roleBody(req.body), id(req)); audit(req, 'update', 'role', id(req)); ok(res, {});
}));
api.delete('/roles/:id', can('users', true), requireFeature('custom_roles'), wrap((req, res) => {
  if (get('SELECT 1 FROM users WHERE custom_role_id=?', id(req))) throw bad('Reassign the users of this role first');
  run('DELETE FROM roles WHERE id=?', id(req)); audit(req, 'delete', 'role', id(req)); ok(res, {});
}));
api.put('/lock-date', can('accounting', true), requireFeature('period_lock'), wrap((req, res) => {
  const d = req.body.date || '';
  if (d && !isDate(d)) throw bad('Invalid date');
  setSetting('lock_date', d); audit(req, 'update', 'settings', null, `books closed through ${d || 'none'}`); ok(res, { lockDate: d });
}));

/* -------------------------------- relatórios ------------------------------ */
const REPORT_FEATURE = { 'ap-aging': 'reports_full', 'expenses-by-vendor': 'reports_full', tax: 'reports_full', 'trial-balance': 'reports_full', inventory: 'inventory', budget: 'budgets', 'pnl-class': 'classes', '1099': 'contractors_1099' };
api.use('/reports/:name', (req, res, next) => { const f = REPORT_FEATURE[req.params.name]; return f ? requireFeature(f)(req, res, next) : next(); });
api.get('/reports/budget', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.budgetVsActual(f, t)); }));
api.get('/reports/pnl-class', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.plByClass(f, t)); }));
api.get('/dashboard', can('reports'), wrap((_req, res) => ok(res, rep.dashboard())));
api.get('/reports/pnl', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.profitAndLoss(f, t)); }));
api.get('/reports/balance-sheet', can('reports'), wrap((req, res) => ok(res, rep.balanceSheet(req.query.asof || today()))));
api.get('/reports/trial-balance', can('reports'), wrap((req, res) => ok(res, rep.trialBalance(req.query.asof || today()))));
api.get('/reports/cash-flow', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.cashFlow(f, t)); }));
api.get('/reports/ar-aging', can('reports'), wrap((req, res) => ok(res, rep.aging('receivable', req.query.asof || today()))));
api.get('/reports/ap-aging', can('reports'), wrap((req, res) => ok(res, rep.aging('payable', req.query.asof || today()))));
api.get('/reports/sales-by-customer', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.salesByCustomer(f, t)); }));
api.get('/reports/expenses-by-category', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.expensesByCategory(f, t)); }));
api.get('/reports/expenses-by-vendor', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.expensesByVendor(f, t)); }));
api.get('/reports/tax', can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, rep.taxSummary(f, t)); }));
api.get('/reports/inventory', can('reports'), wrap((_req, res) => ok(res, rep.inventoryValuation())));

// backup completo em JSON (somente proprietário)
api.get('/export', can('users'), wrap((_req, res) => {
  const tables = ['settings', 'accounts', 'contacts', 'items', 'projects', 'docs', 'doc_lines', 'payments', 'expenses', 'journal_entries', 'journal_lines', 'bank_txns', 'bank_rules', 'time_entries', 'recurring', 'employees', 'pay_runs', 'pay_run_lines', 'payroll_remittances'];
  res.setHeader('Content-Disposition', `attachment; filename="fluxo-backup-${today()}.json"`);
  ok(res, Object.fromEntries(tables.map((t) => [t, all(`SELECT * FROM ${t}`)])));
}));

api.use((req, _res, next) => next(new HttpError(404, 'Route not found')));
app.use('/api', api);

/* ---------------------------- frontend estático --------------------------- */
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'File too large' });
  if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'Duplicate record' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 4000);
  app.listen(port, () => console.log(`Fluxo rodando em http://localhost:${port}`));
  const tick = () => { try { const n = acc.runRecurring().length; if (n) console.log(`${n} fatura(s) recorrente(s) geradas`); } catch (e) { console.error(e); } };
  tick(); setInterval(tick, 60 * 60 * 1000).unref();
}
