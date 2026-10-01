import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../i18n.jsx';
import { api, qs } from '../api.js';
import { addDays, date, money, moneyShort, monthLabel, today } from '../format.js';
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Loading, PageHeader, Select, Stat, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

export const CATEGORY = {
  INCOME: t('Income§cat'), TRANSFER_IN: t('Transfers in'), TRANSFER_OUT: t('Transfers out'), LOAN_PAYMENTS: t('Loan payments'), BANK_FEES: t('Bank fees'), ENTERTAINMENT: t('Entertainment'),
  FOOD_AND_DRINK: t('Food & drink'), GENERAL_MERCHANDISE: t('Shopping & supplies'), HOME_IMPROVEMENT: t('Home improvement'), MEDICAL: t('Medical'), PERSONAL_CARE: t('Personal care'),
  GENERAL_SERVICES: t('Services'), GOVERNMENT_AND_NON_PROFIT: t('Government & non-profit'), TRANSPORTATION: t('Transportation'), TRAVEL: t('Travel'), RENT_AND_UTILITIES: t('Rent & utilities'),
};
const catLabel = (c) => CATEGORY[c] || (c ? t('Other') : t('Uncategorized'));
const PERIODS = { 30: t('Last 30 days'), 90: t('Last 90 days'), month: t('This month'), year: t('This year') };
const rangeOf = (p) => {
  const to = today();
  if (p === 'month') return { from: `${to.slice(0, 7)}-01`, to };
  if (p === 'year') return { from: `${to.slice(0, 4)}-01-01`, to };
  return { from: addDays(to, -(Number(p) - 1)), to };
};

/* ------------------------------- Plaid Link (navegador) ------------------------------- */
let linkScript = null;
const loadPlaidLink = () => linkScript || (linkScript = new Promise((resolve, reject) => {
  if (window.Plaid) return resolve(window.Plaid);
  const s = document.createElement('script');
  s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
  s.onload = () => resolve(window.Plaid); s.onerror = () => { linkScript = null; reject(new Error(t('Could not load the bank connection window. Check your internet connection.'))); };
  document.head.appendChild(s);
}));

/* ----------------------------------------- visões ----------------------------------------- */
function Bars({ rows, tone = 'bg-rose-400' }) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <ul className="space-y-3">{rows.map((r) => (
      <li key={r.label}><div className="mb-1 flex justify-between gap-3 text-sm"><span className="truncate">{r.label}{r.sub && <span className="ml-2 text-xs text-slate-400">{r.sub}</span>}</span><span className="num shrink-0 font-medium">{money(r.total)}</span></div>
        <div className="h-1.5 rounded bg-slate-100"><div className={`h-1.5 rounded ${tone}`} style={{ width: `${(r.total / max) * 100}%` }} /></div></li>
    ))}</ul>
  );
}

function Overview({ onConnect, hasConnections }) {
  const [period, setPeriod] = useState('30');
  const { from, to } = rangeOf(period);
  const { data: d, loading, error, reload } = useLoad(() => api.get(`/plaid/insights${qs({ from, to })}`), [period]);
  if (!hasConnections) return <Card><Empty>{t('Connect a bank to see balances, who paid you and where your money goes.')}<div className="mt-4"><Button onClick={onConnect}>{t('Connect a bank')}</Button></div></Empty></Card>;
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const months = d.monthly.slice(-6);
  const maxM = Math.max(1, ...months.flatMap((m) => [m.money_in, m.money_out]));
  return (
    <>
      <div className="no-print mb-4 flex justify-end"><Select className="field max-w-[12rem]" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label={t('Period')}>{Object.entries(PERIODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('Cash in connected banks')} value={money(d.balance)} sub={d.creditOwed ? `${t('Cards owed')}: ${money(d.creditOwed)}` : undefined} />
        <Stat label={t('Money in')} value={money(d.moneyIn)} tone="good" sub={`${date(from)} – ${date(to)}`} />
        <Stat label={t('Money out')} value={money(d.moneyOut)} tone="bad" />
        <Stat label={t('Net')} value={money(d.moneyIn - d.moneyOut)} tone={d.moneyIn - d.moneyOut < 0 ? 'bad' : 'good'} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('Spending by category')}>{d.byCategory.length === 0 ? <p className="text-sm text-slate-400">{t('No spending in this period.')}</p> : <Bars rows={d.byCategory.map((c) => ({ label: catLabel(c.category), total: c.total, sub: `${c.count}×` }))} />}</Card>
        <Card title={t('Who paid you')}>{d.payers.length === 0 ? <p className="text-sm text-slate-400">{t('No deposits in this period.')}</p> : <Bars tone="bg-emerald-500" rows={d.payers.map((p) => ({ label: p.name, total: p.total, sub: `${p.count}× · ${t('last')} ${date(p.last_date)}` }))} />}</Card>
        <Card title={t('Where you spent the most')} pad={false}>
          <Table head={[t('Merchant'), t('Category'), { label: t('Total'), right: true }]} empty={t('No spending in this period.')}>
            {d.topMerchants.map((m) => <tr key={m.name}><td className="td font-medium">{m.name}</td><td className="td text-slate-500">{catLabel(m.category)}</td><td className="td num text-right">{money(m.total)}</td></tr>)}
          </Table>
        </Card>
        <Card title={t('Money in and out by month')}>
          {months.length === 0 ? <p className="text-sm text-slate-400">{t('No data in this period.')}</p> : (
            <svg viewBox="0 0 360 150" className="w-full" role="img" aria-label={t('Money in and out by month')}>
              {months.map((m, i) => { const bw = 360 / months.length, x = i * bw + bw * 0.15, w = bw * 0.33, h = (v) => (v / maxM) * 110;
                return <g key={m.month}><rect x={x} y={120 - h(m.money_in)} width={w} height={h(m.money_in)} rx="3" fill="#10b981"><title>{`${t('Money in')} ${money(m.money_in)}`}</title></rect>
                  <rect x={x + w + 3} y={120 - h(m.money_out)} width={w} height={h(m.money_out)} rx="3" fill="#f43f5e"><title>{`${t('Money out')} ${money(m.money_out)}`}</title></rect>
                  <text x={x + w} y="140" fontSize="10" textAnchor="middle" fill="#64748b">{monthLabel(m.month)}</text><text x={x + w} y={114 - Math.max(h(m.money_in), h(m.money_out))} fontSize="8" textAnchor="middle" fill="#94a3b8">{moneyShort(Math.max(m.money_in, m.money_out))}</text></g>; })}
            </svg>)}
        </Card>
      </div>
    </>
  );
}

