// Painel do administrador da plataforma (modo multi-empresa). Acesso por e-mail e senha definidos no ambiente.
import crypto from 'node:crypto';
import { get, getSetting } from './db.js';
import { HttpError } from './accounting.js';
import * as tenants from './tenants.js';

const TTL = 12 * 60 * 60 * 1000;
const cfg = () => ({ email: String(process.env.FLUXO_ADMIN_EMAIL || '').trim().toLowerCase(), password: String(process.env.FLUXO_ADMIN_PASSWORD || '') });
export const adminEnabled = () => tenants.multiEnabled() && !!cfg().email && cfg().password.length >= 12;
const secret = () => crypto.createHash('sha256').update(`fluxo-admin|${cfg().password}|${process.env.FLUXO_ENCRYPTION_KEY || ''}`).digest();
const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function adminLogin(email, password) {
  if (!adminEnabled()) throw new HttpError(404, 'Route not found');
  const c = cfg();
  // compara os dois campos sempre, para não revelar qual deles está errado
  const okEmail = safeEq(String(email || '').trim().toLowerCase(), c.email), okPass = safeEq(String(password || ''), c.password);
  if (!(okEmail && okPass)) throw new HttpError(401, 'Incorrect email or password');
  const exp = Date.now() + TTL, payload = `admin|${exp}`;
  return `admin.${exp}.${sign(payload)}`;
}
export function requireAdmin(req, _res, next) {
  if (!adminEnabled()) return next(new HttpError(404, 'Route not found'));
  const h = req.headers.authorization || '';
  const [kind, exp, sig] = (h.startsWith('Bearer ') ? h.slice(7) : '').split('.');
  if (kind !== 'admin' || !/^\d+$/.test(exp || '') || Number(exp) < Date.now() || !sig || !safeEq(sig, sign(`admin|${exp}`))) return next(new HttpError(401, 'Session expired, please sign in again'));
  next();
}

/** Resumo de cada empresa, lido do banco dela (plano, assinatura, uso). */
export function overview() {
  const rows = tenants.listTenants().map((t) => tenants.inTenant(t.slug, () => ({
    ...t, plan: getSetting('plan', 'free'), payroll: getSetting('addon_payroll', '0') === '1', subscription: getSetting('subscription_status', '') || (getSetting('plan', 'free') === 'free' ? 'free' : 'manual'),
    users: get('SELECT COUNT(*) n FROM users WHERE active=1').n, invoices: get("SELECT COUNT(*) n FROM docs WHERE type='invoice'").n,
    last_invoice: get("SELECT MAX(created_at) d FROM docs WHERE type='invoice'").d || '',
  })));
  const byPlan = {};
  for (const r of rows) byPlan[r.plan] = (byPlan[r.plan] || 0) + 1;
  return { total: rows.length, active: rows.filter((r) => r.status === 'active').length, byPlan, tenants: rows };
}
