import { t } from '../i18n.jsx';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { money, STATUS } from '../format.js';

/* ---------- carregamento de dados ---------- */
export function useLoad(fn, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: '' }));
    Promise.resolve().then(fn).then((data) => { if (n === seq.current) setState({ data, loading: false, error: '' }); })
      .catch((e) => { if (n === seq.current) setState({ data: null, loading: false, error: e.message }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/* ---------- avisos ---------- */
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'ok') => {
    const id = Math.random();
    setItems((x) => [...x, { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="no-print fixed bottom-4 right-4 z-[60] flex flex-col gap-2" role="status" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} className={`rounded-lg px-4 py-2.5 text-sm text-white shadow-lg ${i.kind === 'err' ? 'bg-rose-600' : 'bg-slate-800'}`}>{i.msg}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
/** Executa uma ação assíncrona mostrando erro/sucesso. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, okMsg) => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, 'err'); return undefined; } finally { setBusy(false); }
  }, [toast]);
  return [run, busy];
}

/* ---------- blocos visuais ---------- */
export const PageHeader = ({ title, subtitle, children }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div><h1 className="text-xl font-semibold text-slate-900">{title}</h1>{subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}</div>
    <div className="no-print flex flex-wrap items-center gap-2">{children}</div>
  </div>
);
export const Card = ({ title, action, children, className = '', pad = true }) => (
  <section className={`card ${className}`}>
    {(title || action) && <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><h2 className="text-sm font-semibold text-slate-700">{title}</h2>{action}</header>}
    <div className={pad ? 'p-4' : ''}>{children}</div>
  </section>
);
export const Button = ({ variant = 'primary', className = '', ...p }) => <button className={`btn btn-${variant} ${className}`} {...p} />;
export const Field = ({ label, hint, children, className = '' }) => (
  <label className={`block ${className}`}><span className="mb-1 block text-xs font-medium text-slate-600">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}</label>
);
export const Input = (p) => <input className="field" {...p} />;
export const Select = ({ children, ...p }) => <select className="field" {...p}>{children}</select>;
export const Badge = ({ status, children }) => {
  const [label, cls] = STATUS[status] || [status, 'bg-slate-100 text-slate-600'];
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>{children || label}</span>;
};
export const Money = ({ v, color = false, className = '' }) => (
  <span className={`num ${color ? (v < 0 ? 'text-rose-600' : v > 0 ? 'text-emerald-700' : 'text-slate-500') : ''} ${className}`}>{money(v)}</span>
);
export const Loading = () => <div className="p-10 text-center text-sm text-slate-400">{t('Loading…')}</div>;
export const ErrorBox = ({ error, retry }) => (
  <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error} {retry && <button className="ml-2 underline" onClick={retry}>{t('Try again')}</button>}</div>
);
export const Empty = ({ children }) => <div className="p-10 text-center text-sm text-slate-400">{children}</div>;
export const Stat = ({ label, value, sub, tone = 'default', to }) => {
  const body = (<>
    <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
    <div className={`num mt-1 break-words text-lg font-semibold sm:text-2xl ${tone === 'bad' ? 'text-rose-600' : tone === 'good' ? 'text-emerald-700' : 'text-slate-900'}`}>{value}</div>
    {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
  </>);
  return to ? <Link to={to} className="card block p-4 transition hover:border-brand-500 hover:shadow">{body}</Link> : <div className="card p-4">{body}</div>;
};
export function Table({ head, children, empty = t('Nothing here yet.') }) {
  const rows = Array.isArray(children) ? children.flat().filter(Boolean) : children;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead className="border-b border-slate-200 bg-slate-50/60"><tr>{head.map((h, i) => <th key={i} className={`th ${h.right ? '!text-right' : ''}`}>{h.label ?? h}</th>)}</tr></thead>
        <tbody className="divide-y divide-slate-100">{rows}</tbody>
      </table>
      {(!rows || rows.length === 0) && <Empty>{empty}</Empty>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide = false, footer }) {
  useEffect(() => { const h = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`mt-10 w-full min-w-0 ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl bg-white shadow-2xl`}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5"><h3 className="font-semibold text-slate-900">{title}</h3><button onClick={onClose} aria-label={t('Close')} className="text-slate-400 hover:text-slate-700">✕</button></header>
        <div className="p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}
export function useConfirm() {
  return (msg) => window.confirm(msg);
}
export const Tabs = ({ tabs, value, onChange }) => (
  <div className="no-print mb-4 flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-200">
    {tabs.map(([k, label]) => (
      <button key={k} onClick={() => onChange(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${value === k ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>
    ))}
  </div>
);
