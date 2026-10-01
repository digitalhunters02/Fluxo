import { t, tr } from '../i18n.jsx';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Table } from '../components/ui.jsx';
import { date } from '../format.js';

const KEY = 'fluxo_admin';
const store = { get: () => { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } }, set: (v) => { try { v ? sessionStorage.setItem(KEY, v) : sessionStorage.removeItem(KEY); } catch { /* ignore */ } } };
async function call(method, path, body) {
  const res = await fetch(`/api/admin${path}`, { method, headers: { 'Content-Type': 'application/json', ...(store.get() ? { Authorization: `Bearer ${store.get()}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { if (res.status === 401 && store.get()) store.set(''); throw Object.assign(new Error(data.error ? tr(data.error) : `Error ${res.status}`), { status: res.status }); }
  return data;
}
const PLAN = { free: 'Free', starter: 'Starter', essentials: 'Essentials', plus: 'Plus', advanced: 'Advanced' };

/** Painel do dono da plataforma: quem são os clientes, em que plano estão e quem está suspenso. */
export default function Admin() {
  const [authed, setAuthed] = useState(!!store.get());
  const [f, setF] = useState({ email: '', password: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { try { setData(await call('GET', '/overview')); setError(''); } catch (e) { if (e.status === 401) setAuthed(false); setError(e.message); } }, []);
  useEffect(() => { document.title = `${t('Admin')} — Fluxo`; if (authed) load(); }, [authed, load]);
  const login = async (e) => { e.preventDefault(); setBusy(true); try { store.set((await call('POST', '/login', f)).token); setAuthed(true); setError(''); } catch (err) { setError(err.message); } setBusy(false); };
  const toggle = async (s) => {
    if (s.status === 'active' && !confirm(t('Suspend {0}? Nobody in this company will be able to sign in.', [s.name || s.slug]))) return;
    setBusy(true); try { await call('POST', `/tenants/${s.slug}/${s.status === 'active' ? 'suspend' : 'resume'}`, {}); await load(); } catch (err) { setError(err.message); } setBusy(false);
  };
  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <form onSubmit={login} className="card w-full max-w-sm space-y-3 p-6">
          <h1 className="text-lg font-semibold">{t('Fluxo administrator')}</h1>
          {error && <div className="rounded-lg bg-rose-50 p-2 text-sm text-rose-700" role="alert">{error}</div>}
          <Field label={t('Email')}><Input type="email" required autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('Password')}><Input type="password" required autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Button className="w-full" disabled={busy}>{t('Sign in')}</Button>
        </form>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold text-slate-900">{t('Companies')}</h1>
        <div className="flex gap-2"><Link className="btn btn-ghost" to="/">{t('Back to app')}</Link><Button variant="ghost" onClick={() => { store.set(''); setAuthed(false); setData(null); }}>{t('Sign out')}</Button></div></div>
      {error && <ErrorBox error={error} retry={load} />}
      {!data ? <Loading /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><div className="text-xs uppercase text-slate-500">{t('Companies')}</div><div className="num text-2xl font-semibold">{data.total}</div></Card>
            <Card><div className="text-xs uppercase text-slate-500">{t('Active')}</div><div className="num text-2xl font-semibold">{data.active}</div></Card>
            {['free', 'starter', 'essentials', 'plus', 'advanced'].filter((p) => data.byPlan[p]).slice(0, 2).map((p) => <Card key={p}><div className="text-xs uppercase text-slate-500">{PLAN[p]}</div><div className="num text-2xl font-semibold">{data.byPlan[p]}</div></Card>)}
          </div>
          <Card pad={false}>
            <Table head={[t('Company'), t('Owner'), t('Plan'), t('Users'), t('Invoices'), t('Created'), t('Status'), '']} empty={t('No companies yet.')}>
              {data.tenants.map((s) => (
                <tr key={s.slug}><td className="td font-medium">{s.name || s.slug}<div className="text-xs font-normal text-slate-500">{s.slug}</div></td><td className="td">{s.owner_email}</td>
                  <td className="td">{PLAN[s.plan] || s.plan}{s.payroll ? ` + ${t('Payroll')}` : ''}<div className="text-xs text-slate-500">{s.subscription}</div></td>
                  <td className="td num">{s.users}</td><td className="td num">{s.invoices}</td><td className="td">{date(s.created_at.slice(0, 10))}</td>
                  <td className="td">{s.status === 'active' ? <Badge status="paid">{t('Active')}</Badge> : <Badge status="void">{t('Suspended')}</Badge>}</td>
                  <td className="td text-right"><button disabled={busy} className="text-xs text-brand-700 hover:underline" onClick={() => toggle(s)}>{s.status === 'active' ? t('Suspend') : t('Reactivate')}</button></td></tr>
              ))}
            </Table>
          </Card>
        </>)}
    </div>
  );
}
