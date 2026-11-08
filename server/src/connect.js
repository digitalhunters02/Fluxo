// Cobrança online das faturas (plano Advanced) com Stripe Connect Express: o dinheiro vai direto para a conta do cliente do Fluxo
// (cobrança direta na conta conectada); o Fluxo pode reter uma taxa opcional (application_fee) definida em % pela plataforma.
// O pagamento confirmado chega por webhook (STRIPE_CONNECT_WEBHOOK_SECRET) e vira um pagamento da fatura, uma única vez.
import { all, get, run, tx, getSetting, setSetting } from './db.js';
import { HttpError, loadDoc, addPayment, deletePayment, today } from './accounting.js';
import { stripeRequest, stripeConfigured, verifyStripeSignature } from './billing.js';
import { stripeSdk, isMissingAccount } from './stripeSdk.js';
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

/** Lê o estado da conta no Stripe. Contas novas são Accounts v2; se for uma conta antiga (v1, criada antes desta versão), cai no formato antigo. */
async function readAccountFlags(acct) {
  try {
    const a = await stripeSdk().v2.core.accounts.retrieve(acct, { include: ['configuration.merchant', 'requirements'] });
    const caps = a.configuration?.merchant?.capabilities || {};
    return { ready: caps.card_payments?.status === 'active', ach: caps.ach_debit_payments?.status === 'active',
      detailsSubmitted: !(a.requirements?.entries || []).some((e) => e.awaiting_action_from === 'user'), payoutsEnabled: caps.card_payments?.status === 'active' };
  } catch (e) {
    if (!isMissingAccount(e)) throw e;
    const a = await stripeRequest('GET', `/v1/accounts/${acct}`);
    return { ready: !!a.charges_enabled, ach: achActive(a), detailsSubmitted: !!a.details_submitted, payoutsEnabled: !!a.payouts_enabled };
  }
}

export async function connectStatus() {
  const acct = accountId();
  const base = { configured: stripeConfigured(), connected: !!acct, ready: false, ach: { enabled: achWanted(), ready: achReady() }, feePct: platformFeePct(), depositAccountId: Number(getSetting('connect_deposit_account', '0')) || null };
  if (!acct || !stripeConfigured()) return base;
  let f;
  try { f = await readAccountFlags(acct); }
  catch (e) {
    // conta que o Stripe não conhece (acontece ao trocar chaves de teste pelas reais): vale como "não conectado" e a empresa conecta de novo
    if (isMissingAccount(e)) { forgetAccount(); return { ...base, connected: false }; }
    throw e;
  }
  setSetting('connect_ready', f.ready ? '1' : '0');
  setSetting('connect_ach_ready', f.ach ? '1' : '0');
  return { ...base, ach: { enabled: achWanted(), ready: achReady() }, ready: f.ready, detailsSubmitted: f.detailsSubmitted, payoutsEnabled: f.payoutsEnabled };
}

const forgetAccount = () => { setSetting('connect_account_id', ''); setSetting('connect_ready', '0'); setSetting('connect_ach_ready', '0'); };

export async function startOnboarding(origin) {
  if (!stripeConfigured()) throw new HttpError(503, 'Online payments are not configured on this server');
  const sdk = stripeSdk();
  let link;
  for (let attempt = 0; attempt < 2 && !link; attempt++) {
    let acct = accountId();
    if (!acct) {
      // Accounts v2 (formato aceito para plataformas novas). Cada empresa paga a taxa do Stripe direto a ela, e o Stripe
      // responde por estornos e contestações (fees_collector e losses_collector = "stripe"), com o painel completo do Stripe.
      // A plataforma (Impact Digital) não assume o prejuízo de nenhuma empresa.
      const a = await sdk.v2.core.accounts.create({
        contact_email: getSetting('company_email', '') || undefined,
        display_name: getSetting('company_name', '') || undefined,
        identity: { country: 'us' },
        dashboard: 'full',
        defaults: { currency: 'usd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
        configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
        metadata: { fluxo_slug: currentSlug() || '' },
      });
      acct = a.id;
      setSetting('connect_account_id', acct);
      linkTenant('connect_account', acct);
    }
    try {
      link = await sdk.v2.core.accountLinks.create({
        account: acct,
        use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: `${origin}/settings?connect=refresh`, return_url: `${origin}/settings?connect=done` } },
      });
    } catch (e) {
      // conta guardada que o Stripe não conhece neste modo (ex.: de teste, depois de trocar para as chaves reais): esquece e cria outra
      if (attempt === 0 && isMissingAccount(e)) { forgetAccount(); continue; }
      throw e;
    }
  }
  return { url: link.url };
}

