// Planos e permissões por função: cada recurso exige um plano mínimo (como o QuickBooks Online).
import { getSetting, setSetting } from './db.js';
import { HttpError } from './accounting.js';

export const PLAN_ORDER = ['starter', 'essentials', 'plus', 'advanced'];
export const PLAN_PRICES = { starter: 29, essentials: 65, plus: 109, advanced: 269 };
export const PAYROLL_ADDON_PRICE = { base: 35, perEmployee: 5 };

/** recurso -> plano mínimo. Recursos que não aparecem aqui valem para todos os planos. */
export const FEATURES = {
  bills: 'essentials', recurring: 'essentials', time_tracking: 'essentials', audit_log: 'essentials', reports_full: 'essentials',
  bank_feeds: 'essentials', inventory: 'plus', project_profit: 'plus', contractors_1099: 'plus', budgets: 'plus', purchase_orders: 'plus', period_lock: 'plus', classes: 'plus',
  custom_roles: 'advanced', batch_invoices: 'advanced',
};
export const ADDON_FEATURES = ['payroll'];
/** Limites numéricos por plano (conexões bancárias automáticas). */
export const LIMITS = { bank_connections: { starter: 0, essentials: 2, plus: 5, advanced: 15 } };
export const limitFor = (name) => LIMITS[name][currentPlan()];

export const currentPlan = () => { const p = getSetting('plan', 'advanced'); return PLAN_ORDER.includes(p) ? p : 'advanced'; };
export const hasAddon = (a) => getSetting(`addon_${a}`, '0') === '1';
export function hasFeature(f) {
  if (ADDON_FEATURES.includes(f)) return hasAddon(f);
  const min = FEATURES[f];
  if (!min) return true;
  return PLAN_ORDER.indexOf(currentPlan()) >= PLAN_ORDER.indexOf(min);
}
export const featureMap = () => Object.fromEntries([...Object.keys(FEATURES), ...ADDON_FEATURES].map((f) => [f, hasFeature(f)]));

export function assertFeature(f) {
  if (hasFeature(f)) return;
  if (ADDON_FEATURES.includes(f)) throw new HttpError(402, 'The payroll add-on is not active', { feature: f, required: 'addon' });
  throw new HttpError(402, 'Your plan does not include this feature', { feature: f, required: FEATURES[f] });
}
/** middleware Express */
export const requireFeature = (f) => (_req, _res, next) => { try { assertFeature(f); next(); } catch (e) { next(e); } };

export function setPlan({ plan, payroll }) {
  if (plan !== undefined) { if (!PLAN_ORDER.includes(plan)) throw new HttpError(400, 'Invalid plan'); setSetting('plan', plan); }
  if (payroll !== undefined) setSetting('addon_payroll', payroll ? '1' : '0');
}
