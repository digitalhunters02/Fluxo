import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api, qs } from '../api.js';
import { addDays, date, money, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';
import { Gate, Lock } from '../components/plan.jsx';
import { fromCents } from '../format.js';

const TYPES = { asset: t('Asset'), liability: t('Liability'), equity: t('Equity'), income: t('Income§type'), expense: t('Expense') };

function AccountModal({ acc, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ code: '', name: '', type: 'expense', subtype: '', ...acc });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const r = await run(() => (acc?.id ? api.put(`/accounts/${acc.id}`, f) : api.post('/accounts', f)), t('Account saved')); if (r) onSaved(); };
  return (
    <Modal title={acc?.id ? t('Edit account') : t('New account')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Code')}><Input value={f.code} onChange={set('code')} /></Field>
        <Field label={t('Type')}><Select value={f.type} disabled={!!acc?.id} onChange={set('type')}>{Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label={t('Name')} className="col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        {!acc?.id && ['asset', 'liability'].includes(f.type) && <Field label={t('Function')} className="col-span-2"><Select value={f.subtype} onChange={set('subtype')}><option value="">{t('Regular')}</option>
          {f.type === 'asset' && <><option value="bank">{t('Bank account / cash')}</option><option value="fixed_asset">{t('Fixed asset')}</option></>}{f.type === 'liability' && <><option value="credit_card">{t('Credit card')}</option><option value="loan">{t('Loan')}</option></>}</Select></Field>}
      </div>
    </Modal>
  );
}

