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
const PLAN = { free: 'Free', starter: 'Starter', essentials: 'Essentials', plus: 'Plus', advanced: 'Advanced', business: 'Business', enterprise: 'Enterprise' };

const CLEAN_STATE = { would_warn: t('Will be warned'), warned: t('Warned'), waiting: t('Waiting for the notice period'), would_delete: t('Will be deleted'), deleted: t('Deleted'), cancelled: t('Warning cancelled (back in use)'), blocked_no_email: t('Cannot warn: email not set up'), warn_failed: t('Warning failed, will retry'), error: t('Error') };

/** Contas Free paradas: prévia do que a limpeza faria, botão para rodar agora e o histórico do que já foi apagado. */
function CleanupCard() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => { try { setData(await call('GET', '/cleanup')); setError(''); } catch (e) { setError(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const runNow = async () => {
    if (!confirm(t('Run the cleanup now? Accounts already warned more than {0} days ago will be deleted for good. Accounts not yet warned get the warning email.', [data.config.graceDays]))) return;
    setBusy(true); setMsg('');
    try { const r = await call('POST', '/cleanup/run', {}); const n = (s) => r.items.filter((i) => i.state === s).length; setMsg(t('Done: {0} warned, {1} deleted.', [n('warned'), n('deleted')])); await load(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return (
    <Card title={t('Unused free accounts')} className="mt-4">
      {error && <p className="mb-2 text-sm text-rose-700" role="alert">{error}</p>}
      {!data ? <Loading /> : (<>
        <p className="mb-2 text-sm text-slate-600">{t('Free accounts with no use for {0} months, no paid plan, no payroll, no connected bank and no accounting entries from the last {1} months get a warning email and {2} days to sign in before they are deleted.', [data.config.idleMonths, data.config.fiscalMonths, data.config.graceDays])}</p>
        <p className={`mb-3 rounded-lg p-2 text-sm ${data.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`} data-testid="cleanup-enabled">{data.enabled ? t('Automatic cleanup is ON (runs once a day).') : t('Automatic cleanup is OFF. Set FLUXO_CLEANUP=1 on the server to turn it on. You can still preview it and run it by hand.')}</p>
        {!data.mailReady && <p className="mb-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">{t('Email is not set up, so no account will be warned or deleted.')}</p>}
        <div className="overflow-x-auto">
          <Table head={[t('Company'), t('Owner'), t('Last use'), t('Last accounting entry'), t('What happens')]} empty={t('No unused free accounts right now.')}>
            {data.items.map((i) => <tr key={i.slug}><td className="td font-medium">{i.company || i.slug}</td><td className="td">{i.owner}</td><td className="td">{i.lastActivity ? date(i.lastActivity) : '—'}</td><td className="td">{i.lastFiscal ? date(i.lastFiscal) : '—'}</td><td className="td">{CLEAN_STATE[i.state] || i.state}{i.deleteAfter ? ` (${date(i.deleteAfter)})` : ''}</td></tr>)}
          </Table>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3"><Button variant="ghost" disabled={busy} onClick={load}>{t('Refresh preview')}</Button><Button disabled={busy || !data.items.length} onClick={runNow}>{busy ? t('Please wait…') : t('Run the cleanup now')}</Button>{msg && <span className="text-sm text-emerald-700" role="status">{msg}</span>}</div>
        <h3 className="mb-1 mt-5 text-sm font-semibold">{t('Deleted accounts (record)')}</h3>
        <div className="overflow-x-auto">
          <Table head={[t('Deleted on'), t('Company'), t('Owner'), t('Last use'), t('Data removed')]} empty={t('Nothing has been deleted yet.')}>
            {data.log.map((l) => <tr key={l.id}><td className="td">{date(l.at.slice(0, 10))}</td><td className="td font-medium">{l.company}<div className="text-xs font-normal text-slate-500">{l.slug}</div></td><td className="td">{l.email_masked}</td><td className="td">{l.last_activity ? date(l.last_activity) : '—'}</td><td className="td text-xs">{t('{0} documents, {1} expenses, {2} users', [l.counts.documents ?? 0, l.counts.expenses ?? 0, l.counts.users ?? 0])}</td></tr>)}
          </Table>
        </div>
      </>)}
    </Card>
  );
}

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
          {data.mail && !data.mail.linksReady && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800" role="alert" data-testid="admin-mail-warning">{data.mail.configured ? t('Email is partly set up: APP_URL is missing, so links in emails (confirmation, password reset) are off.') : t('Email is not set up on this server (no SMTP or Resend). Email confirmation, password reset, invoice emails and the 12-month warning for unused accounts are off.')}</p>}
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Card><div className="text-xs uppercase text-slate-500">{t('Companies')}</div><div className="num text-2xl font-semibold">{data.total}</div></Card>
            <Card><div className="text-xs uppercase text-slate-500">{t('Active')}</div><div className="num text-2xl font-semibold">{data.active}</div></Card>
            {['free', 'starter', 'essentials', 'plus', 'advanced', 'business', 'enterprise'].filter((p) => data.byPlan[p]).slice(0, 2).map((p) => <Card key={p}><div className="text-xs uppercase text-slate-500">{PLAN[p]}</div><div className="num text-2xl font-semibold">{data.byPlan[p]}</div></Card>)}
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
          <CleanupCard />
        </>)}
    </div>
  );
}
