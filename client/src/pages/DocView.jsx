import { t } from '../i18n.jsx';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, fromCents, money, number, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const NAMES = { invoice: t('Invoice'), estimate: t('Estimate'), bill: t('Bill'), credit: t('Credit memo'), po: t('Purchase order') };

function ApplyCreditModal({ credit, onClose, onDone }) {
  const [act, busy] = useAction();
  const { data } = useLoad(() => api.get('/docs/invoice'));
  const invoices = (data || []).filter((i) => i.contact_id === credit.contact_id && ['sent', 'partial'].includes(i.status) && i.balance > 0);
  const [f, setF] = useState({ invoice_id: '', amount: '', date: today() });
  const inv = invoices.find((i) => String(i.id) === String(f.invoice_id || invoices[0]?.id));
  const amount = f.amount === '' ? fromCents(Math.min(credit.balance, inv?.balance || 0)) : f.amount;
  return (
    <Modal title={t('Apply credit to an invoice')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
      <Button disabled={busy || !inv} onClick={async () => { const r = await act(() => api.post(`/doc/${credit.id}/apply-credit`, { invoice_id: inv.id, amount: toCents(amount), date: f.date }), t('Credit applied')); if (r) onDone(); }}>{t('Apply')}</Button></>}>
      {invoices.length === 0 ? <p className="text-sm text-slate-500">{t('This customer has no open invoices.')}</p> : (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('Invoice')} className="col-span-2"><Select value={inv?.id || ''} onChange={(e) => setF({ ...f, invoice_id: e.target.value, amount: '' })}>{invoices.map((i) => <option key={i.id} value={i.id}>{i.number} — {money(i.balance)}</option>)}</Select></Field>
          <Field label={t('Amount')} hint={`${t('Credit balance:')} ${money(credit.balance)}`}><Input inputMode="decimal" value={amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
          <Field label={t('Date')}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        </div>)}
    </Modal>
  );
}

