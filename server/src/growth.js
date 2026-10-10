// Pacote de crescimento do Fluxo: integrações (API/webhooks), e-mail de faturas, pagamento online (Stripe Connect), migração do
// QuickBooks/Xero, aprovações, ativos fixos, fechamento do mês, previsão de caixa, grupo de empresas e login único (SSO).
// As rotas são registradas em duas etapas: as públicas (sem sessão) antes de api.use(requireAuth), as demais depois.
import { all, get, run, getSetting, setSetting } from './db.js';
import * as tenants from './tenants.js';
import * as acc from './accounting.js';
import * as rep from './reports.js';
import * as billing from './billing.js';
import * as connect from './connect.js';
import * as mig from './migrate.js';
import * as approvals from './approvals.js';
import { requireFresh } from './twofa.js';
import * as assets from './assets.js';
import * as close from './close.js';
import * as groups from './groups.js';
import * as docmail from './docmail.js';
import * as mailer from './mailer.js';
import { registerIntegrationAdmin } from './integrations.js';
import { registerSsoPublic, ssoSettings, saveSsoSettings } from './sso.js';
import { hasFeature } from './plans.js';
import { rateLimitLogin } from './auth.js';

const { HttpError, today, isDate } = acc;
const bad = (m) => new HttpError(400, m);
const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export function registerGrowthPublic(api, h) {
  const { wrap, ok, publicTenant, withSlug } = h;

  // Stripe Connect: pagamentos de faturas e atualização da conta conectada (assinado com STRIPE_CONNECT_WEBHOOK_SECRET)
  api.post('/stripe/connect-webhook', wrap(async (req, res) => {
    billing.verifyStripeSignature(req.rawBody || Buffer.from(''), req.headers['stripe-signature'], connect.connectWebhookSecret());
    const ev = req.body || {};
    if (!tenants.multiEnabled()) return ok(res, connect.handleConnectEvent(ev));
    const slug = tenants.slugForLink('connect_account', ev.account) || (tenants.tenantExists(ev.data?.object?.metadata?.fluxo_slug) ? ev.data.object.metadata.fluxo_slug : null);
    ok(res, slug ? tenants.inTenant(slug, () => connect.handleConnectEvent(ev)) : { ignored: true });
  }));

  // o cliente da empresa paga a fatura pelo link público
  api.post('/public/doc/:token/pay', publicTenant, wrap(async (req, res) => {
    rateLimitLogin(`pay|${req.params.token}|${req.ip}`);
    if (!hasFeature('online_payments')) throw new HttpError(402, 'Online payments are not available for this company');
    const row = get("SELECT id FROM docs WHERE share_token=? AND type='invoice'", req.params.token);
    if (!row) throw new HttpError(404, 'Document not found');
    ok(res, await connect.createPayLink(acc.loadDoc(row.id), withSlug(req.params.token), billing.originOf(req)));
  }));

  registerSsoPublic(api, h);
}