function Ledger({ account, onClose }) {
  const [from, setFrom] = useState(`${today().slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today());
  const { data, loading, error } = useLoad(() => api.get(`/ledger/${account.id}${qs({ from, to })}`), [account.id, from, to]);
  return (
    <Modal wide title={t('Ledger — {0} {1}', [account.code, account.name])} onClose={onClose}>
      <div className="mb-3 flex gap-3"><Field label={t('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label={t('To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : <Table head={[t('Date'), t('Memo§ledger'), { label: t('Debit'), right: true }, { label: t('Credit'), right: true }, { label: t('Balance'), right: true }]}>
        <tr className="bg-slate-50"><td className="td" colSpan={4}>{t('Opening balance')}</td><td className="td num text-right font-medium">{money(data.opening)}</td></tr>
        {data.lines.map((l) => <tr key={l.id}><td className="td">{date(l.date)}</td><td className="td">{l.memo}</td><td className="td num text-right">{l.debit ? money(l.debit) : ''}</td><td className="td num text-right">{l.credit ? money(l.credit) : ''}</td><td className="td num text-right">{money(l.balance)}</td></tr>)}
      </Table>}
    </Modal>
  );
}

function Chart() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/accounts'));
  const [edit, setEdit] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [run] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      {can('accounting', true) && <div className="mb-3 flex justify-end"><Button onClick={() => setEdit({})}>{t('+ New account')}</Button></div>}
      <Card pad={false}>
        <Table head={[t('Code'), t('Name'), t('Type'), { label: t('Balance'), right: true }, '']}>
          {data.map((a) => (
            <tr key={a.id} className={`hover:bg-slate-50 ${a.active ? '' : 'opacity-50'}`}><td className="td font-mono text-xs">{a.code}</td><td className="td font-medium"><button className="hover:text-brand-700 hover:underline" onClick={() => setLedger(a)}>{a.name}</button>{a.is_system ? <span className="ml-2 text-xs text-slate-400">{t('system')}</span> : null}</td>
              <td className="td">{TYPES[a.type]}</td><td className="td num text-right">{money(a.balance)}</td>
              <td className="td whitespace-nowrap text-right">{can('accounting', true) && <><button className="text-xs text-brand-700 hover:underline" onClick={() => setEdit(a)}>{t('Edit')}</button>
                {!a.is_system && <button className="ml-3 text-xs text-slate-500 hover:underline" onClick={() => run(async () => { await api.put(`/accounts/${a.id}`, { active: !a.active }); reload(); })}>{a.active ? t('Deactivate') : t('Activate')}</button>}</>}</td></tr>
          ))}
        </Table>
      </Card>
      {edit && <AccountModal acc={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {ledger && <Ledger account={ledger} onClose={() => setLedger(null)} />}
    </>
  );
}

function EntryModal({ accounts, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ date: today(), memo: '' });
  const [lines, setLines] = useState([{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }]);
  const setL = (i, p) => setLines(lines.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const d = lines.reduce((s, l) => s + toCents(l.debit), 0), c = lines.reduce((s, l) => s + toCents(l.credit), 0);
  const save = async () => { const r = await run(() => api.post('/journal', { ...f, lines: lines.filter((l) => l.account_id).map((l) => ({ account_id: Number(l.account_id), debit: toCents(l.debit), credit: toCents(l.credit) })) }), t('Entry created')); if (r) onSaved(); };
  return (
    <Modal wide title={t('New manual entry')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || d !== c || d === 0} onClick={save}>{t('Post')}</Button></>}>
      <div className="mb-4 grid grid-cols-3 gap-3"><Field label={t('Date')}><Input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field><Field label={t('Memo§ledger')} className="col-span-2"><Input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field></div>
      <table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-slate-500"><th>{t('Account')}</th><th className="w-32">{t('Debit')}</th><th className="w-32">{t('Credit')}</th></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}><td className="pb-2 pr-2"><Select value={l.account_id} onChange={(e) => setL(i, { account_id: e.target.value })} aria-label={t('Account')}><option value="">{t('Select…')}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></td>
          <td className="pb-2 pr-2"><Input inputMode="decimal" value={l.debit} onChange={(e) => setL(i, { debit: e.target.value, credit: '' })} aria-label={t('Debit')} /></td><td className="pb-2"><Input inputMode="decimal" value={l.credit} onChange={(e) => setL(i, { credit: e.target.value, debit: '' })} aria-label={t('Credit')} /></td></tr>)}</tbody></table>
      <div className="mt-1 flex items-center justify-between"><Button variant="ghost" onClick={() => setLines([...lines, { account_id: '', debit: '', credit: '' }])}>{t('+ Line')}</Button>
        <span className={`num text-sm ${d === c && d > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>{t('Debits')}{' '}{money(d)}{' '}{t('· Credits')}{' '}{money(c)} {d !== c && t('(diff. {0})', [money(d - c)])}</span></div>
    </Modal>
  );
}

function Journal() {
  const { can } = useAuth();
  const [from, setFrom] = useState(addDays(today(), -60));
  const [to, setTo] = useState(today());
  const [adding, setAdding] = useState(false);
  const [run] = useAction();
  const { data, loading, error, reload } = useLoad(async () => { const [entries, accounts] = await Promise.all([api.get(`/journal${qs({ from, to })}`), api.get('/accounts/lookup')]); return { entries, accounts }; }, [from, to]);
  const src = { doc: t('Document'), payment: t('Payment'), expense: t('Expense'), bank: t('Banking'), manual: t('Manual'), adjust: t('Inventory') };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div className="flex gap-3"><Field label={t('From')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label={t('To')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
        {can('accounting', true) && <Button onClick={() => setAdding(true)}>{t('+ Manual entry')}</Button>}</div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : data.entries.length === 0 ? <Card><p className="text-sm text-slate-400">{t('No entries in this period.')}</p></Card> : (
        <div className="space-y-3">{data.entries.map((e) => (
          <Card key={e.id} pad={false}>
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2 text-sm"><span><b>{date(e.date)}</b> · {e.memo} <Badge status="draft">{src[e.source_type] || e.source_type}</Badge></span>
              {e.source_type === 'manual' && can('accounting', true) && <button className="text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this entry?')) && run(async () => { await api.del(`/journal/${e.id}`); reload(); }, t('Deleted'))}>{t('Delete')}</button>}</div>
            <table className="w-full text-sm"><tbody>{e.lines.map((l) => <tr key={l.id}><td className={`px-4 py-1.5 ${l.credit ? 'pl-10' : ''}`}>{l.code} · {l.name}</td><td className="num w-32 px-4 text-right">{l.debit ? money(l.debit) : ''}</td><td className="num w-32 px-4 text-right">{l.credit ? money(l.credit) : ''}</td></tr>)}</tbody></table>
          </Card>))}</div>
      )}
      {adding && <EntryModal accounts={data.accounts} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </>
  );
}

function Budgets() {
  const { can } = useAuth();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, loading, error, reload } = useLoad(() => api.get(`/budgets?year=${year}`), [year]);
  const [edits, setEdits] = useState({});
  const [act, busy] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const val = (r, i) => edits[`${r.id}:${i}`] ?? (r.months[i] ? fromCents(r.months[i]) : '');
  const set = (r, i, v) => setEdits({ ...edits, [`${r.id}:${i}`]: v });
  const fillRow = (r) => { const first = val(r, 0); const n = { ...edits }; for (let i = 1; i < 12; i++) n[`${r.id}:${i}`] = first; setEdits(n); };
  const save = () => act(async () => {
    const rows = data.rows.map((r) => ({ account_id: r.id, months: r.months.map((_, i) => toCents(val(r, i))) }));
    await api.put('/budgets', { year, rows }); setEdits({}); reload();
  }, t('Budget saved'));
  const months = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleString(undefined, { month: 'short' }));
  const writable = can('accounting', true);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <Field label={t('Year')}><Input type="number" className="field w-28" value={year} onChange={(e) => { setYear(Number(e.target.value) || year); setEdits({}); }} /></Field>
        {writable && <Button disabled={busy || !Object.keys(edits).length} onClick={save}>{t('Save budget')}</Button>}
      </div>
      <Card pad={false}>
        <div className="overflow-x-auto"><table className="w-full min-w-[1100px] text-sm">
          <thead className="border-b bg-slate-50/60"><tr><th className="th">{t('Account')}</th>{months.map((m) => <th key={m} className="th w-20 !text-right">{m}</th>)}<th className="th" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{['income', 'expense'].map((ty) => [
            <tr key={ty} className="bg-slate-50"><td className="td font-semibold" colSpan={14}>{ty === 'income' ? t('Income') : t('Expenses')}</td></tr>,
            ...data.rows.filter((r) => r.type === ty).map((r) => (
              <tr key={r.id}><td className="td whitespace-nowrap">{r.name}</td>
                {r.months.map((_, i) => <td key={i} className="px-1 py-1"><input className="field !px-2 !py-1 text-right" inputMode="decimal" disabled={!writable} value={val(r, i)} onChange={(e) => set(r, i, e.target.value)} aria-label={`${r.name} ${months[i]}`} /></td>)}
                <td className="td">{writable && <button className="text-xs text-brand-700 hover:underline whitespace-nowrap" onClick={() => fillRow(r)}>{t('Fill year')}</button>}</td></tr>))])}</tbody>
        </table></div>
      </Card>
      <p className="mt-2 text-xs text-slate-400">{t('Enter whole-dollar or cent amounts. “Fill year” copies January to every month. Compare with actuals in Reports → Budget vs actual.')}</p>
    </>
  );
}

