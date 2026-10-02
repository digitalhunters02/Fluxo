import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { t, lang, LANGS, setLang } from '../i18n.jsx';
import { api, setToken } from '../api.js';
import { Button, Card, ErrorBox, Field, Input, Loading, ToastProvider, useAction, useLoad } from '../components/ui.jsx';

const PLAN_INFO = {
  free: { name: t('Free'), blurb: t('Try Fluxo with no card'), features: [t('5 invoices per month & unlimited estimates'), t('Send by link, email button or PDF'), t('Expenses, receipts & sales receipts'), t('Bank CSV import & reconciliation'), t('Core financial reports'), t('1 user')] },
  starter: { name: t('Starter'), blurb: t('Invoicing and bookkeeping basics'), features: [t('Everything in Free'), t('Unlimited invoices'), t('Credit memos'), t('Logo & brand color on invoices'), t('Unlimited users')] },
  essentials: { name: t('Essentials'), blurb: t('Bills, time and automatic banks'), features: [t('Everything in Starter'), t('Bills & vendor payments'), t('Recurring invoices'), t('Time tracking'), t('Connect banks automatically (2)')] },
  plus: { name: t('Plus'), blurb: t('Inventory, projects and budgets'), features: [t('Everything in Essentials'), t('Inventory (average cost)'), t('Purchase orders'), t('Budgets, classes & 1099 report'), t('Connect up to 5 banks')] },
  advanced: { name: t('Advanced'), blurb: t('Teams, permissions and scale'), features: [t('Everything in Plus'), t('Custom roles & permissions'), t('Batch invoicing'), t('Connect up to 15 banks')] },
};

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link to="/" className="flex items-center gap-2.5 font-semibold text-slate-900"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">F</span>Fluxo</Link>
        <div className="flex items-center gap-4 text-sm">
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">{Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <Link to="/" className="text-brand-700 hover:underline">{t('Sign in')}</Link>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 pb-16">{children}</main>
    </div>
  );
}

/** Página pública: o cliente escolhe o plano e vai direto para o pagamento no Stripe. */
export function Pricing() {
  const [params] = useSearchParams();
  const ref = params.get('ref') || ''; // código de afiliado (ex.: vindo de um link de parceiro); só repassado adiante, nunca mostrado
  const { data, loading, error } = useLoad(() => api.get('/public/plans'));
  const [payroll, setPayroll] = useState(false);
  const [email, setEmail] = useState('');
  const [chosen, setChosen] = useState(params.get('plan') || '');
  const [run, busy] = useAction();
  const nav = useNavigate();
  useEffect(() => { document.title = `${t('Pricing')} — Fluxo`; }, []);
  const go = (plan) => plan === 'free' ? nav(`/welcome?plan=free${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`) : run(async () => { const r = await api.post('/public/checkout', { plan, payroll, email: email || undefined, ref: ref || undefined }); window.location.href = r.url; });
  return (
    <ToastProvider><Shell>
      <div className="mx-auto max-w-2xl py-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">{t('Choose your plan')}</h1>
        <p className="mt-2 text-slate-600">{t('Start free, or pick a paid plan with unlimited users. Change or cancel any time.')}</p>
        {params.get('canceled') && <p className="mt-3 rounded-lg bg-amber-50 p-2 text-sm text-amber-800">{t('Checkout was canceled. Pick a plan whenever you are ready.')}</p>}
      </div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (
        <>
          {!data.needsSetup && <p className="mx-auto mb-6 max-w-xl rounded-lg bg-slate-100 p-3 text-center text-sm text-slate-600">{t('This workspace already has an account.')} <Link to="/settings/plan" className="font-medium text-brand-700 hover:underline">{t('Sign in to change your plan')}</Link></p>}
          {!data.configured && <p className="mx-auto mb-6 max-w-xl rounded-lg bg-amber-50 p-3 text-center text-sm text-amber-800">{t('Online payments are not configured on this server yet.')}</p>}
          <div className="mx-auto mb-6 flex max-w-xl flex-wrap items-end justify-center gap-4">
            <Field label={t('Your email (for the receipt)')} className="min-w-[16rem] flex-1"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" /></Field>
            <label className="mb-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={payroll} onChange={(e) => setPayroll(e.target.checked)} /> {t('Add U.S. payroll (${0}/mo + ${1} per employee)', [data.payrollPrice.base, data.payrollPrice.perEmployee])}</label>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            {data.order.map((p) => (
              <Card key={p} className={chosen === p ? 'ring-2 ring-brand-500' : ''}>
                <h2 className="text-lg font-semibold">{PLAN_INFO[p].name}</h2><p className="text-sm text-slate-500">{PLAN_INFO[p].blurb}</p>
                <div className="num my-3 text-4xl font-bold">${data.prices[p]}<span className="text-sm font-normal text-slate-500">{t('/month')}</span></div>
                <ul className="mb-5 space-y-1.5 text-sm">{PLAN_INFO[p].features.map((f) => <li key={f}>✓ {f}</li>)}</ul>
                <Button className="w-full" disabled={busy || !data.needsSetup || (p !== 'free' && !data.configured)} onClick={() => { setChosen(p); go(p); }}>{busy && chosen === p ? t('Please wait…') : p === 'free' ? t('Start free') : t('Choose {0}', [PLAN_INFO[p].name])}</Button>
              </Card>
            ))}
          </div>
          <p className="mt-6 text-center text-xs text-slate-400">{t('Secure payment by Stripe. You will create your account right after paying.')}</p>
        </>)}
    </Shell></ToastProvider>
  );
}

