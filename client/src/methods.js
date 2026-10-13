// Formas de pagamento (1099): a chave decide o formulário. Cartão, PayPal, Stripe e apps de pagamento são
// reportados pela própria empresa de pagamento (1099-K) e ficam fora do total do 1099-NEC.
import { t } from './i18n.jsx';

export const METHOD_KEYS = ['ach', 'wire', 'check', 'zelle', 'cash', 'money_order', 'other', 'card', 'paypal', 'stripe', 'app'];
export const PLATFORM_KEYS = ['card', 'paypal', 'stripe', 'app'];

export const methodLabel = (k) => ({
  ach: t('ACH'), wire: t('Wire transfer'), check: t('Check'), zelle: t('Zelle'), cash: t('Cash'), money_order: t('Money order'), other: t('Other (not a card or payment app)'),
  card: t('Card'), paypal: t('PayPal'), stripe: t('Stripe'), app: t('Venmo, Cash App or similar'),
}[k] || k || '');
