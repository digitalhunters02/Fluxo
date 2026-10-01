import { t } from '../i18n.jsx';
import { useMemo, useState } from 'react';
import { api, qs } from '../api.js';
import { date, fromCents, money, toCents, today } from '../format.js';
import { parseCsv, parseDate } from '../csv.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { SearchBox, useSearch } from '../components/search.jsx';
import { useAuth } from '../App.jsx';

/* ---------- importação de extrato (CSV) ---------- */
function ImportModal({ accounts, initial, onClose, onDone }) {
  const [run, busy] = useAction();
  const [accId, setAccId] = useState(initial.id);
  const account = accounts.find((a) => a.id === Number(accId));
  const [rows, setRows] = useState(null);
  const [map, setMap] = useState({ date: 0, desc: 1, amount: 2, debit: -1, credit: -1 });
  const [invert, setInvert] = useState(false);
  const onFile = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    const text = await f.text();
    const parsed = parseCsv(text);
    if (parsed.length < 2) return alert(t('Empty or invalid file'));
    setRows(parsed);
    const h = parsed[0].map((x) => x.toLowerCase());
    const find = (...keys) => h.findIndex((x) => keys.some((k) => x.includes(k)));
    setMap({ date: Math.max(find('data', 'date'), 0), desc: Math.max(find('descri', 'hist', 'memo', 'name', 'payee', 'detail', 'estabelec'), 1), amount: find('valor', 'amount', 'montante'), debit: find('debit', 'withdraw', 'débito', 'debito', 'saída', 'saida'), credit: find('credit', 'deposit', 'crédito', 'credito', 'entrada') });
  };
  const preview = useMemo(() => {
    if (!rows) return [];
    return rows.slice(1).map((r) => {
      let amount = map.amount >= 0 ? toCents(r[map.amount]) : toCents(r[map.credit]) - Math.abs(toCents(r[map.debit]));
      if (invert) amount = -amount;
      return { date: parseDate(r[map.date]), description: (r[map.desc] || '').trim(), amount };
    });
  }, [rows, map, invert]);
  const valid = preview.filter((p) => p.date && p.amount !== 0);
  const colSel = (k, label, optional) => (
    <Field label={label}><Select value={map[k]} onChange={(e) => setMap({ ...map, [k]: Number(e.target.value) })}>{optional && <option value={-1}>{t('— don\'t use —')}</option>}{rows[0].map((h, i) => <option key={i} value={i}>{h || t('Column {0}', [i + 1])}</option>)}</Select></Field>
  );
  return (
    <Modal wide title={t('Import statement — {0}', [account.name])} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
      <Button disabled={busy || !valid.length} onClick={async () => { const r = await run(() => api.post('/banking/import', { account_id: account.id, rows: valid }), t('Statement imported')); if (r) { alert(t('{0} new transaction(s), {1} duplicate(s) skipped.', [r.added, r.duplicates])); onDone(); } }}>{t('Import')}{' '}{valid.length}{' '}{t('row(s)')}</Button></>}>
      <Field label={t('Import into account')} className="mb-3 max-w-xs"><Select value={accId} onChange={(e) => setAccId(Number(e.target.value))}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} className="text-sm" />
      <p className="mt-2 text-xs text-slate-400">{t('Export your bank statement as CSV. Negative amounts are money out. Duplicates are skipped automatically.')}</p>
      {rows && <>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">{colSel('date', t('Date column'))}{colSel('desc', t('Description column'))}{colSel('amount', t('Amount column'), true)}{map.amount < 0 && <>{colSel('debit', t('Debit column'), true)}{colSel('credit', t('Credit column'), true)}</>}</div>
        <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} />{' '}{t('Flip signs (use for card statements where purchases show as positive)')}</label>
        <div className="mt-3 max-h-56 overflow-auto rounded border border-slate-200"><Table head={[t('Date'), t('Description'), { label: t('Amount'), right: true }]}>
          {preview.slice(0, 8).map((p, i) => <tr key={i}><td className={`td ${p.date ? '' : 'text-rose-600'}`}>{p.date ? date(p.date) : t('invalid date')}</td><td className="td">{p.description}</td><td className="td num text-right">{money(p.amount)}</td></tr>)}
        </Table></div>
      </>}
    </Modal>
  );
}

