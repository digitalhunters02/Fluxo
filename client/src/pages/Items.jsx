import { t } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { fromCents, money, number, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

function ItemModal({ item, accounts, onClose, onSaved }) {
  const { has } = useAuth();
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', sku: '', kind: 'service', price: '', cost: '', track_inventory: false, qty_on_hand: '0', reorder_point: '0', income_account_id: '', tax_rate: '0',
    ...(item ? { ...item, price: fromCents(item.price), cost: fromCents(item.cost), track_inventory: !!item.track_inventory, income_account_id: item.income_account_id || '' } : {}) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    const body = { ...f, price: toCents(f.price), cost: toCents(f.cost), income_account_id: f.income_account_id ? Number(f.income_account_id) : null, qty_on_hand: Number(String(f.qty_on_hand).replace(',', '.')) || 0, reorder_point: Number(f.reorder_point) || 0, tax_rate: Number(f.tax_rate) || 0 };
    const r = await run(() => (item ? api.put(`/items/${item.id}`, body) : api.post('/items', body)), t('Item saved')); if (r) onSaved();
  };
  return (
    <Modal title={item ? t('Edit item') : t('New product or service')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')} className="col-span-2"><Input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label={t('Type')}><Select value={f.kind} onChange={set('kind')}><option value="service">{t('Service')}</option><option value="product">{t('Product')}</option></Select></Field>
        <Field label={t('Code (SKU)')}><Input value={f.sku} onChange={set('sku')} /></Field>
        <Field label={t('Sale price')}><Input inputMode="decimal" value={f.price} onChange={set('price')} /></Field>
        <Field label={t('Default tax (%)')}><Input inputMode="decimal" value={f.tax_rate} onChange={set('tax_rate')} /></Field>
        <Field label={t('Income account')} className="col-span-2"><Select value={f.income_account_id} onChange={set('income_account_id')}><option value="">{t('Automatic')}</option>{accounts.filter((a) => a.type === 'income').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        {f.kind === 'product' && <>
          {!has('inventory') && !item?.track_inventory && <p className="col-span-2 rounded bg-amber-50 p-2 text-xs text-amber-800">🔒 {t('Inventory tracking is available from the Plus plan.')}</p>}
          {(has('inventory') || item?.track_inventory) && <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.track_inventory} onChange={set('track_inventory')} disabled={!!item?.track_inventory && item.qty_on_hand !== 0} />{' '}{t('Track inventory (average cost)')}</label>}
          {f.track_inventory && <>
            {!item && <Field label={t('Opening stock')} hint={t('Posted against Owner Capital')}><Input inputMode="decimal" value={f.qty_on_hand} onChange={set('qty_on_hand')} /></Field>}
            {!item && <Field label={t('Opening unit cost')}><Input inputMode="decimal" value={f.cost} onChange={set('cost')} /></Field>}
            <Field label={t('Low-stock alert level')}><Input inputMode="decimal" value={f.reorder_point} onChange={set('reorder_point')} /></Field>
          </>}
        </>}
      </div>
    </Modal>
  );
}

function AdjustModal({ item, accounts, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ qty_delta: '', offset_account_id: '' });
  const save = async () => { const r = await run(() => api.post(`/items/${item.id}/adjust`, { qty_delta: Number(String(f.qty_delta).replace(',', '.')), date: today(), offset_account_id: f.offset_account_id ? Number(f.offset_account_id) : undefined }), t('Stock adjusted')); if (r) onSaved(); };
  return (
    <Modal title={t('Adjust stock — {0}', [item.name])} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !f.qty_delta} onClick={save}>{t('Adjust')}</Button></>}>
      <p className="mb-3 text-sm text-slate-500">{t('On hand:')}{' '}<b>{number(item.qty_on_hand, 3)}</b>{' '}{t('· average cost')}{' '}{money(item.cost)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Change (+ in / − out)')}><Input inputMode="decimal" value={f.qty_delta} onChange={(e) => setF({ ...f, qty_delta: e.target.value })} placeholder="-2" /></Field>
        <Field label={t('Offset account')}><Select value={f.offset_account_id} onChange={(e) => setF({ ...f, offset_account_id: e.target.value })}><option value="">{t('Cost of goods (loss/gain)')}</option>{accounts.filter((a) => a.type !== 'asset' || a.subtype !== 'inventory').filter((a) => ['expense', 'equity'].includes(a.type)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

export default function Items() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => { const [items, accounts] = await Promise.all([api.get('/items'), api.get('/accounts/lookup')]); return { items, accounts }; });
  const [edit, setEdit] = useState(null);
  const [adj, setAdj] = useState(null);
  const [run] = useAction();
  const [tab, setTab] = useState('all');
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const rows = data.items.filter((i) => tab === 'all' || (tab === 'stock' ? i.track_inventory : tab === 'low' ? i.track_inventory && i.qty_on_hand <= i.reorder_point : i.kind === 'service'));
  const value = data.items.filter((i) => i.track_inventory).reduce((s, i) => s + Math.round(i.qty_on_hand * i.cost), 0);
  return (
    <>
      <PageHeader title={t('Products & inventory')} subtitle={t('Inventory value (average cost): {0}', [money(value)])}>{can('inventory', true) && <Button onClick={() => setEdit({})}>{t('+ New item')}</Button>}</PageHeader>
      <div className="no-print mb-3 flex gap-2">{[['all', t('All')], ['stock', t('Stocked')], ['low', t('Low stock')], ['service', t('Services')]].map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1 text-sm ${tab === k ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}>{l}</button>)}</div>
      <Card pad={false}>
        <Table head={[t('Item'), 'SKU', t('Type'), { label: t('Price'), right: true }, { label: t('Cost'), right: true }, { label: t('Inventory'), right: true }, '']} empty={t('No items.')}>
          {rows.map((i) => (
            <tr key={i.id} className="hover:bg-slate-50"><td className="td font-medium">{i.name}</td><td className="td">{i.sku}</td><td className="td">{i.kind === 'product' ? t('Product') : t('Service')}</td>
              <td className="td num text-right">{money(i.price)}</td><td className="td num text-right">{i.track_inventory ? money(i.cost) : '—'}</td>
              <td className="td num text-right">{i.track_inventory ? <>{number(i.qty_on_hand, 3)} {i.qty_on_hand <= i.reorder_point && <Badge status="declined">{t('low')}</Badge>}</> : '—'}</td>
              <td className="td whitespace-nowrap text-right">{can('inventory', true) && <>{i.track_inventory ? <button className="text-xs text-brand-700 hover:underline" onClick={() => setAdj(i)}>{t('Adjust')}</button> : null}
                <button className="ml-3 text-xs text-brand-700 hover:underline" onClick={() => setEdit(i)}>{t('Edit')}</button>
                <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Archive {0}?', [i.name])) && run(async () => { await api.del(`/items/${i.id}`); reload(); }, t('Item archived'))}>{t('Archive')}</button></>}</td></tr>
          ))}
        </Table>
      </Card>
      {edit && <ItemModal item={edit.id ? edit : null} accounts={data.accounts} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {adj && <AdjustModal item={adj} accounts={data.accounts} onClose={() => setAdj(null)} onSaved={() => { setAdj(null); reload(); }} />}
    </>
  );
}
