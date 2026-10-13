// Forma de pagamento (1099). A forma decide o formulário: transferência, cheque, dinheiro… = 1099-NEC;
// cartão, PayPal, Stripe e apps de pagamento = reportado pela própria empresa de pagamento (1099-K) e
// fica FORA do total do 1099-NEC (IRS, instruções do 1099-MISC/1099-NEC). O Fluxo organiza os números;
// não envia nada ao IRS e não é aconselhamento fiscal.
export const METHODS = ['ach', 'wire', 'check', 'zelle', 'cash', 'money_order', 'other', 'card', 'paypal', 'stripe', 'app'];
export const PLATFORM_METHODS = new Set(['card', 'paypal', 'stripe', 'app']);

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Texto antigo (digitado ou traduzido: "Card", "Cartão", "Tarjeta", "PIX"…) → chave; '' se não reconhecer. */
export function classifyMethod(v) {
  const s = norm(v);
  if (!s) return '';
  if (METHODS.includes(s)) return s;
  if (/cash ?app|venmo|square|apple pay|google pay/.test(s)) return 'app';
  if (/paypal/.test(s)) return 'paypal';
  if (/stripe/.test(s)) return 'stripe';
  if (/card|cartao|tarjeta|credit|debit|credito|debito/.test(s)) return 'card';
  if (/zelle/.test(s)) return 'zelle';
  if (/money order|boleto|giro/.test(s)) return 'money_order';
  if (/wire|transfer/.test(s)) return 'wire';
  if (/^ach$|pix|bank|banco/.test(s)) return 'ach';
  if (/cheque|check/.test(s)) return 'check';
  if (/cash|dinheiro|efectivo/.test(s)) return 'cash';
  return '';
}
export const isPlatformMethod = (v) => PLATFORM_METHODS.has(classifyMethod(v));
export const formFor = (v) => (isPlatformMethod(v) ? '1099-K' : '1099-NEC');
