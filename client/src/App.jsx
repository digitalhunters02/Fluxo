import { t, lang, LANGS, setLang } from './i18n.jsx';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { setFormat } from './format.js';
import { ToastProvider, Loading, Button, Field, Input, Select, useAction } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Docs from './pages/Docs.jsx';
import DocEditor from './pages/DocEditor.jsx';
import DocView from './pages/DocView.jsx';
import Expenses from './pages/Expenses.jsx';
import Contacts from './pages/Contacts.jsx';
import Items from './pages/Items.jsx';
import Banking from './pages/Banking.jsx';
import Accounting from './pages/Accounting.jsx';
import Projects from './pages/Projects.jsx';
import Recurring from './pages/Recurring.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import Payroll from './pages/Payroll.jsx';
import PublicDoc from './pages/PublicDoc.jsx';
import { Gate, Lock } from './components/plan.jsx';
import Connections from './pages/Connections.jsx';
import { Pricing, Welcome } from './pages/Pricing.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function LangSwitch({ dark = false }) {
  return (
    <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}
      className={`rounded-md border px-2 py-1 text-xs ${dark ? 'border-white/20 bg-white/10 text-white' : 'border-slate-300 bg-white text-slate-700'}`}>
      {Object.entries(LANGS).map(([k, l]) => <option key={k} value={k} className="text-slate-900">{l}</option>)}
    </select>
  );
}

function AuthScreen({ status, onAuth }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ company_name: '', name: '', email: '', password: '', demo: true, currency: 'USD', plan: 'advanced' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  if (status.needsSetup && status.requirePayment) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-7 text-center shadow-2xl">
          <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">F</div>
          <h1 className="text-lg font-semibold">{t('Choose a plan to get started')}</h1>
          <p className="mt-2 text-sm text-slate-500">{t('Your workspace is created right after you pick a plan and pay.')}</p>
          <a href="/pricing" className="btn btn-primary mt-5 w-full">{t('See plans and pricing')}</a>
          <div className="mt-4 flex justify-center"><LangSwitch /></div>
        </div>
      </div>
    );
  }
  const submit = async (e) => {
    e.preventDefault();
    const r = await run(() => api.post(status.needsSetup ? '/setup' : '/login', { ...f, lang }));
    if (r) { setToken(r.token); onAuth(); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500 p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-2xl bg-white p-7 shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">F</div>
          <div><div className="text-lg font-semibold text-slate-900">Fluxo</div><div className="text-xs text-slate-500">{t('Simple finance and accounting')}</div></div>
        </div>
        <div className="mb-4 flex justify-end"><LangSwitch /></div>
        {((status.needsSetup && status.billing) || status.multi) && <p className="mb-3 rounded-lg bg-brand-50 p-3 text-sm text-brand-700">{t('New here?')} <a className="font-semibold underline" href="/pricing">{t('Choose a plan to get started')}</a></p>}
        <h1 className="mb-4 text-base font-semibold">{status.needsSetup ? t('Create your owner account') : t('Sign in to {0}', [status.company])}</h1>
        <div className="space-y-3">
          {status.needsSetup && <><Field label={t('Company name')}><Input value={f.company_name} onChange={set('company_name')} placeholder={t('My Company LLC')} /></Field><Field label={t('Currency')}><Select value={f.currency} onChange={set('currency')}>{['USD', 'EUR', 'GBP', 'CAD', 'MXN'].map((c) => <option key={c}>{c}</option>)}</Select></Field><Field label={t('Plan')} hint={t('You can change it later in Settings')}><Select value={f.plan} onChange={set('plan')}><option value="starter">Starter — $29</option><option value="essentials">Essentials — $65</option><option value="plus">Plus — $109</option><option value="advanced">Advanced — $269</option></Select></Field><Field label={t('Your name')}><Input required value={f.name} onChange={set('name')} /></Field></>}
          <Field label={t('Email')}><Input type="email" required autoComplete="username" value={f.email} onChange={set('email')} /></Field>
          <Field label={t('Password')} hint={status.needsSetup ? t('At least 8 characters') : ''}><Input type="password" required minLength={status.needsSetup ? 8 : 1} autoComplete={status.needsSetup ? 'new-password' : 'current-password'} value={f.password} onChange={set('password')} /></Field>
          {status.needsSetup && <label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={f.demo} onChange={set('demo')} />{' '}{t('Load sample data (6 months of activity)')}</label>}
        </div>
        <Button className="mt-5 w-full" disabled={busy}>{busy ? t('Please wait…') : status.needsSetup ? t('Get started') : t('Sign in')}</Button>
      </form>
    </div>
  );
}

