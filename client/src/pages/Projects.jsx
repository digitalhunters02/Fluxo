import { t } from '../i18n.jsx';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { date, fromCents, money, number, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

function ProjectModal({ p, contacts, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', contact_id: '', hourly_rate: '', budget: '', status: 'active', notes: '', ...(p ? { ...p, contact_id: p.contact_id || '', hourly_rate: fromCents(p.hourly_rate), budget: fromCents(p.budget) } : {}) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => { const body = { ...f, contact_id: f.contact_id ? Number(f.contact_id) : null, hourly_rate: toCents(f.hourly_rate), budget: toCents(f.budget) }; const r = await run(() => (p ? api.put(`/projects/${p.id}`, body) : api.post('/projects', body)), t('Project saved')); if (r) onSaved(); };
  return (
    <Modal title={p ? t('Edit project') : t('New project')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Name')} className="col-span-2"><Input value={f.name} onChange={set('name')} /></Field>
        <Field label={t('Customer')} className="col-span-2"><Select value={f.contact_id} onChange={set('contact_id')}><option value="">—</option>{contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={t('Hourly rate')}><Input inputMode="decimal" value={f.hourly_rate} onChange={set('hourly_rate')} /></Field><Field label={t('Estimate')}><Input inputMode="decimal" value={f.budget} onChange={set('budget')} /></Field>
        <Field label={t('Status')} className="col-span-2"><Select value={f.status} onChange={set('status')}><option value="active">{t('Asset')}</option><option value="completed">{t('Completed')}</option><option value="archived">{t('Archived')}</option></Select></Field>
      </div>
    </Modal>
  );
}

function TimeModal({ projects, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ project_id: projects[0]?.id || '', date: today(), hours: '', description: '', billable: true });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title={t('Log time')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={async () => { const r = await run(() => api.post('/time', { ...f, project_id: Number(f.project_id), hours: Number(String(f.hours).replace(',', '.')) }), t('Time logged')); if (r) onSaved(); }}>{t('Save')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('Project')} className="col-span-2"><Select value={f.project_id} onChange={set('project_id')}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></Field>
        <Field label={t('Date')}><Input type="date" value={f.date} onChange={set('date')} /></Field><Field label={t('Hours')}><Input inputMode="decimal" value={f.hours} onChange={set('hours')} placeholder="2,5" /></Field>
        <Field label={t('Description')} className="col-span-2"><Input value={f.description} onChange={set('description')} /></Field>
        <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.billable} onChange={set('billable')} />{' '}{t('Billable')}</label>
      </div>
    </Modal>
  );
}

export default function Projects() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState('projects');
  const { data, loading, error, reload } = useLoad(async () => { const [projects, time, contacts] = await Promise.all([api.get('/projects'), api.get('/time'), api.get('/contacts')]); return { projects, time, contacts }; });
  const [editP, setEditP] = useState(null);
  const [timing, setTiming] = useState(false);
  const [run] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const w = can('projects', true);
  const active = data.projects.filter((p) => p.status === 'active');
  return (
    <>
      <PageHeader title={t('Projects & time')} subtitle={t('Track hours, costs and profitability by project')}>
        {w && <Button variant="ghost" disabled={!active.length} onClick={() => setTiming(true)}>{t('⏱ Log time')}</Button>}{w && <Button onClick={() => setEditP({})}>{t('+ New project')}</Button>}
      </PageHeader>
      <Tabs tabs={[['projects', t('Projects')], ['time', t('Hours')]]} value={tab} onChange={setTab} />
      {tab === 'projects' ? (
        <Card pad={false}><Table head={[t('Project'), t('Customer'), { label: t('Hours'), right: true }, { label: t('To invoice'), right: true }, { label: t('Invoiced§m'), right: true }, { label: t('Costs'), right: true }, { label: t('Profit'), right: true }, '']} empty={t('No projects.')}>
          {data.projects.map((p) => (
            <tr key={p.id} className="hover:bg-slate-50"><td className="td font-medium">{p.name} {p.status !== 'active' && <Badge status="void">{p.status === 'completed' ? t('Completed') : t('Archived')}</Badge>}
              {p.budget > 0 && <div className="mt-1 h-1 w-32 rounded bg-slate-100"><div className={`h-1 rounded ${p.invoiced > p.budget ? 'bg-rose-500' : 'bg-brand-500'}`} style={{ width: `${Math.min(100, (p.invoiced / p.budget) * 100)}%` }} /></div>}</td>
              <td className="td">{p.contact_name}</td><td className="td num text-right">{number(p.hours, 1)}</td><td className="td num text-right">{money(p.unbilled)}</td>{p.profitHidden ? <td className="td text-right text-xs text-slate-400" colSpan={3} title={t('Project profitability is available from the Plus plan.')}>🔒 {t('Plus plan')}</td> : <><td className="td num text-right">{money(p.invoiced)}</td><td className="td num text-right">{money(p.costs)}</td>
              <td className={`td num text-right font-medium ${p.profit < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{money(p.profit)}</td></>}
              <td className="td whitespace-nowrap text-right">{w && <>{p.unbilled > 0 && can('sales', true) && <button className="text-xs text-brand-700 hover:underline" onClick={() => run(async () => { const d = await api.post(`/projects/${p.id}/invoice-time`); nav(`/document/${d.id}`); }, t('Invoice created from the hours'))}>{t('Invoice hours')}</button>}
                <button className="ml-3 text-xs text-brand-700 hover:underline" onClick={() => setEditP(p)}>{t('Edit')}</button></>}</td></tr>
          ))}
        </Table></Card>
      ) : (
        <Card pad={false}><Table head={[t('Date'), t('Project'), t('Description'), t('Who'), { label: t('Hours'), right: true }, t('Status'), '']} empty={t('No time logged.')}>
          {data.time.map((tx) => (
            <tr key={tx.id}><td className="td">{date(tx.date)}</td><td className="td">{tx.project_name}</td><td className="td">{tx.description}</td><td className="td">{tx.user_name}</td><td className="td num text-right">{number(tx.hours, 2)}</td>
              <td className="td">{tx.invoice_id ? <Badge status="paid">{t('Invoiced§f')}</Badge> : tx.billable ? <Badge status="partial">{t('To invoice')}</Badge> : <Badge status="draft">{t('Non-billable')}</Badge>}</td>
              <td className="td text-right">{w && !tx.invoice_id && <button className="text-xs text-rose-600 hover:underline" onClick={() => run(async () => { await api.del(`/time/${tx.id}`); reload(); })}>{t('Delete')}</button>}</td></tr>
          ))}
        </Table></Card>
      )}
      {editP && <ProjectModal p={editP.id ? editP : null} contacts={data.contacts.filter((c) => c.kind !== 'vendor')} onClose={() => setEditP(null)} onSaved={() => { setEditP(null); reload(); }} />}
      {timing && <TimeModal projects={active} onClose={() => setTiming(false)} onSaved={() => { setTiming(false); reload(); }} />}
    </>
  );
}
