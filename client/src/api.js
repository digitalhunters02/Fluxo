import { t, tr } from './i18n.jsx';
const KEY = 'fluxo_token';
export const getToken = () => { try { return localStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch { /* ignore */ } };
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

async function req(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && getToken()) onUnauthorized();
    throw new Error(data.error ? tr(data.error) : t('Error {0}', [res.status]));
  }
  return data;
}
export const api = { get: (p) => req('GET', p), post: (p, b = {}) => req('POST', p, b), put: (p, b = {}) => req('PUT', p, b), del: (p) => req('DELETE', p) };
export const qs = (o) => { const p = new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)); const s = p.toString(); return s ? `?${s}` : ''; };
