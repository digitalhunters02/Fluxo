import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { date, money, today, toCents, fromCents } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

function AssetModal({ onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', acquired_date: today(), cost: '', salvage: '0', life_years: '5' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const r = await run(() => api.post('/assets', { name: f.name, acquired_date: f.acquired_date, cost: toCents(f.cost), salvage: toCents(f.salvage || 0), life_months: Math.round(Number(f.life_years) * 12) }), t('Asset added'));
    if (r) onSaved();
  };
  return (
    <Modal title={t('New fixed asset')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !f.name || !f.cost} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')} className="col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label={t('Purchase date')}><Input type="date" value={f.acquired_date} onChange={set('acquired_date')} /></Field>
        <Field label={t('Cost')}><Input inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>
        <Field label={t('Salvage value')} hint={t('What it is worth at the end of its life')}><Input inputMode="decimal" value={f.salvage} onChange={set('salvage')} /></Field>
        <Field label={t('Useful life (years)')}><Input inputMode="decimal" value={f.life_years} onChange={set('life_years')} /></Field>
      </div>
      <p className="mt-3 text-xs text-slate-400">{t('Straight-line depreciation, one entry per month, starting in the month of purchase.')}</p>
    </Modal>
  );
}

function DisposeModal({ asset, onClose, onDone }) {
  const [run, busy] = useAction();
  const { data: accounts } = useLoad(() => api.get('/accounts/lookup'));
  const banks = (accounts || []).filter((a) => a.type === 'asset' && a.subtype === 'bank');
  const [f, setF] = useState({ date: today(), proceeds: '0', account_id: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const r = await run(() => api.post(`/assets/${asset.id}/dispose`, { date: f.date, proceeds: toCents(f.proceeds || 0), deposit_account_id: Number(f.account_id || banks[0]?.id) }), t('Asset disposed')); if (r) onDone(); };
  return (
    <Modal title={t('Sell or dispose of {0}', [asset.name])} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Confirm')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Date')}><Input type="date" value={f.date} onChange={set('date')} /></Field>
        <Field label={t('Amount received')}><Input inputMode="decimal" value={f.proceeds} onChange={set('proceeds')} /></Field>
        <Field label={t('Deposit to')} className="col-span-2"><Select value={f.account_id || banks[0]?.id || ''} onChange={set('account_id')}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      </div>
      <p className="mt-3 text-xs text-slate-400">{t('Fluxo depreciates up to this month, removes the asset and records the gain or loss.')}</p>
    </Modal>
  );
}

export default function Assets() {
  const { can } = useAuth();
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(() => api.get('/assets'));
  const [adding, setAdding] = useState(false); const [disposing, setDisposing] = useState(null); const [through, setThrough] = useState(today().slice(0, 7)); const [msg, setMsg] = useState('');
  const w = can('accounting', true);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      <PageHeader title={t('Fixed assets')} subtitle={t('Equipment, vehicles and other things you use for years, with monthly depreciation.')}>
        {w && <Button onClick={() => setAdding(true)}>{t('New asset')}</Button>}
      </PageHeader>
      {w && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('Depreciate through')}><Input type="month" value={through} onChange={(e) => setThrough(e.target.value)} /></Field>
            <Button disabled={busy} onClick={() => run(async () => { const r = await api.post('/assets/depreciate', { through }); setMsg(r.posted.length ? t('Posted {0} entries ({1}).', [r.posted.length, money(r.total)]) : t('Nothing new to post.')); if (r.skipped.length) setMsg((m) => `${m} ${t('{0} months were skipped because the period is closed.', [r.skipped.length])}`); reload(); })}>{t('Post depreciation')}</Button>
            {msg && <span className="text-sm text-slate-600" data-testid="depr-msg">{msg}</span>}
          </div>
        </Card>)}
      <Card pad={false}>
        <Table head={[t('Asset'), t('Purchased'), { label: t('Cost'), right: true }, { label: t('Depreciated'), right: true }, { label: t('Book value'), right: true }, t('Status'), '']} empty={t('No fixed assets yet.')}>
          {data.assets.map((a) => (
            <tr key={a.id}><td className="td font-medium">{a.name}</td><td className="td">{date(a.acquired_date)}</td><td className="td num text-right">{money(a.cost)}</td><td className="td num text-right">{money(a.depreciated)}</td><td className="td num text-right">{money(a.book_value)}</td>
              <td className="td text-sm">{a.status === 'disposed' ? t('Disposed {0}', [date(a.disposed_date)]) : a.fully_depreciated ? t('Fully depreciated') : t('{0} of {1} months', [a.months_done, a.life_months])}</td>
              <td className="td text-right">{w && a.status === 'active' && <button className="text-xs text-brand-700 hover:underline" onClick={() => setDisposing(a)}>{t('Sell / dispose')}</button>}
                {w && a.status === 'active' && !a.months_done && <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this asset?')) && run(async () => { await api.del(`/assets/${a.id}`); reload(); })}>{t('Delete')}</button>}</td></tr>))}
        </Table>
      </Card>
      {adding && <AssetModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {disposing && <DisposeModal asset={disposing} onClose={() => setDisposing(null)} onDone={() => { setDisposing(null); reload(); }} />}
    </>
  );
}