function Activity() {
  const [f, setF] = useState({ q: '', direction: '', category: '', period: '90' });
  const { from, to } = rangeOf(f.period);
  const { data, loading, error, reload } = useLoad(() => api.get(`/plaid/activity${qs({ from, to, q: f.q, direction: f.direction, category: f.category, limit: 500 })}`), [f]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="no-print mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input placeholder={t('Search name or merchant…')} value={f.q} onChange={set('q')} aria-label={t('Search')} />
        <Select value={f.direction} onChange={set('direction')} aria-label={t('Type')}><option value="">{t('Money in and out')}</option><option value="in">{t('Money in only')}</option><option value="out">{t('Money out only')}</option></Select>
        <Select value={f.category} onChange={set('category')} aria-label={t('Category')}><option value="">{t('All categories')}</option>{Object.entries(CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Select value={f.period} onChange={set('period')} aria-label={t('Period')}>{Object.entries(PERIODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
      </div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (
        <Card pad={false}>
          <Table head={[t('Date'), t('Description'), t('Category'), t('Account'), { label: t('Amount'), right: true }]} empty={t('No transactions match.')}>
            {data.map((x) => (
              <tr key={x.transaction_id} className="hover:bg-slate-50"><td className="td whitespace-nowrap">{date(x.date)}</td><td className="td"><div className="font-medium">{x.merchant || x.name}</div>{x.merchant && x.merchant !== x.name && <div className="text-xs text-slate-400">{x.name}</div>}</td>
                <td className="td text-slate-600">{catLabel(x.category_primary)}</td><td className="td text-slate-500">{x.institution_name} ••{x.mask}</td>
                <td className={`td num text-right font-medium ${x.amount < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{money(x.amount)}</td></tr>
            ))}
          </Table>
        </Card>)}
    </>
  );
}

function AccountRow({ a, bankAccounts, onChange }) {
  const [act] = useAction();
  const linkedValue = a.linked_account_id ? String(a.linked_account_id) : '';
  const change = (v) => act(async () => { await api.put(`/plaid/accounts/${a.id}`, v === 'new' ? { create: true } : { linked_account_id: v ? Number(v) : null }); onChange(); }, t('Account linked'));
  const options = bankAccounts.filter((b) => (a.is_credit ? b.subtype === 'credit_card' : b.subtype === 'bank'));
  return (
    <tr>
      <td className="td"><div className="font-medium">{a.name} <span className="text-slate-400">••{a.mask}</span></div><div className="text-xs capitalize text-slate-400">{a.subtype || a.type}</div></td>
      <td className="td num text-right">{a.balance_current == null ? '—' : money(a.is_credit ? -a.balance_current : a.balance_current)}{a.balance_available != null && !a.is_credit && <div className="text-xs text-slate-400">{t('Available')} {money(a.balance_available)}</div>}</td>
      <td className="td"><Select value={linkedValue} onChange={(e) => change(e.target.value)} aria-label={t('Link to bookkeeping account')}>
        <option value="">{t('Not linked (view only)')}</option>{options.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}{!a.linked_account_id && <option value="new">{t('+ Create a new account')}</option>}</Select></td>
    </tr>
  );
}

function Banks({ overview, reload, canWrite }) {
  const [act, busy] = useAction();
  const { data: accounts } = useLoad(() => api.get('/banking/accounts'));
  const mode = overview.mode;
  const connectLive = async (existingItem) => {
    const { link_token } = await api.post('/plaid/link-token', existingItem ? { item_id: existingItem } : {});
    const Plaid = await loadPlaidLink();
    Plaid.create({ token: link_token, onSuccess: (public_token, metadata) => {
      act(async () => { if (!existingItem) await api.post('/plaid/exchange', { public_token, institution: metadata?.institution }); else await api.post('/plaid/sync', { item_id: existingItem }); reload(); }, t('Bank connected'));
    } }).open();
  };
  const connect = () => act(() => (mode === 'live' ? connectLive() : api.post('/plaid/demo', {}).then(reload)), mode === 'live' ? undefined : t('Demo bank connected'));
  const used = overview.connections.length;
  const full = used >= overview.limit;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">{t('{0} of {1} bank connections used on your plan.', [used, overview.limit])}</p>
        {canWrite && mode !== 'off' && <div className="flex gap-2">
          {used > 0 && <Button variant="ghost" disabled={busy} onClick={() => act(async () => { await api.post('/plaid/sync', {}); reload(); }, t('Synced'))}>{t('Sync now')}</Button>}
          <Button disabled={busy || full} title={full ? t('Upgrade your plan to connect more banks') : ''} onClick={connect}>{mode === 'live' ? t('Connect a bank') : t('Connect demo bank')}</Button></div>}
      </div>
      {mode === 'demo' && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('Demo mode: no Plaid keys are configured on this server, so the connection below uses made-up sample data.')}</p>}
      {mode === 'off' && <p className="mb-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-600">{t('Bank connections are not configured on this server. Add your Plaid keys to turn them on.')}</p>}
      {overview.connections.length === 0 ? <Card><Empty>{t('No banks connected yet.')}</Empty></Card> : overview.connections.map((c) => (
        <Card key={c.item_id} className="mb-4" pad={false}
          title={<span className="flex items-center gap-2">{c.institution_name || t('Bank')} {c.demo ? <Badge status="draft">{t('Demo')}</Badge> : null}
            {c.status === 'ok' ? <Badge status="paid">{t('Connected')}</Badge> : <Badge status="declined">{c.status === 'login_required' ? t('Sign-in needed') : t('Problem')}</Badge>}</span>}
          action={<div className="flex items-center gap-3 text-xs">{c.last_sync && <span className="text-slate-400">{t('Synced')} {date(c.last_sync.slice(0, 10))}</span>}
            {canWrite && c.status === 'login_required' && mode === 'live' && <button className="text-brand-700 hover:underline" onClick={() => act(() => connectLive(c.item_id))}>{t('Reconnect')}</button>}
            {canWrite && <button className="text-rose-600 hover:underline" onClick={() => confirm(t('Disconnect this bank? Your bookkeeping entries stay; no new transactions will arrive.')) && act(async () => { await api.del(`/plaid/items/${c.item_id}`); reload(); }, t('Bank disconnected'))}>{t('Disconnect')}</button>}</div>}>
          <Table head={[t('Account'), { label: t('Balance'), right: true }, t('Bookkeeping account')]}>
            {c.accounts.map((a) => <AccountRow key={a.id} a={a} bankAccounts={accounts || []} onChange={reload} />)}
          </Table>
        </Card>
      ))}
      <p className="text-xs text-slate-400">{t('Linked accounts send their transactions to Banking → Transactions, already categorized when we can, ready to review and reconcile.')}</p>
    </>
  );
}

export default function Connections() {
  const { tab = 'overview' } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/plaid/overview'));
  useEffect(() => { document.title = `${t('Connected banks')} — Fluxo`; }, []);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      <PageHeader title={t('Connected banks')} subtitle={t('See balances, who paid you, your history and where your money goes.')} />
      <Tabs tabs={[['overview', t('Overview')], ['activity', t('Activity')], ['banks', t('Banks')]]} value={tab} onChange={(k) => nav(`/connections/${k}`)} />
      {tab === 'overview' && <Overview hasConnections={data.connections.length > 0} onConnect={() => nav('/connections/banks')} />}
      {tab === 'activity' && (data.connections.length ? <Activity /> : <Card><Empty>{t('No banks connected yet.')}</Empty></Card>)}
      {tab === 'banks' && <Banks overview={data} reload={reload} canWrite={can('banking', true)} />}
    </>
  );
}
