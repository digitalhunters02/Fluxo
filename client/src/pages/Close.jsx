import { t } from '../i18n.jsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { date, today } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const prevMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const LABEL = () => ({
  bank_rec: [t('Bank and card accounts are reconciled'), '/banking'], depreciation: [t('Depreciation is posted'), '/assets'], approvals: [t('No bill is waiting for approval'), '/settings/approvals'],
  payroll: [t('No pay run is left in draft'), '/payroll'], review_ar: [t('I reviewed the accounts receivable aging'), '/reports/ar-aging'], review_ap: [t('I reviewed the accounts payable aging'), '/reports/ap-aging'], review_reports: [t('I reviewed the income statement and balance sheet'), '/reports/pnl'],
});

export default function Close() {
  const { can } = useAuth();
  const [period, setPeriod] = useState(prevMonth());
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(() => api.get(`/close/${period}`), [period]);
  const w = can('accounting', true);
  const L = LABEL();
  const done = data ? data.items.filter((i) => i.done).length : 0;
  return (
    <>
      <PageHeader title={t('Month-end close')} subtitle={t('Go through the checklist, then close the month to lock it against changes.')} />
      <Card className="mb-4"><div className="flex flex-wrap items-end gap-3"><Field label={t('Month')}><Input type="month" value={period} max={today().slice(0, 7)} onChange={(e) => e.target.value && setPeriod(e.target.value)} /></Field>
        {data && <span className="pb-2 text-sm text-slate-600">{t('{0} of {1} done', [done, data.items.length])}</span>}</div></Card>
      {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (
        <Card title={t('Checklist')} className="max-w-3xl">
          <ul className="divide-y divide-slate-100" data-testid="close-list">
            {data.items.map((i) => (
              <li key={i.key} className="flex items-center gap-3 py-2.5 text-sm">
                <input type="checkbox" className="h-5 w-5" checked={i.done} disabled={i.auto || !w || busy || data.locked} aria-label={L[i.key][0]} onChange={(e) => run(async () => { await api.post(`/close/${period}/${i.key}`, { done: e.target.checked }); reload(); })} />
                <span className={i.done ? 'text-slate-500' : ''}>{L[i.key][0]}{i.detail ? ` (${i.detail})` : ''}</span>
                {i.auto && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">{t('checked by Fluxo')}</span>}
                {!i.done && L[i.key][1] && <Link className="ml-auto text-xs text-brand-700 hover:underline" to={L[i.key][1]}>{t('Open')}</Link>}
                {i.by && <span className="ml-auto text-xs text-slate-400">{i.by}</span>}
              </li>))}
          </ul>
          <div className="mt-4 flex items-center gap-3">
            {data.locked ? <span className="rounded bg-emerald-100 px-2 py-1 text-sm font-semibold text-emerald-700" data-testid="closed-badge">{t('Closed through {0}', [date(data.end)])}</span>
              : <Button disabled={busy || !w || !data.ready} onClick={() => confirm(t('Close {0}? Nobody will be able to add or change entries up to {1}.', [period, date(data.end)])) && run(async () => { await api.post(`/close/${period}/lock`); reload(); }, t('Month closed'))}>{t('Close the month')}</Button>}
            {!data.ready && !data.locked && <span className="text-xs text-slate-500">{t('Finish every item to close.')}</span>}
          </div>
        </Card>)}
    </>
  );
}
