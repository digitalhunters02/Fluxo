import { t } from '../i18n.jsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { money, toCents, fromCents } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, Select, Table, useAction, useLoad } from '../components/ui.jsx';

const STATUS = () => ({
  over: [t('Over the limit'), 'bg-rose-100 text-rose-800'], near: [t('Close to the limit'), 'bg-amber-100 text-amber-800'], ok: [t('Below the limit'), 'bg-emerald-100 text-emerald-800'],
  home: [t('Your home state'), 'bg-slate-100 text-slate-700'], no_tax: [t('No state sales tax'), 'bg-slate-100 text-slate-700'],
});

function Rates({ data, states, reload }) {
  const [run, busy] = useAction();
  const blank = { name: '', state: '', rate: '', notes: '' };
  const [f, setF] = useState(blank); const [editId, setEditId] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = () => run(async () => { await (editId ? api.put(`/tax/rates/${editId}`, { ...f, rate: Number(f.rate), active: true }) : api.post('/tax/rates', { ...f, rate: Number(f.rate) })); setF(blank); setEditId(null); await reload(); }, t('Saved'));
  return (
    <Card title={t('Sales tax rates')}>
      <p className="mb-3 text-sm text-slate-600">{t('Name each rate you charge (for example "Texas + Austin 8.25%"). Pick it on an invoice line or set it as a customer\'s default. Reports then add up the tax you collected for each rate.')}</p>
      <div className="grid gap-3 sm:grid-cols-5">
        <Field label={t('Name')} className="sm:col-span-2"><Input value={f.name} onChange={set('name')} data-testid="rate-name" /></Field>
        <Field label={t('State')}><Select value={f.state} onChange={set('state')}><option value="">—</option>{Object.entries(states).map(([k, n]) => <option key={k} value={k}>{k}</option>)}</Select></Field>
        <Field label={t('Rate (%)')}><Input inputMode="decimal" value={f.rate} onChange={set('rate')} data-testid="rate-value" /></Field>
        <div className="flex items-end gap-2"><Button disabled={busy || !f.name.trim() || f.rate === ''} onClick={save} data-testid="rate-save">{editId ? t('Update') : t('Add rate')}</Button>{editId && <Button variant="ghost" onClick={() => { setEditId(null); setF(blank); }}>{t('Cancel')}</Button>}</div>
      </div>
      <Table head={[t('Name'), t('State'), { label: t('Rate'), right: true }, '']} empty={t('No rates yet.')}>
        {data.rates.map((r) => (
          <tr key={r.id} className={r.active ? '' : 'opacity-50'}><td className="td">{r.name}{r.notes && <div className="text-xs text-slate-400">{r.notes}</div>}</td><td className="td">{r.state || '—'}</td><td className="td num text-right">{r.rate}%</td>
            <td className="td whitespace-nowrap text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => { setEditId(r.id); setF({ name: r.name, state: r.state, rate: String(r.rate), notes: r.notes }); }}>{t('Edit')}</button>{' '}
              <button className="text-xs text-rose-600 hover:underline" onClick={() => run(async () => { await api.del(`/tax/rates/${r.id}`); await reload(); })}>{t('Delete')}</button></td></tr>))}
      </Table>
      <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
        <p>{t('Starting point: add the state-level rate of every state that has a state sales tax. These are base rates only, without city or county taxes, and they can be out of date: check each one with your state before you charge it.')}</p>
        <Button className="mt-2" variant="ghost" disabled={busy} data-testid="rate-state-base" onClick={() => run(async () => { const r = await api.post('/tax/rates/state-base', {}); await reload(); return r; }, t('State rates added'))}>{t('Add state base rates')}</Button>
      </div>
    </Card>
  );
}

