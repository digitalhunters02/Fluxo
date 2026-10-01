import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api, getToken } from '../api.js';
import { date } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

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
          <td className="td"><Select value={u.role} onChange={(e) => run(async () => { await api.put(`/users/${u.id}`, { role: e.target.value }); reload(); }, t('Role updated'))} aria-label={t('Role')}>{Object.entries(data.roles).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</Select></td>
          <td className="td">{u.active ? <Badge status="paid">{t('Asset')}</Badge> : <Badge status="void">{t('Inactive')}</Badge>}</td>
          <td className="td text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => run(async () => { await api.put(`/users/${u.id}`, { active: !u.active }); reload(); })}>{u.active ? t('Deactivate') : t('Activate')}</button></td></tr>)}
      </Table></Card>
      <Card title={t('What each role can do')} className="mt-4"><ul className="space-y-1 text-sm text-slate-600"><li><b>{t('Owner:')}</b>{' '}{t('everything, including users and settings.')}</li><li><b>{t('Accountant:')}</b>{' '}{t('all finance, banking, payroll, reports and the chart of accounts.')}</li><li><b>{t('Sales:')}</b>{' '}{t('customers, invoices, estimates, products, projects and time.')}</li><li><b>{t('Read-only:')}</b>{' '}{t('view documents and reports without changing anything.')}</li></ul></Card>
      {adding && <Modal title={t('New user')} onClose={() => setAdding(false)} footer={<><Button variant="ghost" onClick={() => setAdding(false)}>{t('Cancel')}</Button><Button disabled={busy} onClick={async () => { const r = await run(() => api.post('/users', f), t('User created')); if (r) { setAdding(false); reload(); } }}>{t('Create')}</Button></>}>
        <div className="grid gap-3"><Field label={t('Name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field><Field label={t('Email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label={t('Initial password')} hint={t('At least 8 characters')}><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label={t('Role')}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{Object.entries(data.roles).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</Select></Field></div></Modal>}
    </>
  );
}

const ACTIONS = { create: t('created'), update: t('updated'), delete: t('deleted'), post: t('issued'), void: t('voided'), accept: t('accepted'), decline: t('declined'), send: t('sent'), convert: t('converted'),
  payment: t('recorded a payment on'), import: t('imported'), 'accept-all': t('accepted all suggestions on'), reconcile: t('reconciled'), 'undo-reconcile': t('undid reconciliation on'), transfer: t('transferred'),
  adjust: t('adjusted'), password: t('changed password'), finalize: t('finalized'), remit: t('paid taxes') };
const ENTITIES = { invoice: t('invoice'), estimate: t('estimate'), bill: t('bill'), expense: t('expense'), contact: t('contact'), item: t('item'), account: t('account'), journal: t('journal'), project: t('project'),
  recurring: t('recurring'), user: t('user'), settings: t('settings'), employee: t('employee'), payroll: t('payroll'), bank: t('bank'), payment: t('payment') };

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

export default function Settings({ reloadSettings }) {
  const { user } = useAuth();
  const [tab, setTab] = useState('company');
  const tabs = [['company', t('Company')], ['account', t('My account')], ...(user.role === 'owner' ? [['users', t('Users')], ['audit', t('Audit log')]] : [])];
  return (<><PageHeader title={t('Settings')} /><Tabs tabs={tabs} value={tab} onChange={setTab} />
    {tab === 'company' && <Company reload={reloadSettings} />}{tab === 'account' && <Account />}{tab === 'users' && <Users />}{tab === 'audit' && <Audit />}</>);
}
