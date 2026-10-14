// Cobrança online das faturas (plano Advanced) com Stripe Connect Express: o dinheiro vai direto para a conta do cliente do Fluxo
// (cobrança direta na conta conectada); o Fluxo pode reter uma taxa opcional (application_fee) definida em % pela plataforma.
// O pagamento confirmado chega por webhook (STRIPE_CONNECT_WEBHOOK_SECRET) e vira um pagamento da fatura, uma única vez.
import { all, get, run, getSetting, setSetting } from './db.js';
import { HttpError, loadDoc, addPayment, today } from './accounting.js';
import { stripeRequest, stripeConfigured, verifyStripeSignature } from './billing.js';
import { link as linkTenant, currentSlug, multiEnabled } from './tenants.js';

const bad = (m) => new HttpError(400, m);
export const connectWebhookSecret = () => process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '';
export const platformFeePct = () => { const n = Number(process.env.CONNECT_FEE_PCT ?? getSetting('connect_fee_pct', '0')); return Number.isFinite(n) && n >= 0 && n <= 10 ? n : 0; };
const accountId = () => getSetting('connect_account_id', '');
// Pagamento por débito em conta (ACH): a empresa liga, o Stripe ativa a capacidade na conta dela, e só então o link oferece "banco".
// ACH é lento (dias) e pode falhar depois: a fatura só baixa quando o Stripe confirma (async_payment_succeeded) e enquanto isso o link não é oferecido de novo.
const achWanted = () => getSetting('connect_ach', '0') === '1';
const achActive = (acct) => acct?.capabilities?.us_bank_account_ach_payments === 'active';
export const achReady = () => achWanted() && getSetting('connect_ach_ready', '0') === '1';
const pendingKey = (docId) => `ach_pending_${docId}`;
const PENDING_DAYS = 10;
/** Existe um pagamento por banco em andamento para esta fatura? (some sozinho depois de 10 dias) */
export function achPending(docId) {
  const v = getSetting(pendingKey(docId), '');
  if (!v) return false;
  const at = Number(v.split('|')[1]) || 0;
  return Date.now() - at < PENDING_DAYS * 86400000;
}

export async function connectStatus() {
  const acct = accountId();
  const base = { configured: stripeConfigured(), connected: !!acct, ready: false, ach: { enabled: achWanted(), ready: achReady() }, feePct: platformFeePct(), depositAccountId: Number(getSetting('connect_deposit_account', '0')) || null };
  if (!acct || !stripeConfigured()) return base;
  const a = await stripeRequest('GET', `/v1/accounts/${acct}`);
  const ready = !!a.charges_enabled;
  setSetting('connect_ready', ready ? '1' : '0');
  setSetting('connect_ach_ready', achActive(a) ? '1' : '0');
  return { ...base, ach: { enabled: achWanted(), ready: achReady() }, ready, detailsSubmitted: !!a.details_submitted, payoutsEnabled: !!a.payouts_enabled };
}

export async function startOnboarding(origin) {
  if (!stripeConfigured()) throw new HttpError(503, 'Online payments are not configured on this server');
  let acct = accountId();
  if (!acct) {
    const a = await stripeRequest('POST', '/v1/accounts', {
      type: 'express', country: 'US', business_profile: { name: getSetting('company_name', '') || undefined },
      capabilities: { card_payments: { requested: 'true' }, transfers: { requested: 'true' } },
      metadata: { fluxo_slug: currentSlug() || '' },
    });
    acct = a.id;
    setSetting('connect_account_id', acct);
    linkTenant('connect_account', acct);
  }
  const l = await stripeRequest('POST', '/v1/account_links', { account: acct, type: 'account_onboarding', refresh_url: `${origin}/settings?connect=refresh`, return_url: `${origin}/settings?connect=done` });
  return { url: l.url };
}

/** Liga/desliga o pagamento por banco. Ao ligar, pede ao Stripe a capacidade na conta da empresa (ela pode levar um tempo e pedir dados). */
export async function setAch(on) {
  if (!stripeConfigured() || !accountId()) throw bad('Connect your Stripe account first');
  if (on) await stripeRequest('POST', `/v1/accounts/${accountId()}`, { capabilities: { us_bank_account_ach_payments: { requested: 'true' } } });
  setSetting('connect_ach', on ? '1' : '0');
  return connectStatus();
}

export function saveConnectSettings({ deposit_account_id }) {
  if (deposit_account_id !== undefined) {
    const a = get("SELECT id FROM accounts WHERE id=? AND type='asset' AND active=1", Number(deposit_account_id));
    if (!a) throw bad('Choose the account that receives these payments');
    setSetting('connect_deposit_account', a.id);
  }
}

