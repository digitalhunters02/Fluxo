// Integrações: chaves de API e webhooks (para o dono) e a API pública /api/v1 (para outros sistemas).
// Chave: flx_live_<empresa>.<segredo> (a empresa vem na chave porque cada empresa tem o seu arquivo). Só o SHA-256 fica no banco;
// a chave inteira aparece uma única vez, na criação. Valores em centavos. Chave "read" só lê; "write" também grava.
// Gravações aceitam "externalId": reenviar o mesmo externalId nunca duplica (responde 200 com o registro que já existe).
import crypto from 'node:crypto';
import express from 'express';
import { all, get, run, insert } from './db.js';
import * as acc from './accounting.js';
import * as tenants from './tenants.js';
import { hasFeature, currentPlan, limitFor } from './plans.js';
import { appUrl } from './mailer.js';
import { assertSafeUrl, deliver, EVENTS, emit } from './events.js';

const { HttpError, today, isDate } = acc;
const bad = (m) => new HttpError(400, m);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const PREFIX = 'flx_live_';

/* ----------------------------- administração (dono) ----------------------------- */
export function registerIntegrationAdmin(api, { wrap, ok, can, requireFeature, audit, id }) {
  const feat = requireFeature('api');
  api.get('/integrations/keys', can('settings'), feat, wrap((_req, res) => ok(res, { keys: all('SELECT id,name,prefix,scope,last_used_at,created_at FROM api_keys WHERE revoked=0 ORDER BY created_at DESC, rowid DESC') })));
  api.post('/integrations/keys', can('settings', true), feat, wrap((req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const scope = req.body?.scope === 'read' ? 'read' : 'write';
    if (!name) throw bad('Give the key a name (for example: Website form)');
    if (get('SELECT COUNT(*) AS n FROM api_keys WHERE revoked=0').n >= 10) throw new HttpError(409, 'Limit of 10 keys. Revoke one first');
    const slug = tenants.multiEnabled() ? tenants.currentSlug() : '';
    const key = `${PREFIX}${slug}.${crypto.randomBytes(32).toString('base64url')}`;
    const kid = crypto.randomUUID();
    run('INSERT INTO api_keys(id,name,prefix,key_hash,scope) VALUES(?,?,?,?,?)', kid, name, key.slice(0, 18), sha256(key), scope);
    audit(req, 'create', 'api_key', null, name);
    ok(res, { id: kid, key, prefix: key.slice(0, 18), scope, note: 'Save this key now: it will not be shown again.' });
  }));
  api.delete('/integrations/keys/:id', can('settings', true), feat, wrap((req, res) => { run('UPDATE api_keys SET revoked=1 WHERE id=?', req.params.id); audit(req, 'revoke', 'api_key'); ok(res, {}); }));

  api.get('/integrations/webhooks', can('settings'), feat, wrap((_req, res) => ok(res, {
    webhooks: all('SELECT id,url,events,active,failures,last_status,last_at,created_at FROM webhooks ORDER BY created_at DESC, rowid DESC').map((w) => ({ ...w, events: JSON.parse(w.events || '[]'), active: w.active === 1 })), events: EVENTS })));
  api.post('/integrations/webhooks', can('settings', true), feat, wrap(async (req, res) => {
    const url = String(req.body?.url || '').trim().slice(0, 500);
    try { await assertSafeUrl(url); } catch (e) { throw bad(e.message); }
    const events = Array.isArray(req.body?.events) && req.body.events.length ? req.body.events.map(String) : ['*'];
    if (events.some((e) => e !== '*' && !EVENTS.includes(e))) throw bad('Unknown event');
    if (get('SELECT COUNT(*) AS n FROM webhooks').n >= 10) throw new HttpError(409, 'Limit of 10 webhooks');
    const wid = crypto.randomUUID();
    const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
    run('INSERT INTO webhooks(id,url,secret,events) VALUES(?,?,?,?)', wid, url, secret, JSON.stringify(events));
    audit(req, 'create', 'webhook', null, url);
    ok(res, { id: wid, secret, note: 'Save the secret now: it will not be shown again. Use it to check the X-Fluxo-Signature header.' });
  }));
  api.post('/integrations/webhooks/:id/test', can('settings', true), feat, wrap(async (req, res) => {
    const hook = get('SELECT * FROM webhooks WHERE id=?', req.params.id);
    if (!hook) throw new HttpError(404, 'Webhook not found');
    ok(res, await deliver(hook, 'webhook.test', { message: 'Test event from Fluxo' }));
  }));
  api.delete('/integrations/webhooks/:id', can('settings', true), feat, wrap((req, res) => { run('DELETE FROM webhooks WHERE id=?', req.params.id); ok(res, {}); }));
}