/** Depois do pagamento: confirma a sessão no servidor e deixa o cliente criar o acesso de proprietário. */
export function Welcome() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const sid = params.get('session_id');
  const free = params.get('plan') === 'free' && !sid;
  const ref = params.get('ref') || ''; // plano free: vem direto da URL; plano pago: volta em `data.ref` (gravado na sessão do Stripe)
  const { data, loading, error } = useLoad(() => free ? api.get('/public/signup?plan=free') : api.get(`/public/signup?session_id=${encodeURIComponent(sid || '')}`), [sid, free]);
  const [f, setF] = useState({ company_name: '', name: '', email: '', password: '', currency: 'USD' });
  const [run, busy] = useAction();
  useEffect(() => { if (data?.email) setF((x) => ({ ...x, email: data.email })); }, [data]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post('/setup', { ...f, lang, ref: (ref || data?.ref) || undefined, ...(free ? { plan: 'free' } : { checkout_session_id: sid }) }));
    if (r) { setToken(r.token); window.location.href = '/'; }
  };
  return (
    <ToastProvider><Shell>
      <div className="mx-auto max-w-md py-10">
        {loading ? <Loading /> : error ? <><ErrorBox error={error} /><p className="mt-4 text-center"><Link to="/pricing" className="text-brand-700 hover:underline">{t('Back to pricing')}</Link></p></>
          : data.alreadySetup ? <Card><p className="text-sm">{t('This workspace is already set up.')}</p><Link to="/" className="btn btn-primary mt-4">{t('Sign in')}</Link></Card>
          : (
            <form onSubmit={submit} className="card space-y-3 p-6">
              <h1 className="text-xl font-semibold">{free ? t('Create your free account') : t('Payment received — create your account')}</h1>
              <p className="text-sm text-slate-500">{free ? t('No card needed. You can upgrade any time.') : t('Your plan is ready. Set up your owner login to start.')}</p>
              <Field label={t('Company name')}><Input required value={f.company_name} onChange={set('company_name')} /></Field>
              <Field label={t('Your name')}><Input required value={f.name} onChange={set('name')} autoComplete="name" /></Field>
              <Field label={t('Email')}><Input type="email" required value={f.email} onChange={set('email')} autoComplete="username" /></Field>
              <Field label={t('Password')} hint={t('At least 8 characters')}><Input type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
              <Button className="w-full" disabled={busy}>{busy ? t('Please wait…') : t('Create my account')}</Button>
            </form>)}
      </div>
    </Shell></ToastProvider>
  );
}