/** Liga/desliga o pagamento por banco. Ao ligar, pede ao Stripe a capacidade na conta da empresa (ela pode levar um tempo e pedir dados). */
export async function setAch(on) {
  if (!stripeConfigured() || !accountId()) throw bad('Connect your Stripe account first');
  if (on) {
    try { await stripeSdk().v2.core.accounts.update(accountId(), { configuration: { merchant: { capabilities: { ach_debit_payments: { requested: true } } } } }); }
    catch (e) {
      if (!isMissingAccount(e)) throw e;
      await stripeRequest('POST', `/v1/accounts/${accountId()}`, { capabilities: { us_bank_account_ach_payments: { requested: 'true' } } }); // conta antiga (v1)
    }
  }
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
      if (amount > 0 && dep) {
        addPayment(doc.id, { date: today(), amount, account_id: dep, method: event.type === 'checkout.session.async_payment_succeeded' ? 'ACH (online)' : 'card (online)', ref: obj.id }, null);
        // guarda de qual cobrança do Stripe veio este pagamento, para o reembolso/contestação achar e ajustar depois
        const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : '';
        const pay = pi ? get('SELECT id FROM payments WHERE doc_id=? AND ref=? ORDER BY id DESC', doc.id, obj.id) : null;
        if (pay) setSetting(`stripe_pi_${pi}`, JSON.stringify({ paymentId: pay.id, docId: doc.id, amount }));
      }
      else handled = 'nothing_to_record';
    }
  }
  else if (['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'].includes(event.type)) {
    // reembolso e contestação só valem se a cobrança é desta empresa (conta Stripe conferida)
    if (event.account && accountId() && event.account !== accountId()) handled = 'other_account';
    else handled = handleMoneyBack(event, obj);
  }
  run('INSERT INTO stripe_events(id,type) VALUES(?,?)', event.id, event.type);
  return { handled };
}

/* --------------------------- reembolsos e contestações --------------------------- */
const piKey = (pi) => `stripe_pi_${pi}`;
const linkedPayment = (pi) => { const raw = pi ? getSetting(piKey(pi), '') : ''; try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
function alertOwner(kind, refKey, title, doc) {
  run('INSERT OR IGNORE INTO reminders(kind,ref_key,title,detail,link,data,due_date) VALUES(?,?,?,?,?,?,?)', kind, refKey, title, doc ? doc.contact_name : '', doc ? `/document/${doc.id}` : '/settings',
    JSON.stringify(doc ? { number: doc.number, name: doc.contact_name, id: doc.id } : {}), today());
}
/** Ajusta o pagamento da fatura ao que o Stripe devolveu: total = tira o pagamento; parcial = deixa só o que sobrou. Repetir o aviso não desconta de novo. */
function adjustToRefund(pi, refundedCents, full) {
  const m = linkedPayment(pi);
  if (!m) return null;
  const doc = loadDoc(m.docId);
  const pay = get('SELECT * FROM payments WHERE id=?', m.paymentId);
  if (!doc || !pay) return { doc, state: 'same' }; // já ajustado antes
  const target = full ? 0 : Math.max(0, m.amount - Math.round(Number(refundedCents) || 0));
  if (pay.amount === target) return { doc, state: 'same' };
  tx(() => {
    deletePayment(pay.id);
    if (target > 0) {
      addPayment(m.docId, { date: pay.date, amount: target, account_id: pay.account_id, method: pay.method, ref: pay.ref, allowDuplicate: true }, null);
      const np = get('SELECT id FROM payments WHERE doc_id=? AND ref=? ORDER BY id DESC', m.docId, pay.ref);
      setSetting(piKey(pi), JSON.stringify({ ...m, paymentId: np.id }));
    }
  });
  return { doc: loadDoc(m.docId), state: target > 0 ? 'reduced' : 'removed' };
}
function handleMoneyBack(event, obj) {
  const pi = typeof obj.payment_intent === 'string' ? obj.payment_intent : '';
  const tag = `${event.type}:${pi || obj.id}`;
  const unlinked = () => { alertOwner('stripe_review', `${tag}:${event.id}`, 'Stripe refunded or disputed a payment that is not linked to an invoice: check it by hand', null); return 'unlinked'; };
  if (!linkedPayment(pi)) return unlinked();
  try {
    if (event.type === 'charge.refunded') {
      const full = !!obj.refunded;
      const r = adjustToRefund(pi, obj.amount_refunded, full);
      if (r.state === 'same') return 'already_applied';
      alertOwner('refund', `${tag}:${Number(obj.amount_refunded) || 0}`, full ? 'Stripe refunded invoice {0} in full: the payment was removed' : 'Stripe refunded part of invoice {0}: the payment was reduced', r.doc);
      return full ? 'refunded' : 'partial_refund';
    }
    if (event.type === 'charge.dispute.created') {
      alertOwner('dispute', `${tag}:created`, 'Card dispute on invoice {0}: send your evidence in Stripe before the deadline', loadDoc(linkedPayment(pi).docId));
      return 'dispute_open';
    }
    if (obj.status === 'lost') { // contestação perdida: o dinheiro saiu, igual a um reembolso total
      const r = adjustToRefund(pi, 0, true);
      alertOwner('dispute', `${tag}:lost`, 'Dispute lost on invoice {0}: the payment was removed', r.doc || loadDoc(linkedPayment(pi).docId));
      return 'dispute_lost';
    }
    if (obj.status === 'won') { alertOwner('dispute', `${tag}:won`, 'Dispute won on invoice {0}: the money stays with you', loadDoc(linkedPayment(pi).docId)); return 'dispute_won'; }
    return 'dispute_other';
  } catch (e) {
    console.error('[connect] reembolso/contestação não pôde ser ajustado:', e.message);
    return unlinked();
  }
}

export { verifyStripeSignature };