const NAV = [
  { to: '/', label: t('Dashboard'), icon: '◧', read: 'reports', end: true },
  { group: t('Sales'), items: [['/invoices', t('Invoices'), 'sales'], ['/estimates', t('Estimates'), 'sales'], ['/credit-memos', t('Credit memos'), 'sales', 'credit_memos'], ['/recurring', t('Recurring'), 'sales', 'recurring'], ['/customers', t('Customers'), 'sales']] },
  { group: t('Purchases'), items: [['/bills', t('Bills'), 'purchases', 'bills'], ['/purchase-orders', t('Purchase orders'), 'purchases', 'purchase_orders'], ['/expenses', t('Expenses'), 'purchases'], ['/vendors', t('Vendors'), 'sales']] },
  { group: t('Banking'), items: [['/connections', t('Connected banks'), 'banking', 'bank_feeds'], ['/banking', t('Transactions & reconciliation'), 'banking']] },
  { group: t('Management'), items: [['/products', t('Products & inventory'), 'inventory'], ['/projects', t('Projects & time'), 'projects', 'time_tracking'], ['/payroll', t('Payroll'), 'payroll', 'payroll'], ['/reports', t('Reports'), 'reports'], ['/accounting', t('Accounting'), 'accounting']] },
  { to: '/settings', label: t('Settings'), icon: '⚙', read: 'settings' },
];

