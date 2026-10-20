import { t } from '../i18n.jsx';
import { Link } from 'react-router-dom';
import RevealTaxId from '../components/RevealTaxId.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { date, money } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';
import { LockedHint } from '../components/plan.jsx';
import PhotoImportButton from '../components/PhotoImportButton.jsx';

function ContactModal({ c, kind, onClose, onSaved }) {
  const { has } = useAuth();
  const taxInfo = useLoad(() => api.get('/tax/rates').catch(() => ({ rates: [], states: {} })));
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
        <Field label={t('Tax ID (EIN / SSN)')} hint={t('Saved encrypted. Only the last 4 digits are shown. Contractors and employees need 9 digits.')}><Input value={f.tax_id} onChange={set('tax_id')} /></Field>
        {c?.id && c.has_tax_id && <RevealTaxId path={`/contacts/${c.id}/tax-id`} />}
        <Field label={t('Payment terms (days)')}><Input type="number" min="0" value={f.terms_days} onChange={set('terms_days')} /></Field>
        <Field label={t('Type')}><Select value={f.kind} onChange={set('kind')}><option value="customer">{t('Customer')}</option><option value="vendor">{t('Vendor')}</option><option value="both">{t('Customer and vendor')}</option></Select></Field>
        <Field label={t('Address')} className="col-span-2"><Input value={f.address} onChange={set('address')} /></Field>
        {f.kind !== 'vendor' && (
          <div className="col-span-2 grid grid-cols-2 gap-3 rounded-lg border border-slate-200 p-3" data-testid="contact-sales-tax">
            <div className="col-span-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('Sales tax')}</div>
            <Field label={t('State')} hint={t('Where this customer is. Used to watch your sales per state.')}><Select value={f.tax_state || ''} onChange={set('tax_state')}><option value="">—</option>{Object.entries(taxInfo.data?.states || {}).map(([k, n]) => <option key={k} value={k}>{k} — {n}</option>)}</Select></Field>
            <Field label={t('Default tax rate')}><Select value={f.tax_rate_id || ''} onChange={set('tax_rate_id')} disabled={!!f.tax_exempt}><option value="">{t('Company default')}</option>{(taxInfo.data?.rates || []).filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.name} ({r.rate}%)</option>)}</Select></Field>
            <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.tax_exempt} onChange={(e) => setF({ ...f, tax_exempt: e.target.checked ? 1 : 0 })} data-testid="contact-tax-exempt" />{' '}{t('Tax-exempt customer (no sales tax on invoices)')}</label>
            {!!f.tax_exempt && <Field label={t('Exemption certificate / reason')} className="col-span-2"><Input value={f.tax_exempt_note || ''} onChange={set('tax_exempt_note')} placeholder={t('Resale certificate number')} /></Field>}
          </div>)}
        {f.kind !== 'customer' && !has('contractors_1099') && <LockedHint gate="contractors_1099" className="col-span-2" />}
        {f.kind !== 'customer' && has('contractors_1099') && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={!!f.is_1099} onChange={(e) => setF({ ...f, is_1099: e.target.checked ? 1 : 0 })} />{' '}{t('Independent contractor (will receive Form 1099)')}</label>}
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
  const [q, setQ] = useState(() => { try { return new URLSearchParams(location.search).get('q') || ''; } catch { return ''; } });
  const [run] = useAction();
  if (loading && !data) return <Loading />; // recarregar a lista não pode desmontar a tela (e a janela de foto aberta)
  if (error) return <ErrorBox error={error} retry={reload} />;
  const isV = kind === 'vendor';
  const rows = data.filter((c) => !q || `${c.name} ${c.email} ${c.tax_id}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHeader title={isV ? t('Vendors') : t('Customers')}>
        {can('sales', true) && <PhotoImportButton
          kind="clients" title={isV ? t('Import vendors from a photo') : t('Import customers from a photo')} onImported={reload}
          fields={[{ key: 'name', label: 'photo.f.name' }, { key: 'phone', label: 'photo.f.phone' }, { key: 'email', label: 'photo.f.email' }, { key: 'address', label: 'photo.f.address', wide: true }, { key: 'notes', label: 'photo.f.notes', wide: true }]}
          validate={(r) => (String(r.name || '').trim() ? '' : 'photo.missingName')}
          toPayload={(r) => ({ name: r.name.trim(), phone: r.phone || '', email: r.email || '', address: r.address || '', notes: r.notes || '' })}
          onSave={(b) => api.post('/contacts', { kind: isV ? 'vendor' : 'customer', name: b.name, phone: b.phone, email: b.email, address: b.address, notes: b.notes })}
        />}
        {can('sales', true) && <Button onClick={() => setEdit({ kind })}>+ {isV ? t('New vendor') : t('New customer')}</Button>}
      </PageHeader>
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><Input className="field max-w-xs" placeholder={t('Search…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} /></div>
        <Table head={[t('Name'), t('Email'), t('Phone'), { label: isV ? t('To pay') : t('To receive'), right: true }, '']} empty={t('No contacts.')}>
          {rows.map((c) => (
            <tr key={c.id} className="hover:bg-slate-50"><td className="td font-medium">{c.name}{c.kind === 'both' && <span className="ml-2 text-xs text-slate-400">{t('customer and vendor')}</span>}</td><td className="td">{c.email}</td><td className="td">{c.phone}</td>
              <td className="td num text-right">{money(isV ? c.payable : c.receivable)}</td>
              <td className="td whitespace-nowrap text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => setStmt(c)}>{t('Statement')}</button>{c.is_1099 && can('purchases', true) && <Link className="ml-3 text-xs text-brand-700 hover:underline" to={`/expenses?pay=${c.id}`}>{t('Pay contractor')}</Link>}
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
