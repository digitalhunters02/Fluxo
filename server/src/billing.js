// Cobrança automática dos planos do Fluxo via Stripe (Checkout, assinaturas, portal do cliente e webhooks).
// Preços são criados no Stripe sob demanda por "lookup key", então não há IDs de preço para configurar.
import crypto from 'node:crypto';
import { get, run, tx, getSetting, setSetting } from './db.js';
import { HttpError } from './accounting.js';
import { link as linkTenant, currentSlug } from './tenants.js';
import { PAID_PLANS, PLAN_PRICES, PAYROLL_ADDON_PRICE, setPlan } from './plans.js';

const bad = (m) => new HttpError(400, m);
const env = () => process.env;
export const stripeConfigured = () => !!env().STRIPE_SECRET_KEY;
const apiBase = () => env().STRIPE_API_BASE || 'https://api.stripe.com';

/* ------------------------------------ cliente HTTP ------------------------------------ */
/** application/x-www-form-urlencoded com objetos/arrays aninhados no estilo do Stripe (a[b][0][c]=1). */
export function encodeForm(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? encodeForm(x, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, x])));
    else if (typeof v === 'object') encodeForm(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

async function stripe(method, path, params = {}) {
  if (!stripeConfigured()) throw new HttpError(503, 'Online billing is not configured on this server');
  const form = new URLSearchParams(encodeForm(params));
  const url = method === 'GET' && form.toString() ? `${apiBase()}${path}?${form}` : `${apiBase()}${path}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${env().STRIPE_SECRET_KEY}`, ...(method !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: method === 'GET' ? undefined : form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 402 ? 402 : 502, data.error?.message || 'The payment service returned an error', { stripe_error: data.error?.code || '' });
  return data;
}

/* ------------------------------------ preços ------------------------------------ */
const KEY = { plan: (p) => `fluxo_plan_${p}_monthly`, base: 'fluxo_payroll_base_monthly', seat: 'fluxo_payroll_seat_monthly' };
const NAME = { free: 'Free', starter: 'Starter', essentials: 'Essentials', plus: 'Plus', advanced: 'Advanced' };
const priceCache = new Map();
export const _resetPriceCache = () => priceCache.clear();

async function ensurePrice(lookupKey, cents, productName) {
  const cached = priceCache.get(lookupKey);
  if (cached && cached.unit_amount === cents) return cached;
  const found = (await stripe('GET', '/v1/prices', { 'lookup_keys[]': lookupKey, active: 'true' })).data?.[0];
  if (found && found.unit_amount === cents) { priceCache.set(lookupKey, found); return found; }
  // preço novo (primeira vez, ou o valor mudou: a lookup key é transferida para o preço novo)
  const created = await stripe('POST', '/v1/prices', { currency: 'usd', unit_amount: cents, recurring: { interval: 'month' }, lookup_key: lookupKey, transfer_lookup_key: found ? 'true' : undefined, product_data: { name: productName } });
  priceCache.set(lookupKey, created);
  return created;
}
export async function planPrice(plan) { return ensurePrice(KEY.plan(plan), PLAN_PRICES[plan] * 100, `Fluxo ${NAME[plan]}`); }
const payrollPrices = async () => ({ base: await ensurePrice(KEY.base, PAYROLL_ADDON_PRICE.base * 100, 'Fluxo Payroll add-on'), seat: await ensurePrice(KEY.seat, PAYROLL_ADDON_PRICE.perEmployee * 100, 'Fluxo Payroll — per employee') });
const activeEmployees = () => get('SELECT COUNT(*) AS n FROM employees WHERE active=1').n;

async function lineItems(plan, payroll, seats) {
  const items = [{ price: (await planPrice(plan)).id, quantity: 1 }];
  if (payroll) { const p = await payrollPrices(); items.push({ price: p.base.id, quantity: 1 }); if (seats > 0) items.push({ price: p.seat.id, quantity: seats }); }
  return items;
}

/* ------------------------------------ estado ------------------------------------ */
export function billingState() {
  return {
    configured: stripeConfigured(), managed: getSetting('billing_managed', '0') === '1', status: getSetting('subscription_status', ''),
    periodEnd: getSetting('subscription_period_end', ''), cancelAtPeriodEnd: getSetting('subscription_cancel_at_end', '0') === '1', hasCustomer: !!getSetting('stripe_customer_id', ''),
  };
}

/** Lê plano e complemento de folha dos preços da assinatura e grava no estado da empresa. */
export function applySubscription(sub) {
  const keys = (sub.items?.data || []).map((i) => i.price?.lookup_key).filter(Boolean);
  const plan = PAID_PLANS.find((p) => keys.includes(KEY.plan(p)));
  const payroll = keys.includes(KEY.base);
  const active = ['active', 'trialing', 'past_due'].includes(sub.status);
  tx(() => {
    setSetting('billing_managed', '1');
    setSetting('stripe_subscription_id', sub.id || '');
    if (sub.customer) { setSetting('stripe_customer_id', typeof sub.customer === 'string' ? sub.customer : sub.customer.id); linkTenant('stripe_customer', typeof sub.customer === 'string' ? sub.customer : sub.customer.id); }
    linkTenant('stripe_subscription', sub.id);
    setSetting('subscription_status', sub.status || '');
    const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    setSetting('subscription_period_end', end ? new Date(end * 1000).toISOString().slice(0, 10) : '');
    setSetting('subscription_cancel_at_end', sub.cancel_at_period_end ? '1' : '0');
    if (active && plan) setPlan({ plan, payroll });
    else if (!active) setPlan({ plan: 'free', payroll: false }); // assinatura encerrada: volta ao plano gratuito
  });
  return billingState();
}

/* ------------------------------------ ações ------------------------------------ */
const originOf = (req) => env().APP_URL || `${req.protocol}://${req.get('host')}`;

export async function createCheckout({ plan, payroll, origin, email, signup = false, ref }) {
  if (plan === 'free') throw bad('The Free plan needs no payment');
  if (!PAID_PLANS.includes(plan)) throw bad('Invalid plan');
  const customer = getSetting('stripe_customer_id', '');
  const session = await stripe('POST', '/v1/checkout/sessions', {
    mode: 'subscription', line_items: await lineItems(plan, !!payroll, signup ? 0 : activeEmployees()),
    ...(customer && !signup ? { customer } : email ? { customer_email: email } : {}),
    success_url: signup ? `${origin}/welcome?session_id={CHECKOUT_SESSION_ID}` : `${origin}/settings/plan?checkout=success`,
    cancel_url: signup ? `${origin}/pricing?canceled=1` : `${origin}/settings/plan?checkout=canceled`,
    allow_promotion_codes: 'true', client_reference_id: currentSlug() || 'fluxo',
    // ref: código de afiliado capturado na página de preços (?ref=CODE); viaja na sessão do Stripe para sobreviver ao redirect e voltar em verifyCheckoutSession().
    metadata: { fluxo_signup: signup ? '1' : '0', plan, payroll: payroll ? '1' : '0', ref: ref ? String(ref).slice(0, 64) : undefined },
    subscription_data: { metadata: { fluxo_plan: plan } },
  });
  return { url: session.url, id: session.id };
}

export async function createPortal(origin) {
  const customer = getSetting('stripe_customer_id', '');
  if (!customer) throw bad('There is no subscription to manage yet');
  return { url: (await stripe('POST', '/v1/billing_portal/sessions', { customer, return_url: `${origin}/settings/plan` })).url };
}

/** Troca de plano / liga ou desliga a folha numa assinatura existente, com cobrança proporcional. */
export async function changeSubscription({ plan, payroll }) {
  const subId = getSetting('stripe_subscription_id', '');
  if (!subId) throw bad('There is no active subscription to change. Start one first.');
  const sub = await stripe('GET', `/v1/subscriptions/${subId}`);
  if (['canceled', 'incomplete_expired'].includes(sub.status)) throw bad('This subscription has ended. Start a new one.');
  if (plan === 'free') { // voltar ao gratuito: a assinatura segue até o fim do período já pago e depois encerra
    return applySubscription(await stripe('POST', `/v1/subscriptions/${subId}`, { cancel_at_period_end: 'true' }));
  }
  const lookup = (i) => i.price?.lookup_key;
  const cur = sub.items.data;
  const items = [];
  const wantPlan = plan && PAID_PLANS.includes(plan) ? plan : PAID_PLANS.find((p) => cur.some((i) => lookup(i) === KEY.plan(p)));
  if (plan && !PAID_PLANS.includes(plan)) throw bad('Invalid plan');
  const planItem = cur.find((i) => PAID_PLANS.some((p) => lookup(i) === KEY.plan(p)));
  if (planItem && wantPlan && lookup(planItem) !== KEY.plan(wantPlan)) items.push({ id: planItem.id, price: (await planPrice(wantPlan)).id });
  const hasPayroll = cur.some((i) => lookup(i) === KEY.base);
  if (payroll !== undefined && payroll !== hasPayroll) {
    if (payroll) { const p = await payrollPrices(); items.push({ price: p.base.id, quantity: 1 }); if (activeEmployees() > 0) items.push({ price: p.seat.id, quantity: activeEmployees() }); }
    else for (const i of cur.filter((x) => [KEY.base, KEY.seat].includes(lookup(x)))) items.push({ id: i.id, deleted: 'true' });
  }
  if (!items.length) return billingState();
  const updated = await stripe('POST', `/v1/subscriptions/${subId}`, { items, proration_behavior: 'create_prorations', cancel_at_period_end: 'false' });
  return applySubscription(updated);
}

/** Mantém a quantidade de funcionários da cobrança da folha em dia (chamado quando o quadro muda). */
export async function syncPayrollSeats() {
  if (!stripeConfigured()) return;
  const subId = getSetting('stripe_subscription_id', '');
  if (!subId || getSetting('addon_payroll', '0') !== '1') return;
  const sub = await stripe('GET', `/v1/subscriptions/${subId}`);
  const seat = sub.items.data.find((i) => i.price?.lookup_key === KEY.seat);
  const n = activeEmployees();
  if (seat && seat.quantity === n) return;
  if (seat && n === 0) await stripe('POST', `/v1/subscriptions/${subId}`, { items: [{ id: seat.id, deleted: 'true' }], proration_behavior: 'create_prorations' });
  else if (seat) await stripe('POST', `/v1/subscriptions/${subId}`, { items: [{ id: seat.id, quantity: n }], proration_behavior: 'create_prorations' });
  else if (n > 0) await stripe('POST', `/v1/subscriptions/${subId}`, { items: [{ price: (await payrollPrices()).seat.id, quantity: n }], proration_behavior: 'create_prorations' });
}

/** Confirma no Stripe que a sessão de checkout foi paga e devolve os dados da assinatura. */
export async function verifyCheckoutSession(sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(String(sessionId || ''))) throw bad('Invalid checkout session');
  const s = await stripe('GET', `/v1/checkout/sessions/${sessionId}`);
  if (s.status !== 'complete' || !['paid', 'no_payment_required'].includes(s.payment_status)) throw new HttpError(402, 'Payment was not completed');
  const sub = s.subscription ? await stripe('GET', `/v1/subscriptions/${typeof s.subscription === 'string' ? s.subscription : s.subscription.id}`) : null;
  const keys = (sub?.items?.data || []).map((i) => i.price?.lookup_key);
  return { email: s.customer_details?.email || s.customer_email || '', customer: typeof s.customer === 'string' ? s.customer : s.customer?.id, subscription: sub,
    plan: PAID_PLANS.find((p) => keys.includes(KEY.plan(p))) || null, payroll: keys.includes(KEY.base), ref: s.metadata?.ref || s.params?.metadata?.ref || '' };
}

