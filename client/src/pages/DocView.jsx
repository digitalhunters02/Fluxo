import { t } from '../i18n.jsx';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, fromCents, money, number, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const NAMES = { invoice: t('Invoice'), estimate: t('Estimate'), bill: t('Bill') };

function PaymentModal({ doc, onClose, onDone }) {
  const [run, busy] = useAction();
  const { data: accounts } = useLoad(() => api.get('/banking/accounts').catch(() => api.get('/accounts/lookup')));
  const [f, setF] = useState({ date: today(), amount: fromCents(doc.balance), account_id: '', method: '', ref: '' });
  const list = (accounts || []).filter((a) => a.subtype === 'bank' || a.subtype === 'credit_card');
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const r = await run(() => api.post(`/doc/${doc.id}/payments`, { ...f, amount: toCents(f.amount), account_id: Number(f.account_id || list[0]?.id) }), t('Payment recorded'));
    if (r) onDone(r);
  };
  return (
    <Modal title={doc.type === 'invoice' ? t('Record payment received') : t('Record payment')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Confirm')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Date')}><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label={t('Amount')} hint={t('Balance: {0}', [money(doc.balance)])}><Input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field>
        <Field label={doc.type === 'invoice' ? t('Deposit to') : t('Pay from')} className="col-span-2"><Select value={f.account_id || list[0]?.id || ''} onChange={set('account_id')}>{list.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('Method')}><Select value={f.method} onChange={set('method')}><option value="">—</option>{[t('ACH'), t('Money order'), t('Card'), t('Wire transfer'), t('Cash'), t('Check')].map((m) => <option key={m}>{m}</option>)}</Select></Field>
        <Field label={t('Reference')}><Input value={f.ref} onChange={set('ref')} /></Field>
      </div>
    </Modal>
  );
}