function RefundModal({ credit, onClose, onDone }) {
  const [act, busy] = useAction();
  const { data: accounts } = useLoad(() => api.get('/banking/accounts'));
  const banks = (accounts || []).filter((a) => a.subtype === 'bank');
  const [f, setF] = useState({ account_id: '', amount: fromCents(credit.balance), date: today() });
  return (
    <Modal title={t('Refund the customer')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
      <Button disabled={busy || !banks.length} onClick={async () => { const r = await act(() => api.post(`/doc/${credit.id}/refund`, { account_id: Number(f.account_id || banks[0].id), amount: toCents(f.amount), date: f.date }), t('Refund recorded')); if (r) onDone(); }}>{t('Record refund')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Pay from')} className="col-span-2"><Select value={f.account_id || banks[0]?.id || ''} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('Amount')} hint={`${t('Credit balance:')} ${money(credit.balance)}`}><Input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label={t('Date')}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
      </div>
      <p className="mt-3 text-xs text-slate-400">{t('This records the money going out in your books. Send the actual refund from your bank.')}</p>
    </Modal>
  );
}

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
  const { can, settings, user } = useAuth();
  const { data: d, loading, error, reload } = useLoad(() => api.get(`/doc/${id}`), [id]);
  const [run, busy] = useAction();
  const [paying, setPaying] = useState(false);
  const [applying, setApplying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const purchase = ['bill', 'po'].includes(d.type);
  const isQuote = ['estimate', 'po'].includes(d.type);
  const mod = purchase ? 'purchases' : 'sales';
  const w = can(mod, true);
  const act = (a, msg) => run(async () => { await api.post(`/doc/${id}/${a}`); reload(); }, msg);
  const link = `${location.origin}/p/${user.tenant ? `${user.tenant}.` : ''}${d.share_token}`; // hospedado: o link leva a empresa junto
  const posted = !isQuote && !['draft', 'void'].includes(d.status);

  return (
    <>
      <PageHeader title={`${NAMES[d.type]} ${d.number}`} subtitle={<span className="flex items-center gap-2"><Badge status={d.overdue ? 'overdue' : d.status} />{d.project_name && <span>{t('Project:')}{' '}{d.project_name}</span>}</span>}>
        <Button variant="ghost" onClick={() => nav(-1)}>{t('Back')}</Button>
        {!purchase && <Button variant="ghost" onClick={() => window.print()}>{t('Print / PDF')}</Button>}
        {!purchase && <Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(link); toast(t('Link copied')); } catch { prompt(t('Copy the link:'), link); } }}>{t('Copy link')}</Button>}
        {!purchase && d.contact_email && <a className="btn btn-ghost" href={`mailto:${d.contact_email}?subject=${encodeURIComponent(`${NAMES[d.type]} ${d.number}`)}&body=${encodeURIComponent(t('Hi! Here is the link to view the document: {0}', [link]))}`}>{t('Send by email')}</a>}
        {w && !['void', 'invoiced', 'billed'].includes(d.status) && <Link className="btn btn-ghost" to={`/document/${d.type}/${d.id}/edit`}>{t('Edit')}</Link>}
        {w && d.status === 'draft' && ['invoice', 'credit'].includes(d.type) && <Button disabled={busy} onClick={() => act('post', t('Document issued'))}>{t('Issue')}</Button>}
        {w && posted && ['invoice', 'bill'].includes(d.type) && d.balance > 0 && <Button disabled={busy} onClick={() => setPaying(true)}>{d.type === 'invoice' ? t('Record payment received') : t('Record payment')}</Button>}
        {w && d.type === 'credit' && posted && d.balance > 0 && <><Button disabled={busy} onClick={() => setApplying(true)}>{t('Apply to invoice')}</Button><Button variant="ghost" disabled={busy} onClick={() => setRefunding(true)}>{t('Refund')}</Button></>}
        {w && d.type === 'po' && ['draft', 'sent', 'accepted'].includes(d.status) && <Button disabled={busy} onClick={() => run(async () => { const b = await api.post(`/doc/${id}/convert-po`); nav(`/document/${b.id}`); }, t('Converted to bill (draft)'))}>{t('Convert to bill')}</Button>}
        {w && d.type === 'estimate' && ['draft', 'sent', 'accepted'].includes(d.status) && <Button disabled={busy} onClick={() => run(async () => { const inv = await api.post(`/doc/${id}/convert`); nav(`/document/${inv.id}`); }, t('Converted to invoice (draft)'))}>{t('Convert to invoice')}</Button>}
      </PageHeader>
      <Card className="mx-auto max-w-4xl">
        <div className="flex flex-wrap justify-between gap-6 border-b border-slate-100 pb-5">
          <div>{settings.company_logo && <img src={settings.company_logo} alt="" className="mb-2 max-h-14" />}<div className="text-lg font-semibold">{settings.company_name}</div>{settings.company_tax_id && <div className="text-sm text-slate-500">{settings.company_tax_id}</div>}</div>
          <div className="text-right text-sm"><div className="text-xl font-semibold">{NAMES[d.type].toUpperCase()}</div><div className="text-slate-500">{d.number}</div></div>
        </div>
        <div className="grid gap-4 py-5 text-sm sm:grid-cols-3">
          <div><div className="text-xs uppercase text-slate-500">{purchase ? t('Vendor') : t('Customer')}</div><div className="font-medium">{d.contact_name}</div></div>
          <div><div className="text-xs uppercase text-slate-500">{t('Issued')}</div>{date(d.issue_date)}</div>
          <div><div className="text-xs uppercase text-slate-500">{isQuote ? t('Valid until') : t('Due')}</div>{date(d.due_date)}</div>
        </div>
        <Table head={[t('Description'), { label: t('Qty'), right: true }, { label: t('Price'), right: true }, ...(purchase ? [] : [{ label: t('Tax§short'), right: true }]), { label: t('Total'), right: true }]}>
          {d.lines.map((l) => (
            <tr key={l.id}><td className="td">{l.description || l.item_name}</td><td className="td num text-right">{number(l.qty, 3)}</td><td className="td num text-right">{money(l.unit_price)}</td>
              {!purchase && <td className="td num text-right">{l.tax_rate ? `${number(l.tax_rate)}%` : '—'}</td>}<td className="td num text-right">{money(l.amount)}</td></tr>
          ))}
        </Table>
        <dl className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">{t('Subtotal')}</dt><dd className="num">{money(d.subtotal)}</dd></div>
          {!purchase && <div className="flex justify-between"><dt className="text-slate-500">{t('Taxes')}</dt><dd className="num">{money(d.tax)}</dd></div>}
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold"><dt>{t('Total')}</dt><dd className="num">{money(d.total)}</dd></div>
          {!isQuote && <><div className="flex justify-between"><dt className="text-slate-500">{d.type === 'credit' ? t('Used') : t('Paid§m')}</dt><dd className="num">{money(d.paid)}</dd></div>
            <div className="flex justify-between font-semibold"><dt>{t('Balance')}</dt><dd className="num">{money(d.balance)}</dd></div></>}
        </dl>
        {d.notes && <p className="mt-5 whitespace-pre-line border-t border-slate-100 pt-4 text-sm text-slate-600">{d.notes}</p>}
        {!purchase && settings.invoice_footer && <p className="mt-4 text-center text-xs text-slate-400">{settings.invoice_footer}</p>}
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
      {d.applications?.length > 0 && (
        <Card title={d.type === 'credit' ? t('Where this credit went') : t('Credits applied')} className="no-print mx-auto mt-4 max-w-4xl" pad={false}>
          <Table head={[t('Date'), d.type === 'credit' ? t('Applied to') : t('Credit memo'), { label: t('Amount'), right: true }, '']}>
            {d.applications.map((a) => (
              <tr key={a.id}><td className="td">{date(a.date)}</td><td className="td">{d.type === 'credit' ? (a.invoice_number || `${t('Refund')} — ${a.account_name || ''}`) : a.credit_number}</td><td className="td num text-right">{money(a.amount)}</td>
                <td className="td text-right">{can('sales', true) && <button className="text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Remove this credit application?')) && run(async () => { await api.del(`/credit-applications/${a.id}`); reload(); }, t('Removed'))}>{t('Remove')}</button>}</td></tr>
            ))}
          </Table>
        </Card>
      )}
      {w && (
        <div className="no-print mx-auto mt-4 flex max-w-4xl justify-end gap-2">
          {posted && <Button variant="danger" disabled={busy} onClick={() => confirm(t('Void this document? Its accounting entries will be reversed.')) && act('void', t('Document voided'))}>{t('Void')}</Button>}
          {['draft', 'void', 'accepted', 'declined', 'sent', 'invoiced'].includes(d.status) && isQuote && !['invoiced', 'billed'].includes(d.status) && <>
            {d.status === 'sent' && <Button variant="ghost" onClick={() => act('accept', t('Estimate accepted'))}>{t('Mark as accepted')}</Button>}
            {d.status === 'sent' && <Button variant="ghost" onClick={() => act('decline', t('Estimate declined'))}>{t('Mark as declined')}</Button>}
          </>}
          {['draft', 'void'].includes(d.status) || isQuote ? <Button variant="danger" disabled={busy} onClick={() => confirm(t('Delete permanently?')) && run(async () => { await api.del(`/doc/${id}`); nav(-1); }, t('Deleted'))}>{t('Delete')}</Button> : null}
        </div>
      )}
      {applying && <ApplyCreditModal credit={d} onClose={() => setApplying(false)} onDone={() => { setApplying(false); reload(); }} />}
      {refunding && <RefundModal credit={d} onClose={() => setRefunding(false)} onDone={() => { setRefunding(false); reload(); }} />}
      {paying && <PaymentModal doc={d} onClose={() => setPaying(false)} onDone={() => { setPaying(false); reload(); }} />}
    </>
  );
}