function Shell({ user, settings, logout }) {
  const { has } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  const can = (m) => user.permissions.read.includes(m);
  const link = ({ isActive }) => `block rounded-lg px-3 py-1.5 text-sm ${isActive ? 'bg-white/15 font-medium text-white' : 'text-indigo-100 hover:bg-white/10'}`;
  const home = can('reports') ? '/' : can('sales') ? '/invoices' : '/settings';
  return (
    <div className="flex min-h-screen">
      <button className="no-print fixed left-3 top-3 z-40 rounded-lg bg-brand-700 px-3 py-2 text-white md:hidden" onClick={() => setOpen(!open)} aria-label={t('Menu')}>☰</button>
      <aside className={`no-print fixed inset-y-0 left-0 z-30 w-60 shrink-0 overflow-y-auto bg-brand-900 p-4 transition md:static md:translate-x-0 ${open ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="mb-6 flex items-center gap-2.5 px-1 pt-1">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-bold text-white">F</div>
          <div className="min-w-0"><div className="font-semibold leading-tight text-white">Fluxo</div><div className="truncate text-xs text-indigo-200">{settings.company_name}</div></div>
        </div>
        <nav className="space-y-4">
          {NAV.map((n, i) => n.group ? (
            <div key={i}>
              {n.items.some(([, , m]) => can(m)) && <div className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-indigo-300">{n.group}</div>}
              {n.items.filter(([, , m]) => can(m)).map(([to, label, , feat]) => <NavLink key={to} to={to} className={link}>{label}{feat && !has(feat) && <Lock />}</NavLink>)}
            </div>
          ) : can(n.read) && <NavLink key={n.to} to={n.to} end={n.end} className={link}>{n.label}</NavLink>)}
        </nav>
        <div className="mt-8 border-t border-white/10 pt-4 text-xs text-indigo-200">
          <div className="font-medium text-white">{user.name}</div><div>{user.email}</div>
          <div className="mt-3"><LangSwitch dark /></div>
          <button onClick={logout} className="mt-3 block underline hover:text-white">{t('Sign out')}</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 pt-14 md:p-8 md:pt-8">
        {user.planInfo.billing?.status === 'past_due' && <div className="no-print mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{t('Your last payment failed.')} <NavLink to="/settings/plan" className="font-semibold underline">{t('Update your payment method')}</NavLink></div>}
        <Routes>
          <Route path="/" element={can('reports') ? <Dashboard /> : <Navigate to={home} replace />} />
          <Route path="/invoices" element={<Docs type="invoice" />} />
          <Route path="/estimates" element={<Docs type="estimate" />} />
          <Route path="/credit-memos" element={<Gate feature="credit_memos"><Docs type="credit" /></Gate>} />
          <Route path="/bills" element={<Gate feature="bills"><Docs type="bill" /></Gate>} />
          <Route path="/purchase-orders" element={<Gate feature="purchase_orders"><Docs type="po" /></Gate>} />
          <Route path="/document/:type/new" element={<DocEditor />} />
          <Route path="/document/:type/:id/edit" element={<DocEditor />} />
          <Route path="/document/:id" element={<DocView />} />
          <Route path="/recurring" element={<Gate feature="recurring"><Recurring /></Gate>} />
          <Route path="/customers" element={<Contacts kind="customer" />} />
          <Route path="/vendors" element={<Contacts kind="vendor" />} />
          <Route path="/expenses" element={<Expenses />} />
          <Route path="/connections/:tab?" element={<Gate feature="bank_feeds"><Connections /></Gate>} />
          <Route path="/banking" element={<Banking />} />
          <Route path="/products" element={<Items />} />
          <Route path="/projects" element={<Gate feature="time_tracking"><Projects /></Gate>} />
          <Route path="/payroll/:tab?" element={<Gate feature="payroll"><Payroll /></Gate>} />
          <Route path="/reports/:report?" element={<Reports />} />
          <Route path="/accounting" element={<Accounting />} />
          <Route path="/settings/:tab?" element={<Settings reloadSettings={settings.reload} />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState(null);
  const [user, setUser] = useState(null);
  const [settings, setSettings] = useState(null);
  const loc = useLocation();
  const nav = useNavigate();

  const boot = useCallback(async () => {
    try {
      const st = await api.get('/status'); setStatus(st);
      if (getToken()) {
        try {
          const [me, s] = await Promise.all([api.get('/me'), api.get('/settings')]);
          setFormat(s); setUser(me); setSettings(s);
        } catch { setToken(null); setUser(null); }
      } else setUser(null);
    } catch { setStatus({ error: true }); }
  }, []);
  useEffect(() => { boot(); }, [boot]);
  useEffect(() => { setUnauthorizedHandler(() => { setToken(null); setUser(null); }); }, []);

  if (loc.pathname === '/pricing') return <Pricing />;
  if (loc.pathname === '/welcome') return <Welcome />;
  if (loc.pathname.startsWith('/p/')) return <ToastProvider><Routes><Route path="/p/:token" element={<PublicDoc />} /></Routes></ToastProvider>;
  if (!status) return <Loading />;
  if (status.error) return <div className="p-10 text-center text-rose-600">{t('Could not connect to the server.')}</div>;
  const logout = async () => { try { await api.post('/logout'); } catch { /* ignore */ } setToken(null); setUser(null); setSettings(null); nav('/'); boot(); };
  return (
    <ToastProvider>
      {!user || !settings
        ? <AuthScreen status={status} onAuth={boot} />
        : <AuthCtx.Provider value={{ user, settings, planInfo: user.planInfo, has: (f) => !!user.planInfo.features[f], refresh: boot, can: (m, w) => user.permissions[w ? 'write' : 'read'].includes(m) }}>
            <Shell user={user} settings={{ ...settings, reload: async () => { const s = await api.get('/settings'); setFormat(s); setSettings(s); } }} logout={logout} />
          </AuthCtx.Provider>}
    </ToastProvider>
  );
}
