import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { date, money } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

function ContactModal({ c, kind, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ kind, name: '', email: '', phone: '', tax_id: '', address: '', notes: '', terms_days: 15, ...c });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const r = await run(() => (c?.id ? api.put(`/contacts/${c.id}`, f) : api.post('/contacts', f)), t('Contact saved')); if (r) onSaved(); };
  return (
    <Modal title={c?.id ? t('Edit contact') : kind === 'vendor' ? t('New vendor') : t('New customer')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name / Business name')} className="col-span-2"><Input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label={t('Email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label={t('Phone')}><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label={t('Tax ID (EIN / SSN)')}><Input value={f.tax_id} onChange={set('tax_id')} /></Field>
        <Field label={t('Payment terms (days)')}><Input type="number" min="0" value={f.terms_days} onChange={set('terms_days')} /></Field>
        <Field label={t('Type')}><Select value={f.kind} onChange={set('kind')}><option value="customer">{t('Customer')}</option><option value="vendor">{t('Vendor')}</option><option value="both">{t('Customer and vendor')}</option></Select></Field>
        <Field label={t('Address')} className="col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
        {f.kind !== 'customer' && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.is_1099} onChange={(e) => setF({ ...f, is_1099: e.target.checked ? 1 : 0 })} />{' '}{t('Independent contractor (will receive Form 1099)')}</label>}
        <Field label={t('Notes')} className="col-span-2"><textarea className="field h-20" value={f.notes} onChange={set('notes')} /></Field>
      </div>
    </Modal>
  );
}

function Statement({ c, onClose }) {
  const { data, loading } = useLoad(() => api.get(`/contacts/${c.id}/statement`));
  return (
    <Modal wide title={t('Statement — {0}', [c.name])} onClose={onClose}>
      {loading ? <Loading /> : <Table head={[t('Document'), t('Issued'), t('Due'), t('Status'), { label: t('Total'), right: true }, { label: t('Balance'), right: true }]} empty={t('No documents.')}>
        {data.docs.map((d) => <tr key={d.id}><td className="td">{d.number}</td><td className="td">{date(d.issue_date)}</td><td className="td">{date(d.due_date)}</td><td className="td"><Badge status={d.status} /></td><td className="td num text-right">{money(d.total)}</td><td className="td num text-right">{money(d.total - d.paid)}</td></tr>)}
      </Table>}
    </Modal>
  );
}

export default function Contacts({ kind }) {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get(`/contacts?kind=${kind}`), [kind]);
  const [edit, setEdit] = useState(null);
  const [stmt, setStmt] = useState(null);
  const [q, setQ] = useState('');
  const [run] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const isV = kind === 'vendor';
  const rows = data.filter((c) => !q || `${c.name} ${c.email} ${c.tax_id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title={isV ? t('Vendors') : t('Customers')}>{can('sales', true) && <Button onClick={() => setEdit({ kind })}>+ {isV ? t('New vendor') : t('New customer')}</Button>}</PageHeader>
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><Input className="field max-w-xs" placeholder={t('Search…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} /></div>
        <Table head={[t('Name'), t('Email'), t('Phone'), { label: isV ? t('To pay') : t('To receive'), right: true }, '']} empty={t('No contacts.')}>
          {rows.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50"><td className="td font-medium">{c.name}{c.kind === 'both' && <span className="ml-2 text-xs text-slate-400">{t('customer and vendor')}</span>}</td><td className="td">{c.email}</td><td className="td">{c.phone}</td>
              <td className="td num text-right">{money(isV ? c.payable : c.receivable)}</td>
              <td className="td whitespace-nowrap text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => setStmt(c)}>{t('Statement')}</button>
                {can('sales', true) && <><button className="ml-3 text-xs text-brand-700 hover:underline" onClick={() => setEdit(c)}>{t('Edit')}</button>
                  <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Remove {0}?', [c.name])) && run(async () => { await api.del(`/contacts/${c.id}`); reload(); }, t('Contact removed'))}>{t('Remove')}</button></>}</td></tr>
          ))}
        </Table>
      </Card>
      {edit && <ContactModal c={edit} kind={kind} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {stmt && <Statement c={stmt} onClose={() => setStmt(null)} />}
    </>
  );
}
