import { t } from '../i18n.jsx';
import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { date, money, statusLabel, today, toCents } from '../format.js';
import { download } from '../csv.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Stat, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const TITLES = { invoice: [t('Invoices'), t('New invoice'), t('Customer')], estimate: [t('Estimates'), t('New estimate'), t('Customer')], bill: [t('Bills'), t('New bill'), t('Vendor')], credit: [t('Credit memos'), t('New credit memo'), t('Customer')], po: [t('Purchase orders'), t('New purchase order'), t('Vendor')] };

function BatchModal({ onClose, onDone }) {
  const [run, busy] = useAction();
  const { settings } = useAuth();
  const { data: contacts } = useLoad(() => api.get('/contacts?kind=customer'));
  const [sel, setSel] = useState(new Set());
  const [q, setQ] = useState('');
  const [f, setF] = useState({ issue_date: today(), terms_days: '', description: '', qty: '1', price: '', tax_rate: String(settings.default_tax_rate || 0), post: true });
  const list = (contacts || []).filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id) => setSel((x) => { const n = new Set(x); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = async () => {
    const r = await run(() => api.post('/docs/invoice/batch', { contact_ids: [...sel], issue_date: f.issue_date, terms_days: f.terms_days === '' ? undefined : Number(f.terms_days), post: f.post,
      lines: [{ description: f.description, qty: Number(f.qty) || 1, unit_price: toCents(f.price), tax_rate: Number(f.tax_rate) || 0 }] }), t('Invoices created'));
    if (r) onDone();
  };
  return (
    <Modal wide title={t('Batch invoices')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !sel.size || !f.description || !toCents(f.price)} onClick={save}>{t('Create {0} invoice(s)', [sel.size])}</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <Input placeholder={t('Search customers…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} />
          <div className="mt-2 max-h-64 overflow-auto rounded border border-slate-200">
            {list.map((c) => <label key={c.id} className="flex items-center gap-2 border-b border-slate-100 px-3 py-2 text-sm last:border-0"><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} />{c.name}</label>)}
          </div>
          <button className="mt-2 text-xs text-brand-700 hover:underline" onClick={() => setSel(new Set(list.map((c) => c.id)))}>{t('Select all')}</button>
        </div>
        <div className="grid grid-cols-2 gap-3 content-start">
          <Field label={t('Description')} className="col-span-2"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
          <Field label={t('Quantity')}><Input inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></Field>
          <Field label={t('Price')}><Input inputMode="decimal" placeholder="0.00" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
          <Field label={t('Tax %')}><Input inputMode="decimal" value={f.tax_rate} onChange={(e) => setF({ ...f, tax_rate: e.target.value })} /></Field>
          <Field label={t('Issued')}><Input type="date" value={f.issue_date} onChange={(e) => setF({ ...f, issue_date: e.target.value })} /></Field>
          <Field label={t('Terms (days)')} hint={t('Blank = each customer’s own terms')}><Input type="number" min="0" value={f.terms_days} onChange={(e) => setF({ ...f, terms_days: e.target.value })} /></Field>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.post} onChange={(e) => setF({ ...f, post: e.target.checked })} /> {t('Issue now (otherwise save as drafts)')}</label>
        </div>
      </div>
    </Modal>
  );
}

export default function Docs({ type }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad(() => api.get(`/docs/${type}`), [type]);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [title, newLabel, who] = TITLES[type];
  const mod = ['bill', 'po'].includes(type) ? 'purchases' : 'sales';
  const purchase = ['bill', 'po'].includes(type);
  const { has, planInfo } = useAuth();
  const [batch, setBatch] = useState(false);
  const rows = useMemo(() => (data || []).filter((d) => {
    if (status === 'overdue' ? !d.overdue : status && d.status !== status) return false;
    return !q || `${d.number} ${d.contact_name}`.toLowerCase().includes(q.toLowerCase());
  }), [data, q, status]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const open = data.filter((d) => ['sent', 'open', 'partial'].includes(d.status));
  const sum = (a) => a.reduce((s, d) => s + d.balance, 0);
  const statuses = type === 'estimate' ? ['draft', 'sent', 'accepted', 'declined', 'invoiced'] : type === 'po' ? ['draft', 'sent', 'accepted', 'declined', 'billed', 'void'] : type === 'credit' ? ['draft', 'open', 'partial', 'used', 'void'] : ['draft', type === 'bill' ? 'open' : 'sent', 'partial', 'paid', 'void'];
  return (
    <>
      <PageHeader title={title}>
        <Button variant="ghost" onClick={() => download(`${type}s.csv`, [[t('Number'), who, t('Issued'), t('Due'), t('Status'), t('Total'), t('Paid§m'), t('Balance')], ...rows.map((d) => [d.number, d.contact_name, d.issue_date, d.due_date, d.status, d.total / 100, d.paid / 100, d.balance / 100])])}>{t('Export CSV')}</Button>
        {type === 'invoice' && can('sales', true) && has('batch_invoices') && <Button variant="ghost" onClick={() => setBatch(true)}>{t('Batch invoices')}</Button>}
        {can(mod, true) && <Button onClick={() => nav(`/document/${type}/new`)}>+ {newLabel}</Button>}
      </PageHeader>
      {type === 'invoice' && planInfo.limits.invoices_per_month != null && (
        <p className="mb-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-700">{t('Free plan: {0} of {1} invoices used this month.', [planInfo.limits.invoices_used, planInfo.limits.invoices_per_month])} <Link to="/settings/plan" className="font-semibold underline">{t('See plans')}</Link></p>
      )}
      {type === 'credit' && <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-3"><Stat label={t('Unused credit')} value={money(sum(open))} sub={`${open.length} ${t('credit memo(s)')}`} /></div>}
      {['invoice', 'bill'].includes(type) && (
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-3">
          <Stat label={t('Open')} value={money(sum(open))} sub={t('{0} document(s)', [open.length])} />
          <Stat label={t('Overdue§m')} value={money(sum(open.filter((d) => d.overdue)))} sub={t('{0} document(s)', [open.filter((d) => d.overdue).length])} tone={open.some((d) => d.overdue) ? 'bad' : 'default'} />
        </div>
      )}
      <Card pad={false}>
        <div className="flex flex-wrap gap-3 border-b border-slate-100 p-3">
          <Input className="field max-w-xs" placeholder={purchase ? t('Search by number or vendor…') : t('Search by number or customer…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} />
          <Select className="field max-w-[11rem]" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('Filter by status')}>
            <option value="">{t('All statuses')}</option>{['invoice', 'bill'].includes(type) && <option value="overdue">{t('Overdue§fp')}</option>}
            {statuses.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </Select>
        </div>
        <Table head={[t('Number'), who, t('Issued'), t('Due'), t('Status'), { label: t('Total'), right: true }, { label: t('Balance'), right: true }]} empty={t('No documents found.')}>
          {rows.map((d) => (
            <tr key={d.id} className="hover:bg-slate-50">
              <td className="td font-medium"><Link className="text-brand-700 hover:underline" to={`/document/${d.id}`}>{d.number}</Link></td>
              <td className="td">{d.contact_name}</td><td className="td">{date(d.issue_date)}</td>
              <td className={`td ${d.overdue ? 'font-medium text-rose-600' : ''}`}>{date(d.due_date)}</td>
              <td className="td"><Badge status={d.overdue ? 'overdue' : d.status} /></td>
              <td className="td num text-right">{money(d.total)}</td>
              <td className="td num text-right font-medium">{['estimate', 'po'].includes(type) ? '—' : money(d.balance)}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {batch && <BatchModal onClose={() => setBatch(false)} onDone={() => { setBatch(false); reload(); }} />}
    </>
  );
}
