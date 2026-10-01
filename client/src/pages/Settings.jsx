import { t } from '../i18n.jsx';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, getToken } from '../api.js';
import { date } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';
import { Gate, Lock, PLAN_LABEL } from '../components/plan.jsx';

function Company({ reload }) {
  const { can } = useAuth();
  const { data, loading, error } = useLoad(() => api.get('/settings'));
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  const v = f || data; const set = (k) => (e) => setF({ ...v, [k]: e.target.value });
  const ro = !can('settings', true);
  return (
    <Card title={t('Company details & numbering')}><div className="grid max-w-3xl gap-3 md:grid-cols-2">
      <Field label={t('Company name')}><Input disabled={ro} value={v.company_name} onChange={set('company_name')} /></Field><Field label={t('EIN / Tax ID')}><Input disabled={ro} value={v.company_tax_id} onChange={set('company_tax_id')} /></Field>
      <Field label={t('Email')}><Input disabled={ro} value={v.company_email} onChange={set('company_email')} /></Field><Field label={t('Phone')}><Input disabled={ro} value={v.company_phone} onChange={set('company_phone')} /></Field>
      <Field label={t('Address')} className="md:col-span-2"><Input disabled={ro} value={v.company_address} onChange={set('company_address')} /></Field>
      <Field label={t('Currency')}><Select disabled={ro} value={v.currency} onChange={set('currency')}>{['USD', 'EUR', 'GBP', 'CAD', 'MXN'].map((c) => <option key={c}>{c}</option>)}</Select></Field>
      <Field label={t('Default sales tax (%)')}><Input disabled={ro} value={v.default_tax_rate} onChange={set('default_tax_rate')} /></Field><Field label={t('Default terms (days)')}><Input disabled={ro} value={v.default_terms_days} onChange={set('default_terms_days')} /></Field>
      <Field label={t('Invoice prefix')}><Input disabled={ro} value={v.invoice_prefix} onChange={set('invoice_prefix')} /></Field><Field label={t('Estimate prefix')}><Input disabled={ro} value={v.estimate_prefix} onChange={set('estimate_prefix')} /></Field>
      <Field label={t('Invoice footer')} className="md:col-span-2"><Input disabled={ro} value={v.invoice_footer} onChange={set('invoice_footer')} /></Field>
      <Field label={t('Logo (PNG, JPEG or WebP, max 300 KB)')} className="md:col-span-2">
        <div className="flex items-center gap-3">
          {v.company_logo ? <img src={v.company_logo} alt="" className="max-h-12 rounded border border-slate-200 bg-white p-1" /> : <span className="text-xs text-slate-400">{t('No logo')}</span>}
          {!ro && <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={t('Logo')} className="text-sm" onChange={(e) => {
            const file = e.target.files[0]; if (!file) return;
            if (file.size > 300_000) { alert(t('Logo must be a PNG, JPEG or WebP under 300 KB')); e.target.value = ''; return; }
            const r = new FileReader(); r.onload = () => setF({ ...v, company_logo: r.result }); r.readAsDataURL(file);
          }} />}
          {!ro && v.company_logo && <button className="text-xs text-rose-600 hover:underline" onClick={() => setF({ ...v, company_logo: '' })}>{t('Remove')}</button>}
        </div>
      </Field>
      <Field label={t('Brand color')}><input type="color" disabled={ro} className="h-10 w-20 rounded border border-slate-300" value={v.brand_color || '#4338CA'} onChange={set('brand_color')} aria-label={t('Brand color')} /></Field>
    </div>{!ro && <Button className="mt-4" disabled={busy || !f} onClick={() => run(async () => { await api.put('/settings', f); await reload(); setF(null); }, t('Settings saved'))}>{t('Save')}</Button>}</Card>
  );
}