/* ----------------------------------- API pública ----------------------------------- */
const hits = new Map(); // limite simples por chave: 600 pedidos por minuto
function throttle(keyId) {
  const now = Date.now();
  const rec = (hits.get(keyId) || []).filter((t) => now - t < 60_000);
  if (rec.length >= 600) throw new HttpError(429, 'Too many requests');
  rec.push(now); hits.set(keyId, rec);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t >= 60_000)) hits.delete(k);
}

const ext = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, 100));
const docOut = (d) => ({ id: d.id, number: d.number, type: d.type, customerId: d.contact_id, customerName: d.contact_name, issueDate: d.issue_date, dueDate: d.due_date, status: d.status, subtotalCents: d.subtotal, taxCents: d.tax, totalCents: d.total, paidCents: d.paid, balanceCents: d.balance, externalId: d.external_id || null });
const contactOut = (c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, address: c.address, kind: c.kind, externalId: c.external_id || null });

export function createV1Router() {
  const r = express.Router();
  const wrap = (fn) => (req, res, next) => { try { Promise.resolve(fn(req, res)).catch(next); } catch (e) { next(e); } };

  // 1) quem é? acha a empresa pela chave e roda o resto dentro do banco dela
  r.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const key = header.startsWith(`Bearer ${PREFIX}`) ? header.slice(7) : '';
    if (!key) return next(new HttpError(401, 'API key required (Authorization: Bearer flx_live_...)'));
    const slug = key.slice(PREFIX.length).split('.')[0];
    const run_ = () => {
      const k = get('SELECT * FROM api_keys WHERE key_hash=? AND revoked=0', sha256(key));
      if (!k) return next(new HttpError(401, 'Invalid or revoked API key'));
      try {
        throttle(k.id);
        if (!hasFeature('api')) throw new HttpError(402, 'The API is part of the Advanced plan and up', { feature: 'api', required: 'advanced' });
        if (k.scope === 'read' && req.method !== 'GET') throw new HttpError(403, 'This key is read-only');
      } catch (e) { return next(e); }
      run('UPDATE api_keys SET last_used_at=CURRENT_TIMESTAMP WHERE id=?', k.id);
      next();
    };
    if (tenants.multiEnabled()) {
      if (!tenants.tenantExists(slug)) return next(new HttpError(401, 'Invalid or revoked API key'));
      if (tenants.isSuspended(slug)) return next(new HttpError(403, 'This account is suspended'));
      return tenants.inTenant(slug, run_);
    }
    if (slug) return next(new HttpError(401, 'Invalid or revoked API key'));
    run_();
  });

  const cust = (v) => {
    if (v.customerId) { const c = get('SELECT id FROM contacts WHERE id=?', Number(v.customerId)); if (c) return c.id; }
    if (v.customerExternalId) { const c = get('SELECT id FROM contacts WHERE external_id=?', String(v.customerExternalId)); if (c) return c.id; }
    throw bad('Unknown customer (send customerId or customerExternalId)');
  };

  // Quem sou eu: o CRM usa ao ligar a conexão (plano, endereço do site e banco) para sugerir o endereço
  // certo e não deixar o cliente sem banco.
  r.get('/me', wrap((_req, res) => {
    const max = limitFor('bank_connections');
    const plan = currentPlan();
    res.json({
      product: 'fluxo', plan, planName: plan.charAt(0).toUpperCase() + plan.slice(1), appUrl: appUrl(),
      features: { api: hasFeature('api'), online_payments: hasFeature('online_payments') },
      bank: { allowed: hasFeature('bank_feeds') && (max === null || max > 0), max, connected: get('SELECT COUNT(*) AS n FROM plaid_items').n },
    });
  }));

  r.get('/customers', wrap((req, res) => res.json({ customers: all("SELECT * FROM contacts WHERE active=1 AND kind IN ('customer','both') ORDER BY name LIMIT 1000").map(contactOut) })));
  r.post('/customers', wrap((req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) throw bad('name is required');
    const externalId = ext(b.externalId);
    if (externalId) { const ex = get('SELECT * FROM contacts WHERE external_id=?', externalId); if (ex) return res.status(200).json({ customer: contactOut(ex), duplicate: true }); }
    const cid = insert("INSERT INTO contacts(kind,name,email,phone,address,external_id) VALUES('customer',?,?,?,?,?)", name, String(b.email || '').slice(0, 200), String(b.phone || '').slice(0, 60), String(b.address || '').slice(0, 300), externalId);
    const c = get('SELECT * FROM contacts WHERE id=?', cid);
    emit('customer.created', { id: c.id, name: c.name, externalId });
    res.status(201).json({ customer: contactOut(c) });
  }));

  r.get('/invoices', wrap((req, res) => {
    const rows = all("SELECT id FROM docs WHERE type='invoice' ORDER BY id DESC LIMIT ?", Math.min(Math.max(Number(req.query.limit) || 100, 1), 500));
    res.json({ invoices: rows.map((x) => docOut(acc.loadDoc(x.id))) });
  }));
  r.get('/invoices/:id', wrap((req, res) => {
    const d = acc.loadDoc(Number(req.params.id));
    if (!d || d.type !== 'invoice') throw new HttpError(404, 'Invoice not found');
    res.json({ invoice: { ...docOut(d), lines: d.lines.map((l) => ({ description: l.description, qty: l.qty, unitPriceCents: l.unit_price, amountCents: l.amount })) } });
  }));
  r.post('/invoices', wrap((req, res) => {
    const b = req.body || {};
    const externalId = ext(b.externalId);
    if (externalId) { const ex = get("SELECT id FROM docs WHERE external_id=? AND type='invoice'", externalId); if (ex) return res.status(200).json({ invoice: docOut(acc.loadDoc(ex.id)), duplicate: true }); }
    const issue = b.issueDate || today();
    if (!isDate(issue)) throw bad('issueDate must be YYYY-MM-DD');
    const lines = (Array.isArray(b.lines) ? b.lines : []).map((l) => ({ description: String(l.description || ''), qty: Number(l.qty ?? 1), unit_price: Math.round(Number(l.unitPriceCents)), tax_rate: Number(l.taxRate || 0) }));
    if (lines.some((l) => !Number.isFinite(l.unit_price) || !Number.isFinite(l.qty))) throw bad('Each line needs qty and unitPriceCents');
    const doc = acc.saveDoc({ type: 'invoice', contact_id: cust(b), issue_date: issue, due_date: b.dueDate || issue, notes: String(b.notes || '').slice(0, 1000), post: b.post !== false, lines }, null);
    if (externalId) run('UPDATE docs SET external_id=? WHERE id=?', externalId, doc.id);
    res.status(201).json({ invoice: docOut(acc.loadDoc(doc.id)) });
  }));
  r.post('/invoices/:id/payments', wrap((req, res) => {
    const b = req.body || {};
    const accountId = b.accountId ? Number(b.accountId) : get("SELECT id FROM accounts WHERE subtype='bank' AND active=1 ORDER BY code LIMIT 1")?.id;
    const d = acc.addPayment(Number(req.params.id), { date: b.date || today(), amount: Math.round(Number(b.amountCents)), account_id: accountId, method: String(b.method || 'api').slice(0, 30), ref: String(b.reference || '').slice(0, 100) }, null);
    res.status(201).json({ invoice: docOut(d) });
  }));

  r.use((_req, _res, next) => next(new HttpError(404, 'Unknown endpoint')));
  return r;
}
