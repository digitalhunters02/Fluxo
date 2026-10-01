import { t } from '../i18n.jsx';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { money, moneyShort, monthLabel, date } from '../format.js';
import { Card, ErrorBox, Loading, PageHeader, Stat, useLoad, Badge } from '../components/ui.jsx';

function BarChart({ series }) {
  const max = Math.max(1, ...series.flatMap((s) => [s.income, s.expense]));
  const W = 520, H = 190, pad = 46, bw = (W - pad * 2) / series.length;
  return (
    <svg viewBox={`0 0 ${W} ${H + 22}`} className="w-full" role="img" aria-label={t('Income and expenses by month')}>
      {[0, 0.5, 1].map((t) => <g key={t}><line x1={pad} x2={W - 6} y1={H - t * (H - 14)} y2={H - t * (H - 14)} stroke="#e2e8f0" /><text x={pad - 4} y={H - t * (H - 14) + 3} fontSize="9" textAnchor="end" fill="#94a3b8">{t ? moneyShort(max * t) : '0'}</text></g>)}
      {series.map((s, i) => {
        const x = pad + i * bw + bw * 0.15, w = bw * 0.33, h = (v) => (v / max) * (H - 14);
        return (
          <g key={s.month}>
            <rect x={x} y={H - h(s.income)} width={w} height={h(s.income)} rx="3" fill="#10b981"><title>{t('Income {0}', [money(s.income)])}</title></rect>
            <rect x={x + w + 3} y={H - h(s.expense)} width={w} height={h(s.expense)} rx="3" fill="#f43f5e"><title>{t('Expense {0}', [money(s.expense)])}</title></rect>
            <text x={x + w} y={H + 14} fontSize="10" textAnchor="middle" fill="#64748b">{monthLabel(s.month)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const { data, loading, error, reload } = useLoad(() => api.get('/dashboard'));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const d = data;
  const maxExp = Math.max(1, ...d.topExpenses.map((e) => e.total));
  return (
    <>
      <PageHeader title={t('Dashboard')} subtitle={t('Overview of your financial health')} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label={t('Cash in bank')} value={money(d.cash)} sub={t('30-day forecast: {0}', [money(d.forecast30)])} tone={d.cash < 0 ? 'bad' : 'default'} />
        <Stat label={t('To receive')} value={money(d.receivable.v)} sub={d.receivableOverdue.n ? t('{0} overdue ({1})', [money(d.receivableOverdue.v), d.receivableOverdue.n]) : t('Nothing overdue')} tone={d.receivableOverdue.n ? 'bad' : 'default'} />
        <Stat label={t('To pay')} value={money(d.payable.v)} sub={d.payableOverdue.n ? t('{0} overdue ({1})', [money(d.payableOverdue.v), d.payableOverdue.n]) : t('Nothing overdue')} tone={d.payableOverdue.n ? 'bad' : 'default'} />
        <Stat label={t('Profit this month')} value={money(d.month.profit)} sub={t('{0} income · {1} expenses', [money(d.month.income), money(d.month.expense)])} tone={d.month.profit < 0 ? 'bad' : 'good'} />
      </div>
      {(d.pendingBank > 0 || d.lowStock > 0) && (
        <div className="mt-4 flex flex-wrap gap-3">
          {d.pendingBank > 0 && <Link to="/banking" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800 hover:bg-amber-100">🏦 {d.pendingBank}{' '}{t('bank transaction(s) to review')}</Link>}
          {d.lowStock > 0 && <Link to="/products" className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-800 hover:bg-rose-100">📦 {d.lowStock}{' '}{t('product(s) low on stock')}</Link>}
        </div>
      )}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card title={t('Income and expenses — last 6 months')} className="lg:col-span-2" action={<span className="text-xs text-slate-500"><i className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-500" />{t('Income§type')}{' '}<i className="ml-2 mr-1 inline-block h-2 w-2 rounded-full bg-rose-500" />{t('Expense')}</span>}>
          <BarChart series={d.series} />
        </Card>
        <Card title={t('Top expenses this month')}>
          {d.topExpenses.length === 0 ? <p className="text-sm text-slate-400">{t('No expenses this month.')}</p> : (
            <ul className="space-y-3">{d.topExpenses.map((e) => (
              <li key={e.id}><div className="mb-1 flex justify-between text-sm"><span>{e.name}</span><span className="num font-medium">{money(e.total)}</span></div>
                <div className="h-1.5 rounded bg-slate-100"><div className="h-1.5 rounded bg-rose-400" style={{ width: `${(e.total / maxExp) * 100}%` }} /></div></li>
            ))}</ul>
          )}
        </Card>
      </div>
      <Card title={t('Upcoming due dates')} className="mt-4" pad={false}>
        {d.upcoming.length === 0 ? <p className="p-4 text-sm text-slate-400">{t('No open accounts.')}</p> : (
          <ul className="divide-y divide-slate-100">{d.upcoming.map((u) => (
            <li key={u.id}><Link to={`/document/${u.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
              <span><Badge status={u.type === 'invoice' ? 'sent' : 'open'}>{u.type === 'invoice' ? t('Receivable') : t('Payable')}</Badge> <span className="ml-2 font-medium">{u.contact_name}</span> <span className="text-slate-400">· {u.number}</span></span>
              <span className="text-right"><span className="num font-medium">{money(u.balance)}</span> <span className="ml-2 text-xs text-slate-500">{date(u.due_date)}</span></span>
            </Link></li>
          ))}</ul>
        )}
      </Card>
    </>
  );
}