function Classes() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/classes'));
  const [name, setName] = useState('');
  const [act, busy] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      <p className="mb-3 max-w-2xl text-sm text-slate-500">{t('Classes tag income and expenses by department, location or product line, so you can see profit for each one in Reports → Profit & loss by class.')}</p>
      {can('accounting', true) && <div className="mb-3 flex items-end gap-3"><Field label={t('New class')}><Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && act(async () => { await api.post('/classes', { name }); setName(''); reload(); }, t('Class created'))} /></Field>
        <Button disabled={busy || !name.trim()} onClick={() => act(async () => { await api.post('/classes', { name }); setName(''); reload(); }, t('Class created'))}>{t('Add')}</Button></div>}
      <Card pad={false}><Table head={[t('Name'), t('Status'), '']} empty={t('No classes yet.')}>
        {data.map((c) => <tr key={c.id}><td className="td font-medium">{c.name}</td><td className="td">{c.active ? t('Active') : t('Inactive')}</td>
          <td className="td text-right">{can('accounting', true) && <button className="text-xs text-brand-700 hover:underline" onClick={() => act(async () => { await api.put(`/classes/${c.id}`, { active: !c.active }); reload(); })}>{c.active ? t('Deactivate') : t('Activate')}</button>}</td></tr>)}
      </Table></Card>
    </>
  );
}

export default function Accounting() {
  const { has } = useAuth();
  const [tab, setTab] = useState('chart');
  return (
    <>
      <PageHeader title={t('Accounting')} subtitle={t('Chart of accounts and double-entry journal. Everything you do in the other screens creates entries here automatically.')} />
      <Tabs tabs={[['chart', t('Chart of accounts')], ['journal', t('General journal')], ['budgets', <>{t('Budgets')}{!has('budgets') && <Lock />}</>], ['classes', <>{t('Classes')}{!has('classes') && <Lock />}</>]]} value={tab} onChange={setTab} />
      {tab === 'chart' && <Chart />}{tab === 'journal' && <Journal />}
      {tab === 'budgets' && <Gate feature="budgets"><Budgets /></Gate>}{tab === 'classes' && <Gate feature="classes"><Classes /></Gate>}
    </>
  );
}