/** Resumo da assinatura desta empresa no Stripe (status, intervalo, valor real em dólares) — usado pelo endpoint
 * /api/affiliate/tenant-summary que o Harbor consulta para saber como está o cliente que veio de um código de afiliado.
 * null quando não há cobrança online configurada ou a empresa nunca teve assinatura (ex.: ainda no plano Free). */
export async function subscriptionSummary() {
  const subId = getSetting('stripe_subscription_id', '');
  if (!stripeConfigured() || !subId) return null;
  try {
    const sub = await stripe('GET', `/v1/subscriptions/${subId}`);
    const price = sub.items?.data?.[0]?.price;
    return {
      status: sub.status,
      interval: price?.recurring?.interval || null,
      amount: typeof price?.unit_amount === 'number' ? price.unit_amount / 100 : null,
      cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    };
  } catch {
    // Stripe fora do ar: devolve o que sabemos pelo último webhook em vez de falhar o Harbor inteiro.
    return { status: getSetting('subscription_status', '') || 'unknown', interval: null, amount: null, cancelAtPeriodEnd: getSetting('subscription_cancel_at_end', '0') === '1', canceledAt: null };
  }
}

/* ------------------------------------ webhooks ------------------------------------ */
export function verifyStripeSignature(rawBody, header, secret = env().STRIPE_WEBHOOK_SECRET, tolerance = 300) {
  if (!secret) throw new HttpError(503, 'Webhook secret is not configured');
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=').map((x) => x.trim())).filter((p) => p.length === 2).map(([k, v]) => [k, v]));
  const sigs = String(header || '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('v1=')).map((s) => s.slice(3));
  if (!parts.t || !sigs.length) throw new HttpError(400, 'Invalid webhook signature');
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest('hex');
  const ok = sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  if (!ok) throw new HttpError(400, 'Invalid webhook signature');
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > tolerance) throw new HttpError(400, 'Webhook signature expired');
}