export function registerGrowth(api, h) {
  const { wrap, ok, can, requireFeature, audit, id, withSlug, multi } = h;
  const need = (v, m) => { if (v === undefined || v === null || String(v).trim() === '') throw bad(m); return v; };

  registerIntegrationAdmin(api, h);

  /* ------------------------------ e-mail de faturas ------------------------------ */
  api.post('/doc/:id/email', can('sales', true), requireFeature('email_invoices'), wrap(async (req, res) => {
    const d = acc.loadDoc(id(req));
    if (!d) throw new HttpError(404, 'Document not found');
    const link = `${billing.originOf(req)}/p/${withSlug(d.share_token)}`;
    const r = await docmail.emailDocument(d.id, req.body || {}, link);
    audit(req, 'email', d.type, d.id, `${d.number} → ${r.sentTo}`);
    ok(res, r);
  }));
  api.get('/email/status', wrap((_req, res) => ok(res, { ready: docmail.emailReady() })));

  /* ------------------------------ pagamento online ------------------------------ */
  api.get('/connect/status', can('settings'), wrap(async (_req, res) => ok(res, hasFeature('online_payments') ? await connect.connectStatus() : { available: false })));
  api.post('/connect/onboard', can('settings', true), requireFeature('online_payments'), wrap(async (req, res) => ok(res, await connect.startOnboarding(billing.originOf(req)))));
  api.put('/connect/settings', can('settings', true), requireFeature('online_payments'), wrap((req, res) => { connect.saveConnectSettings(req.body || {}); audit(req, 'update', 'settings', null, 'online payments'); ok(res, {}); }));

  /* ------------------------------ migração ------------------------------ */
  api.post('/migrate/:kind', can('accounting', true), wrap((req, res) => {
    const b = req.body || {};
    const out = mig.runMigration({ kind: req.params.kind, csv: b.csv, apply: !!b.apply, asof: b.asof, contactKind: b.contact_kind }, req.user);
    if (b.apply) audit(req, 'import', 'migration', null, req.params.kind);
    ok(res, out);
  }));

  /* ------------------------------ aprovações ------------------------------ */
  api.get('/approvals', can('purchases'), requireFeature('approvals'), wrap((_req, res) => ok(res, { settings: approvals.approvalSettings(), pending: approvals.pendingApprovals() })));
  api.put('/approvals/settings', can('settings', true), requireFeature('approvals'), wrap((req, res) => { const r = approvals.saveApprovalSettings(req.body || {}); audit(req, 'update', 'settings', null, 'approvals'); ok(res, r); }));
  for (const action of ['approve', 'reject']) {
    api.post(`/doc/:id/${action}`, can('purchases', true), requireFresh, requireFeature('approvals'), wrap((req, res) => { const d = approvals.decide(id(req), action, req.user); audit(req, action, 'bill', d.id, d.number); ok(res, d); }));
  }

  /* ------------------------------ ativos fixos ------------------------------ */
  const fa = [can('accounting'), requireFeature('fixed_assets')], faw = [can('accounting', true), requireFeature('fixed_assets')];
  api.get('/assets', ...fa, wrap((_req, res) => ok(res, { assets: assets.listAssets() })));
  api.post('/assets', ...faw, wrap((req, res) => { const a = assets.createAsset(req.body || {}); audit(req, 'create', 'asset', a.id, a.name); ok(res, a); }));
  api.post('/assets/depreciate', ...faw, wrap((req, res) => { const r = assets.depreciate(req.body?.through || today().slice(0, 7), req.user); audit(req, 'depreciate', 'asset', null, `${r.posted.length} entries`); ok(res, r); }));
  api.post('/assets/:id/dispose', ...faw, wrap((req, res) => { const a = assets.disposeAsset(id(req), req.body || {}, req.user); audit(req, 'dispose', 'asset', a.id, a.name); ok(res, a); }));
  api.delete('/assets/:id', ...faw, wrap((req, res) => {
    const a = assets.loadAsset(id(req));
    if (!a) throw new HttpError(404, 'Asset not found');
    if (a.months_done || a.status === 'disposed') throw bad('This asset already has depreciation or was disposed of. Dispose of it instead of deleting');
    run('DELETE FROM fixed_assets WHERE id=?', a.id); audit(req, 'delete', 'asset', a.id, a.name); ok(res, {});
  }));

  /* ------------------------------ fechamento do mês ------------------------------ */
  const cl = [can('accounting'), requireFeature('close_checklist')], clw = [can('accounting', true), requireFeature('close_checklist')];
  api.get('/close/:period', ...cl, wrap((req, res) => ok(res, close.checklist(req.params.period))));
  api.post('/close/:period/lock', ...clw, wrap((req, res) => { const r = close.closeMonth(req.params.period); audit(req, 'close', 'period', null, req.params.period); ok(res, r); }));
  api.post('/close/:period/:key', ...clw, wrap((req, res) => ok(res, close.toggleTask(req.params.period, req.params.key, req.body?.done !== false, req.user))));

  /* ------------------------------ previsão e auditoria ------------------------------ */
  api.get('/reports/forecast', can('reports'), requireFeature('forecast'), wrap((req, res) => ok(res, rep.cashForecast(req.query.weeks))));
  api.get('/audit/export.csv', can('users'), requireFeature('audit_export'), wrap((_req, res) => {
    const rows = all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100000');
    const lines = [['when', 'user', 'action', 'entity', 'entity_id', 'detail'].join(',')].concat(rows.map((r) => [r.at, r.user_name, r.action, r.entity, r.entity_id, r.detail].map(csvCell).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="fluxo-audit-log.csv"'); res.send(lines.join('\n'));
  }));

  /* ------------------------------ grupo de empresas (modo multiempresa) ------------------------------ */
  const needMulti = (_req, _res, next) => (multi() ? next() : next(new HttpError(404, 'Company groups are only available on the hosted version')));
  api.get('/group', needMulti, can('settings'), wrap((_req, res) => ok(res, groups.info())));
  api.post('/group', needMulti, can('users', true), requireFeature('multi_company'), wrap((req, res) => { const r = groups.create(need(req.body?.name, 'Name the group')); audit(req, 'create', 'group'); ok(res, r); }));
  api.post('/group/invite', needMulti, can('users', true), wrap((_req, res) => ok(res, groups.invite())));
  api.post('/group/join', needMulti, can('users', true), wrap((req, res) => { const r = groups.join(req.body?.code); audit(req, 'join', 'group'); ok(res, r); }));
  api.post('/group/leave', needMulti, can('users', true), wrap((req, res) => { const r = groups.leave(); audit(req, 'leave', 'group'); ok(res, r); }));
  const range = (req) => { const t = today(); const from = req.query.from || `${t.slice(0, 4)}-01-01`, to = req.query.to || t; if (!isDate(from) || !isDate(to) || from > to) throw bad('Invalid period'); return [from, to]; };
  api.get('/group/reports/pnl', needMulti, can('reports'), wrap((req, res) => { const [f, t] = range(req); ok(res, groups.consolidatedPnl(f, t)); }));
  api.get('/group/reports/balance-sheet', needMulti, can('reports'), wrap((req, res) => ok(res, groups.consolidatedBalanceSheet(req.query.asof || today()))));

  /* ------------------------------ login único (configuração) ------------------------------ */
  api.get('/sso/settings', can('users'), wrap((_req, res) => ok(res, { ...ssoSettings(), available: hasFeature('sso') })));
  api.put('/sso/settings', can('users', true), requireFeature('sso'), wrap((req, res) => { const r = saveSsoSettings(req.body || {}); audit(req, 'update', 'settings', null, 'sso'); ok(res, r); }));
}
