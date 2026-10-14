import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { t, lang, LANGS, setLang } from '../i18n.jsx';
import { api, setToken } from '../api.js';
import { date } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Table, useAction, useLoad } from '../components/ui.jsx';

const STATUS = () => ({ pending: ['draft', t('Waiting for them to accept')], active: ['paid', t('Has access')], expired: ['void', t('Invitation expired')], ended: ['void', t('Access ended')] });

/** Configurações → Contador: o dono convida o contador por e-mail, vê quem tem acesso e encerra na hora. */
export function AccountantsTab() {
  const { data, loading, error, reload } = useLoad(() => api.get('/accountants'));
  const [f, setF] = useState({ name: '', email: '' });
  const [last, setLast] = useState(null); // { email, link, emailed } do convite recém-criado
  const [run, busy] = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  const st = STATUS();
  const send = async (e) => {
    e?.preventDefault();
    const r = await run(() => api.post('/accountants', f), t('Invitation created'));
    if (r) { setLast(r); setF({ name: '', email: '' }); reload(); }
  };
  const renew = async (a) => { const r = await run(() => api.post('/accountants', { email: a.email, name: a.name }), t('New link created')); if (r) { setLast(r); reload(); } };
  const copy = async (link) => { try { await navigator.clipboard.writeText(link); } catch { window.prompt(t('Copy this link'), link); return; } run(async () => {}, t('Copied')); };
  const { used, limit } = data.seats;
  const full = limit !== null && used >= limit;
  return (
    <>
      <Card title={t('Invite your accountant')}>
        <p className="mb-3 text-sm text-slate-600">{t('Your accountant gets their own login and can look at your numbers and reports, but cannot change anything. You can end the access at any time, and it stops immediately.')}</p>
        <form onSubmit={send} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label={t('Accountant name (optional)')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} /></Field>
          <Field label={t('Accountant email')}><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Button disabled={busy || !f.email}>{busy ? t('Please wait…') : t('Send invitation')}</Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">{limit === null ? t('Your plan has no limit on accountants.') : t('Accountants on your plan: {0} of {1} used.', [used, limit])}{full && ` ${t('Upgrade to invite more.')}`}</p>
        {!data.mailReady && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{t('Email is not set up on this server, so you will get a link to send to your accountant yourself.')}</p>}
        {last && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900" role="status">
            <p>{last.emailed ? t('We emailed {0}. The link works for 7 days.', [last.email]) : t('Send this link to {0}. It works for 7 days.', [last.email])}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2"><input readOnly aria-label={t('Invitation link')} value={last.link} onFocus={(e) => e.target.select()} className="field min-w-0 flex-1 text-xs" /><Button type="button" variant="ghost" onClick={() => copy(last.link)}>{t('Copy link')}</Button></div>
          </div>
        )}
      </Card>
      <Card title={t('Accountants')} className="mt-4" pad={false}>
        <Table head={[t('Name'), t('Email'), t('Status'), '']} empty={t('No accountant invited yet.')}>
          {data.accountants.map((a) => (
            <tr key={a.id}>
              <td className="td font-medium">{a.name || '—'}</td><td className="td">{a.email}</td>
              <td className="td"><Badge status={st[a.status][0]}>{st[a.status][1]}</Badge>{a.status === 'pending' && <span className="ml-2 text-xs text-slate-500">{t('until {0}', [date(a.expires_at.slice(0, 10))])}</span>}</td>
              <td className="td whitespace-nowrap text-right">
                {['pending', 'expired', 'ended'].includes(a.status) && <button className="mr-3 text-xs text-brand-700 hover:underline" onClick={() => renew(a)}>{a.status === 'pending' ? t('New link') : t('Invite again')}</button>}
                {['pending', 'active'].includes(a.status) && <button className="text-xs text-rose-600 hover:underline" onClick={() => window.confirm(a.status === 'active' ? t('End access for {0}? They will be signed out right away.', [a.email]) : t('Cancel this invitation?')) && run(async () => { await api.del(`/accountants/${a.id}`); reload(); }, t('Access ended'))}>{a.status === 'active' ? t('End access') : t('Cancel invitation')}</button>}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}

/** Página pública /accountant/<código>: o contador cria a senha e já entra, só para ler. */
export function AccountantInvitePage() {
  const { token } = useParams();
  const [info, setInfo] = useState(null);
  const [bad, setBad] = useState(false);
  const [f, setF] = useState({ name: '', password: '', again: '' });
  const [run, busy] = useAction();
  useEffect(() => { document.title = `${t('Accountant access')} — Fluxo`; }, []);
  useEffect(() => { api.get(`/public/accountant/${token}`).then((d) => { setInfo(d); setF((x) => ({ ...x, name: d.name || '' })); }).catch(() => setBad(true)); }, [token]);
  const mismatch = f.again !== '' && f.password !== f.again;
  const submit = async (e) => {
    e.preventDefault(); if (mismatch) return;
    const r = await run(() => api.post(`/public/accountant/${token}/accept`, { name: f.name, password: f.password }));
    if (r) { setToken(r.token); window.location.assign('/'); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5 font-semibold text-slate-900"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white">F</span>Fluxo</span>
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">{Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        {bad ? (
          <div className="space-y-3 text-sm text-slate-600"><h1 className="text-base font-semibold text-slate-900">{t('Accountant access')}</h1><p>{t('This invitation is invalid or has expired. Ask the owner for a new one.')}</p><Link to="/" className="btn btn-ghost w-full">{t('Back to sign in')}</Link></div>
        ) : !info ? <Loading /> : (
          <form onSubmit={submit} className="space-y-3">
            <h1 className="text-base font-semibold text-slate-900">{t('{0} invited you', [info.company || 'Fluxo'])}</h1>
            <p className="text-sm text-slate-600">{t('Create a password to look at the numbers and reports of {0}. Your access is read-only: you can see everything you need, but you cannot change anything.', [info.company || 'Fluxo'])}</p>
            <Field label={t('Email')}><Input value={info.email} readOnly /></Field>
            <Field label={t('Your name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={100} autoComplete="name" /></Field>
            <Field label={t('Choose a password')} hint={t('At least 8 characters')}><Input type="password" required minLength={8} autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
            <Field label={t('Repeat the password')} hint={mismatch ? t('The passwords do not match') : ''}><Input type="password" required minLength={8} autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
            <Button className="w-full" disabled={busy || mismatch}>{busy ? t('Please wait…') : t('Create password and open')}</Button>
          </form>
        )}
      </div>
    </div>
  );
}