export default function DocView() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { can, settings } = useAuth();
  const { data: d, loading, error, reload } = useLoad(() => api.get(`/doc/${id}`), [id]);
  const [run, busy] = useAction();
  const [paying, setPaying] = useState(false);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const mod = d.type === 'bill' ? 'purchases' : 'sales';
  const w = can(mod, true);
  const act = (a, msg) => run(async () => { await api.post(`/doc/${id}/${a}`); reload(); }, msg);
  const link = `${location.origin}/p/${d.share_token}`;
  const posted = d.type !== 'estimate' && !['draft', 'void'].includes(d.status);

  return (
    <>
      <PageHeader title={`${NAMES[d.type]} ${d.number}`} subtitle={<span className="flex items-center gap-2"><Badge status={d.overdue ? 'overdue' : d.status} />{d.project_name && <span>{t('Project:')}{' '}{d.project_name}</span>}</span>}>
        <Button variant="ghost" onClick={() => nav(-1)}>{t('Back')}</Button>
        {d.type !== 'bill' && <Button variant="ghost" onClick={() => window.print()}>{t('Print / PDF')}</Button>}
        {d.type !== 'bill' && <Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(link); toast(t('Link copied')); } catch { prompt(t('Copy the link:'), link); } }}>{t('Copy link')}</Button>}
        {d.type !== 'bill' && d.contact_email && <a className="btn btn-ghost" href={`mailto:${d.contact_email}?subject=${encodeURIComponent(`${NAMES[d.type]} ${d.number}`)}&body=${encodeURIComponent(t('Hi! Here is the link to view the document: {0}', [link]))}`}>{t('Send by email')}</a>}
        {w && d.status !== 'void' && d.status !== 'invoiced' && <Link className="btn btn-ghost" to={`/document/${d.type}/${d.id}/edit`}>{t('Edit')}</Link>}
        {w && d.status === 'draft' && d.type === 'invoice' && <Button disabled={busy} onClick={() => act('post', t('Invoice issued'))}>{t('Issue')}</Button>}
        {w && posted && d.balance > 0 && <Button disabled={busy} onClick={() => setPaying(true)}>{d.type === 'invoice' ? t('Record payment received') : t('Record payment')}</Button>}
        {w && d.type === 'estimate' && ['draft', 'sent', 'accepted'].includes(d.status) && <Button disabled={busy} onClick={() => run(async () => { const inv = await api.post(`/doc/${id}/convert`); nav(`/document/${inv.id}`); }, t('Converted to invoice (draft)'))}>{t('Convert to invoice')}</Button>}
      </PageHeader>
      <Card className="mx-auto max-w-4xl">
        <div className="flex flex-wrap justify-between gap-6 border-b border-slate-100 pb-5">
          <div><div className="text-lg font-semibold">{settings.company_name}</div>{settings.company_tax_id && <div className="text-sm text-slate-500">{settings.company_tax_id}</div>}</div>
          <div className="text-right text-sm"><div className="text-xl font-semibold">{NAMES[d.type].toUpperCase()}</div><div className="text-slate-500">{d.number}</div></div>
        </div>
        <div className="grid gap-4 py-5 text-sm sm:grid-cols-3">
          <div><div className="text-xs uppercase text-slate-500">{d.type === 'bill' ? t('Vendor') : t('Customer')}</div><div className="font-medium">{d.contact_name}</div></div>
          <div><div className="text-xs uppercase text-slate-500">{t('Issued')}</div>{date(d.issue_date)}</div>
          <div><div className="text-xs uppercase text-slate-500">{d.type === 'estimate' ? t('Valid until') : t('Due')}</div>{date(d.due_date)}</div>
        </div>
        <Table head={[t('Description'), { label: t('Qty'), right: true }, { label: t('Price'), right: true }, ...(d.type === 'bill' ? [] : [{ label: t('Tax§short'), right: true }]), { label: t('Total'), right: true }]}>
          {d.lines.map((l) => (
            <tr key={l.id}><td className="td">{l.description || l.item_name}</td><td className="td num text-right">{number(l.qty, 3)}</td><td className="td num text-right">{money(l.unit_price)}</td>
              {d.type !== 'bill' && <td className="td num text-right">{l.tax_rate ? `${number(l.tax_rate)}%` : '—'}</td>}<td className="td num text-right">{money(l.amount)}</td></tr>
          ))}
        </Table>
        <dl className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">{t('Subtotal')}</dt><dd className="num">{money(d.subtotal)}</dd></div>
          {d.type !== 'bill' && <div className="flex justify-between"><dt className="text-slate-500">{t('Taxes')}</dt><dd className="num">{money(d.tax)}</dd></div>}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold"><dt>{t('Total')}</dt><dd className="num">{money(d.total)}</dd></div>
          {d.type !== 'estimate' && <><div className="flex justify-between"><dt className="text-slate-500">{t('Paid§m')}</dt><dd className="num">{money(d.paid)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>{t('Balance')}</dt><dd className="num">{money(d.balance)}</dd></div></>}
        </dl>
        {d.notes && <p className="mt-5 whitespace-pre-line border-t border-slate-100 pt-4 text-sm text-slate-600">{d.notes}</p>}
        {d.type !== 'bill' && settings.invoice_footer && <p className="mt-4 text-center text-xs text-slate-400">{settings.invoice_footer}</p>}
      </Card>
      {d.payments.length > 0 && (
        <Card title={t('Payments')} className="no-print mx-auto mt-4 max-w-4xl" pad={false}>
          <Table head={[t('Date'), t('Account'), t('Method'), t('Ref.'), { label: t('Amount'), right: true }, '']}>
            {d.payments.map((p) => (
              <tr key={p.id}><td className="td">{date(p.date)}</td><td className="td">{p.account_name}</td><td className="td">{p.method}</td><td className="td">{p.ref}</td><td className="td num text-right">{money(p.amount)}</td>
                <td className="td text-right">{can('accounting', true) && <button className="text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this payment?')) && run(async () => { await api.del(`/payments/${p.id}`); reload(); }, t('Payment deleted'))}>{t('Delete')}</button>}</td></tr>
            ))}
          </Table>
        </Card>
      )}
      {w && (
        <div className="no-print mx-auto mt-4 flex max-w-4xl justify-end gap-2">
          {posted && <Button variant="danger" disabled={busy} onClick={() => confirm(t('Void this document? Its accounting entries will be reversed.')) && act('void', t('Document voided'))}>{t('Void')}</Button>}
          {['draft', 'void', 'accepted', 'declined', 'sent', 'invoiced'].includes(d.status) && d.type === 'estimate' && d.status !== 'invoiced' && <>
            {d.status === 'sent' && <Button variant="ghost" onClick={() => act('accept', t('Estimate accepted'))}>{t('Mark as accepted')}</Button>}
            {d.status === 'sent' && <Button variant="ghost" onClick={() => act('decline', t('Estimate declined'))}>{t('Mark as declined')}</Button>}
          </>}
          {['draft', 'void'].includes(d.status) || d.type === 'estimate' ? <Button variant="danger" disabled={busy} onClick={() => confirm(t('Delete permanently?')) && run(async () => { await api.del(`/doc/${id}`); nav(-1); }, t('Deleted'))}>{t('Delete')}</Button> : null}
        </div>
      )}
      {paying && <PaymentModal doc={d} onClose={() => setPaying(false)} onDone={() => { setPaying(false); reload(); }} />}
    </>
  );
}
