import { t } from '../i18n.jsx';
import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api.js';
import { addDays, date, money, number, today } from '../format.js';
import { download } from '../csv.js';
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Table, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';
import { Lock, UpgradeNotice } from '../components/plan.jsx';

const year = today().slice(0, 4);
const PRESETS = {
  month: [t('This month'), () => [`${today().slice(0, 7)}-01`, today()]],
  last30: [t('Last 30 days'), () => [addDays(today(), -29), today()]],
  year: [t('This year'), () => [`${year}-01-01`, today()]],
  lastyear: [t('Last year'), () => [`${year - 1}-01-01`, `${year - 1}-12-31`]],
};

const Row = ({ label, v, bold, indent, prev }) => (
  <tr className={bold ? 'border-t border-slate-200 bg-slate-50 font-semibold' : ''}><td className={`td ${indent ? 'pl-8' : ''}`}>{label}</td><td className="td num text-right">{money(v)}</td>{prev !== undefined && <td className="td num text-right text-slate-500">{money(prev)}</td>}</tr>
);

function Pnl({ d }) {
  const p = d.previous;
  return (<Table head={['', { label: `${date(d.from)} – ${date(d.to)}`, right: true }, { label: t('Previous period'), right: true }]}>
    <tr><td className="td font-semibold" colSpan={3}>{t('Income')}</td></tr>{d.income.map((r) => <Row key={r.id} indent label={r.name} v={r.balance} />)}
    <Row bold label={t('Total income')} v={d.totalIncome} prev={p.totalIncome} />
    {d.cogs.length > 0 && <><tr><td className="td font-semibold" colSpan={3}>{t('Cost of goods sold')}</td></tr>{d.cogs.map((r) => <Row key={r.id} indent label={r.name} v={r.balance} />)}</>}
    <Row bold label={t('Gross profit')} v={d.grossProfit} prev={p.grossProfit} />
    <tr><td className="td font-semibold" colSpan={3}>{t('Operating expenses')}</td></tr>{d.opex.map((r) => <Row key={r.id} indent label={r.name} v={r.balance} />)}
    <Row bold label={t('Total expenses')} v={d.totalOpex} prev={p.totalOpex} />
    <tr className="border-t-2 border-slate-300 bg-slate-100 text-base font-bold"><td className="td">{t('Net income')}</td><td className={`td num text-right ${d.netIncome < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{money(d.netIncome)}</td><td className="td num text-right text-slate-500">{money(p.netIncome)}</td></tr>
  </Table>);
}
const pnlCsv = (d) => [[t('Account'), t('Amount')], ...d.income.map((r) => [r.name, r.balance / 100]), [t('Total income§csv'), d.totalIncome / 100], ...d.cogs.map((r) => [r.name, r.balance / 100]), [t('Gross profit'), d.grossProfit / 100], ...d.opex.map((r) => [r.name, r.balance / 100]), [t('Total expenses§csv'), d.totalOpex / 100], [t('Net income'), d.netIncome / 100]];

function Balance({ d }) {
  const sec = (title, totalLabel, rows, total, extra) => <><tr><td className="td font-semibold" colSpan={2}>{title}</td></tr>{rows.map((r) => <Row key={r.id} indent label={r.name} v={r.balance} />)}{extra}<Row bold label={totalLabel} v={total} /></>;
  return (<>
    {!d.balanced && <ErrorBox error={t('Warning: the balance sheet does not balance. Check your entries.')} />}
    <Table head={['', { label: `Em ${date(d.asof)}`, right: true }]}>
      {sec(t('Asset'), t('Total assets'), d.assets, d.totalAssets)}{sec(t('Liability'), t('Total liabilities'), d.liabilities, d.totalLiabilities)}
      {sec(t('Equity'), t('Total equity'), d.equity, d.totalEquity, <Row indent label={t('Current-year earnings (retained)')} v={d.currentEarnings} />)}
    </Table></>);
}

function CashFlow({ d }) {
  const sec = (title, totalLabel, s) => <><tr><td className="td font-semibold" colSpan={2}>{title}</td></tr>{s.items.map((i) => <Row key={i.name} indent label={i.name} v={i.amount} />)}<Row bold label={totalLabel} v={s.total} /></>;
  return (<Table head={['', { label: t('Amount'), right: true }]}>
    <Row label={t('Opening cash balance')} v={d.opening} />{sec(t('Operating'), t('Cash from operating activities'), d.operating)}{sec(t('Investing'), t('Cash from investing activities'), d.investing)}{sec(t('Financing'), t('Cash from financing activities'), d.financing)}
    <Row bold label={t('Net change in cash')} v={d.netChange} /><Row bold label={t('Closing cash balance')} v={d.closing} />
  </Table>);
}

function Aging({ d }) {
  const cols = [['current', t('Not yet due')], ['d1_30', '1–30'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90p', '+90']];
  return (<Table head={[d.kind === 'receivable' ? t('Customer') : t('Vendor'), ...cols.map(([, l]) => ({ label: l, right: true })), { label: t('Total'), right: true }]} empty={t('Nothing outstanding. 🎉')}>
    {d.rows.map((c) => <tr key={c.contact_id}><td className="td font-medium">{c.contact_name}</td>{cols.map(([k]) => <td key={k} className={`td num text-right ${k !== 'current' && c[k] ? 'text-rose-600' : ''}`}>{c[k] ? money(c[k]) : '—'}</td>)}<td className="td num text-right font-semibold">{money(c.total)}</td></tr>)}
    {d.rows.length > 0 && <tr className="border-t-2 bg-slate-50 font-semibold"><td className="td">{t('Total')}</td>{cols.map(([k]) => <td key={k} className="td num text-right">{money(d.totals[k])}</td>)}<td className="td num text-right">{money(d.totals.total)}</td></tr>}
  </Table>);
}

const simple = (head, rowFn) => ({ d }) => <Table head={head} empty={t('No data in this period.')}>{(Array.isArray(d) ? d : d.rows).map(rowFn)}</Table>;

const sign = (v) => (v < 0 ? 'text-rose-600' : 'text-emerald-700');
function Budget({ d }) {
  const tot = d.totals;
  const sec = (title, rows, kind) => (<><tr><td className="td font-semibold" colSpan={4}>{title}</td></tr>
    {rows.map((r) => <tr key={r.id}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.budget)}</td><td className="td num text-right">{money(r.actual)}</td><td className={`td num text-right ${sign(r.variance)}`}>{money(r.variance)}</td></tr>)}
    <tr className="border-t bg-slate-50 font-semibold"><td className="td">{kind === 'income' ? t('Total income') : t('Total expenses')}</td><td className="td num text-right">{money(kind === 'income' ? tot.incomeBudget : tot.expenseBudget)}</td>
      <td className="td num text-right">{money(kind === 'income' ? tot.incomeActual : tot.expenseActual)}</td><td className={`td num text-right ${sign(kind === 'income' ? tot.incomeActual - tot.incomeBudget : tot.expenseBudget - tot.expenseActual)}`}>{money(kind === 'income' ? tot.incomeActual - tot.incomeBudget : tot.expenseBudget - tot.expenseActual)}</td></tr></>);
  const netB = tot.incomeBudget - tot.expenseBudget, netA = tot.incomeActual - tot.expenseActual;
  return (<Table head={['', { label: t('Budget'), right: true }, { label: t('Actual'), right: true }, { label: t('Variance'), right: true }]} empty={t('No budget set for this period. Set one under Accounting → Budgets.')}>
    {(d.income.length > 0 || d.expense.length > 0) && [sec(t('Income'), d.income, 'income'), sec(t('Expenses'), d.expense, 'expense'),
      <tr key="net" className="border-t-2 bg-slate-100 text-base font-bold"><td className="td">{t('Net income')}</td><td className="td num text-right">{money(netB)}</td><td className="td num text-right">{money(netA)}</td><td className={`td num text-right ${sign(netA - netB)}`}>{money(netA - netB)}</td></tr>]}
  </Table>);
}
function ByClass({ d }) {
  const cols = d.classes.map((c) => ({ key: c.id, label: c.name || t('No class') }));
  const row = (r, k) => <tr key={r.id}><td className="td pl-8">{r.name}</td>{cols.map((c) => <td key={c.key} className="td num text-right">{r.byClass[c.key] ? money(r.byClass[c.key]) : '—'}</td>)}<td className="td num text-right font-medium">{money(r.total)}</td></tr>;
  const total = (rows) => cols.reduce((o, c) => ({ ...o, [c.key]: rows.reduce((s, r) => s + (r.byClass[c.key] || 0), 0) }), {});
  const ti = total(d.income), te = total(d.expense);
  return (<Table head={['', ...cols.map((c) => ({ label: c.label, right: true })), { label: t('Total'), right: true }]} empty={t('No data in this period.')}>
    {(d.income.length > 0 || d.expense.length > 0) && [<tr key="i"><td className="td font-semibold" colSpan={cols.length + 2}>{t('Income')}</td></tr>, ...d.income.map(row),
      <tr key="e"><td className="td font-semibold" colSpan={cols.length + 2}>{t('Expenses')}</td></tr>, ...d.expense.map(row),
      <tr key="n" className="border-t-2 bg-slate-100 font-bold"><td className="td">{t('Net income')}</td>{cols.map((c) => <td key={c.key} className="td num text-right">{money((ti[c.key] || 0) - (te[c.key] || 0))}</td>)}<td className="td num text-right">{money(cols.reduce((s, c) => s + (ti[c.key] || 0) - (te[c.key] || 0), 0))}</td></tr>]}
  </Table>);
}

const REPORTS = {
  pnl: { title: t('Profit & loss statement'), range: true, url: '/reports/pnl', View: Pnl, csv: pnlCsv },
  'balance-sheet': { title: t('Balance sheet'), asof: true, url: '/reports/balance-sheet', View: Balance, csv: (d) => [[t('Account'), t('Balance')], ...d.assets.map((r) => [r.name, r.balance / 100]), [t('Total assets'), d.totalAssets / 100], ...d.liabilities.map((r) => [r.name, r.balance / 100]), [t('Total liabilities'), d.totalLiabilities / 100], ...d.equity.map((r) => [r.name, r.balance / 100]), [t('Current-year earnings'), d.currentEarnings / 100], [t('Total equity§csv'), d.totalEquity / 100]] },
  'cash-flow': { title: t('Cash flow'), range: true, url: '/reports/cash-flow', View: CashFlow, csv: (d) => [[t('Section'), t('Item'), t('Amount')], ...['operating', 'investing', 'financing'].flatMap((s) => d[s].items.map((i) => [s, i.name, i.amount / 100])), ['', t('Net change'), d.netChange / 100]] },
  'ar-aging': { title: t('Accounts receivable aging'), asof: true, url: '/reports/ar-aging', View: Aging, csv: (d) => [[t('Customer'), t('Not yet due'), '1-30', '31-60', '61-90', '+90', t('Total')], ...d.rows.map((c) => [c.contact_name, c.current / 100, c.d1_30 / 100, c.d31_60 / 100, c.d61_90 / 100, c.d90p / 100, c.total / 100])] },
  'ap-aging': { title: t('Accounts payable aging'), asof: true, url: '/reports/ap-aging', View: Aging, csv: (d) => [[t('Vendor'), t('Not yet due'), '1-30', '31-60', '61-90', '+90', t('Total')], ...d.rows.map((c) => [c.contact_name, c.current / 100, c.d1_30 / 100, c.d31_60 / 100, c.d61_90 / 100, c.d90p / 100, c.total / 100])] },
  'sales-by-customer': { title: t('Sales by customer'), range: true, url: '/reports/sales-by-customer', csv: (d) => [[t('Customer'), t('Invoices'), t('Total')], ...d.map((r) => [r.name, r.count, r.total / 100])],
    View: simple([t('Customer'), { label: t('Invoices'), right: true }, { label: t('Subtotal'), right: true }, { label: t('Taxes'), right: true }, { label: t('Total'), right: true }], (r) => <tr key={r.id}><td className="td">{r.name}</td><td className="td num text-right">{r.count}</td><td className="td num text-right">{money(r.subtotal)}</td><td className="td num text-right">{money(r.tax)}</td><td className="td num text-right font-medium">{money(r.total)}</td></tr>) },
  'expenses-by-category': { title: t('Expenses by category'), range: true, url: '/reports/expenses-by-category', csv: (d) => [[t('Category'), t('Total')], ...d.map((r) => [r.name, r.total / 100])],
    View: simple([t('Category'), { label: t('Total'), right: true }], (r) => <tr key={r.id}><td className="td">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>) },
  'expenses-by-vendor': { title: t('Expenses by vendor'), range: true, url: '/reports/expenses-by-vendor', csv: (d) => [[t('Vendor'), t('Total')], ...d.map((r) => [r.name, r.total / 100])],
    View: simple([t('Vendor'), { label: t('Total'), right: true }], (r) => <tr key={r.id}><td className="td">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>) },
  tax: { title: t('Sales tax summary'), range: true, url: '/reports/tax', csv: (d) => [[t('Rate %'), t('Base'), t('Tax')], ...d.byRate.map((r) => [r.rate, r.base / 100, r.tax / 100])],
    View: ({ d }) => <><Table head={[{ label: t('Rate'), right: true }, { label: t('Taxable base'), right: true }, { label: t('Tax'), right: true }]} empty={t('No sales in this period.')}>{d.byRate.map((r) => <tr key={r.rate}><td className="td num text-right">{number(r.rate)}%</td><td className="td num text-right">{money(r.base)}</td><td className="td num text-right">{money(r.tax)}</td></tr>)}</Table>
      <p className="mt-3 text-right text-sm font-semibold">{t('Total to remit for the period:')}{' '}{money(d.collected)}</p></> },
  budget: { title: t('Budget vs actual'), range: true, url: '/reports/budget', View: Budget, feature: 'budgets', csv: (d) => [['Account', 'Budget', 'Actual', 'Variance'], ...[...d.income, ...d.expense].map((r) => [r.name, r.budget / 100, r.actual / 100, r.variance / 100])] },
  'pnl-class': { title: t('Profit & loss by class'), range: true, url: '/reports/pnl-class', View: ByClass, feature: 'classes', csv: (d) => [['Account', ...d.classes.map((c) => c.name || 'No class'), 'Total'], ...[...d.income, ...d.expense].map((r) => [r.name, ...d.classes.map((c) => (r.byClass[c.id] || 0) / 100), r.total / 100])] },
  inventory: { title: t('Inventory valuation'), url: '/reports/inventory', csv: (d) => [[t('Item'), 'SKU', t('Qty§inv'), t('Average cost'), t('Amount')], ...d.rows.map((r) => [r.name, r.sku, r.qty_on_hand, r.cost / 100, r.value / 100])],
    View: ({ d }) => <Table head={[t('Item'), 'SKU', { label: t('Qty'), right: true }, { label: t('Average cost'), right: true }, { label: t('Amount'), right: true }]} empty={t('No stocked items.')}>{[...d.rows.map((r) => <tr key={r.id}><td className="td">{r.name} {r.low && <span className="text-xs text-rose-600">{t('(low)')}</span>}</td><td className="td">{r.sku}</td><td className="td num text-right">{number(r.qty_on_hand, 3)}</td><td className="td num text-right">{money(r.cost)}</td><td className="td num text-right">{money(r.value)}</td></tr>),
      d.rows.length ? <tr key="t" className="border-t-2 bg-slate-50 font-semibold"><td className="td" colSpan={4}>{t('Total')}</td><td className="td num text-right">{money(d.total)}</td></tr> : null]}</Table> },
  'trial-balance': { title: t('Trial balance'), asof: true, url: '/reports/trial-balance', csv: (d) => [[t('Code'), t('Account'), t('Debit'), t('Credit')], ...d.rows.map((r) => [r.code, r.name, r.debitBalance / 100, r.creditBalance / 100])],
    View: ({ d }) => <Table head={[t('Code'), t('Account'), { label: t('Debit'), right: true }, { label: t('Credit'), right: true }]}>{[...d.rows.map((r) => <tr key={r.id}><td className="td font-mono text-xs">{r.code}</td><td className="td">{r.name}</td><td className="td num text-right">{r.debitBalance ? money(r.debitBalance) : ''}</td><td className="td num text-right">{r.creditBalance ? money(r.creditBalance) : ''}</td></tr>),
      <tr key="t" className="border-t-2 bg-slate-50 font-semibold"><td className="td" colSpan={2}>{t('Totals')}{' '}{d.totalDebit === d.totalCredit ? '✓' : t('⚠ out of balance')}</td><td className="td num text-right">{money(d.totalDebit)}</td><td className="td num text-right">{money(d.totalCredit)}</td></tr>]}</Table> },
  forecast: { title: t('Cash forecast'), url: '/reports/forecast', csv: (d) => [[t('Week starting'), t('Money in'), t('Money out'), t('Net'), t('Balance at end')], ...d.rows.map((r) => [r.from, r.inflowTotal / 100, r.outflowTotal / 100, r.net / 100, r.ending / 100])],
    View: ({ d }) => (<>
      <p className="border-b border-slate-100 p-3 text-sm text-slate-600">{t('Starting from your bank balances today, adding open invoices and recurring invoices on their due dates and subtracting open bills and recurring bills. Payroll and one-off expenses are not included.')}</p>
      <div className="grid gap-3 p-3 sm:grid-cols-3"><div><div className="text-xs uppercase text-slate-500">{t('Cash today')}</div><div className="num text-lg font-semibold">{money(d.startingCash)}</div></div><div><div className="text-xs uppercase text-slate-500">{t('Cash in {0} weeks', [d.weeks])}</div><div className="num text-lg font-semibold">{money(d.endingCash)}</div></div><div><div className="text-xs uppercase text-slate-500">{t('Lowest point')}</div><div className={`num text-lg font-semibold ${d.lowest.balance < 0 ? 'text-rose-600' : ''}`}>{money(d.lowest.balance)}{d.lowest.week ? ` · ${t('week {0}', [d.lowest.week])}` : ''}</div></div></div>
      <Table head={[t('Week starting'), { label: t('Money in'), right: true }, { label: t('Money out'), right: true }, { label: t('Net'), right: true }, { label: t('Balance at end'), right: true }]}>
        {d.rows.map((r) => <tr key={r.from}><td className="td">{date(r.from)}</td><td className="td num text-right">{money(r.inflowTotal)}</td><td className="td num text-right">{money(r.outflowTotal)}</td><td className="td num text-right">{money(r.net)}</td><td className={`td num text-right font-medium ${r.ending < 0 ? 'text-rose-600' : ''}`}>{money(r.ending)}</td></tr>)}
      </Table></>) },
  'group-pnl': { title: t('Group income statement'), range: true, url: '/group/reports/pnl', csv: (d) => [[t('Account'), t('Amount')], ...d.income.map((r) => [r.name, r.total / 100]), [t('Total income§csv'), d.totalIncome / 100], ...d.opex.map((r) => [r.name, r.total / 100]), [t('Net income'), d.netIncome / 100]],
    View: ({ d }) => (<>
      <Table head={['', { label: `${date(d.from)} – ${date(d.to)}`, right: true }]}>
        <tr><td className="td font-semibold" colSpan={2}>{t('Income')}</td></tr>{d.income.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}
        <Row bold label={t('Total income')} v={d.totalIncome} />
        {d.cogs.length > 0 && <><tr><td className="td font-semibold" colSpan={2}>{t('Cost of goods sold')}</td></tr>{d.cogs.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}</>}
        <Row bold label={t('Gross profit')} v={d.grossProfit} />
        <tr><td className="td font-semibold" colSpan={2}>{t('Operating expenses')}</td></tr>{d.opex.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}
        <Row bold label={t('Total expenses')} v={d.totalOpex} />
        <tr className="border-t-2 border-slate-300 bg-slate-100 text-base font-bold"><td className="td">{t('Net income')}</td><td className="td num text-right">{money(d.netIncome)}</td></tr>
      </Table>
      <div className="border-t border-slate-100 p-3 text-sm text-slate-600"><div className="mb-1 font-semibold">{t('By company')}</div>{d.companies.map((c) => <div key={c.slug} className="flex justify-between"><span>{c.name}</span><span className="num">{money(c.netIncome)}</span></div>)}
        <p className="mt-2 text-xs text-slate-500">{t('Taken out as intercompany: income {0}, expenses {1}.', [money(d.eliminated.income), money(d.eliminated.expense)])} {d.eliminated.difference !== 0 && <span className="font-semibold text-rose-600">{t('They do not match: difference {0}.', [money(d.eliminated.difference)])}</span>}</p></div></>) },
  'group-balance': { title: t('Group balance sheet'), asof: true, url: '/group/reports/balance-sheet', csv: (d) => [[t('Account'), t('Amount')], ...d.assets.map((r) => [r.name, r.total / 100]), [t('Total assets'), d.totalAssets / 100], ...d.liabilities.map((r) => [r.name, r.total / 100]), [t('Total liabilities'), d.totalLiabilities / 100], ...d.equity.map((r) => [r.name, r.total / 100]), [t('Total equity'), d.totalEquity / 100]],
    View: ({ d }) => (<>
      {!d.balanced && <ErrorBox error={t('Warning: the group balance sheet does not balance. Check the intercompany accounts.')} />}
      <Table head={['', { label: `Em ${date(d.asof)}`, right: true }]}>
        <tr><td className="td font-semibold" colSpan={2}>{t('Asset')}</td></tr>{d.assets.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}<Row bold label={t('Total assets')} v={d.totalAssets} />
        <tr><td className="td font-semibold" colSpan={2}>{t('Liability')}</td></tr>{d.liabilities.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}<Row bold label={t('Total liabilities')} v={d.totalLiabilities} />
        <tr><td className="td font-semibold" colSpan={2}>{t('Equity')}</td></tr>{d.equity.map((r) => <tr key={r.name}><td className="td pl-8">{r.name}</td><td className="td num text-right">{money(r.total)}</td></tr>)}<Row indent label={t('Current-year earnings (retained)')} v={d.currentEarnings} /><Row bold label={t('Total equity')} v={d.totalEquity} />
      </Table>
      <p className="border-t border-slate-100 p-3 text-xs text-slate-500">{t('Taken out as intercompany: assets {0}, liabilities {1}.', [money(d.eliminated.assets), money(d.eliminated.liabilities)])} {d.eliminated.difference !== 0 && <span className="font-semibold text-rose-600">{t('They do not match: difference {0}.', [money(d.eliminated.difference)])}</span>}</p></>) },
};
const FEATURE_OF = { forecast: 'forecast', 'ap-aging': 'reports_full', 'expenses-by-vendor': 'reports_full', tax: 'reports_full', 'trial-balance': 'reports_full', inventory: 'inventory', budget: 'budgets', 'pnl-class': 'classes' };
const GROUPS = [[t('Performance'), ['pnl', 'balance-sheet', 'cash-flow', 'budget', 'pnl-class']], [t('Customers & vendors'), ['ar-aging', 'ap-aging', 'sales-by-customer']], [t('Expenses'), ['expenses-by-category', 'expenses-by-vendor']], [t('Other'), ['tax', 'inventory', 'trial-balance']], [t('Forecast & group'), ['forecast', 'group-pnl', 'group-balance']]];

export default function Reports() {
  const { report = 'pnl' } = useParams();
  const { has, user } = useAuth();
  const nav = useNavigate();
  const cfg = REPORTS[report];
  const groups = GROUPS.map(([g, keys]) => [g, keys.filter((k) => !k.startsWith('group-') || user.tenant)]).filter(([, keys]) => keys.length); // consolidação só no modo hospedado
  const [[from, to], setRange] = useState(PRESETS.year[1]());
  const [asof, setAsof] = useState(today());
  const locked = cfg && FEATURE_OF[report] && !has(FEATURE_OF[report]);
  const { data, loading, error, reload } = useLoad(() => (cfg && !locked ? api.get(cfg.url + qs(cfg.range ? { from, to } : cfg.asof ? { asof } : {})) : null), [report, from, to, asof, locked]);
  const View = cfg?.View;
  const title = useMemo(() => cfg?.title, [cfg]);
  if (!cfg) return <ErrorBox error={t('Report not found')} />;
  return (
    <>
      <PageHeader title={t('Reports')}>
        <Button variant="ghost" disabled={!data || locked} onClick={() => download(`${report}.csv`, cfg.csv(data))}>{t('Export CSV')}</Button><Button variant="ghost" onClick={() => window.print()}>{t('Print / PDF')}</Button>
      </PageHeader>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Select className="field no-print lg:hidden" aria-label={t('Report')} value={report} onChange={(e) => nav(`/reports/${e.target.value}`)}>{groups.map(([g, keys]) => <optgroup key={g} label={g}>{keys.map((k) => <option key={k} value={k}>{REPORTS[k].title}</option>)}</optgroup>)}</Select>
        <nav className="no-print hidden space-y-4 lg:block">{groups.map(([g, keys]) => <div key={g}><div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g}</div>
          {keys.map((k) => <NavLink key={k} to={`/reports/${k}`} className={({ isActive }) => `block rounded-lg px-2 py-1.5 text-sm ${isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100'}`}>{REPORTS[k].title}{FEATURE_OF[k] && !has(FEATURE_OF[k]) && <Lock />}</NavLink>)}</div>)}</nav>
        <Card title={title} pad={false}>
          {(cfg.range || cfg.asof) && <div className="no-print flex flex-wrap items-end gap-3 border-b border-slate-100 p-3">
            {cfg.range ? <><Field label={t('Period')}><Select value="" onChange={(e) => e.target.value && setRange(PRESETS[e.target.value][1]())}><option value="">{t('Shortcuts…')}</option>{Object.entries(PRESETS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
              <Field label={t('From')}><Input type="date" value={from} onChange={(e) => setRange([e.target.value, to])} /></Field><Field label={t('To')}><Input type="date" value={to} onChange={(e) => setRange([from, e.target.value])} /></Field></>
              : <Field label={t('As of')}><Input type="date" value={asof} onChange={(e) => setAsof(e.target.value)} /></Field>}
          </div>}
          {locked ? <UpgradeNotice feature={FEATURE_OF[report]} /> : loading ? <Loading /> : error ? <div className="p-4"><ErrorBox error={error} retry={reload} /></div> : <View d={data} />}
        </Card>
      </div>
    </>
  );
}
