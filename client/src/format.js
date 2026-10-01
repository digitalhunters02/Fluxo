import { t } from './i18n.jsx';
import { localeFor } from './i18n.jsx';
let cfg = { currency: 'USD', locale: localeFor() };
export const setFormat = (s) => { cfg = { currency: s.currency || 'USD', locale: localeFor() }; };
export const money = (c, opts = {}) => new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency, ...opts }).format((c || 0) / 100);
export const moneyShort = (c) => new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency, notation: 'compact', maximumFractionDigits: 1 }).format((c || 0) / 100);
export const number = (n, d = 2) => new Intl.NumberFormat(cfg.locale, { maximumFractionDigits: d }).format(n || 0);
// Datas no padrão dos EUA (mês/dia/ano) em todos os idiomas
export const date = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-US') : '');
export const monthLabel = (ym) => new Date(ym + '-01T00:00:00').toLocaleDateString(cfg.locale, { month: 'short' }).replace('.', '');
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** "1,234.56", "1234.56", "$12.5", "(45.00)" -> centavos. Aceita também "1.234,56". */
export const toCents = (v) => {
  if (typeof v === 'number') return Math.round(v * 100);
  const raw = String(v ?? '').trim();
  const neg = /^\(.*\)$/.test(raw) || raw.includes('-');
  let s = raw.replace(/[^\d,.]/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) {
    // vírgula depois do ponto: decimal europeu (1.234,56) — ou milhar americano (1,234) quando há exatamente 3 dígitos depois
    s = lastDot === -1 && /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  } else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -1 : 1) * Math.round(n * 100) : 0;
};
export const fromCents = (c) => ((c || 0) / 100).toFixed(2);
export const statusLabel = (s) => (STATUS[s] ? STATUS[s][0] : s);
export const STATUS = {
  draft: [t('Draft'), 'bg-slate-100 text-slate-600'], sent: [t('Sent'), 'bg-sky-100 text-sky-700'], open: [t('Open'), 'bg-sky-100 text-sky-700'],
  partial: [t('Partial'), 'bg-amber-100 text-amber-700'], paid: [t('Paid§f'), 'bg-emerald-100 text-emerald-700'], void: [t('Voided'), 'bg-slate-200 text-slate-500'],
  accepted: [t('Accepted'), 'bg-emerald-100 text-emerald-700'], declined: [t('Declined'), 'bg-rose-100 text-rose-700'], invoiced: [t('Invoiced§m'), 'bg-violet-100 text-violet-700'],
  used: [t('Used'), 'bg-violet-100 text-violet-700'], billed: [t('Billed'), 'bg-violet-100 text-violet-700'],
  final: [t('Finalized'), 'bg-emerald-100 text-emerald-700'],
  overdue: [t('Overdue§f'), 'bg-rose-100 text-rose-700'],
};
