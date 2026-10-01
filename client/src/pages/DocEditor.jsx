import { t } from '../i18n.jsx';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { addDays, fromCents, money, toCents, today } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const blank = (taxRate) => ({ item_id: '', description: '', qty: '1', price: '', tax_rate: String(taxRate ?? 0), account_id: '', class_id: '' });

const TITLES = { invoice: [t('New invoice'), t('Edit invoice')], estimate: [t('New estimate'), t('Edit estimate')], bill: [t('New bill'), t('Edit bill')], credit: [t('New credit memo'), t('Edit credit memo')], po: [t('New purchase order'), t('Edit purchase order')] };

function QuickContact({ kind, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [run, busy] = useAction();
  const save = async () => { const c = await run(() => api.post('/contacts', { name, kind })); if (c) onCreated(c); };
  return (
    <Modal title={kind === 'vendor' ? t('New vendor') : t('New customer')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !name.trim()} onClick={save}>{t('Create')}</Button></>}>
      <Field label={t('Name')}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && save()} /></Field>
      <p className="mt-2 text-xs text-slate-400">{kind === 'vendor' ? t('You can complete the details later under Vendors.') : t('You can complete the details later under Customers.')}</p>
    </Modal>
  );
}

export default function DocEditor() {
  const { type: typeParam, id } = useParams();
  const nav = useNavigate();
  const { settings, has } = useAuth();
  const [run, busy] = useAction();
  const [payNow, setPayNow] = useState('');
  const meta = useLoad(async () => {
    const [contacts, items, accounts, projects, classes, banks, existing] = await Promise.all([
      api.get('/contacts'), api.get('/items/lookup'), api.get('/accounts/lookup'), api.get('/projects').catch(() => []), api.get('/classes').catch(() => []),
      api.get('/banking/accounts').catch(() => []), id ? api.get(`/doc/${id}`) : null]);
    return { contacts, items, accounts, projects, classes: classes.filter((c) => c.active), banks: banks.filter((a) => a.subtype === 'bank'), existing };
  }, [id]);
  const [doc, setDoc] = useState(null);
  const [quick, setQuick] = useState(false);
  const type = meta.data?.existing?.type || typeParam;
  const isBill = ['bill', 'po'].includes(type); // documentos de compra: sem imposto, categoria por linha
  const isQuote = ['estimate', 'po'].includes(type);

  useEffect(() => {
    if (!meta.data || doc) return;
    const e = meta.data.existing;
    const rate = Number(settings.default_tax_rate || 0);
    if (e) setDoc({ contact_id: String(e.contact_id), project_id: e.project_id ? String(e.project_id) : '', issue_date: e.issue_date, due_date: e.due_date, notes: e.notes,
      lines: e.lines.map((l) => ({ item_id: l.item_id ? String(l.item_id) : '', description: l.description, qty: String(l.qty), price: fromCents(l.unit_price), tax_rate: String(l.tax_rate), account_id: l.account_id ? String(l.account_id) : '', class_id: l.class_id ? String(l.class_id) : '', time_entry_id: l.time_entry_id })), status: e.status });
    else setDoc({ contact_id: '', project_id: '', issue_date: today(), due_date: addDays(today(), Number(settings.default_terms_days || 15)), notes: '', lines: [blank(isBill ? 0 : rate)], status: 'draft' });
  }, [meta.data, doc, settings, isBill]);

  const totals = useMemo(() => {
    if (!doc) return { subtotal: 0, tax: 0, total: 0 };
    let subtotal = 0, tax = 0;
    for (const l of doc.lines) { const a = Math.round((Number(String(l.qty).replace(',', '.')) || 0) * toCents(l.price)); subtotal += a; tax += isBill ? 0 : Math.round((a * (Number(l.tax_rate) || 0)) / 100); }
    return { subtotal, tax, total: subtotal + tax };
  }, [doc, isBill]);

  if (meta.loading || !doc) return meta.error ? <ErrorBox error={meta.error} retry={meta.reload} /> : <Loading />;
  const { contacts, items, accounts, projects, classes, banks } = meta.data;
  const people = contacts.filter((c) => (isBill ? ['vendor', 'both'] : ['customer', 'both']).includes(c.kind));
  const expenseAccounts = accounts.filter((a) => a.type === 'expense' && a.subtype !== 'cogs');
  const set = (k, v) => setDoc((d) => ({ ...d, [k]: v }));
  const setLine = (i, patch) => setDoc((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const pickContact = (cid) => {
    const c = contacts.find((x) => String(x.id) === cid);
    setDoc((d) => ({ ...d, contact_id: cid, due_date: c && !id ? addDays(d.issue_date, c.terms_days) : d.due_date }));
  };
  const pickItem = (i, itemId) => {
    const it = items.find((x) => String(x.id) === itemId);
    if (!it) return setLine(i, { item_id: '' });
    setLine(i, { item_id: itemId, description: it.name, price: fromCents(isBill && it.cost ? it.cost : it.price), tax_rate: isBill ? '0' : String(it.tax_rate || 0) });
  };

  const save = async (post) => {
    const body = { contact_id: Number(doc.contact_id), project_id: doc.project_id ? Number(doc.project_id) : null, issue_date: doc.issue_date, due_date: doc.due_date, notes: doc.notes, post,
      lines: doc.lines.filter((l) => l.description || l.item_id || toCents(l.price)).map((l) => ({ item_id: l.item_id ? Number(l.item_id) : null, description: l.description, qty: Number(String(l.qty).replace(',', '.')),
        unit_price: toCents(l.price), tax_rate: Number(l.tax_rate) || 0, account_id: l.account_id ? Number(l.account_id) : null, class_id: l.class_id ? Number(l.class_id) : null, time_entry_id: l.time_entry_id || null })) };
    if (!id && type === 'invoice' && payNow) { body.post = true; body.pay_now = { account_id: Number(payNow) }; }
    if (!body.contact_id) return run(async () => { throw new Error(isBill ? t('Select the vendor') : t('Select the customer')); });
    const r = await run(() => (id ? api.put(`/doc/${id}`, body) : api.post(`/docs/${type}`, body)), t('Saved'));
    if (r) nav(`/document/${r.id}`);
  };
  const posted = id && !['draft', 'accepted', 'declined'].includes(doc.status) && !isQuote;

  return (
    <>
      <PageHeader title={TITLES[type][id ? 1 : 0]} subtitle={posted ? t('Already issued: saving will redo its accounting entries.') : undefined}>
        <Button variant="ghost" onClick={() => nav(-1)}>{t('Cancel')}</Button>
        {!posted && type !== 'bill' && <Button variant="ghost" disabled={busy} onClick={() => save(false)}>{t('Save draft')}</Button>}
        <Button disabled={busy} onClick={() => save(true)}>{posted ? t('Save changes') : isQuote ? t('Save and mark as sent') : type === 'bill' ? t('Save') : payNow ? t('Save and record payment') : t('Save and issue')}</Button>
      </PageHeader>
      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <Field label={isBill ? t('Vendor') : t('Customer')} className="md:col-span-2">
            <div className="flex gap-2">
              <Select value={doc.contact_id} onChange={(e) => pickContact(e.target.value)}><option value="">{t('Select…')}</option>{people.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              <Button variant="ghost" type="button" onClick={() => setQuick(true)} title={t('New contact')}>+</Button>
            </div>
          </Field>
          <Field label={t('Issued')}><Input type="date" value={doc.issue_date} onChange={(e) => set('issue_date', e.target.value)} /></Field>
          <Field label={isQuote ? t('Valid until') : t('Due')}><Input type="date" value={doc.due_date} min={doc.issue_date} onChange={(e) => set('due_date', e.target.value)} /></Field>
          <Field label={t('Project (optional)')} className="md:col-span-2"><Select value={doc.project_id} onChange={(e) => set('project_id', e.target.value)}><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        </div>
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="pb-2 pr-2">{t('Item')}</th><th className="pb-2 pr-2">{t('Description')}</th><th className="w-20 pb-2 pr-2">{t('Qty')}</th><th className="w-28 pb-2 pr-2">{t('Price')}</th>
              {isBill ? <th className="w-44 pb-2 pr-2">{t('Category')}</th> : <th className="w-20 pb-2 pr-2">{t('Tax %')}</th>}{has('classes') && classes.length > 0 && <th className="w-28 pb-2 pr-2">{t('Class')}</th>}<th className="w-28 pb-2 text-right">{t('Total')}</th><th className="w-8" /></tr></thead>
            <tbody>{doc.lines.map((l, i) => {
              const it = items.find((x) => String(x.id) === l.item_id);
              const amt = Math.round((Number(String(l.qty).replace(',', '.')) || 0) * toCents(l.price));
              return (
                <tr key={i} className="align-top">
                  <td className="pb-2 pr-2"><Select value={l.item_id} onChange={(e) => pickItem(i, e.target.value)} aria-label={t('Item')}><option value="">—</option>{items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></td>
                  <td className="pb-2 pr-2"><Input value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} aria-label={t('Description')} />{it?.track_inventory === 1 && !isBill && <span className="text-xs text-slate-400">{t('In stock:')}{' '}{it.qty_on_hand}</span>}</td>
                  <td className="pb-2 pr-2"><Input inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, { qty: e.target.value })} aria-label={t('Quantity')} /></td>
                  <td className="pb-2 pr-2"><Input inputMode="decimal" placeholder="0.00" value={l.price} onChange={(e) => setLine(i, { price: e.target.value })} aria-label={t('Price')} /></td>
                  {isBill
                    ? <td className="pb-2 pr-2">{it?.track_inventory ? <span className="text-xs text-slate-500">{t('Inventory')}</span> : <Select value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })} aria-label={t('Category')}><option value="">{t('Miscellaneous expenses')}</option>{expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select>}</td>
                    : <td className="pb-2 pr-2"><Input inputMode="decimal" value={l.tax_rate} onChange={(e) => setLine(i, { tax_rate: e.target.value })} aria-label={t('Tax')} /></td>}
                  {has('classes') && classes.length > 0 && <td className="pb-2 pr-2"><Select value={l.class_id} onChange={(e) => setLine(i, { class_id: e.target.value })} aria-label={t('Class')}><option value="">—</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></td>}
                  <td className="num pb-2 pt-2 text-right font-medium">{money(amt)}</td>
                  <td className="pb-2 pt-1.5 text-right"><button type="button" aria-label={t('Remove line')} className="text-slate-400 hover:text-rose-600" onClick={() => set('lines', doc.lines.length > 1 ? doc.lines.filter((_, j) => j !== i) : [blank(doc.lines[0].tax_rate)])}>✕</button></td>
                </tr>
              );
            })}</tbody>
          </table>
          <Button variant="ghost" type="button" className="mt-1" onClick={() => set('lines', [...doc.lines, blank(isBill ? 0 : Number(settings.default_tax_rate || 0))])}>{t('+ Add line')}</Button>
        </div>
        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <Field label={t('Notes§doc')}><textarea className="field h-24" value={doc.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
            {type === 'invoice' && !id && banks.length > 0 && <Field label={t('Payment received now (sales receipt)')} hint={t('Issues the invoice and records the full payment')}>
              <Select value={payNow} onChange={(e) => setPayNow(e.target.value)}><option value="">{t('No, bill the customer later')}</option>{banks.map((a) => <option key={a.id} value={a.id}>{t('Deposit to')} {a.name}</option>)}</Select></Field>}
          </div>
          <dl className="ml-auto w-full max-w-xs space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">{t('Subtotal')}</dt><dd className="num">{money(totals.subtotal)}</dd></div>
            {!isBill && <div className="flex justify-between"><dt className="text-slate-500">{t('Taxes')}</dt><dd className="num">{money(totals.tax)}</dd></div>}
            <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold"><dt>{t('Total')}</dt><dd className="num">{money(totals.total)}</dd></div>
          </dl>
        </div>
      </Card>
      {quick && <QuickContact kind={isBill ? 'vendor' : 'customer'} onClose={() => setQuick(false)} onCreated={(c) => { setQuick(false); meta.reload(); setDoc((d) => ({ ...d, contact_id: String(c.id), due_date: id ? d.due_date : addDays(d.issue_date, c.terms_days ?? 15) })); }} />}
    </>
  );
}
