import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { t } from '../i18n.jsx';
import { api, qs } from '../api.js';
import { addDays, date, fromCents, money, number, toCents, today } from '../format.js';
import { download } from '../csv.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select, Table, Tabs, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const COMPONENT = {
  fit: t('Federal income tax'), ss_ee: t('Social Security (employee)'), ss_er: t('Social Security (employer)'), med_ee: t('Medicare (employee)'),
  med_er: t('Medicare (employer)'), addmed_ee: t('Additional Medicare'), sit: t('State income tax'), futa: t('FUTA (federal unemployment)'),
  suta: t('SUTA (state unemployment)'), deduction: t('Other deductions'),
};
const FEDERAL = ['fit', 'ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee'];
const FREQ = { weekly: t('Weekly'), biweekly: t('Every 2 weeks'), semimonthly: t('Twice a month'), monthly: t('Monthly') };
const DEFAULT_HOURS = { weekly: 40, biweekly: 80, semimonthly: 86.67, monthly: 173.33 };

const errMsg = (e) => e.message;

/* ------------------------------- funcionários ------------------------------ */
function EmployeeModal({ emp, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: '', email: '', tax_id: '', position: '', hire_date: today(), pay_basis: 'year', pay_rate: '', frequency: 'biweekly', filing_status: 'single', credits: '0',
    extra_withholding: '0', state_pct: '0', pretax_deduction: '0', other_deduction: '0', other_deduction_label: '', active: true,
    ...(emp ? { ...emp, pay_rate: fromCents(emp.pay_rate), credits: fromCents(emp.credits), extra_withholding: fromCents(emp.extra_withholding), pretax_deduction: fromCents(emp.pretax_deduction), other_deduction: fromCents(emp.other_deduction), active: !!emp.active } : {}) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async () => {
    const body = { ...f, pay_rate: toCents(f.pay_rate), credits: toCents(f.credits), extra_withholding: toCents(f.extra_withholding), pretax_deduction: toCents(f.pretax_deduction), other_deduction: toCents(f.other_deduction), state_pct: Number(f.state_pct) || 0 };
    const r = await run(() => (emp ? api.put(`/payroll/employees/${emp.id}`, body) : api.post('/payroll/employees', body)), t('Employee saved'));
    if (r) onSaved();
  };
  return (
    <Modal wide title={emp ? t('Edit employee') : t('New employee')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy} onClick={save}>{t('Save')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t('Name')} className="md:col-span-2"><Input autoFocus value={f.name} onChange={set('name')} /></Field>
        <Field label={t('Job title')}><Input value={f.position} onChange={set('position')} /></Field>
        <Field label={t('Email')}><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label={t('SSN / Tax ID')} hint={t('Stored only in your own database')}><Input value={f.tax_id} onChange={set('tax_id')} /></Field>
        <Field label={t('Hire date')}><Input type="date" value={f.hire_date} onChange={set('hire_date')} /></Field>
        <Field label={t('Pay type')}><Select value={f.pay_basis} onChange={set('pay_basis')}><option value="year">{t('Annual salary')}</option><option value="hour">{t('Hourly')}</option></Select></Field>
        <Field label={f.pay_basis === 'year' ? t('Annual salary') : t('Hourly rate')}><Input inputMode="decimal" value={f.pay_rate} onChange={set('pay_rate')} /></Field>
        <Field label={t('Pay frequency')}><Select value={f.frequency} onChange={set('frequency')}>{Object.entries(FREQ).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
        <Field label={t('Federal filing status (W-4)')}><Select value={f.filing_status} onChange={set('filing_status')}><option value="single">{t('Single or married filing separately')}</option><option value="married">{t('Married filing jointly')}</option></Select></Field>
        <Field label={t('W-4 step 3: yearly credits')} hint={t('e.g. child tax credit')}><Input inputMode="decimal" value={f.credits} onChange={set('credits')} /></Field>
        <Field label={t('Extra withholding per paycheck')}><Input inputMode="decimal" value={f.extra_withholding} onChange={set('extra_withholding')} /></Field>
        <Field label={t('State income tax rate (%)')} hint={t('Flat estimate; check your state')}><Input inputMode="decimal" value={f.state_pct} onChange={set('state_pct')} /></Field>
        <Field label={t('Pre-tax deduction per paycheck')} hint={t('e.g. 401(k): lowers income tax only')}><Input inputMode="decimal" value={f.pretax_deduction} onChange={set('pretax_deduction')} /></Field>
        <Field label={t('After-tax deduction per paycheck')}><Input inputMode="decimal" value={f.other_deduction} onChange={set('other_deduction')} /></Field>
        <Field label={t('After-tax deduction label')}><Input value={f.other_deduction_label} onChange={set('other_deduction_label')} placeholder={t('e.g. Health plan')} /></Field>
        {emp && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.active} onChange={set('active')} /> {t('Active employee')}</label>}
      </div>
    </Modal>
  );
}

function Employees() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/payroll/employees'));
  const [edit, setEdit] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  return (
    <>
      {can('payroll', true) && <div className="mb-3 flex justify-end"><Button onClick={() => setEdit({})}>{t('+ New employee')}</Button></div>}
      <Card pad={false}>
        <Table head={[t('Name'), t('Job title'), t('Pay'), t('Frequency'), t('Filing status'), t('Status'), '']} empty={t('No employees yet.')}>
          {data.map((e) => (
            <tr key={e.id} className={e.active ? 'hover:bg-slate-50' : 'opacity-50'}>
              <td className="td font-medium">{e.name}</td><td className="td">{e.position}</td>
              <td className="td num">{money(e.pay_rate)}{e.pay_basis === 'hour' ? t('/hour') : t('/year')}</td><td className="td">{FREQ[e.frequency]}</td>
              <td className="td">{e.filing_status === 'married' ? t('Married jointly') : t('Single')}</td><td className="td">{e.active ? <Badge status="paid">{t("Active employee")}</Badge> : <Badge status="void">{t('Inactive')}</Badge>}</td>
              <td className="td text-right">{can('payroll', true) && <button className="text-xs text-brand-700 hover:underline" onClick={() => setEdit(e)}>{t('Edit')}</button>}</td>
            </tr>
          ))}
        </Table>
      </Card>
      {edit && <EmployeeModal emp={edit.id ? edit : null} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </>
  );
}

/* --------------------------------- rodadas -------------------------------- */
function RunEditor({ employees, banks, run: existing, onClose, onSaved }) {
  const [act, busy] = useAction();
  const active = employees.filter((e) => e.active);
  const [f, setF] = useState(() => existing ? { type: existing.type, period_start: existing.period_start, period_end: existing.period_end, pay_date: existing.pay_date, memo: existing.memo || '' }
    : { type: 'regular', period_start: addDays(today(), -13), period_end: today(), pay_date: addDays(today(), 3), memo: '' });
  const [rows, setRows] = useState(() => active.map((e) => {
    const l = existing?.lines.find((x) => x.employee_id === e.id);
    return { employee_id: e.id, include: existing ? !!l : true, hours: l ? String(l.hours) : e.pay_basis === 'hour' ? String(DEFAULT_HOURS[e.frequency]) : '0', overtime_hours: l ? String(l.overtime_hours) : '0',
      bonus: l ? fromCents(l.bonus) : '0', other_earnings: l ? fromCents(l.other_earnings) : '0' };
  }));
  const [bank, setBank] = useState(banks[0]?.id || '');
  const [preview, setPreview] = useState(null);
  const [perr, setPerr] = useState('');
  const body = useMemo(() => ({ id: existing?.id, ...f, lines: rows.filter((r) => r.include).map((r) => ({ employee_id: r.employee_id, hours: Number(r.hours) || 0, overtime_hours: Number(r.overtime_hours) || 0, bonus: toCents(r.bonus), other_earnings: toCents(r.other_earnings) })) }), [f, rows, existing]);
  useEffect(() => {
    if (!body.lines.length) { setPreview(null); setPerr(''); return; }
    const h = setTimeout(() => api.post('/payroll/preview', body).then((p) => { setPreview(p); setPerr(''); }).catch((e) => { setPreview(null); setPerr(errMsg(e)); }), 250);
    return () => clearTimeout(h);
  }, [body]);
  const setRow = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const calc = (id) => preview?.lines.find((l) => l.employee_id === id);
  const save = async (finalize) => {
    const saved = await act(() => (existing ? api.put(`/payroll/runs/${existing.id}`, body) : api.post('/payroll/runs', body)));
    if (!saved) return;
    if (finalize) { const done = await act(() => api.post(`/payroll/runs/${saved.id}/finalize`, { paid_from_id: Number(bank) }), t('Payroll finalized')); if (!done) { onSaved(); return; } } else await act(async () => 0, t('Draft saved'));
    onSaved();
  };
  return (
    <Modal wide title={existing ? t('Edit pay run') : t('New pay run')} onClose={onClose} footer={<>
      <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
      <Button variant="ghost" disabled={busy || !preview} onClick={() => save(false)}>{t('Save draft')}</Button>
      <Button disabled={busy || !preview || !bank} onClick={() => confirm(t('Finalize this payroll? It posts the accounting entries and cannot be edited afterwards.')) && save(true)}>{t('Finalize payroll')}</Button></>}>
      <div className="grid gap-3 md:grid-cols-5">
        <Field label={t('Type')}><Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="regular">{t('Regular§run')}</option><option value="bonus">{t('Bonus (supplemental)')}</option></Select></Field>
        <Field label={t('Period start')}><Input type="date" value={f.period_start} onChange={(e) => setF({ ...f, period_start: e.target.value })} /></Field>
        <Field label={t('Period end')}><Input type="date" value={f.period_end} onChange={(e) => setF({ ...f, period_end: e.target.value })} /></Field>
        <Field label={t('Pay date')}><Input type="date" value={f.pay_date} onChange={(e) => setF({ ...f, pay_date: e.target.value })} /></Field>
        <Field label={t('Pay from')}><Select value={bank} onChange={(e) => setBank(e.target.value)}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500"><th className="w-8" /><th className="pb-2">{t('Employee')}</th><th className="w-20 pb-2">{t('Hours')}</th><th className="w-20 pb-2">{t('Overtime')}</th><th className="w-24 pb-2">{t('Bonus')}</th><th className="w-24 pb-2">{t('Other pay')}</th>
            <th className="pb-2 text-right">{t('Gross')}</th><th className="pb-2 text-right">{t('Taxes')}</th><th className="pb-2 text-right">{t('Net pay')}</th></tr></thead>
          <tbody>{rows.map((r, i) => {
            const e = active[i], c = calc(e.id), hourly = e.pay_basis === 'hour', bonusRun = f.type === 'bonus';
            return (
              <tr key={e.id} className={r.include ? '' : 'opacity-40'}>
                <td className="py-1"><input type="checkbox" aria-label={t('Include')} checked={r.include} onChange={(ev) => setRow(i, { include: ev.target.checked })} /></td>
                <td className="py-1 pr-2 font-medium">{e.name}<div className="text-xs font-normal text-slate-400">{money(e.pay_rate)}{hourly ? t('/hour') : t('/year')}</div></td>
                <td className="py-1 pr-2"><Input inputMode="decimal" disabled={!hourly || bonusRun} value={r.hours} onChange={(ev) => setRow(i, { hours: ev.target.value })} aria-label={t('Hours')} /></td>
                <td className="py-1 pr-2"><Input inputMode="decimal" disabled={!hourly || bonusRun} value={r.overtime_hours} onChange={(ev) => setRow(i, { overtime_hours: ev.target.value })} aria-label={t('Overtime')} /></td>
                <td className="py-1 pr-2"><Input inputMode="decimal" value={r.bonus} onChange={(ev) => setRow(i, { bonus: ev.target.value })} aria-label={t('Bonus')} /></td>
                <td className="py-1 pr-2"><Input inputMode="decimal" value={r.other_earnings} onChange={(ev) => setRow(i, { other_earnings: ev.target.value })} aria-label={t('Other pay')} /></td>
                <td className="num py-1 text-right">{r.include && c ? money(c.gross) : '—'}</td><td className="num py-1 text-right text-slate-500">{r.include && c ? money(c.ee_total + c.other_deduction) : '—'}</td><td className="num py-1 text-right font-medium">{r.include && c ? money(c.net) : '—'}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {perr && <div className="mt-3"><ErrorBox error={perr} /></div>}
      {preview && (
        <dl className="mt-4 grid max-w-xl gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between"><dt className="text-slate-500">{t('Gross pay')}</dt><dd className="num font-medium">{money(preview.totals.gross)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">{t('Net pay (cash out)')}</dt><dd className="num font-medium">{money(preview.totals.net)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">{t('Employee taxes withheld')}</dt><dd className="num">{money(preview.totals.employee_taxes)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">{t('Employer taxes (extra cost)')}</dt><dd className="num">{money(preview.totals.employer_taxes)}</dd></div>
          <div className="flex justify-between border-t pt-1 font-semibold sm:col-span-2"><dt>{t('Total payroll cost')}</dt><dd className="num">{money(preview.totals.gross + preview.totals.employer_taxes)}</dd></div>
        </dl>
      )}
      <p className="mt-4 text-xs text-slate-400">{t('Tax calculations follow IRS Publication 15-T (2026) and are estimates to review; Fluxo does not file or deposit taxes for you.')}</p>
    </Modal>
  );
}

function RunView({ runId, onClose }) {
  const { data, loading } = useLoad(() => api.get(`/payroll/runs/${runId}`), [runId]);
  const [stub, setStub] = useState(null);
  if (loading) return <Modal title={t('Pay run')} onClose={onClose}><Loading /></Modal>;
  const r = data;
  const line = stub && r.lines.find((l) => l.id === stub);
  return (
    <Modal wide title={`${t('Pay run')} ${date(r.period_start)} – ${date(r.period_end)}`} onClose={onClose} footer={<Button variant="ghost" onClick={() => window.print()}>{t('Print')}</Button>}>
      {!line ? (
        <>
          <p className="mb-3 text-sm text-slate-500">{t('Pay date')}: {date(r.pay_date)} · <Badge status={r.status} /></p>
          <Table head={[t('Employee'), { label: t('Gross'), right: true }, { label: t('Taxes'), right: true }, { label: t('Net pay'), right: true }, '']}>
            {r.lines.map((l) => (
              <tr key={l.id}><td className="td font-medium">{l.employee_name}</td><td className="td num text-right">{money(l.gross)}</td><td className="td num text-right">{money(l.details.ee_total + l.other_deduction)}</td><td className="td num text-right">{money(l.net)}</td>
                <td className="td text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => setStub(l.id)}>{t('Pay stub')}</button></td></tr>
            ))}
          </Table>
        </>
      ) : (
        <div>
          <button className="no-print mb-3 text-sm text-brand-700 hover:underline" onClick={() => setStub(null)}>← {t('Back')}</button>
          <h4 className="text-lg font-semibold">{t('Pay stub')} — {line.employee_name}</h4>
          <p className="mb-3 text-sm text-slate-500">{date(r.period_start)} – {date(r.period_end)} · {t('Pay date')} {date(r.pay_date)}</p>
          <table className="w-full max-w-md text-sm"><tbody>
            {line.details.regular > 0 && <tr><td className="py-1">{t('Regular pay')}</td><td className="num text-right">{money(line.details.regular)}</td></tr>}
            {line.details.overtime > 0 && <tr><td className="py-1">{t('Overtime')}</td><td className="num text-right">{money(line.details.overtime)}</td></tr>}
            {line.bonus > 0 && <tr><td className="py-1">{t('Bonus')}</td><td className="num text-right">{money(line.bonus)}</td></tr>}
            {line.other_earnings > 0 && <tr><td className="py-1">{t('Other pay')}</td><td className="num text-right">{money(line.other_earnings)}</td></tr>}
            <tr className="border-t font-semibold"><td className="py-1">{t('Gross pay')}</td><td className="num text-right">{money(line.gross)}</td></tr>
            {line.details.ee.map((x) => <tr key={x.code}><td className="py-1 text-slate-600">− {COMPONENT[x.code]}</td><td className="num text-right">{money(x.amount)}</td></tr>)}
            {line.other_deduction > 0 && <tr><td className="py-1 text-slate-600">− {line.details.deduction_label || t('Other deductions')}</td><td className="num text-right">{money(line.other_deduction)}</td></tr>}
            <tr className="border-t text-base font-bold"><td className="py-1.5">{t('Net pay')}</td><td className="num text-right">{money(line.net)}</td></tr>
          </tbody></table>
        </div>
      )}
    </Modal>
  );
}

function Runs() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => {
    const [runs, employees, accounts] = await Promise.all([api.get('/payroll/runs'), api.get('/payroll/employees'), api.get('/banking/accounts')]);
    return { runs, employees, banks: accounts.filter((a) => a.subtype === 'bank') };
  });
  const [editor, setEditor] = useState(null);
  const [viewId, setViewId] = useState(null);
  const [act] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const openEditor = async (id) => { if (!id) return setEditor({}); const r = await act(() => api.get(`/payroll/runs/${id}`)); if (r) setEditor({ run: r }); };
  const hasEmployees = data.employees.some((e) => e.active);
  return (
    <>
      {can('payroll', true) && <div className="mb-3 flex justify-end"><Button disabled={!hasEmployees || !data.banks.length} onClick={() => openEditor()}>{t('+ New pay run')}</Button></div>}
      {!hasEmployees && <p className="mb-3 text-sm text-slate-500">{t('Add your employees first, then run payroll.')}</p>}
      <Card pad={false}>
        <Table head={[t('Pay date'), t('Period'), t('Type'), t('Status'), { label: t('Gross'), right: true }, { label: t('Net pay'), right: true }, { label: t('Employer taxes'), right: true }, '']} empty={t('No pay runs yet.')}>
          {data.runs.map((r) => (
            <tr key={r.id} className="hover:bg-slate-50"><td className="td">{date(r.pay_date)}</td><td className="td">{date(r.period_start)} – {date(r.period_end)}</td><td className="td">{r.type === 'bonus' ? t('Bonus (supplemental)') : t('Regular§run')}</td>
              <td className="td"><Badge status={r.status} /></td><td className="td num text-right">{money(r.gross)}</td><td className="td num text-right">{money(r.net)}</td><td className="td num text-right">{money(r.employer_taxes)}</td>
              <td className="td whitespace-nowrap text-right"><button className="text-xs text-brand-700 hover:underline" onClick={() => setViewId(r.id)}>{t('View')}</button>
                {can('payroll', true) && r.status === 'draft' && <><button className="ml-3 text-xs text-brand-700 hover:underline" onClick={() => openEditor(r.id)}>{t('Edit')}</button>
                  <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Delete this draft?')) && act(async () => { await api.del(`/payroll/runs/${r.id}`); reload(); }, t('Deleted'))}>{t('Delete')}</button></>}
                {can('payroll', true) && r.status === 'final' && <button className="ml-3 text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Void this payroll? Its accounting entries will be reversed.')) && act(async () => { await api.post(`/payroll/runs/${r.id}/void`); reload(); }, t('Payroll voided'))}>{t('Void')}</button>}</td></tr>
          ))}
        </Table>
      </Card>
      {editor && <RunEditor employees={data.employees} banks={data.banks} run={editor.run} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); reload(); }} />}
      {viewId && <RunView runId={viewId} onClose={() => setViewId(null)} />}
    </>
  );
}

/* ----------------------------- impostos a recolher ------------------------- */
function Liabilities() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => { const [liab, accounts, settings] = await Promise.all([api.get('/payroll/liabilities'), api.get('/banking/accounts'), api.get('/settings')]); return { liab, banks: accounts.filter((a) => a.subtype === 'bank'), settings }; });
  const [sel, setSel] = useState(new Set());
  const [bank, setBank] = useState('');
  const [when, setWhen] = useState(today());
  const [act, busy] = useAction();
  const [cfg, setCfg] = useState(null);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const open = data.liab.filter((l) => l.outstanding > 0);
  const total = open.filter((l) => sel.has(l.component)).reduce((s, l) => s + l.outstanding, 0);
  const toggle = (c) => setSel((s) => { const n = new Set(s); n.has(c) ? n.delete(c) : n.add(c); return n; });
  const pick = (list) => setSel(new Set(open.filter((l) => list.includes(l.component)).map((l) => l.component)));
  const c = cfg || { rate: data.settings.payroll_suta_rate, base: data.settings.payroll_suta_base };
  return (
    <>
      <Card title={t('Payroll taxes & deductions owed')} pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3 text-sm">
          <button className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => pick(FEDERAL)}>{t('Select federal deposit (Form 941)')}</button>
          <button className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => pick(['futa'])}>{t('Select FUTA (Form 940)')}</button>
          <button className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => pick(['sit', 'suta'])}>{t('Select state taxes')}</button>
        </div>
        <Table head={['', t('What'), { label: t('Accrued'), right: true }, { label: t('Paid'), right: true }, { label: t('Owed'), right: true }]} empty={t('Nothing owed yet. Finalize a pay run first.')}>
          {data.liab.map((l) => (
            <tr key={l.component}><td className="td w-10"><input type="checkbox" aria-label={t('Select')} disabled={l.outstanding <= 0} checked={sel.has(l.component)} onChange={() => toggle(l.component)} /></td>
              <td className="td">{COMPONENT[l.component]}</td><td className="td num text-right">{money(l.accrued)}</td><td className="td num text-right">{money(l.remitted)}</td><td className="td num text-right font-medium">{money(l.outstanding)}</td></tr>
          ))}
        </Table>
      </Card>
      {can('payroll', true) && open.length > 0 && (
        <Card className="mt-4"><div className="flex flex-wrap items-end gap-3">
          <Field label={t('Pay from')}><Select value={bank || data.banks[0]?.id || ''} onChange={(e) => setBank(e.target.value)}>{data.banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
          <Field label={t('Date')}><Input type="date" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
          <Button disabled={busy || total <= 0} onClick={() => act(async () => { await api.post('/payroll/remit', { account_id: Number(bank || data.banks[0]?.id), date: when, items: open.filter((l) => sel.has(l.component)).map((l) => ({ component: l.component, amount: l.outstanding })) }); setSel(new Set()); reload(); }, t('Tax payment recorded'))}>{t('Record payment')} {total > 0 && `· ${money(total)}`}</Button>
        </div><p className="mt-2 text-xs text-slate-400">{t('This records the payment in your books. Make the actual deposit on EFTPS or your state portal.')}</p></Card>
      )}
      {can('payroll', true) && (
        <Card title={t('State unemployment (SUTA)')} className="mt-4"><div className="flex flex-wrap items-end gap-3">
          <Field label={t('SUTA rate (%)')}><Input inputMode="decimal" value={c.rate} onChange={(e) => setCfg({ ...c, rate: e.target.value })} /></Field>
          <Field label={t('SUTA wage base (per employee, per year)')}><Input inputMode="decimal" value={c.base} onChange={(e) => setCfg({ ...c, base: e.target.value })} /></Field>
          <Button variant="ghost" disabled={busy || !cfg} onClick={() => act(async () => { await api.put('/settings', { payroll_suta_rate: String(Number(c.rate) || 0), payroll_suta_base: String(toCents(c.base)) }); setCfg(null); reload(); }, t('Settings saved'))}>{t('Save')}</Button>
        </div><p className="mt-2 text-xs text-slate-400">{t('Use the rate and wage base from your state notice. Leave at 0 to skip SUTA.')}</p></Card>
      )}
    </>
  );
}