export async function handleStripeEvent(event) {
  if (get('SELECT 1 FROM stripe_events WHERE id=?', event.id)) return { duplicate: true };
  const obj = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
      if (obj.mode === 'subscription' && obj.subscription && obj.metadata?.fluxo_signup !== '1') {
        // compra feita por quem já tem conta: aplica já a assinatura
        applySubscription(await stripe('GET', `/v1/subscriptions/${typeof obj.subscription === 'string' ? obj.subscription : obj.subscription.id}`));
      }
      break;
    case 'customer.subscription.created': case 'customer.subscription.updated': case 'customer.subscription.deleted':
      // só assinaturas ligadas a esta empresa (já conhecida) ou criadas pelo checkout do Fluxo
      if (getSetting('stripe_subscription_id', '') === obj.id || getSetting('stripe_customer_id', '') === (typeof obj.customer === 'string' ? obj.customer : obj.customer?.id)) {
        applySubscription(event.type === 'customer.subscription.deleted' ? { ...obj, status: 'canceled' } : obj);
      }
      break;
    case 'invoice.payment_failed':
      if (getSetting('stripe_customer_id', '') === obj.customer) setSetting('subscription_status', 'past_due');
      break;
    case 'invoice.paid':
      if (getSetting('stripe_customer_id', '') === obj.customer && getSetting('subscription_status', '') === 'past_due') setSetting('subscription_status', 'active');
      break;
    default: break;
  }
  run('INSERT INTO stripe_events(id,type) VALUES(?,?)', event.id, event.type);
  return { handled: event.type };
}

export { originOf };