function Nexus({ n, states, reload }) {
  const [run, busy] = useAction();
  const S = STATUS();
  const saveLimit = (state, sales, txns) => run(async () => { await api.put('/tax/nexus/threshold', { state, sales: toCents(sales), txns: Number(txns) || 0 }); await reload(); }, t('Saved'));
  return (
    <Card title={t('Where you may owe sales tax')}>
      <p className="mb-3 text-sm text-slate-600">{t('Selling to customers in another state can create an obligation to register and collect sales tax there once you pass that state\'s limit. This table adds up your last 12 months of sales by customer state. The limits are common defaults and some states differ or change them: confirm with the state or your accountant. Fluxo does not register or file for you.')}</p>
      {n.customersWithoutState > 0 && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="nexus-nostate">{t('{0} customers have no state set, so their sales are not counted per state.', [n.customersWithoutState])} <Link className="underline" to="/customers">{t('Set the state')}</Link>{n.unassigned.sales > 0 ? ` · ${t('Sales without a state: {0}', [money(n.unassigned.sales)])}` : ''}</p>}
      <Table head={[t('State'), { label: t('Sales (12 months)'), right: true }, { label: t('Sales count'), right: true }, { label: t('Limit: sales'), right: true }, { label: t('Limit: count'), right: true }, t('Status')]} empty={t('No sales to customers with a state yet.')}>
        {n.rows.map((r) => (
          <tr key={r.state} data-testid={`nexus-${r.state}`}><td className="td">{r.state} — {r.name}</td><td className="td num text-right">{money(r.sales)} <span className="text-xs text-slate-400">({r.pct}%)</span></td><td className="td num text-right">{r.txns}</td>
            <td className="td text-right"><Input className="field !w-28 text-right" inputMode="decimal" defaultValue={fromCents(r.limitSales)} disabled={busy} onBlur={(e) => { if (toCents(e.target.value) !== r.limitSales) saveLimit(r.state, e.target.value, r.limitTxns); }} aria-label={t('Limit: sales')} /></td>
            <td className="td text-right"><Input className="field !w-20 text-right" inputMode="numeric" defaultValue={r.limitTxns} disabled={busy} onBlur={(e) => { if (Number(e.target.value) !== r.limitTxns) saveLimit(r.state, fromCents(r.limitSales), e.target.value); }} aria-label={t('Limit: count')} /></td>
            <td className="td"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${S[r.status][1]}`}>{S[r.status][0]}</span></td></tr>))}
      </Table>
      <p className="mt-2 text-xs text-slate-400">{t('Set a limit to 0 to ignore that kind of limit for a state.')}</p>
    </Card>
  );
}

export default function SalesTaxSettings() {
  const [run, busy] = useAction();
  const rates = useLoad(() => api.get('/tax/rates'));
  const nexus = useLoad(() => api.get('/reports/tax-nexus'));
  if (rates.loading || nexus.loading) return <Loading />;
  if (rates.error) return <ErrorBox error={rates.error} retry={rates.reload} />;
  if (nexus.error) return <ErrorBox error={nexus.error} retry={nexus.reload} />;
  const reloadAll = async () => { await rates.reload(); await nexus.reload(); };
  return (
    <div className="max-w-5xl space-y-4" data-testid="sales-tax">
      <Card title={t('Your home state')}>
        <p className="mb-3 text-sm text-slate-600">{t('The state where your business is based. You already owe sales tax there, so it is left out of the warnings below.')}</p>
        <div className="max-w-xs"><Select value={rates.data.homeState} disabled={busy} onChange={(e) => run(async () => { await api.put('/tax/home-state', { state: e.target.value }); await reloadAll(); }, t('Saved'))} data-testid="home-state"><option value="">—</option>{Object.entries(rates.data.states).map(([k, n]) => <option key={k} value={k}>{k} — {n}</option>)}</Select></div>
      </Card>
      <Nexus n={nexus.data} states={rates.data.states} reload={reloadAll} />
      <Rates data={rates.data} states={rates.data.states} reload={reloadAll} />
    </div>
  );
}
