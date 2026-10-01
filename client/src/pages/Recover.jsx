import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { t, lang, LANGS, setLang } from '../i18n.jsx';
import { api } from '../api.js';
import { Button, Field, Input, useAction, useLoad } from '../components/ui.jsx';

function Frame({ title, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
        <div className="mb-5 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-2.5 font-semibold text-slate-900"><span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 font-bold text-white">F</span>Fluxo</Link>
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">{Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
        <h1 className="mb-3 text-base font-semibold">{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Passo 1: a pessoa informa o e-mail e recebe o link. A resposta é sempre a mesma, exista ou não a conta. */
export function Forgot() {
  const { data: status } = useLoad(() => api.get('/status'));
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => { document.title = `${t('Forgot your password?')} — Fluxo`; }, []);
  const submit = async (e) => { e.preventDefault(); const r = await run(() => api.post('/forgot', { email })); if (r) setSent(true); };
  return (
    <Frame title={t('Forgot your password?')}>
      {sent ? (
        <div className="space-y-3 text-sm text-slate-600" role="status">
          <p>{t('If that email has an account, we sent a link to choose a new password. It works for 1 hour.')}</p>
          <p className="text-xs text-slate-500">{t('Nothing arrived? Check your spam folder, or ask the account owner to reset it for you in Settings → Users.')}</p>
          <Link to="/" className="btn btn-primary w-full">{t('Back to sign in')}</Link>
        </div>
      ) : status && !status.recovery ? (
        <div className="space-y-3 text-sm text-slate-600">
          <p className="rounded-lg bg-amber-50 p-3 text-amber-800">{t('Email password reset is not set up on this server.')}</p>
          <p>{t('Ask the account owner to set a new password for you in Settings → Users. If you are the owner, ask the server administrator.')}</p>
          <Link to="/" className="btn btn-ghost w-full">{t('Back to sign in')}</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-sm text-slate-600">{t('Enter the email you sign in with and we will send you a link to choose a new password.')}</p>
          <Field label={t('Email')}><Input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Button className="w-full" disabled={busy}>{busy ? t('Please wait…') : t('Send the link')}</Button>
          <Link to="/" className="block text-center text-sm text-brand-700 hover:underline">{t('Back to sign in')}</Link>
        </form>
      )}
    </Frame>
  );
}

/** Passo 2: o link do e-mail abre aqui; a pessoa escolhe a nova senha. */
export function Reset() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const [pw, setPw] = useState({ a: '', b: '' });
  const [done, setDone] = useState(false);
  const [run, busy] = useAction();
  useEffect(() => { document.title = `${t('Choose a new password')} — Fluxo`; }, []);
  const mismatch = pw.b !== '' && pw.a !== pw.b;
  const submit = async (e) => { e.preventDefault(); if (mismatch) return; const r = await run(() => api.post('/reset', { token, password: pw.a })); if (r) setDone(true); };
  return (
    <Frame title={t('Choose a new password')}>
      {done ? (
        <div className="space-y-3 text-sm text-slate-600" role="status">
          <p>{t('Your password was changed. Sign in with the new one.')}</p>
          <Link to="/" className="btn btn-primary w-full">{t('Sign in')}</Link>
        </div>
      ) : !token ? (
        <div className="space-y-3 text-sm text-slate-600"><p>{t('This link is invalid or has expired. Ask for a new one.')}</p><Link to="/forgot" className="btn btn-primary w-full">{t('Ask for a new link')}</Link></div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <Field label={t('New password')} hint={t('At least 8 characters')}><Input type="password" required minLength={8} autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
          <Field label={t('Repeat the new password')} hint={mismatch ? t('The passwords do not match') : ''}><Input type="password" required minLength={8} autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
          <Button className="w-full" disabled={busy || mismatch}>{busy ? t('Please wait…') : t('Change password')}</Button>
        </form>
      )}
    </Frame>
  );
}
