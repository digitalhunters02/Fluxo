import { t } from '../i18n.jsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { date, money, today } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, useAction, useLoad } from '../components/ui.jsx';
import { SearchBox, useSearch } from '../components/search.jsx';
import { useAuth } from '../App.jsx';

const REPEAT = () => ({ '': t('Does not repeat'), weekly: t('Weekly'), monthly: t('Monthly'), quarterly: t('Quarterly'), yearly: t('Yearly') });

/** Texto do aviso: os automáticos chegam com a chave em inglês e os dados para preencher. */
export const reminderTitle = (r) => {
  if (r.manual) return r.title;
  const arg = { overdue: r.data.number, bill: r.data.number, estimate: r.data.number, stock: r.data.name, bank: r.data.n }[r.kind];
  return t(r.title, arg === undefined ? [] : [arg]);
};

/** Abre o e-mail do próprio usuário com a cobrança já escrita (não custa nada e sai do e-mail dele). */
async function emailCustomer(r, tenant) {
  let link = '';
  try { const d = await api.get(`/doc/${r.data.id}`); link = `${location.origin}/p/${tenant ? `${tenant}.` : ''}${d.share_token}`; } catch { /* sem link: segue só com o texto */ }
  const body = t('Hi {0}, our records show invoice {1} for {2} was due on {3}. Could you let us know when to expect payment? {4}', [r.data.name, r.data.number, money(r.data.balance), date(r.due_date), link]);
  location.href = `mailto:${r.data.email || ''}?subject=${encodeURIComponent(t('Invoice {0} is past due', [r.data.number]))}&body=${encodeURIComponent(body)}`;
}

export function useReminderCount(dep) {
  const { data } = useLoad(() => api.get('/reminders').catch(() => []), [dep]);
  return (data || []).length;
}

export default function Reminders() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/reminders'));
  const [run, busy] = useAction();
  const [f, setF] = useState({ title: '', due_date: today(), repeat: '' });
  const [q, setQ, search] = useSearch();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const act = (fn, msg) => run(async () => { await fn(); await reload(); }, msg);
  const add = async (e) => { e.preventDefault(); await act(() => api.post('/reminders', f), t('Reminder added')); setF({ ...f, title: '' }); };
  return (
    <>
      <PageHeader title={t('Reminders')} subtitle={t('Things Fluxo noticed, and tasks you want to remember.')}>
        <Link className="btn btn-ghost" to="/settings/automations">{t('Automations')}</Link>
      </PageHeader>
      <Card title={t('Add a reminder')} className="mb-4">
        <form onSubmit={add} className="grid gap-3 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
          <Field label={t('What do you need to do?')}><Input required maxLength={160} value={f.title} onChange={set('title')} placeholder={t('Pay payroll taxes')} /></Field>
          <Field label={t('Due')}><Input required type="date" value={f.due_date} onChange={set('due_date')} /></Field>
          <Field label={t('Repeat')}><Select value={f.repeat} onChange={set('repeat')}>{Object.entries(REPEAT()).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
          <Button disabled={busy}>{t('Add')}</Button>
        </form>
        <p className="mt-2 text-xs text-slate-500">{t('Repeating reminders come back by themselves when you mark them done.')}</p>
      </Card>
      {data.length > 4 && <SearchBox className="mb-3 max-w-sm" value={q} onChange={setQ} placeholder={t('Search reminders…')} />}
      {data.length === 0 ? <Card><p className="py-6 text-center text-sm text-slate-500">{t('All caught up. Nothing needs your attention.')}</p></Card> : (
        <ul className="space-y-3">
          {search(data).map((r) => (
            <li key={r.id} className={`card flex flex-wrap items-start gap-3 p-4 ${r.overdue ? 'border-rose-200' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">{reminderTitle(r)}</div>
                {r.detail && <div className="text-sm text-slate-500">{r.manual ? r.detail : t(r.detail)}</div>}
                <div className={`mt-1 text-xs ${r.overdue ? 'text-rose-600' : 'text-slate-500'}`}>
                  {r.due_date && <>{r.overdue ? t('Was due {0}', [date(r.due_date)]) : t('Due {0}', [date(r.due_date)])}</>}
                  {r.repeat && <> · {REPEAT()[r.repeat]}</>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {r.link && <Link className="btn btn-ghost" to={r.link}>{t('Open§action')}</Link>}
                {r.kind === 'overdue' && <Button variant="ghost" onClick={() => emailCustomer(r, user.tenant)}>{t('Email customer')}</Button>}
                <Button variant="ghost" disabled={busy} onClick={() => act(() => api.post(`/reminders/${r.id}/snooze`, { days: 1 }), t('Snoozed until tomorrow'))}>{t('Snooze')}</Button>
                <Button disabled={busy} onClick={() => act(() => api.post(`/reminders/${r.id}/done`), t('Done'))}>{t('Done')}</Button>
                {r.manual && <Button variant="danger" disabled={busy} onClick={() => confirm(t('Delete this reminder?')) && act(() => api.del(`/reminders/${r.id}`))}>{t('Delete')}</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