/* --------------------------------- relatórios ------------------------------ */
function Reports() {
  const [kind, setKind] = useState('941');
  const [year, setYear] = useState(new Date().getFullYear());
  const [quarter, setQuarter] = useState(Math.floor(new Date().getMonth() / 3) + 1);
  const url = kind === '941' ? `/payroll/reports/941${qs({ year, quarter })}` : kind === 'w2' ? `/payroll/reports/w2${qs({ year })}` : kind === '1099' ? `/reports/1099${qs({ year })}`
    : `/payroll/reports/summary${qs({ from: `${year}-01-01`, to: `${year}-12-31` })}`;
  const { data: d, loading, error, reload } = useLoad(() => api.get(url), [url]);
  const row = (label, v, bold) => <tr className={bold ? 'border-t bg-slate-50 font-semibold' : ''}><td className="td">{label}</td><td className="td num text-right">{money(v)}</td></tr>;
  return (
    <>
      <div className="no-print mb-4 flex flex-wrap items-end gap-3">
        <Field label={t('Report')}><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="941">{t('Form 941 quarterly summary')}</option><option value="w2">{t('W-2 summary')}</option><option value="summary">{t('Payroll summary')}</option><option value="1099">{t('Contractors (1099)')}</option></Select></Field>
        <Field label={t('Year')}><Input type="number" className="field w-28" value={year} onChange={(e) => setYear(Number(e.target.value) || year)} /></Field>
        {kind === '941' && <Field label={t('Quarter')}><Select value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</Select></Field>}
        <Button variant="ghost" onClick={() => window.print()}>{t('Print / PDF')}</Button>
      </div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (
        <Card pad={false}>
          {kind === '941' && <Table head={[`${t('Form 941')} — ${year} Q${quarter}`, { label: '', right: true }]}>
            {row(t('Employees paid in the quarter: ') + d.employees, d.wages)}
            {row(t('Line 2 — Wages, tips and other compensation'), d.wages)}{row(t('Line 3 — Federal income tax withheld'), d.fit)}
            {row(t('Line 5a — Taxable Social Security wages'), d.ssWages)}{row(t('Line 5a — Social Security tax (12.4%)'), d.ssTax)}
            {row(t('Line 5c — Medicare tax (2.9%)'), d.medTax)}{row(t('Line 5d — Additional Medicare tax withheld'), d.addMed)}
            {row(t('Total taxes before adjustments'), d.totalTax, true)}{row(t('Deposits recorded in this quarter'), d.deposits)}{row(t('Balance due'), d.balance, true)}
          </Table>}
          {kind === 'w2' && <Table head={[t('Employee'), { label: t('Box 1 Wages'), right: true }, { label: t('Box 2 Fed. tax'), right: true }, { label: t('Box 3 SS wages'), right: true }, { label: t('Box 4 SS tax'), right: true }, { label: t('Box 5 Medicare wages'), right: true }, { label: t('Box 6 Medicare tax'), right: true }, { label: t('Box 17 State tax'), right: true }]} empty={t('No finalized payroll in this year.')}>
            {d.rows.map((r) => <tr key={r.employee_id}><td className="td font-medium">{r.name}</td>{[r.box1, r.box2, r.box3, r.box4, r.box5, r.box6, r.box17].map((v, i) => <td key={i} className="td num text-right">{money(v)}</td>)}</tr>)}
          </Table>}
          {kind === 'summary' && <Table head={[t('Employee'), { label: t('Gross'), right: true }, { label: t('Employee taxes'), right: true }, { label: t('Deductions'), right: true }, { label: t('Net pay'), right: true }, { label: t('Employer taxes'), right: true }]} empty={t('No finalized payroll in this year.')}>
            {d.rows.map((r) => <tr key={r.employee_id}><td className="td font-medium">{r.name}</td><td className="td num text-right">{money(r.gross)}</td><td className="td num text-right">{money(r.employee_taxes)}</td><td className="td num text-right">{money(r.deductions)}</td><td className="td num text-right">{money(r.net)}</td><td className="td num text-right">{money(r.employer_taxes)}</td></tr>)}
            {d.rows.length > 0 && <tr className="border-t-2 bg-slate-50 font-semibold"><td className="td">{t('Totals')}</td>{['gross', 'employee_taxes', 'deductions', 'net', 'employer_taxes'].map((k) => <td key={k} className="td num text-right">{money(d.totals[k])}</td>)}</tr>}
          </Table>}
          {kind === '1099' && <>
            <p className="border-b border-slate-100 p-3 text-sm text-slate-500">{t('Contractors flagged for 1099 who were paid at least the reporting threshold:')} <b>{money(d.threshold)}</b></p>
            <Table head={[t('Contractor'), t('Tax ID'), { label: t('Paid in year'), right: true }, t('Status')]} empty={t('No contractors flagged. Mark a vendor as an independent contractor in Vendors.')}>
              {d.rows.map((r) => <tr key={r.id}><td className="td font-medium">{r.name}</td><td className="td">{r.tax_id || <span className="text-rose-600">{t('Missing')}</span>}</td><td className="td num text-right">{money(r.paid)}</td>
                <td className="td">{r.reportable ? <Badge status="partial">{t('File 1099-NEC')}</Badge> : <Badge status="draft">{t('Below threshold')}</Badge>}</td></tr>)}
            </Table></>}
        </Card>
      )}
      <p className="mt-3 text-xs text-slate-400">{t('These figures help you complete IRS forms. Review them with your accountant; Fluxo does not e-file.')}</p>
    </>
  );
}

export default function Payroll() {
  const { tab = 'runs' } = useParams();
  const nav = useNavigate();
  return (
    <>
      <PageHeader title={t('Payroll')} subtitle={t('U.S. payroll: pay runs, withholding, employer taxes, W-2 and 941 summaries')} />
      <Tabs tabs={[['runs', t('Pay runs')], ['employees', t('Employees')], ['taxes', t('Taxes owed')], ['reports', t('Reports')]]} value={tab} onChange={(k) => nav(`/payroll/${k}`)} />
      {tab === 'runs' && <Runs />}{tab === 'employees' && <Employees />}{tab === 'taxes' && <Liabilities />}{tab === 'reports' && <Reports />}
    </>
  );
}