/* ---------- categorizar transação ---------- */
function CategorizeModal({ txn, accounts, contacts, onClose, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ account_id: txn.suggested_account_id || '', contact_id: '', memo: txn.description, remember: true });
  const cats = accounts.filter((a) => (txn.amount < 0 ? ['expense', 'asset', 'liability', 'equity'] : ['income', 'asset', 'liability', 'equity']).includes(a.type) && a.id !== txn.account_id);
  const save = async () => { const r = await run(() => api.post(`/banking/txns/${txn.id}/categorize`, { ...f, account_id: Number(f.account_id), contact_id: f.contact_id ? Number(f.contact_id) : null }), t('Categorized§one')); if (r) onDone(); };
  return (
    <Modal title={t('Categorize transaction')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !f.account_id} onClick={save}>{t('Confirm')}</Button></>}>
      <p className="mb-3 text-sm"><b>{txn.description}</b><br /><span className="text-slate-500">{date(txn.date)} · </span><span className={txn.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}>{money(txn.amount)}</span></p>
      <div className="grid gap-3">
        <Field label={t('Category / account')}><Select autoFocus value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">{t('Select…')}</option>{cats.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</Select></Field>
        <Field label={t('Contact (optional)')}><Select value={f.contact_id} onChange={(e) => setF({ ...f, contact_id: e.target.value })}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('Memo')}><Input value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.remember} onChange={(e) => setF({ ...f, remember: e.target.checked })} />{' '}{t('Remember: auto-categorize similar transactions')}</label>
      </div>
    </Modal>
  );
}

const SOURCES = { rule: 'regra', history: t('history'), existing: t('existing entry') };

