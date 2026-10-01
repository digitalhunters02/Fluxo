import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { date, fromCents, money, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { SearchBox, useSearch } from '../components/search.jsx';
import { useAuth } from '../App.jsx';

const FREQ = { weekly: t('Weekly'), monthly: t('Monthly'), quarterly: t('Quarterly'), yearly: t('Yearly') };

function RecModal({ contacts, items, settings, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', contact_id: '', frequency: 'monthly', next_date: today(), auto_post: true, terms_days: 15, item_id: '', description: '', qty: '1', price: '', tax_rate: settings.default_tax_rate || '0' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const pick = (e) => { const it = items.find((i) => String(i.id) === e.target.value); setF({ ...f, item_id: e.target.value, ...(it ? { description: it.name, price: fromCents(it.price), tax_rate: String(it.tax_rate) } : {}) }); };
  const save = async () => {
    const body = { name: f.name || t('Recurring invoice'), frequency: f.frequency, next_date: f.next_date, auto_post: f.auto_post,
      template: { contact_id: Number(f.contact_id), terms_days: Number(f.terms_days), lines: [{ item_id: f.item_id ? Number(f.item_id) : null, description: f.description, qty: Number(String(f.qty).replace(',', '.')), unit_price: toCents(f.price), tax_rate: Number(f.tax_rate) || 0 }] } };
    const r = await run(() => api.post('/recurring', body), t('Recurring invoice created')); if (r) onSaved();
  };
  return (
    <Modal title={t('New recurring invoice')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Create')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')} className="col-span-2"><Input value={f.name} onChange={set('name')} placeholder={t('Monthly plan — Customer X')} /></Field>
        <Field label={t('Customer')} className="col-span-2"><Select value={f.contact_id} onChange={set('contact_id')}><option value="">{t('Select…')}</option>{contacts.filter((c) => c.kind !== 'vendor').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('Frequency')}><Select value={f.frequency} onChange={set('frequency')}>{Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label={t('Next issue date')}><Input type="date" value={f.next_date} onChange={set('next_date')} /></Field>
        <Field label={t('Item')} className="col-span-2"><Select value={f.item_id} onChange={pick}><option value="">—</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</Select></Field>
        <Field label={t('Description')} className="col-span-2"><Input value={f.description} onChange={set('description')} /></Field>
        <Field label={t('Qty')}><Input value={f.qty} onChange={set('qty')} /></Field><Field label={t('Price')}><Input inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
        <Field label={t('Tax %')}><Input value={f.tax_rate} onChange={set('tax_rate')} /></Field><Field label={t('Terms (days)')}><Input type="number" value={f.terms_days} onChange={set('terms_days')} /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.auto_post} onChange={set('auto_post')} />{' '}{t('Issue automatically (if unchecked, creates a draft)')}</label>
      </div>
    </Modal>
  );
}

export default function Recurring() {
  const { can, settings } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => { const [rec, contacts, items] = await Promise.all([api.get('/recurring'), api.get('/contacts'), api.get('/items/lookup')]); return { rec, contacts, items }; });
  const [adding, setAdding] = useState(false);
  const [q, setQ, search] = useSearch();
  const [run] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const w = can('sales', true);
  return (
    <>
      <PageHeader title={t('Recurring invoices')} subtitle={t('The server creates invoices on schedule by itself (and catches up on any that were missed).')}>
        {w && <Button variant="ghost" onClick={() => run(async () => { const r = await api.post('/recurring/run'); reload(); return r; }, t('Check complete'))}>{t('Generate due ones now')}</Button>}{w && <Button onClick={() => setAdding(true)}>{t('+ New recurring invoice')}</Button>}
      </PageHeader>
      <SearchBox className="mb-3 max-w-sm" value={q} onChange={setQ} placeholder={t('Search recurring invoices…')} />
      <Card pad={false}><Table head={[t('Name'), t('Customer'), t('Frequency'), t('Next'), { label: t('Amount'), right: true }, t('Mode'), '']} empty={t('No recurring invoices.')}>
        {search(data.rec).map((r) => {
          const total = r.template.lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price * (1 + (l.tax_rate || 0) / 100)), 0);
          return (<tr key={r.id} className={r.active ? '' : 'opacity-50'}><td className="td font-medium">{r.name}</td><td className="td">{r.contact_name}</td><td className="td">{FREQ[r.frequency]}</td><td className="td">{date(r.next_date)}</td><td className="td num text-right">{money(total)}</td>
            <td className="td">{r.auto_post ? <Badge status="sent">{t('Auto-issues')}</Badge> : <Badge status="draft">{t('Draft')}</Badge>}</td>
            <td className="td whitespace-nowrap text-right">{w && <><button className="text-xs text-brand-700 hover:underline" onClick={() => run(async () => { await api.put(`/recurring/${r.id}`, { active: !r.active }); reload(); })}>{r.active ? t('Pause') : t('Resume')}</button>
              <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this recurring invoice?')) && run(async () => { await api.del(`/recurring/${r.id}`); reload(); })}>{t('Delete')}</button></>}</td></tr>);
        })}
      </Table></Card>
      {adding && <RecModal contacts={data.contacts} items={data.items} settings={settings} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}
