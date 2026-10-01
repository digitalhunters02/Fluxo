import { useState } from 'react';
import { t } from '../i18n.jsx';

/** Texto pesquisável de uma linha: junta os textos e números dela (e dos objetos aninhados). */
const flat = (v, depth = 0) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (depth > 3) return '';
  if (Array.isArray(v)) return v.map((x) => flat(x, depth + 1)).join(' ');
  if (typeof v === 'object') return Object.values(v).map((x) => flat(x, depth + 1)).join(' ');
  return '';
};
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
export const matches = (row, q) => !q.trim() || norm(q).split(/\s+/).filter(Boolean).every((w) => norm(flat(row)).includes(w));

/** Busca em listas: começa com o texto da URL (?q=), que é como a lupa global leva até o resultado. */
export function useSearch() {
  const [q, setQ] = useState(() => { try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; } });
  return [q, setQ, (rows) => (q.trim() ? rows.filter((r) => matches(r, q)) : rows)];
}

export function SearchBox({ value, onChange, placeholder, className = '' }) {
  return (
    <div className={`no-print relative ${className}`}>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true">🔍</span>
      <input type="search" className="field !pl-9" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || t('Search…')} aria-label={placeholder || t('Search')} />
    </div>
  );
}
