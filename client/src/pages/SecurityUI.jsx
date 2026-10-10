import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const groups = (s) => String(s).replace(/(.{4})/g, '$1 ').trim();

/** Ativação do 2FA em três passos: senha → chave + primeiro código → códigos de recuperação. */
export function TwoFactorSetup({ onDone, onCancel, onEnabled }) {
  const [step, setStep] = useState('start');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState(null);
  const [codes, setCodes] = useState([]);
  const [run, busy] = useAction();
  if (step === 'codes') return (
    <div className="grid max-w-md gap-3">
      <p className="text-sm text-slate-600">{t('Two-step verification is on. Save these recovery codes somewhere safe. Each one works once if you lose your phone. They will not be shown again.')}</p>
      <pre data-testid="recovery-codes" className="select-all rounded-lg bg-slate-50 p-3 text-center font-mono text-sm leading-7">{codes.join('\n')}</pre>
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>{t('Copy codes')}</Button>
        <Button onClick={onDone}>{t('I saved them')}</Button>
      </div>
    </div>
  );
  if (step === 'verify') return (
    <div className="grid max-w-md gap-3">
      <p className="text-sm text-slate-600">{t('1. Open an authenticator app (Google Authenticator, Authy, 1Password…) and add an account with this key.')}</p>
      <div className="rounded-lg bg-slate-50 p-3 text-center font-mono text-lg tracking-wider" data-testid="totp-secret">{groups(info.secret)}</div>
      <a className="text-sm text-brand-700 underline" href={info.otpauth}>{t('Open in my authenticator app')}</a>
      <Field label={t('2. Type the 6-digit code the app shows')}><Input inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
      <div className="flex gap-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>}
        <Button disabled={busy || code.replace(/\s/g, '').length !== 6} onClick={async () => { const r = await run(() => api.post('/me/2fa/enable', { code })); if (r) { setCodes(r.recoveryCodes); setStep('codes'); onEnabled?.(); } }}>{t('Turn on')}</Button>
      </div>
    </div>
  );
  return (
    <div className="grid max-w-sm gap-3">
      <p className="text-sm text-slate-600">{t('A second step protects your books even if someone learns your password. Confirm your password to start.')}</p>
      <Field label={t('Password')}><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <div className="flex gap-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>{t('Cancel')}</Button>}
        <Button disabled={busy || !password} onClick={async () => { const r = await run(() => api.post('/me/2fa/setup', { password })); if (r) { setInfo(r); setStep('verify'); } }}>{t('Continue')}</Button>
      </div>
    </div>
  );
}

/** Cartão na aba "Minha conta". */
export function TwoFactorCard() {
  const { user, refresh } = useAuth();
  const tf = user.twofa || {};
  const [mode, setMode] = useState('');
  const [f, setF] = useState({ password: '', code: '' });
  const [codes, setCodes] = useState(null);
  const [justOn, setJustOn] = useState(false); // acabou de ativar: mostra "Ativo" já, enquanto os códigos de recuperação ainda estão na tela
  const [run, busy] = useAction();
  const reset = () => { setMode(''); setF({ password: '', code: '' }); setCodes(null); setJustOn(false); };
  return (
    <Card title={<>{t('Two-step verification')} <Badge status={tf.enabled || justOn ? 'paid' : 'void'}>{tf.enabled || justOn ? t('On') : t('Off')}</Badge></>}>
      {!tf.enabled && mode !== 'setup' && <><p className="mb-3 max-w-xl text-sm text-slate-500">{t('Ask for a 6-digit code from your phone every time you sign in. Strongly recommended for anyone who approves or pays bills.')}</p><Button onClick={() => setMode('setup')}>{t('Set up')}</Button></>}
      {!tf.enabled && mode === 'setup' && <TwoFactorSetup onEnabled={() => setJustOn(true)} onCancel={reset} onDone={async () => { reset(); await refresh(); }} />}
      {tf.enabled && !mode && <div className="grid gap-3">
        <p className="text-sm text-slate-500">{t('{0} recovery codes left.', [tf.recoveryLeft])}</p>
        <div className="flex flex-wrap gap-2"><Button variant="ghost" onClick={() => setMode('recovery')}>{t('New recovery codes')}</Button>{!tf.required && <Button variant="ghost" onClick={() => setMode('disable')}>{t('Turn off')}</Button>}</div>
        {tf.required && <p className="text-xs text-slate-400">{t('Your company requires two-step verification, so it cannot be turned off.')}</p>}
      </div>}
      {tf.enabled && (mode === 'disable' || mode === 'recovery') && !codes && <div className="grid max-w-sm gap-3">
        <Field label={t('Password')}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label={t('Code from your app')}><Input inputMode="numeric" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <div className="flex gap-2"><Button variant="ghost" onClick={reset}>{t('Cancel')}</Button>
          <Button disabled={busy || !f.password || !f.code} onClick={async () => {
            if (mode === 'disable') { const r = await run(() => api.post('/me/2fa/disable', f), t('Two-step verification is off')); if (r) { reset(); await refresh(); } }
            else { const r = await run(() => api.post('/me/2fa/recovery', f)); if (r) setCodes(r.recoveryCodes); }
          }}>{mode === 'disable' ? t('Turn off') : t('Generate')}</Button></div>
      </div>}
      {codes && <div className="grid max-w-md gap-3"><p className="text-sm text-slate-600">{t('Your old codes no longer work. Save these new ones. They will not be shown again.')}</p>
        <pre className="select-all rounded-lg bg-slate-50 p-3 text-center font-mono text-sm leading-7">{codes.join('\n')}</pre><Button onClick={async () => { reset(); await refresh(); }}>{t('I saved them')}</Button></div>}
    </Card>
  );
}

