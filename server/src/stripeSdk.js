// Cliente oficial do Stripe, usado só onde o Stripe exige o formato novo (Accounts v2: contas conectadas).
// O resto da cobrança do Fluxo segue pelo cliente HTTP próprio de billing.js. Em teste, STRIPE_API_BASE aponta para um Stripe falso local.
import Stripe from 'stripe';

let client = null, clientKey = '', clientBase = '';
export function stripeSdk() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) return null;
  const base = process.env.STRIPE_API_BASE || '';
  if (client && key === clientKey && base === clientBase) return client;
  const opts = {};
  if (base) { const u = new URL(base); opts.host = u.hostname; opts.port = u.port || (u.protocol === 'https:' ? '443' : '80'); opts.protocol = u.protocol.replace(':', ''); }
  client = new Stripe(key, opts); clientKey = key; clientBase = base;
  return client;
}
export const isMissingAccount = (e) => e?.code === 'resource_missing' || e?.statusCode === 404
  || /no such account|account.*(does not exist|not found)|not connected to your platform|does not have access to account/i.test(String(e?.message || ''));
