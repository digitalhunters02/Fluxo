// Planos e permissões por função: cada recurso exige um plano mínimo (como o QuickBooks Online).
import { getSetting, setSetting } from './db.js';
import { HttpError } from './accounting.js';
import { makeGates } from './planGates.js';
import { previewPlanNow } from './owner.js';

export const PLAN_ORDER = ['free', 'starter', 'essentials', 'plus', 'advanced', 'business', 'enterprise'];
/** Planos com assinatura no Stripe (o plano free não tem preço nem cobrança). */
export const PAID_PLANS = PLAN_ORDER.filter((p) => p !== 'free');
export const PLAN_PRICES = { free: 0, starter: 29, essentials: 65, plus: 109, advanced: 269, business: 599, enterprise: 900 };
/** Enterprise: US$ 900/mês, assinatura mensal no Stripe. Inclui 10 empresas no grupo; cada empresa a mais soma US$ 100 por mês (item de quantidade). */
export const ENTERPRISE_FROM = PLAN_PRICES.enterprise;
export const ENTERPRISE_INCLUDED_COMPANIES = 10;
export const ENTERPRISE_EXTRA_COMPANY = 100;
/** Quanto o Enterprise custa por mês para um grupo com este número de empresas. */
export const enterpriseMonthly = (companies) => ENTERPRISE_FROM + Math.max(0, Number(companies || 0) - ENTERPRISE_INCLUDED_COMPANIES) * ENTERPRISE_EXTRA_COMPANY;
export const PAYROLL_ADDON_PRICE = { base: 35, perEmployee: 5 };

/** recurso -> plano mínimo. Recursos que não aparecem aqui valem para todos os planos. */
export const FEATURES = {
  credit_memos: 'starter', branding: 'starter', user_access: 'starter', accountant_access: 'starter',
  bills: 'essentials', recurring: 'essentials', time_tracking: 'essentials', audit_log: 'essentials', reports_full: 'essentials',
  bank_feeds: 'essentials', inventory: 'plus', project_profit: 'plus', contractors_1099: 'plus', budgets: 'plus', purchase_orders: 'plus', period_lock: 'plus', classes: 'plus',
  custom_roles: 'advanced', batch_invoices: 'advanced',
  ai_assistant: 'essentials', email_invoices: 'essentials', forecast: 'plus', api: 'advanced', online_payments: 'advanced',
  approvals: 'business', fixed_assets: 'business', multi_company: 'business', close_checklist: 'business', audit_export: 'business',
  sso: 'enterprise',
};
export const ADDON_FEATURES = ['payroll'];
/** Limites numéricos por plano (conexões bancárias automáticas). */
export const LIMITS = {
  bank_connections: { free: 0, starter: 0, essentials: 2, plus: 5, advanced: 15 },
  invoices_per_month: { free: 5 }, // plano free: 5 faturas novas por mês; os demais planos não têm limite
  users: { free: 1 },
  accountants: { starter: 1, essentials: 1, plus: 3 }, // contadores convidados (só leitura): Advanced em diante sem limite
  group_companies: { business: 5 }, // empresas do mesmo grupo na consolidação; Enterprise sem limite
};
/** Limite do plano atual; null = sem limite. */
export const limitFor = (name) => LIMITS[name][currentPlan()] ?? null;

/** Plano em vigor. Na requisição do DONO da plataforma em modo "ver como plano" (X-Preview-Plan), é o plano visto — só durante a requisição, nada é gravado. */
export const currentPlan = () => {
  const view = previewPlanNow();
  if (view && PLAN_ORDER.includes(view)) return view;
  const p = getSetting('plan', 'advanced'); return PLAN_ORDER.includes(p) ? p : 'advanced';
};
/** Plano de uma empresa específica (usado pela consolidação do grupo, que lê várias empresas). */
export const planRank = (name) => PLAN_ORDER.indexOf(name);
export const hasAddon = (a) => (previewPlanNow() ? false : getSetting(`addon_${a}`, '0') === '1'); // na prévia o cliente do plano visto não tem complemento
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

// ---- RECURSOS COM SELO ("mapa recurso -> plano mínimo") ----
// A fonte é FEATURES (acima): uma linha por recurso. EXTRA_GATES são limites que também ganham selo (ex.: fatura ilimitada).
// O plano mínimo de cada recurso e "o que cada plano acrescenta" saem daqui; o front só consome (/me, /plan e /public/plans).
export const EXTRA_GATES = { unlimited_invoices: 'starter', photo_import: 'essentials' }; // fatura ilimitada (Free: 5 por mês) e leitura de recibo por foto
const GATE_MIN = { ...FEATURES, ...EXTRA_GATES };
const cap = (k) => k[0].toUpperCase() + k.slice(1);
const PLAN_DEFS = Object.fromEntries(PLAN_ORDER.map((key, rank) => [key, { key, name: cap(key), sold: true, rank }]));
const GATE_FNS = Object.fromEntries(Object.entries(GATE_MIN).map(([g, min]) => [g, (p) => p.rank >= PLAN_DEFS[min].rank]));
const gateTable = makeGates(PLAN_DEFS, GATE_FNS, 'free');
export const minPlanForGate = (g) => (ADDON_FEATURES.includes(g) ? null : gateTable.minPlanForGate(g));

/** { recurso: { minPlan, locked } } para o plano EM VIGOR (sem argumento: só o plano mínimo, para a página pública). Complementos: { addon, locked }. */
export function publicGates(planKey) {
  const out = gateTable.publicGates(planKey);
  for (const a of ADDON_FEATURES) out[a] = { minPlan: null, addon: a, ...(planKey ? { locked: !hasAddon(a) } : {}) };
  return out;
}

/** Catálogo para o front: planos na ordem de venda, preço mensal/anual e o que cada plano ACRESCENTA. `yearly` = { plano: preço anual }. */
export function publicCatalog(yearly = {}) {
  const adds = gateTable.addsByPlan();
  return PLAN_ORDER.map((key) => ({ key, name: PLAN_DEFS[key].name, rank: PLAN_DEFS[key].rank, price: { month: PLAN_PRICES[key], year: yearly[key] ?? PLAN_PRICES[key] * 12 }, adds: adds[key] || [] }));
}
/** Complementos vendidos à parte (folha de pagamento): preço base + por funcionário. */
export const publicAddons = (yearly) => ({ payroll: { key: 'payroll', price: { month: PAYROLL_ADDON_PRICE.base, year: yearly?.base ?? PAYROLL_ADDON_PRICE.base * 12 }, perUnit: { month: PAYROLL_ADDON_PRICE.perEmployee, year: yearly?.perEmployee ?? PAYROLL_ADDON_PRICE.perEmployee * 12 } } });