function Feed({ accounts, accountId }) {
  const { can, } = useAuth();
  const w = can('banking', true);
  const [status, setStatus] = useState('pending');
  const [q, setQ, search] = useSearch();
  const [cat, setCat] = useState(null);
  const [importing, setImporting] = useState(false);
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(async () => {
    const [txns, ac, contacts] = await Promise.all([api.get(`/banking/txns${qs({ status, account_id: accountId })}`), api.get('/accounts/lookup'), api.get('/contacts')]);
    return { txns, ac, contacts };
  }, [status, accountId]);
  const account = accounts.find((a) => a.id === Number(accountId));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const sugg = data.txns.filter((t) => t.status === 'pending' && (t.suggested_account_id || t.suggested_line_id)).length;
  return (
    <>
      <SearchBox className="mb-3 max-w-sm" value={q} onChange={setQ} placeholder={t('Search transactions…')} />
      <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">{[['pending', t('To review')], ['categorized', t('Categorized')], ['matched', t('Matched')], ['ignored', t('Ignored')]].map(([k, l]) => <button key={k} onClick={() => setStatus(k)} className={`rounded-full px-3 py-1 text-sm ${status === k ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}>{l}</button>)}</div>
        {w && <div className="flex gap-2">
          {status === 'pending' && sugg > 0 && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { const r = await api.post('/banking/accept-all', { account_id: accountId || undefined }); reload(); return r; }, t('Suggestions accepted'))}>{t('✓ Accept')}{' '}{sugg}{' '}{t('suggestion(s)')}</Button>}
          <Button onClick={() => setImporting(true)}>{t('Import CSV statement')}</Button>
        </div>}
      </div>
      <Card pad={false}>
        <Table head={[t('Date'), t('Description'), ...(accountId ? [] : [t('Account')]), { label: t('Amount'), right: true }, status === 'pending' ? t('Suggestion') : t('Status'), '']} empty={status === 'pending' ? t('All caught up! No pending transactions. 🎉') : t('Nothing here.')}>
          {search(data.txns).map((tx) => (
            <tr key={tx.id} className="hover:bg-slate-50"><td className="td whitespace-nowrap">{date(tx.date)}</td><td className="td">{tx.description}</td>{!accountId && <td className="td text-slate-500">{tx.account_name}</td>}
              <td className={`td num text-right font-medium ${tx.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{money(tx.amount)}</td>
              <td className="td text-sm">{tx.status !== 'pending' ? <Badge status={tx.status === 'ignored' ? 'void' : 'paid'}>{{ categorized: t('Categorized§one'), matched: t('Matched§one'), ignored: t('Ignored§one') }[tx.status]}</Badge>
                : tx.suggested_line_id ? <span className="text-sky-700">≈ {tx.match?.memo} <span className="text-xs text-slate-400">{t('(existing entry)')}</span></span>
                : tx.suggested_account_name ? <span className="text-slate-700">{tx.suggested_account_name} <span className="text-xs text-slate-400">({SOURCES[tx.suggestion_source] || tx.suggestion_source})</span></span> : <span className="text-slate-400">—</span>}</td>
              <td className="td whitespace-nowrap text-right">{w && (tx.status === 'pending' ? <>
                {tx.suggested_line_id && <button className="text-xs text-brand-700 hover:underline" onClick={() => run(async () => { await api.post(`/banking/txns/${tx.id}/match`, { line_id: tx.suggested_line_id }); reload(); }, t('Matched§one'))}>{t('Match')}</button>}
                <button className="ml-3 text-xs text-brand-700 hover:underline" onClick={() => setCat(tx)}>{tx.suggested_account_id ? t('Review') : t('Categorize')}</button>
                <button className="ml-3 text-xs text-slate-500 hover:underline" onClick={() => run(async () => { await api.post(`/banking/txns/${tx.id}/ignore`); reload(); })}>{t('Ignore')}</button></>
                : <button className="text-xs text-slate-500 hover:underline" onClick={() => run(async () => { await api.post(`/banking/txns/${tx.id}/undo`); reload(); }, t('Undone'))}>{t('Undo')}</button>)}</td></tr>
          ))}
        </Table>
      </Card>
      {cat && <CategorizeModal txn={cat} accounts={data.ac} contacts={data.contacts} onClose={() => setCat(null)} onDone={() => { setCat(null); reload(); }} />}
      {importing && <ImportModal accounts={accounts} initial={account || accounts[0]} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
    </>
  );
}

/* ---------- conciliação ---------- */
function Reconcile({ account }) {
  const { can } = useAuth();
  const [stmtDate, setStmtDate] = useState(today());
  const [balance, setBalance] = useState('');
  const [sel, setSel] = useState(new Set());
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(() => api.get(`/banking/reconcile/${account.id}${qs({ upTo: stmtDate })}`), [account.id, stmtDate]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const picked = data.lines.filter((l) => sel.has(l.id));
  const cleared = data.beginning + picked.reduce((s, l) => s + l.amount, 0);
  const diff = toCents(balance) - cleared;
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  return (
    <>
      <Card className="mb-4"><div className="grid gap-4 md:grid-cols-4">
        <Field label={t('Statement date')}><Input type="date" value={stmtDate} onChange={(e) => { setStmtDate(e.target.value); setSel(new Set()); }} /></Field>
        <Field label={t('Statement ending balance')}><Input inputMode="decimal" placeholder="0.00" value={balance} onChange={(e) => setBalance(e.target.value)} /></Field>
        <div className="text-sm"><div className="text-xs text-slate-500">{t('Already reconciled balance')}</div><div className="num mt-1 text-lg font-semibold">{money(data.beginning)}</div>{data.last && <div className="text-xs text-slate-400">{t('last:')}{' '}{date(data.last.statement_date)}</div>}</div>
        <div className="text-sm"><div className="text-xs text-slate-500">{t('Difference')}</div><div className={`num mt-1 text-lg font-semibold ${diff === 0 && balance ? 'text-emerald-700' : 'text-rose-600'}`}>{balance ? money(diff) : '—'}</div></div>
      </div></Card>
      <Card pad={false}>
        <Table head={[{ label: '' }, t('Date'), t('Description'), { label: account.type === 'asset' ? t('Amount') : t('Amount (owed)'), right: true }]} empty={t('Nothing to reconcile up to this date.')}>
          {data.lines.map((l) => (
            <tr key={l.id} className={sel.has(l.id) ? 'bg-brand-50/50' : 'hover:bg-slate-50'}><td className="td w-10"><input type="checkbox" aria-label={t('Select')} checked={sel.has(l.id)} onChange={() => toggle(l.id)} /></td><td className="td">{date(l.date)}</td><td className="td">{l.memo}</td><td className={`td num text-right ${l.amount < 0 ? 'text-rose-600' : ''}`}>{money(l.amount)}</td></tr>
          ))}
        </Table>
      </Card>
      {can('banking', true) && <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setSel(new Set(data.lines.map((l) => l.id)))}>{t('Select all')}</Button>
        {data.last && <Button variant="danger" disabled={busy} onClick={() => confirm(t('Undo the last reconciliation for this account?')) && run(async () => { await api.post(`/banking/reconcile/${account.id}/undo`); reload(); }, t('Reconciliation undone'))}>{t('Undo last')}</Button>}
        <Button disabled={busy || !balance || diff !== 0 || !picked.length} onClick={() => run(async () => { await api.post(`/banking/reconcile/${account.id}`, { statement_date: stmtDate, statement_balance: toCents(balance), line_ids: picked.map((l) => l.id) }); setSel(new Set()); setBalance(''); reload(); }, t('Reconciliation complete'))}>{t('Finish reconciliation')}</Button>
      </div>}
    </>
  );
}

function Rules() {
  const { can } = useAuth();
  const { data, loading, reload } = useLoad(async () => { const [rules, ac] = await Promise.all([api.get('/banking/rules'), api.get('/accounts/lookup')]); return { rules, ac }; });
  const [f, setF] = useState({ pattern: '', account_id: '', direction: 'any' });
  const [run] = useAction();
  if (loading) return <Loading />;
  return (
    <Card title={t('Auto-categorization rules')} pad={false}>
      {can('banking', true) && <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 p-4">
        <Field label={t('When the description contains')}><Input value={f.pattern} onChange={(e) => setF({ ...f, pattern: e.target.value })} placeholder={t('e.g. uber')} /></Field>
        <Field label={t('Type')}><Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="any">{t('Money in or out')}</option><option value="out">{t('Money out only')}</option><option value="in">{t('Money in only')}</option></Select></Field>
        <Field label={t('Categorize as')}><Select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}><option value="">{t('Select…')}</option>{data.ac.filter((a) => ['income', 'expense'].includes(a.type)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Button disabled={!f.pattern || !f.account_id} onClick={() => run(async () => { await api.post('/banking/rules', { ...f, account_id: Number(f.account_id) }); setF({ pattern: '', account_id: '', direction: 'any' }); reload(); }, t('Rule created'))}>{t('Add')}</Button>
      </div>}
      <Table head={[t('Text'), t('Type'), t('Category'), '']} empty={t('No rules yet. They are also created when you categorize a transaction with “remember” checked.')}>
        {data.rules.map((r) => <tr key={r.id}><td className="td font-mono text-xs">{r.pattern}</td><td className="td">{{ any: t('Any'), in: t('In'), out: t('Out') }[r.direction]}</td><td className="td">{r.account_name}</td><td className="td text-right">{can('banking', true) && <button className="text-xs text-rose-600 hover:underline" onClick={() => run(async () => { await api.del(`/banking/rules/${r.id}`); reload(); })}>{t('Remove')}</button>}</td></tr>)}
      </Table>
    </Card>
  );
}

function TransferModal({ accounts, onClose, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ from_id: accounts[0]?.id, to_id: accounts[1]?.id, amount: '', date: today(), memo: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={t('Transfer between accounts')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={async () => { const r = await run(() => api.post('/transfers', { ...f, from_id: Number(f.from_id), to_id: Number(f.to_id), amount: toCents(f.amount) }), t('Transfer recorded')); if (r) onDone(); }}>{t('Transfer')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('From')}><Select value={f.from_id} onChange={set('from_id')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('To§transfer')}><Select value={f.to_id} onChange={set('to_id')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('Amount')}><Input inputMode="decimal" value={f.amount} onChange={set('amount')} /></Field><Field label={t('Date')}><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label={t('Memo')} className="col-span-2"><Input value={f.memo} onChange={set('memo')} /></Field>
      </div>
    </Modal>
  );
}

export default function Banking() {
  const { can } = useAuth();
  const { data: accounts, loading, error, reload } = useLoad(() => api.get('/banking/accounts'));
  const [tab, setTab] = useState('feed');
  const [accountId, setAccountId] = useState('');
  const [transfer, setTransfer] = useState(false);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const sel = accounts.find((a) => String(a.id) === String(accountId)) || accounts[0];
  return (
    <>
      <PageHeader title={t('Banking & reconciliation')}>{can('banking', true) && accounts.length > 1 && <Button variant="ghost" onClick={() => setTransfer(true)}>{t('⇄ Transfer')}</Button>}</PageHeader>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {accounts.map((a) => (
          <button key={a.id} onClick={() => { setAccountId(String(a.id)); setTab('feed'); }} className={`card p-4 text-left transition hover:border-brand-500 ${String(accountId) === String(a.id) ? 'ring-2 ring-brand-500' : ''}`}>
            <div className="text-xs font-medium uppercase text-slate-500">{a.name}</div><div className="num mt-1 text-xl font-semibold">{money(a.balance)}</div>
            <div className="mt-1 text-xs text-slate-500">{a.pending ? <span className="font-medium text-amber-700">{a.pending}{' '}{t('to review')}</span> : t('Up to date')}{a.last_reconciled && t(' · reconciled on {0}', [date(a.last_reconciled)])}</div>
          </button>
        ))}
      </div>
      <Tabs tabs={[['feed', t('Transactions')], ['reconcile', t('Reconcile')], ['rules', t('Rules')]]} value={tab} onChange={setTab} />
      {tab === 'feed' && <Feed accounts={accounts} accountId={accountId} />}
      {tab === 'reconcile' && sel && <>
        <div className="no-print mb-3 max-w-xs"><Select value={sel.id} onChange={(e) => setAccountId(e.target.value)} aria-label={t('Account')}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></div>
        <Reconcile key={sel.id} account={sel} />
      </>}
      {tab === 'rules' && <Rules />}
      {transfer && <TransferModal accounts={accounts} onClose={() => setTransfer(false)} onDone={() => { setTransfer(false); reload(); }} />}
    </>
  );
}