const depositAccount = () => {
  const id = Number(getSetting('connect_deposit_account', '0'));
  if (id && get("SELECT 1 FROM accounts WHERE id=? AND type='asset'", id)) return id;
  return get("SELECT id FROM accounts WHERE type='asset' AND subtype='bank' AND active=1 ORDER BY code")?.id;
};

/** Cria a página de pagamento (Checkout) de uma fatura na conta conectada. */
export async function createPayLink(doc, publicToken, origin) {
  if (getSetting('connect_ready', '0') !== '1' || !accountId()) throw bad('This company is not set up to take online payments');
  if (doc.type !== 'invoice' || !['sent', 'partial'].includes(doc.status) || doc.balance <= 0) throw bad('This invoice cannot be paid online');
  if (achPending(doc.id)) throw bad('A bank payment for this invoice is already being processed. It can take a few business days.');
  const fee = Math.floor(doc.balance * platformFeePct() / 100);
  const s = await stripeRequest('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    payment_method_types: achReady() ? ['card', 'us_bank_account'] : undefined,
    payment_method_options: achReady() ? { us_bank_account: { verification_method: 'instant' } } : undefined,
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: doc.balance, product_data: { name: `Invoice ${doc.number} — ${getSetting('company_name', '')}` } } }],
    payment_intent_data: fee > 0 ? { application_fee_amount: fee } : undefined,
    metadata: { fluxo_doc_id: doc.id, fluxo_slug: currentSlug() || '' },
    success_url: `${origin}/p/${publicToken}?paid=1`, cancel_url: `${origin}/p/${publicToken}`,
  }, { 'Stripe-Account': accountId() });
  return { url: s.url };
}

/** Evento do webhook de contas conectadas (já dentro da empresa certa). Idempotente. */
export function handleConnectEvent(event) {
  if (get('SELECT 1 FROM stripe_events WHERE id=?', event.id)) return { duplicate: true };
  const obj = event.data?.object || {};
  let handled = event.type;
  if (event.type === 'account.updated' && obj.id === accountId()) { setSetting('connect_ready', obj.charges_enabled ? '1' : '0'); setSetting('connect_ach_ready', achActive(obj) ? '1' : '0'); }
  else if (event.type === 'checkout.session.completed' && obj.payment_status === 'unpaid' && obj.metadata?.fluxo_doc_id) {
    // pagamento por banco iniciado: ainda não é dinheiro. Marca "em andamento" para não oferecer pagar de novo.
    setSetting(pendingKey(Number(obj.metadata.fluxo_doc_id)), `${obj.id}|${Date.now()}`);
    handled = 'ach_processing';
  } else if (event.type === 'checkout.session.async_payment_failed' && obj.metadata?.fluxo_doc_id) {
    const docId = Number(obj.metadata.fluxo_doc_id), doc = loadDoc(docId);
    setSetting(pendingKey(docId), '');
    if (doc) run('INSERT OR IGNORE INTO reminders(kind,ref_key,title,detail,link,data,due_date) VALUES(?,?,?,?,?,?,?)', 'payment_failed', `achfail:${obj.id}`, 'Bank payment for invoice {0} failed', doc.contact_name, `/document/${doc.id}`, JSON.stringify({ number: doc.number, name: doc.contact_name, id: doc.id }), today());
    handled = 'ach_failed';
  } else if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && obj.payment_status === 'paid' && obj.metadata?.fluxo_doc_id) {
    setSetting(pendingKey(Number(obj.metadata.fluxo_doc_id)), '');
    const doc = loadDoc(Number(obj.metadata.fluxo_doc_id));
    if (!doc || doc.type !== 'invoice') handled = 'unknown_document';
    else if (all('SELECT 1 FROM payments WHERE doc_id=? AND ref=?', doc.id, obj.id).length) handled = 'already_recorded';
    else {
      const amount = Math.min(Number(obj.amount_total) || 0, doc.balance);
      const dep = depositAccount();
      if (amount > 0 && dep) addPayment(doc.id, { date: today(), amount, account_id: dep, method: event.type === 'checkout.session.async_payment_succeeded' ? 'ACH (online)' : 'card (online)', ref: obj.id }, null);
      else handled = 'nothing_to_record';
    }
  }
  run('INSERT INTO stripe_events(id,type) VALUES(?,?)', event.id, event.type);
  return { handled };
}

export { verifyStripeSignature };
