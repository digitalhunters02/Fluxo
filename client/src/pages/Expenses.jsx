import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { date, fromCents, money, toCents, today } from '../format.js';
import { download } from '../csv.js';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

function ExpenseModal({ exp, lookups, onClose, onSaved }) {
  const [run, busy] = useAction();
  const { accounts, contacts, projects } = lookups;
  const bank = accounts.filter((a) => a.subtype === 'bank' || a.subtype === 'credit_card');
  const cats = accounts.filter((a) => a.type === 'expense');
  const [f, setF] = useState({ date: exp?.date || today(), contact_id: exp?.contact_id || '', account_id: exp?.account_id || cats[0]?.id || '', paid_from_id: exp?.paid_from_id || bank[0]?.id || '',
    amount: exp ? fromCents(exp.amount) : '', description: exp?.description || '', ref: exp?.ref || '', project_id: exp?.project_id || '', receipt: undefined });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const onFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    if (file.size > 1_800_000) { alert(t('Receipt too large (max 1.8 MB)')); e.target.value = ''; return; }
    const r = new FileReader(); r.onload = () => setF((x) => ({ ...x, receipt: r.result })); r.readAsDataURL(file);
  };
  const save = async () => {
    const body = { ...f, amount: toCents(f.amount), account_id: Number(f.account_id), paid_from_id: Number(f.paid_from_id), contact_id: f.contact_id ? Number(f.contact_id) : null, project_id: f.project_id ? Number(f.project_id) : null };
    const r = await run(() => (exp ? api.put(`/expenses/${exp.id}`, body) : api.post('/expenses', body)), t('Expense saved'));
    if (r) onSaved();
  };
  return (
    <Modal title={exp ? t('Edit expense') : t('New expense')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Date')}><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label={t('Amount')}><Input inputMode="decimal" placeholder="0,00" value={f.amount} onChange={set('amount')} /></Field>
        <Field label={t('Description')} className="col-span-2"><Input value={f.description} onChange={set('description')} /></Field>
        <Field label={t('Category')}><Select value={f.account_id} onChange={set('account_id')}>{cats.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('Paid with')}><Select value={f.paid_from_id} onChange={set('paid_from_id')}>{bank.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('Vendor')}><Select value={f.contact_id} onChange={set('contact_id')}><option value="">—</option>{contacts.filter((c) => c.kind !== 'customer').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('Project')}><Select value={f.project_id} onChange={set('project_id')}><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label={t('Receipt (image or PDF)')} className="col-span-2" hint={exp?.has_receipt ? t('A receipt already exists; uploading another replaces it.') : ''}><input type="file" accept="image/*,application/pdf" onChange={onFile} className="text-sm" /></Field>
      </div>
    </Modal>
  );
}

export default function Expenses() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => {
    const [rows, accounts, contacts, projects] = await Promise.all([api.get('/expenses'), api.get('/accounts/lookup'), api.get('/contacts'), api.get('/projects').catch(() => [])]);
    return { rows, lookups: { accounts, contacts, projects } };
  });
  const [edit, setEdit] = useState(null);
  const [run] = useAction();
  const [q, setQ] = useState('');
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const rows = data.rows.filter((e) => !q || `${e.description} ${e.category} ${e.contact_name || ''}`.toLowerCase().includes(q.toLowerCase()));
  const total = rows.reduce((s, e) => s + e.amount, 0);
  const viewReceipt = async (e) => { const r = await run(() => api.get(`/expenses/${e.id}/receipt`)); if (r) { const w = window.open(); if (w) { w.document.write(`<iframe src="${r.receipt}" style="border:0;width:100%;height:100%"></iframe>`); } } };
  return (
    <>
      <PageHeader title={t('Expenses')} subtitle={t('Expenses paid on the spot (for credit-terms purchases, use Bills)')}>
        <Button variant="ghost" onClick={() => download('despesas.csv', [[t('Date'), t('Description'), t('Category'), t('Vendor'), t('Paid with'), t('Amount')], ...rows.map((e) => [e.date, e.description, e.category, e.contact_name, e.paid_from, e.amount / 100])])}>{t('Export CSV')}</Button>
        {can('purchases', true) && <Button onClick={() => setEdit({})}>{t('+ New expense')}</Button>}
      </PageHeader>
      <Card pad={false}>
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 p-3"><Input className="field max-w-xs" placeholder={t('Search…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} /><span className="text-sm text-slate-500">{t('Total:')}{' '}<b className="num text-slate-900">{money(total)}</b></span></div>
        <Table head={[t('Date'), t('Description'), t('Category'), t('Vendor'), t('Paid with'), { label: t('Amount'), right: true }, '']} empty={t('No expenses recorded.')}>
          {rows.map((e) => (
            <tr key={e.id} className="hover:bg-slate-50"><td className="td">{date(e.date)}</td><td className="td">{e.description}{e.has_receipt ? <button onClick={() => viewReceipt(e)} className="ml-2 text-xs text-brand-600 hover:underline">{t('📎 receipt')}</button> : null}</td>
              <td className="td">{e.category}</td><td className="td">{e.contact_name}</td><td className="td">{e.paid_from}</td><td className="td num text-right">{money(e.amount)}</td>
              <td className="td whitespace-nowrap text-right">{can('purchases', true) && <><button className="text-xs text-brand-700 hover:underline" onClick={() => setEdit(e)}>{t('Edit')}</button><button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this expense?')) && run(async () => { await api.del(`/expenses/${e.id}`); reload(); }, t('Expense deleted'))}>{t('Delete')}</button></>}</td></tr>
          ))}
        </Table>
      </Card>
      {edit && <ExpenseModal exp={edit.id ? edit : null} lookups={data.lookups} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}
