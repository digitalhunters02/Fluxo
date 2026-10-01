import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../i18n.jsx';
import { api } from '../api.js';
import { date, money } from '../format.js';

const TYPE_LABEL = () => ({ customer: t('Customer'), vendor: t('Vendor'), both: t('Customer'), invoice: t('Invoice'), estimate: t('Estimate'), credit: t('Credit memo'), bill: t('Bill'), po: t('Purchase order'), expense: t('Expense'), item: t('Item'), project: t('Project'), account: t('Account'), employee: t('Employee') });
const kindOf = (r) => (r.type === 'contact' ? r.kind : ['invoice', 'bill'].includes(r.type) ? r.doc : r.type);
const target = (r) => (r.link.startsWith('/document') ? r.link : `${r.link}?q=${encodeURIComponent(r.title)}`);

/** A lupa: procura clientes, documentos, produtos, despesas, contas e funcionários de uma vez só. */
export default function GlobalSearch({ onClose }) {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);
  const [i, setI] = useState(0);
  const seq = useRef(0);
  const labels = TYPE_LABEL();
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); setBusy(false); return undefined; }
    const my = ++seq.current;
    setBusy(true);
    const h = setTimeout(async () => {
      try { const r = await api.get(`/search?q=${encodeURIComponent(q.trim())}`); if (my === seq.current) { setRows(r); setI(0); } } catch { if (my === seq.current) setRows([]); }
      if (my === seq.current) setBusy(false);
    }, 200);
    return () => clearTimeout(h);
  }, [q]);
  const go = (r) => { onClose(); nav(target(r)); };
  const key = (e) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(x + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(x - 1, 0)); }
    else if (e.key === 'Enter' && rows[i]) go(rows[i]);
  };
  return (
    <div className="no-print fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/50 p-3 safe-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={t('Search')} className="mt-2 w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-2xl md:mt-16">
        <div className="flex items-center gap-2 border-b border-slate-100 px-3">
          <span aria-hidden="true">🔍</span>
          <input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key} placeholder={t('Search customers, invoices, items…')} aria-label={t('Search')} className="h-12 flex-1 bg-transparent text-base outline-none" />
          <button type="button" onClick={onClose} aria-label={t('Close')} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100">✕</button>
        </div>
        <ul className="max-h-[60vh] overflow-y-auto" role="listbox">
          {rows.map((r, n) => (
            <li key={`${r.type}-${r.id}-${r.link}`} role="option" aria-selected={n === i}>
              <button type="button" onClick={() => go(r)} onMouseEnter={() => setI(n)} className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left text-sm ${n === i ? 'bg-brand-50' : ''}`}>
                <span className="min-w-0"><span className="block truncate font-medium text-slate-900">{r.title}</span>{r.subtitle && <span className="block truncate text-xs text-slate-500">{r.subtitle}</span>}</span>
                <span className="shrink-0 text-right text-xs text-slate-500">{labels[kindOf(r)] || ''}{r.amount !== undefined && <span className="num block text-slate-700">{money(r.amount)}</span>}{r.date && <span className="block">{date(r.date)}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
        {q.trim().length >= 2 && !busy && rows.length === 0 && <p className="px-4 py-6 text-center text-sm text-slate-500">{t('Nothing found for “{0}”.', [q.trim()])}</p>}
        {q.trim().length < 2 && <p className="px-4 py-4 text-xs text-slate-500">{t('Type at least 2 letters. Tip: press / from any page to search.')}</p>}
      </div>
    </div>
  );
}