/** Aba "Segurança" (dono): 2FA obrigatório, senha de novo em ações sensíveis e a situação de cada pessoa. */
export function SecurityTab() {
  const { user, refresh } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/security'));
  const [run, busy] = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  const save = (patch, msg) => run(async () => { await api.put('/security', patch); await reload(); await refresh(); }, msg);
  const row = (key, title, hint, extraDisabled) => (
    <label className="flex items-start gap-3 py-2 text-sm"><input type="checkbox" className="mt-1" checked={!!data[key]} disabled={busy || extraDisabled} onChange={(e) => save({ [key]: e.target.checked }, t('Saved'))} />
      <span><span className="font-medium text-slate-800">{title}</span><span className="block text-slate-500">{hint}</span></span></label>);
  return (
    <div className="grid max-w-3xl gap-4">
      <Card title={t('Security rules')}>
        {row('require_2fa', t('Require two-step verification for everyone'), user.twofa?.enabled ? t('People who have not set it up are asked to do it before they can use Fluxo. Single sign-on users follow your identity provider.') : t('Turn on two-step verification for your own account first (My account).'), !user.twofa?.enabled && !data.require_2fa)}
        {row('reauth_sensitive', t('Ask for the password again before sensitive actions'), t('Paying or approving bills, creating API keys, and changing users or roles ask for the password (and the 2FA code) if you have not confirmed it in the last 5 minutes.'))}
      </Card>
      <Card title={t('People')} pad={false}>
        <Table head={[t('Name'), t('Email'), t('Role'), t('Two-step'), '']}>
          {data.users.map((u) => <tr key={u.id}><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.totp_enabled ? <Badge status="paid">{t('On')}</Badge> : <Badge status="void">{t('Off')}</Badge>}</td>
            <td className="text-right">{u.totp_enabled && u.id !== user.id && <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm(t('Remove two-step verification for {0}? They will be signed out and can set it up again.', [u.name]))) run(async () => { await api.post(`/users/${u.id}/2fa/reset`); await reload(); }, t('Two-step verification removed')); }}>{t('Lost phone: reset')}</Button>}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}

/** Janela "confirme a senha" (aparece sozinha quando o servidor pede e repete a ação depois). */
export function ReauthModal({ onResult }) {
  const { user } = useAuth();
  const [f, setF] = useState({ password: '', code: '' });
  const [run, busy] = useAction();
  const need2fa = !!user.twofa?.enabled;
  const submit = async () => { const r = await run(() => api.post('/me/reauth', need2fa ? f : { password: f.password })); if (r) onResult(true); };
  return (
    <Modal title={t('Confirm your password')} onClose={() => onResult(false)} footer={<><Button variant="ghost" onClick={() => onResult(false)}>{t('Cancel')}</Button><Button disabled={busy || !f.password || (need2fa && !f.code)} onClick={submit}>{t('Confirm')}</Button></>}>
      <p className="mb-3 text-sm text-slate-500">{t('For your security, confirm it is you before continuing. This lasts 5 minutes.')}</p>
      <div className="grid gap-3" onKeyDown={(e) => e.key === 'Enter' && submit()}>
        <Field label={t('Password')}><Input type="password" autoFocus autoComplete="current-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        {need2fa && <Field label={t('Code from your app')}><Input inputMode="numeric" autoComplete="one-time-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>}
      </div>
    </Modal>
  );
}

/** Tela cheia para quem precisa ativar o 2FA antes de usar o sistema (a empresa exige). */
export function ForceSetup({ onDone, logout }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
        <h1 className="mb-1 text-lg font-semibold">{t('Set up two-step verification')}</h1>
        <p className="mb-4 text-sm text-slate-500">{t('Your company requires it. It takes about a minute.')}</p>
        <TwoFactorSetup onDone={onDone} />
        <button type="button" onClick={logout} className="mt-4 text-sm text-slate-500 underline">{t('Sign out')}</button>
      </div>
    </div>
  );
}