function Users() {
  const { data, loading, error, reload } = useLoad(() => api.get('/users'));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', email: '', password: '', role: 'sales' });
  const [run, busy] = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  return (
    <>
      <div className="mb-3 flex items-center justify-between"><p className="text-sm text-slate-500">{t('No user limit. Each role has different permissions.')}</p><Button onClick={() => setAdding(true)}>{t('+ Invite user')}</Button></div>
      <Card pad={false}><Table head={[t('Name'), t('Email'), t('Role'), t('Status'), '']}>
        {data.users.map((u) => <tr key={u.id}><td className="td font-medium">{u.name}</td><td className="td">{u.email}</td>
          <td className="td"><Select value={u.custom_role_id ? `custom:${u.custom_role_id}` : u.role} onChange={(e) => run(async () => { const v = e.target.value; await api.put(`/users/${u.id}`, v.startsWith('custom:') ? { custom_role_id: Number(v.slice(7)) } : { role: v, custom_role_id: null }); reload(); }, t('Role updated'))} aria-label={t('Role')}>{Object.entries(data.roles).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}{data.customRoles.map((r) => <option key={r.id} value={`custom:${r.id}`}>{r.name}</option>)}</Select></td>
          <td className="td">{u.active ? <Badge status="paid">{t('Active')}</Badge> : <Badge status="void">{t('Inactive')}</Badge>}</td>
          <td className="td text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => run(async () => { await api.put(`/users/${u.id}`, { active: !u.active }); reload(); })}>{u.active ? t('Deactivate') : t('Activate')}</button></td></tr>)}
      </Table></Card>
      <Card title={t('What each role can do')} className="mt-4"><ul className="space-y-1 text-sm text-slate-600"><li><b>{t('Owner:')}</b>{' '}{t('everything, including users and settings.')}</li><li><b>{t('Accountant:')}</b>{' '}{t('all finance, banking, payroll, reports and the chart of accounts.')}</li><li><b>{t('Sales:')}</b>{' '}{t('customers, invoices, estimates, products, projects and time.')}</li><li><b>{t('Read-only:')}</b>{' '}{t('view documents and reports without changing anything.')}</li></ul></Card>
      {adding && <Modal title={t('New user')} onClose={() => setAdding(false)} footer={<><Button variant="ghost" onClick={() => setAdding(false)}>{t('Cancel')}</Button><Button disabled={busy} onClick={async () => { const r = await run(() => api.post('/users', f), t('User created')); if (r) { setAdding(false); reload(); } }}>{t('Create')}</Button></>}>
        <div className="grid gap-3"><Field label={t('Name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label={t('Email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('Initial password')} hint={t('At least 8 characters')}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label={t('Role')}><Select value={f.custom_role_id ? `custom:${f.custom_role_id}` : f.role} onChange={(e) => { const v = e.target.value; setF(v.startsWith('custom:') ? { ...f, custom_role_id: Number(v.slice(7)) } : { ...f, role: v, custom_role_id: null }); }}>{Object.entries(data.roles).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}{data.customRoles.map((r) => <option key={r.id} value={`custom:${r.id}`}>{r.name}</option>)}</Select></Field></div></Modal>}
    </>
  );
}

const ACTIONS = { create: t('created'), update: t('updated'), delete: t('deleted'), post: t('issued'), void: t('voided'), accept: t('accepted'), decline: t('declined'), send: t('sent'), convert: t('converted'),
  payment: t('recorded a payment on'), import: t('imported'), 'accept-all': t('accepted all suggestions on'), reconcile: t('reconciled'), 'undo-reconcile': t('undid reconciliation on'), transfer: t('transferred'),
  adjust: t('adjusted'), password: t('changed password'), finalize: t('finalized'), remit: t('paid taxes'), apply: t('apply'), refund: t('refund'), connect: t('connected'), disconnect: t('disconnected') };
const ENTITIES = { invoice: t('invoice'), estimate: t('estimate'), bill: t('bill'), expense: t('expense'), contact: t('contact'), item: t('item'), account: t('account'), journal: t('journal'), project: t('project'),
  recurring: t('recurring'), user: t('user'), settings: t('settings'), employee: t('employee'), payroll: t('payroll'), bank: t('bank'), payment: t('payment'), budget: t('budget'), class: t('class'), role: t('role'), credit: t('credit'), po: t('po') };

function Audit() {
  const { data, loading, error } = useLoad(() => api.get('/audit'));
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  return <Card pad={false}><Table head={[t('When'), t('Who'), t('Action'), t('Object'), t('Detail')]} empty={t('No records.')}>{data.map((a) => <tr key={a.id}><td className="td whitespace-nowrap">{date(a.at.slice(0, 10))} {a.at.slice(11, 16)}</td><td className="td">{a.user_name}</td><td className="td">{ACTIONS[a.action] || a.action}</td><td className="td">{ENTITIES[a.entity] || a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td><td className="td text-slate-500">{a.detail}</td></tr>)}</Table></Card>;
}

function Account() {
  const [f, setF] = useState({ current: '', next: '' });
  const [run, busy] = useAction();
  const { user } = useAuth();
  const backup = async () => {
    const r = await fetch('/api/export', { headers: { Authorization: `Bearer ${getToken()}` } });
    if (!r.ok) return alert(t('No permission to export'));
    const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = `fluxo-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
  };
  return (<div className="grid max-w-3xl gap-4">
    <Card title={t('Change password')}><div className="grid max-w-sm gap-3"><Field label={t('Current password')}><Input type="password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field><Field label={t('New password')}><Input type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
      <Button disabled={busy || !f.current || f.next.length < 8} onClick={async () => { const r = await run(() => api.post('/me/password', f), t('Password changed')); if (r) setF({ current: '', next: '' }); }}>{t('Change')}</Button></div></Card>
    {user.role === 'owner' && <Card title={t('Data backup')}><p className="mb-3 text-sm text-slate-500">{t('Download a complete copy (JSON) of all your data. Your data is yours: no lock-in, no fees.')}</p><Button variant="ghost" onClick={backup}>{t('Download backup')}</Button></Card>}
  </div>);
}

function LockDate() {
  const { can, has, planInfo, refresh } = useAuth();
  const [d, setD] = useState(planInfo.lockDate || '');
  const [run, busy] = useAction();
  const allowed = has('period_lock');
  return (
    <Card title={<>{t('Close the books')}{!allowed && <Lock />}</>} className="mt-4">
      <p className="mb-3 max-w-2xl text-sm text-slate-500">{t('Nothing can be posted, edited or deleted on or before this date. Use it after your accountant finishes a period.')}</p>
      {allowed ? (
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('Books closed through')}><Input type="date" value={d} onChange={(e) => setD(e.target.value)} disabled={!can('accounting', true)} /></Field>
          {can('accounting', true) && <><Button disabled={busy} onClick={() => run(async () => { await api.put('/lock-date', { date: d }); await refresh(); }, t('Closing date saved'))}>{t('Save')}</Button>
            {planInfo.lockDate && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await api.put('/lock-date', { date: '' }); setD(''); await refresh(); }, t('Books reopened'))}>{t('Reopen all periods')}</Button>}</>}
        </div>
      ) : <p className="text-sm text-amber-700">{t('Available from the Plus plan.')}</p>}
    </Card>
  );
}

const PLAN_FEATURES = [
  ['Invoices, estimates & credit memos', 'starter'], ['Expenses, receipts & sales receipts', 'starter'], ['Bank CSV import & reconciliation', 'starter'], ['Core financial reports', 'starter'], ['Logo & brand color on invoices', 'starter'],
  ['Bills & vendor payments', 'essentials'], ['Automatic bank connection (Plaid)', 'essentials'], ['Recurring invoices', 'essentials'], ['Time tracking', 'essentials'], ['Full report set & audit log', 'essentials'],
  ['Inventory (average cost)', 'plus'], ['Project profitability', 'plus'], ['Purchase orders', 'plus'], ['Budgets & budget vs actual', 'plus'], ['Classes & P&L by class', 'plus'], ['1099 contractor report', 'plus'], ['Close the books (period lock)', 'plus'],
  ['Custom roles & permissions', 'advanced'], ['Batch invoicing', 'advanced'],
];
const FEATURE_LABEL = {
  'Invoices, estimates & credit memos': t('Invoices, estimates & credit memos'), 'Expenses, receipts & sales receipts': t('Expenses, receipts & sales receipts'), 'Bank CSV import & reconciliation': t('Bank CSV import & reconciliation'),
  'Core financial reports': t('Core financial reports'), 'Logo & brand color on invoices': t('Logo & brand color on invoices'), 'Bills & vendor payments': t('Bills & vendor payments'), 'Automatic bank connection (Plaid)': t('Automatic bank connection (Plaid)'), 'Recurring invoices': t('Recurring invoices'),
  'Time tracking': t('Time tracking'), 'Full report set & audit log': t('Full report set & audit log'), 'Inventory (average cost)': t('Inventory (average cost)'), 'Project profitability': t('Project profitability'),
  'Purchase orders': t('Purchase orders'), 'Budgets & budget vs actual': t('Budgets & budget vs actual'), 'Classes & P&L by class': t('Classes & P&L by class'), '1099 contractor report': t('1099 contractor report'),
  'Close the books (period lock)': t('Close the books (period lock)'), 'Custom roles & permissions': t('Custom roles & permissions'), 'Batch invoicing': t('Batch invoicing'),
};

function PlanTab() {
  const { user, planInfo, refresh } = useAuth();
  const [run, busy] = useAction();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [withPayroll, setWithPayroll] = useState(planInfo.payroll);
  const owner = user.role === 'owner';
  const bill = planInfo.billing;
  const rank = (p) => planInfo.order.indexOf(p);
  const stripeOn = bill.configured;
  // voltou do Stripe: o webhook pode demorar alguns segundos, então atualiza algumas vezes
  useEffect(() => {
    if (params.get('checkout') === 'success') {
      toast(t('Payment received. Updating your plan…'));
      let n = 0; const h = setInterval(async () => { await refresh(); if (++n >= 5) clearInterval(h); }, 2000);
      setParams({}, { replace: true });
      return () => clearInterval(h);
    }
    if (params.get('checkout') === 'canceled') { toast(t('Checkout was canceled.'), 'err'); setParams({}, { replace: true }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const manual = (patch) => run(async () => { await api.put('/plan', patch); await refresh(); }, t('Plan updated'));
  const subscribe = (plan) => run(async () => { const r = await api.post('/billing/checkout', { plan, payroll: withPayroll }); window.location.href = r.url; });
  const change = (patch) => run(async () => { await api.post('/billing/change', patch); await refresh(); }, t('Plan updated'));
  const portal = () => run(async () => { const r = await api.post('/billing/portal', {}); window.location.href = r.url; });
  const statusBadge = { active: ['paid', t('Active')], trialing: ['sent', t('Trial')], past_due: ['declined', t('Payment failed')], canceled: ['void', t('Canceled')] }[bill.status];
  return (
    <>
      <p className="mb-4 max-w-2xl text-sm text-slate-500">{t('Your plan decides which features are available. Everyone on your team is included: there is no per-user fee.')}</p>
      {stripeOn && bill.managed && (
        <Card title={t('Subscription')} className="mb-4">
          <div className="flex flex-wrap items-center gap-3">
            {statusBadge && <Badge status={statusBadge[0]}>{statusBadge[1]}</Badge>}
            {bill.periodEnd && <span className="text-sm text-slate-600">{bill.cancelAtPeriodEnd ? t('Ends on {0}', [date(bill.periodEnd)]) : t('Renews on {0}', [date(bill.periodEnd)])}</span>}
            {owner && bill.hasCustomer && <Button variant="ghost" disabled={busy} onClick={portal}>{t('Manage billing')}</Button>}
          </div>
          {bill.status === 'past_due' && <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{t('Your last payment failed. Update your card in Manage billing to keep your plan.')}</p>}
          <p className="mt-3 text-xs text-slate-400">{t('Upgrades and downgrades are prorated. Update your card, download invoices or cancel in Manage billing.')}</p>
        </Card>
      )}
      {stripeOn && !bill.managed && owner && <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={withPayroll} onChange={(e) => setWithPayroll(e.target.checked)} /> {t('Include U.S. payroll (${0}/mo + ${1} per employee)', [planInfo.payrollPrice.base, planInfo.payrollPrice.perEmployee])}</label>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {planInfo.order.map((p) => {
          const current = p === planInfo.plan && (!stripeOn || bill.managed);
          const up = rank(p) > rank(planInfo.plan);
          return (
            <Card key={p} className={current ? 'ring-2 ring-brand-500' : ''}>
              <div className="flex items-baseline justify-between"><h3 className="text-lg font-semibold">{PLAN_LABEL[p]}</h3>{current && <Badge status="paid">{t('Current plan')}</Badge>}</div>
              <div className="num my-2 text-3xl font-bold">${planInfo.prices[p]}<span className="text-sm font-normal text-slate-500">{t('/month')}</span></div>
              <ul className="space-y-1.5 text-sm">
                {PLAN_FEATURES.map(([f, min]) => <li key={f} className={rank(p) >= rank(min) ? '' : 'text-slate-300 line-through'}>{rank(p) >= rank(min) ? '✓' : '·'} {FEATURE_LABEL[f]}</li>)}
              </ul>
              {owner && !current && (stripeOn
                ? (bill.managed
                  ? <Button className="mt-4 w-full" variant={up ? 'primary' : 'ghost'} disabled={busy} onClick={() => confirm(t('Switch to the {0} plan? The difference is prorated on your next invoice.', [PLAN_LABEL[p]])) && change({ plan: p })}>{up ? t('Upgrade') : t('Downgrade')}</Button>
                  : <Button className="mt-4 w-full" disabled={busy} onClick={() => subscribe(p)}>{t('Subscribe')}</Button>)
                : <Button className="mt-4 w-full" variant={up ? 'primary' : 'ghost'} disabled={busy} onClick={() => confirm(t('Switch to the {0} plan?', [PLAN_LABEL[p]])) && manual({ plan: p })}>{up ? t('Upgrade') : t('Downgrade')}</Button>)}
            </Card>
          );
        })}
      </div>
      <Card title={t('Payroll add-on')} className="mt-4">
        <p className="text-sm text-slate-600">{t('U.S. payroll: ${0}/month + ${1} per employee. Calculates and records payroll, pay stubs, W-2 and 941 summaries.', [planInfo.payrollPrice.base, planInfo.payrollPrice.perEmployee])}</p>
        <div className="mt-3 flex items-center gap-3"><Badge status={planInfo.payroll ? 'paid' : 'void'}>{planInfo.payroll ? t('Active') : t('Inactive')}</Badge>
          {owner && (!stripeOn || bill.managed) && <Button variant="ghost" disabled={busy} onClick={() => (stripeOn ? change({ payroll: !planInfo.payroll }) : manual({ payroll: !planInfo.payroll }))}>{planInfo.payroll ? t('Turn off') : t('Turn on')}</Button>}</div>
      </Card>
      {!stripeOn && <p className="mt-4 text-xs text-slate-400">{t('Online billing is not connected yet: the owner switches plans here by hand.')}</p>}
    </>
  );
}

function RoleModal({ role, modules, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [name, setName] = useState(role?.name || '');
  const [read, setRead] = useState(new Set(role?.read || []));
  const [write, setWrite] = useState(new Set(role?.write || []));
  const MODULE = { sales: t('Sales'), purchases: t('Purchases'), banking: t('Banking'), accounting: t('Accounting'), reports: t('Reports'), projects: t('Projects & time'), inventory: t('Products & inventory'), payroll: t('Payroll') };
  const flip = (set, setter, m) => { const n = new Set(set); n.has(m) ? n.delete(m) : n.add(m); setter(n); };
  const save = async () => {
    const body = { name, read: [...new Set([...read, ...write])], write: [...write] };
    const r = await run(() => (role ? api.put(`/roles/${role.id}`, body) : api.post('/roles', body)), t('Role saved'));
    if (r) onSaved();
  };
  return (
    <Modal title={role ? t('Edit role') : t('New role')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !name.trim()} onClick={save}>{t('Save')}</Button></>}>
      <Field label={t('Role name')}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('e.g. Bookkeeper')} /></Field>
      <table className="mt-4 w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th className="pb-2">{t('Area')}</th><th className="pb-2 text-center">{t('Can view')}</th><th className="pb-2 text-center">{t('Can change')}</th></tr></thead>
        <tbody>{modules.map((m) => <tr key={m} className="border-t border-slate-100"><td className="py-2">{MODULE[m] || m}</td>
          <td className="text-center"><input type="checkbox" aria-label={`${MODULE[m]} — ${t('Can view')}`} checked={read.has(m) || write.has(m)} disabled={write.has(m)} onChange={() => flip(read, setRead, m)} /></td>
          <td className="text-center"><input type="checkbox" aria-label={`${MODULE[m]} — ${t('Can change')}`} checked={write.has(m)} onChange={() => flip(write, setWrite, m)} /></td></tr>)}</tbody></table>
      <p className="mt-3 text-xs text-slate-400">{t('Users and settings are always limited to the owner.')}</p>
    </Modal>
  );
}

function RolesTab() {
  const { data, loading, error, reload } = useLoad(() => api.get('/roles'));
  const [edit, setEdit] = useState(null);
  const [run] = useAction();
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  const MODULE = { sales: t('Sales'), purchases: t('Purchases'), banking: t('Banking'), accounting: t('Accounting'), reports: t('Reports'), projects: t('Projects & time'), inventory: t('Products & inventory'), payroll: t('Payroll') };
  return (
    <>
      <div className="mb-3 flex items-center justify-between"><p className="text-sm text-slate-500">{t('Create roles with exactly the access each person needs, then assign them under Users.')}</p><Button onClick={() => setEdit({})}>{t('+ New role')}</Button></div>
      <Card pad={false}><Table head={[t('Role'), t('Can view'), t('Can change'), '']} empty={t('No custom roles yet.')}>
        {data.roles.map((r) => <tr key={r.id}><td className="td font-medium">{r.name}</td><td className="td text-xs">{r.read.map((m) => MODULE[m] || m).join(', ')}</td><td className="td text-xs">{r.write.map((m) => MODULE[m] || m).join(', ') || '—'}</td>
          <td className="td whitespace-nowrap text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => setEdit(r)}>{t('Edit')}</button>
            <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this role?')) && run(async () => { await api.del(`/roles/${r.id}`); reload(); }, t('Deleted'))}>{t('Delete')}</button></td></tr>)}
      </Table></Card>
      {edit && <RoleModal role={edit.id ? edit : null} modules={data.modules} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

export default function Settings({ reloadSettings }) {
  const { user, has } = useAuth();
  const { tab = 'company' } = useParams();
  const nav = useNavigate();
  const owner = user.role === 'owner';
  const tabs = [['company', t('Company')], ['plan', t('Plan')], ['account', t('My account')],
    ...(owner ? [['users', t('Users')], ['roles', <>{t('Roles')}{!has('custom_roles') && <Lock />}</>], ['audit', <>{t('Audit log')}{!has('audit_log') && <Lock />}</>]] : [])];
  return (<><PageHeader title={t('Settings')} /><Tabs tabs={tabs} value={tab} onChange={(k) => nav(`/settings/${k}`)} />
    {tab === 'company' && <><Company reload={reloadSettings} /><LockDate /></>}{tab === 'plan' && <PlanTab />}{tab === 'account' && <Account />}{tab === 'users' && owner && <Users />}
    {tab === 'roles' && owner && <Gate feature="custom_roles"><RolesTab /></Gate>}{tab === 'audit' && owner && <Gate feature="audit_log"><Audit /></Gate>}</>);
}
