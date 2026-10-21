// Folha "Plano B": telas de depósito direto (arquivo NACHA), depósitos de impostos federais, formulários (941/940/W-2/EFW2/1099),
// registro dos arquivos gerados, configurações e faixa do vigia das tabelas. O Fluxo calcula e gera; quem paga, envia e assina é a empresa.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { t } from '../i18n.jsx';
import { api, qs, downloadPost } from '../api.js';
import { date, fromCents, money, toCents, today } from '../format.js';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, Select, Table, useAction, useLoad } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';

const useOwner = () => useAuth().user.role === 'owner';
const FEDERAL_ONLY = () => t('Federal only in this version: state payroll taxes are calculated for your records, but Fluxo does not create state files or deposits.');

/** Itens que faltam (vêm do servidor em inglês) → texto traduzido. */
export function problemText(p) {
  const pats = [[/^SSN of (.+)$/, 'SSN of {0}'], [/^Address of (.+) \(use "street, city, ST 12345"\)$/, 'Address of {0} (use "street, city, ST 12345")'], [/^Address of (.+)$/, 'Address of {0}'], [/^TIN of (.+)$/, 'TIN of {0}']];
  for (const [re, key] of pats) { const m = p.match(re); if (m) return t(key, [m[1]]); }
  return t(p);
}
const Problems = ({ list }) => (list?.length ? (
  <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
    <div className="font-medium">{t('Complete this first:')}</div>
    <ul className="mt-1 list-disc pl-5">{list.map((p) => <li key={p} className="break-words">{problemText(p)}</li>)}</ul>
    <Link to="/settings/payroll" className="mt-2 inline-block text-brand-700 underline">{t('Open Settings > Payroll')}</Link>
  </div>) : null);

/** Tabela no computador e cartões abaixo de 1024 px (lição L-002: nada de coluna escondida atrás de rolagem no celular).
 *  rows: [{ key, cells: [nó,…], attrs }]; a 1ª célula é o título do cartão; coluna com título '' (ações) fica embaixo, sem rótulo. */
export function RTable({ head, rows, empty }) {
  const label = (h) => (typeof h === 'string' ? h : h.label);
  return (<>
    <div className="hidden lg:block"><Table head={head} empty={empty}>
      {rows.map((r) => <tr key={r.key} {...(r.attrs || {})}>{r.cells.map((c, i) => <td key={i} className={`td ${head[i]?.right ? 'num text-right' : ''} ${i === 0 ? 'font-medium' : ''} ${label(head[i]) === '' ? 'whitespace-nowrap text-right' : ''}`}>{c}</td>)}</tr>)}
    </Table></div>
    <ul className="divide-y divide-slate-100 lg:hidden">
      {rows.length === 0 && <li className="p-6 text-center text-sm text-slate-400">{empty}</li>}
      {rows.map((r) => (
        <li key={r.key} className="p-3" {...(r.attrs || {})}>
          <div className="min-w-0 break-words font-medium text-slate-900">{r.cells[0]}</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            {r.cells.slice(1).map((c, i) => label(head[i + 1]) === '' ? null : (
              <div key={i} className="min-w-0"><dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label(head[i + 1])}</dt><dd className="min-w-0 break-words">{c}</dd></div>))}
          </dl>
          {r.cells.map((c, i) => (label(head[i]) === '' && i > 0 ? <div key={`a${i}`} className="mt-2 flex flex-wrap items-center gap-2">{c}</div> : null))}
        </li>))}
    </ul>
  </>);
}

/** Caixa obrigatória "conferi os valores" antes de qualquer arquivo. */
export function ReviewCheck({ checked, onChange, label }) {
  return (
    <label className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
      <input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid="review-check" />
      <span>{label || t('I reviewed the amounts and I am responsible for them.')}</span>
    </label>
  );
}

/* ------------------------------------ faixa do vigia das tabelas ------------------------------------ */
export function TaxTableBanner() {
  const owner = useOwner();
  const { data } = useLoad(() => api.get('/payroll/tax-tables').catch(() => null));
  if (!owner || !data?.banner) return null;
  const y = data.banner.year;
  return (
    <div className="no-print mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="alert" data-testid="tax-table-banner">
      <b>{data.banner.reason === 'missing' ? t('Fluxo does not have the {0} IRS payroll tax tables yet. Payroll dated in {0} cannot be finalized until Fluxo is updated.', [y]) : t('New IRS tables published for {0} — Fluxo must be updated before the first {0} payroll.', [y])}</b>
      <span className="ml-1">{t('Fluxo never changes tax numbers by itself; the update is reviewed and published by the Fluxo team.')}</span>
    </div>
  );
}

/* ----------------------------------- funcionário: endereço e banco ----------------------------------- */
export const BOX12 = () => [['D', t('D — 401(k)')], ['E', t('E — 403(b)')], ['G', t('G — 457(b)')], ['AA', t('AA — Roth 401(k)')], ['BB', t('BB — Roth 403(b)')], ['', t('None (not a retirement plan)')]];
export function EmployeeExtraFields({ f, set }) {
  return (<>
    <Field label={t('Street address')} className="md:col-span-2" hint={t('Needed for the W-2')}><Input value={f.address || ''} onChange={set('address')} /></Field>
    <Field label={t('City')}><Input value={f.city || ''} onChange={set('city')} /></Field>
    <Field label={t('State (2 letters)')}><Input maxLength={2} value={f.state || ''} onChange={set('state')} /></Field>
    <Field label={t('ZIP code')}><Input inputMode="numeric" value={f.zip || ''} onChange={set('zip')} /></Field>
    <Field label={t('W-2 box 12 code for the pre-tax deduction')}><Select value={f.w2_box12_code ?? 'D'} onChange={set('w2_box12_code')}>{BOX12().map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
  </>);
}

/** Depósito direto do funcionário: só o dono vê e edita (roteamento com dígito verificador; conta cifrada, só o final aparece). */
export function EmployeeBankCard({ emp, onChanged }) {
  const owner = useOwner();
  const [act, busy] = useAction();
  const { data, loading, reload } = useLoad(() => (owner && emp?.id ? api.get(`/payroll/employees/${emp.id}/bank`) : Promise.resolve(null)), [emp?.id, owner]);
  const [f, setF] = useState(null);
  if (!emp?.id) return <p className="text-xs text-slate-500 md:col-span-3">{t('Save the employee first, then add the direct deposit account.')}</p>;
  if (!owner) return <p className="text-xs text-slate-500 md:col-span-3" data-testid="bank-status">{emp.has_bank ? t('Direct deposit account on file.') : t('No direct deposit account: this employee is paid by check.')} {t('Only the account owner can see or change bank details.')}</p>;
  if (loading) return <Loading />;
  const v = f || { routing: data?.routing || '', account: data?.account_mask || '', type: data?.type || 'checking' };
  const set = (k) => (e) => setF({ ...v, [k]: e.target.value });
  const save = async () => { const r = await act(() => api.put(`/payroll/employees/${emp.id}/bank`, v), t('Bank details saved')); if (r) { setF(null); reload(); onChanged?.(); } };
  const remove = async () => { if (!confirm(t('Remove the direct deposit account? This employee will be paid by check.'))) return; const r = await act(() => api.del(`/payroll/employees/${emp.id}/bank`), t('Removed')); if (r) { setF(null); reload(); onChanged?.(); } };
  return (
    <div className="rounded-lg border border-slate-200 p-3 md:col-span-3" data-testid="bank-card">
      <div className="mb-2 text-sm font-semibold text-slate-700">{t('Direct deposit account')}</div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label={t('Routing number (9 digits)')}><Input inputMode="numeric" maxLength={9} value={v.routing} onChange={set('routing')} data-testid="bank-routing" /></Field>
        <Field label={t('Account number')} hint={data?.account_mask ? t('Saved encrypted. Type a new number only to change it.') : t('Saved encrypted. Only the last 4 digits are shown.')}><Input inputMode="numeric" value={v.account} onFocus={() => v.account.includes('*') && setF({ ...v, account: '' })} onChange={set('account')} data-testid="bank-account" /></Field>
        <Field label={t('Account type')}><Select value={v.type} onChange={set('type')}><option value="checking">{t('Checking')}</option><option value="savings">{t('Savings')}</option></Select></Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" variant="ghost" disabled={busy || !f} onClick={save} data-testid="bank-save">{t('Save bank details')}</Button>
        {data?.has_bank && <Button type="button" variant="danger" disabled={busy} onClick={remove}>{t('Remove account')}</Button>}
      </div>
    </div>
  );
}

/* ------------------------------------------- arquivo NACHA ------------------------------------------- */
export function NachaModal({ runId, onClose }) {
  const owner = useOwner();
  const { data, loading, error, reload } = useLoad(() => api.get(`/payroll/runs/${runId}/nacha`), [runId]);
  const [ok, setOk] = useState(false);
  const [eff, setEff] = useState('');
  const [ext, setExt] = useState('ach');
  const [act, busy] = useAction();
  const gen = () => act(() => downloadPost(`/payroll/runs/${runId}/nacha`, { reviewed: true, effective_date: eff || data.run.pay_date, ext }, 'direct-deposit.ach'), t('Bank file downloaded'));
  return (
    <Modal wide title={t('Direct deposit file (NACHA)')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Close')}</Button>{data && owner && <Button disabled={busy || !ok || !data.rows.some((r) => r.method === 'deposit') || !data.configured} onClick={gen} data-testid="nacha-download">{t('Download bank file')}</Button>}</>}>
      {loading ? <Loading /> : error ? <ErrorBox error={error} retry={reload} /> : (<>
        <p className="mb-3 rounded-lg bg-brand-50 p-3 text-sm font-medium text-brand-800" data-testid="nacha-notice">{t("Upload this file to your bank's ACH/Direct deposit portal. Fluxo does not send money.")}</p>
        {!data.configured && <Problems list={[t('Bank file settings (company EIN and your bank routing number)')]} />}
        <RTable head={[t('Employee'), { label: t('Net pay'), right: true }, t('How')]} rows={data.rows.map((r) => ({ key: r.employee_id, cells: [r.name, money(r.net),
          r.method === 'deposit' ? <span>{t('Direct deposit')} <span className="text-slate-500">{r.account_mask} · {r.type === 'savings' ? t('Savings') : t('Checking')}</span></span> : <Badge status="partial">{t('Pay by check')}</Badge>] }))} />
        <dl className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-2"><dt className="text-slate-500">{t('In the bank file')}</dt><dd className="num font-semibold">{money(data.deposit_total)}</dd></div>
          <div className="flex justify-between gap-2"><dt className="text-slate-500">{t('Pay by check (not in the file)')}</dt><dd className="num font-semibold">{money(data.check_total)}</dd></div>
        </dl>
        {owner ? (<div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label={t('Effective entry date (pay date)')} hint={t('The day the money should reach the employees. Most banks need the file 1–2 business days before.')}><Input type="date" value={eff || data.run.pay_date} onChange={(e) => setEff(e.target.value)} data-testid="nacha-date" /></Field>
          <Field label={t('File type')}><Select value={ext} onChange={(e) => setExt(e.target.value)}><option value="ach">.ach</option><option value="txt">.txt</option></Select></Field>
          <div className="sm:col-span-2"><ReviewCheck checked={ok} onChange={setOk} label={t('I reviewed the amounts. I will upload this file to my bank myself.')} /></div>
          <p className="text-xs text-slate-500 sm:col-span-2">{data.balanced ? t('Balanced file: it includes the matching debit from your company account.') : t('Unbalanced file (credits only): your bank takes the money from your account. You can change this in Settings > Payroll.')}</p>
        </div>) : <p className="mt-4 text-sm text-slate-500">{t('Only the account owner can generate the bank file, because it contains account numbers.')}</p>}
      </>)}
    </Modal>
  );
}

/* ------------------------------------- depósitos de impostos ------------------------------------- */
const reasonText = (s) => {
  const v = [money(s.lookback?.total || 0), date(s.lookback?.from), date(s.lookback?.to)];
  if (s.reason === 'first_year') return t('New employer (no payroll in the lookback period): monthly.');
  if (s.reason === 'lookback') return t('Lookback period tax: {0} ({1} to {2}). Up to $50,000 = monthly; more = semiweekly.', v);
  if (s.reason === 'lookback_manual') return t('Lookback period tax entered in Settings: {0}. Up to $50,000 = monthly; more = semiweekly.', v);
  return t('Chosen in Settings > Payroll.');
};
const SCHED = () => ({ monthly: t('Monthly'), semiweekly: t('Semiweekly'), next_day: t('Next business day ($100,000 rule)'), quarterly: t('Quarterly') });

function PayModal({ d, banks, onClose, onDone }) {
  const [f, setF] = useState({ paid_date: today(), account_id: banks[0]?.id || '', eftps_confirmation: '', receipt: null, receipt_name: '' });
  const [act, busy] = useAction();
  const file = (e) => { const x = e.target.files[0]; if (!x) return; if (x.size > 2_000_000) { alert(t('The receipt must be a PNG, JPEG, WebP or PDF under 2 MB')); e.target.value = ''; return; } const r = new FileReader(); r.onload = () => setF((v) => ({ ...v, receipt: r.result, receipt_name: x.name })); r.readAsDataURL(x); };
  const save = async () => { const r = await act(() => api.post('/payroll/deposits/pay', { key: d.key, ...f, account_id: Number(f.account_id) }), t('Deposit marked as paid')); if (r) onDone(); };
  return (
    <Modal title={t('Mark as paid')} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button><Button disabled={busy || !f.account_id} onClick={save} data-testid="pay-save">{t('Mark as paid')}</Button></>}>
      <p className="mb-3 text-sm text-slate-600">{d.kind === 'futa' ? t('FUTA deposit') : t('Federal tax deposit (Form 941)')} · {d.period} · <b>{money(d.amount)}</b></p>
      <div className="grid gap-3">
        <Field label={t('Date you paid on EFTPS')}><Input type="date" value={f.paid_date} max={today()} onChange={(e) => setF({ ...f, paid_date: e.target.value })} /></Field>
        <Field label={t('Paid from')}><Select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>
        <Field label={t('EFTPS confirmation number (optional)')}><Input value={f.eftps_confirmation} maxLength={40} onChange={(e) => setF({ ...f, eftps_confirmation: e.target.value })} data-testid="pay-eftps" /></Field>
        <Field label={t('Receipt (optional: PDF or image, up to 2 MB)')}><input type="file" accept="application/pdf,image/png,image/jpeg,image/webp" className="text-sm" onChange={file} aria-label={t('Receipt')} /></Field>
      </div>
      <p className="mt-3 text-xs text-slate-500">{t('This records the payment in your books (it lowers Payroll Liabilities). It does not pay anything.')}</p>
    </Modal>
  );
}

export function Deposits() {
  const { can } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => { const [d, accounts] = await Promise.all([api.get('/payroll/deposits'), api.get('/banking/accounts').catch(() => [])]); return { ...d, banks: accounts.filter((a) => a.subtype === 'bank') }; });
  const [pay, setPay] = useState(null);
  const [act, busy] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const S = SCHED();
  const receipt = async (id) => { const r = await act(() => api.get(`/payroll/deposits/${id}/receipt`)); if (!r) return; const a = document.createElement('a'); a.href = r.receipt; a.download = r.name || 'receipt'; document.body.appendChild(a); a.click(); a.remove(); };
  return (<>
    <div className="mb-4 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-900" data-testid="eftps-notice">
      <b>{t('Pay at EFTPS.gov — Fluxo does not pay taxes for you.')}</b> <a className="underline" href="https://www.eftps.gov" target="_blank" rel="noreferrer">EFTPS.gov</a>
      <div className="mt-1 text-xs">{t('Amounts: federal income tax withheld + Social Security and Medicare (employee and employer). Reminders appear in the bell 3 days before and on the due date.')}</div>
    </div>
    {data.schedules.length > 0 && <Card title={t('Deposit schedule')} className="mb-4"><ul className="space-y-1 text-sm">{data.schedules.map((s) => (
      <li key={s.year}><b>{s.year}: {S[s.schedule]}</b> — <span className="text-slate-600">{reasonText(s)}</span></li>))}</ul>
      <p className="mt-2 text-xs text-slate-500">{t('If you used another payroll provider before Fluxo, enter the lookback amount in Settings > Payroll so the schedule is right.')}</p></Card>}
    <Card pad={false}>
      <RTable head={[t('Period'), t('Tax'), { label: t('Amount'), right: true }, t('Due date'), t('Status'), '']} empty={t('No deposits yet. Finalize a pay run first.')}
        rows={data.deposits.map((d) => ({ key: d.key, attrs: { 'data-deposit': d.key }, cells: [
          <><div>{d.period || '—'}</div><div className="text-xs font-normal text-slate-500">{S[d.schedule] || ''}</div>
            {d.next_day && <div className="text-xs font-medium text-rose-700">{t('$100,000 rule: deposit by the next business day. You are now a semiweekly depositor.')}</div>}
            {d.small_quarter && <div className="text-xs font-normal text-slate-500">{t('Quarter under $2,500: you may pay this with Form 941 instead of depositing.')}</div>}
            {d.with_return && <div className="text-xs font-normal text-slate-500">{t('$500 or less: you may pay this with Form 940.')}</div>}
            {d.in_progress && <div className="text-xs font-normal text-slate-500">{t('Quarter still open: the amount can grow.')}</div>}
            {d.payment?.differs && <div className="text-xs font-normal text-amber-700">{t('The amount changed after it was marked as paid ({0}). Check it.', [money(d.payment.amount)])}</div>}</>,
          d.kind === 'futa' ? 'FUTA (940)' : 'Form 941',
          money(d.amount),
          <span className="whitespace-nowrap">{date(d.due_date)}{d.due_soon && <div className="text-xs font-medium text-amber-700">{t('Due soon')}</div>}</span>,
          d.status === 'paid' ? <span><Badge status="paid">{t('Paid§deposit')}</Badge><div className="text-xs text-slate-500">{date(d.payment.paid_date)}{d.payment.eftps_confirmation ? ` · #${d.payment.eftps_confirmation}` : ''}</div></span> : d.status === 'overdue' ? <Badge status="overdue">{t('Overdue§deposit')}</Badge> : <Badge status="open">{t('Pending')}</Badge>,
          <>{d.status !== 'paid' && can('payroll', true) && !d.orphan && <Button variant="ghost" onClick={() => setPay(d)} data-testid="mark-paid">{t('Mark as paid')}</Button>}
            {d.payment?.has_receipt && <button className="ml-2 text-xs text-brand-700 hover:underline" onClick={() => receipt(d.payment.id)}>{t('Receipt')}</button>}
            {d.status === 'paid' && can('payroll', true) && <button className="ml-2 text-xs text-rose-600 hover:underline" disabled={busy} onClick={() => confirm(t('Undo this payment? The accounting entry is removed.')) && act(async () => { await api.del(`/payroll/deposits/${d.payment.id}`); reload(); }, t('Payment removed'))}>{t('Undo')}</button>}</>,
        ] }))} />
    </Card>
    <p className="mt-3 text-xs text-slate-500">{FEDERAL_ONLY()}</p>
    {pay && <PayModal d={pay} banks={data.banks} onClose={() => setPay(null)} onDone={() => { setPay(null); reload(); }} />}
  </>);
}

/* ----------------------------------------------- formulários ----------------------------------------------- */
const thisYear = new Date().getFullYear();
const YearSelect = ({ value, onChange }) => <Field label={t('Year')}><Select value={value} onChange={(e) => onChange(Number(e.target.value))}>{[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}</Select></Field>;
const LineList = ({ rows }) => (
  <dl className="divide-y divide-slate-100 text-sm">{rows.map(([line, label, v]) => (
    <div key={line + label} className="flex items-start gap-3 py-1.5"><dt className="w-12 shrink-0 font-semibold text-slate-500">{line}</dt><dd className="min-w-0 flex-1 break-words text-slate-700">{label}</dd>{typeof v === 'number' ? <dd className="num shrink-0 text-right font-medium">{money(v)}</dd> : <dd className="min-w-0 max-w-[50%] break-words text-right font-medium">{v}</dd>}</div>))}</dl>);
const SIGN = () => t('Review, sign and file it yourself (paper or your e-file provider).');
const WORKSHEET = () => t('Worksheet PDF: the official IRS fillable PDF is not built into Fluxo yet, so this PDF lists each line number of the official form with its amount for you to transcribe.');

function GenerateBar({ ok, setOk, onGenerate, busy, label, testid, disabled }) {
  return (<div className="mt-3 space-y-2"><ReviewCheck checked={ok} onChange={setOk} />
    <Button disabled={busy || !ok || disabled} onClick={onGenerate} data-testid={testid}>{label}</Button></div>);
}

function Form941Card() {
  const [y, setY] = useState(thisYear); const [q, setQ] = useState(Math.floor(new Date().getMonth() / 3) + 1);
  const { data: f, loading, error } = useLoad(() => api.get(`/payroll/forms/941${qs({ year: y, quarter: q })}`), [y, q]);
  const [ok, setOk] = useState(false); const [act, busy] = useAction();
  const L = f?.lines;
  const part2 = L && (L[16] === 'small' ? t('Box 1: less than $2,500 this quarter') : L[16] === 'monthly' ? t('Box 2: monthly depositor') : t('Box 3: semiweekly depositor (Schedule B attached)'));
  return (
    <Card title={t('Form 941 — quarterly federal tax return')} className="mb-4">
      <div className="mb-3 flex flex-wrap items-end gap-3"><YearSelect value={y} onChange={(v) => { setY(v); setOk(false); }} /><Field label={t('Quarter')}><Select value={q} onChange={(e) => { setQ(Number(e.target.value)); setOk(false); }}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>Q{n}</option>)}</Select></Field></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (<>
        <LineList rows={[['1', t('Employees paid (pay period including the 12th)'), String(L[1])], ['2', t('Wages, tips and other compensation'), L[2]], ['3', t('Federal income tax withheld'), L[3]],
          ['5a', t('Social Security wages × 12.4%'), L['5a2']], ['5c', t('Medicare wages × 2.9%'), L['5c2']], ['5d', t('Additional Medicare wages × 0.9%'), L['5d2']], ['5e', t('Total Social Security and Medicare'), L['5e']],
          ['6', t('Total taxes before adjustments'), L[6]], ['7', t('Adjustment for fractions of cents'), L[7]], ['10', t('Total taxes after adjustments'), L[10]], ['12', t('Total taxes after credits'), L[12]],
          ['13', t('Deposits recorded in Fluxo'), L[13]], ['14', t('Balance due'), L[14]], ['15', t('Overpayment'), L[15]], ['16', t('Part 2'), part2],
          ...(L[16] === 'monthly' ? [['', t('Month 1'), L['16m1']], ['', t('Month 2'), L['16m2']], ['', t('Month 3'), L['16m3']]] : [])]} />
        <p className="mt-3 text-xs text-slate-500">{f.official ? t('Uses the official IRS fillable PDF.') : WORKSHEET()}</p>
        <p className="mt-1 text-sm font-medium text-slate-700">{SIGN()}</p>
        <GenerateBar ok={ok} setOk={setOk} busy={busy} testid="dl-941" label={t('Download Form 941 PDF')} onGenerate={() => act(() => downloadPost('/payroll/forms/941', { year: y, quarter: q, reviewed: true }, 'form-941.pdf'), t('Downloaded'))} />
      </>)}
    </Card>
  );
}

function Form940Card() {
  const [y, setY] = useState(thisYear);
  const { data: f, loading, error } = useLoad(() => api.get(`/payroll/forms/940${qs({ year: y })}`), [y]);
  const [ok, setOk] = useState(false); const [act, busy] = useAction();
  const L = f?.lines;
  return (
    <Card title={t('Form 940 — annual federal unemployment (FUTA) return')} className="mb-4">
      <div className="mb-3 flex flex-wrap items-end gap-3"><YearSelect value={y} onChange={(v) => { setY(v); setOk(false); }} /></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (<>
        <LineList rows={[['1a', t('State where you paid state unemployment tax'), L['1a'] || '—'], ['3', t('Total payments to all employees'), L[3]], ['5', t('Payments above $7,000 per employee'), L[5]], ['7', t('Taxable FUTA wages'), L[7]],
          ['8', t('FUTA tax (0.6%)'), L[8]], ['12', t('Total FUTA tax after adjustments'), L[12]], ['13', t('FUTA deposits recorded in Fluxo'), L[13]], ['14', t('Balance due'), L[14]],
          ['16a', 'Q1', L['16a']], ['16b', 'Q2', L['16b']], ['16c', 'Q3', L['16c']], ['16d', 'Q4', L['16d']], ['17', t('Total for the year (must equal line 12)'), L[17]]]} />
        <p className="mt-3 text-xs text-slate-500">{WORKSHEET()} {t('Credit-reduction states (Schedule A) are not modeled: check the IRS list.')}</p>
        <p className="mt-1 text-sm font-medium text-slate-700">{SIGN()}</p>
        <GenerateBar ok={ok} setOk={setOk} busy={busy} testid="dl-940" label={t('Download Form 940 PDF')} onGenerate={() => act(() => downloadPost('/payroll/forms/940', { year: y, reviewed: true }, 'form-940.pdf'), t('Downloaded'))} />
      </>)}
    </Card>
  );
}

function W2Card() {
  const owner = useOwner();
  const [y, setY] = useState(thisYear);
  const { data: d, loading, error } = useLoad(() => api.get(`/payroll/forms/w2${qs({ year: y })}`), [y]);
  const [ok, setOk] = useState(false); const [ok2, setOk2] = useState(false); const [act, busy] = useAction();
  return (
    <Card title={t('W-2 and W-3')} className="mb-4">
      <div className="mb-3 flex flex-wrap items-end gap-3"><YearSelect value={y} onChange={(v) => { setY(v); setOk(false); setOk2(false); }} /></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (<>
        <Problems list={d.problems} />
        <RTable head={[t('Employee'), { label: t('Box 1 Wages'), right: true }, { label: t('Box 2 Fed. tax'), right: true }, { label: t('Box 3 SS wages'), right: true }, { label: t('Box 4 SS tax'), right: true }, { label: t('Box 5 Medicare wages'), right: true }, { label: t('Box 6 Medicare tax'), right: true }, t('Box 12')]} empty={t('No finalized payroll in this year.')}
          rows={d.rows.map((r) => ({ key: r.employee_id, cells: [<>{r.name}<div className="text-xs font-normal text-slate-500">{r.ssn_masked}</div></>, ...[r.box1, r.box2, r.box3, r.box4, r.box5, r.box6].map((v) => money(v)), r.box12.map((x) => `${x.code} ${money(x.amount)}`).join(', ') || '—'] }))} />
        <p className="mt-3 text-xs text-slate-500">{t('Employee copies are worksheets (the official W-2 must be issued on the official form or an approved substitute). The W-3 totals are on the last page.')}</p>
        <GenerateBar ok={ok} setOk={setOk} busy={busy} testid="dl-w2" disabled={!d.rows.length} label={t('Download W-2 / W-3 PDF')} onGenerate={() => act(() => downloadPost('/payroll/forms/w2', { year: y, reviewed: true }, 'w2.pdf'), t('Downloaded'))} />
        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="text-sm font-semibold text-slate-700">{t('EFW2 file for SSA Business Services Online')}</div>
          <p className="mt-1 text-sm text-slate-600">{t('Upload it yourself at the SSA Business Services Online (BSO) website. Before the first real use, check the file with the free SSA AccuWage tool.')}</p>
          {owner ? (<><Problems list={d.efw2Problems.filter((p) => !d.problems.includes(p))} />
            <GenerateBar ok={ok2} setOk={setOk2} busy={busy} testid="dl-efw2" disabled={d.efw2Problems.length > 0} label={t('Download EFW2 file')} onGenerate={() => act(() => downloadPost('/payroll/forms/efw2', { year: y, reviewed: true }, 'W2REPORT.txt'), t('Downloaded'))} /></>)
            : <p className="mt-2 text-xs text-slate-500">{t('Only the account owner can generate this file, because it contains full Social Security numbers.')}</p>}
        </div>
      </>)}
    </Card>
  );
}

function Nec1099Card() {
  const owner = useOwner();
  const [y, setY] = useState(thisYear);
  const { data: d, loading, error } = useLoad(() => api.get(`/payroll/forms/1099${qs({ year: y })}`), [y]);
  const [ok, setOk] = useState(false); const [ok2, setOk2] = useState(false); const [act, busy] = useAction();
  const problems = d ? [...(d.rows.some((r) => r.missingTaxId) ? d.rows.filter((r) => r.missingTaxId).map((r) => `TIN of ${r.name}`) : []), ...d.rows.filter((r) => !r.address.city || !r.address.state || !r.address.zip).map((r) => `Address of ${r.name} (use "street, city, ST 12345")`)] : [];
  return (
    <Card title={t('1099-NEC for contractors')} className="mb-4">
      <div className="mb-3 flex flex-wrap items-end gap-3"><YearSelect value={y} onChange={(v) => { setY(v); setOk(false); setOk2(false); }} /></div>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : (<>
        <p className="mb-3 text-sm text-slate-600">{t('Contractors paid at least {0} in {1} (bank transfer, check or cash).', [money(d.threshold), y])}</p>
        <Problems list={problems} />
        <RTable head={[t('Contractor'), t('Tax ID'), { label: t('Box 1 Nonemployee compensation'), right: true }]} empty={t('No contractor reached the 1099 threshold this year.')}
          rows={d.rows.map((r) => ({ key: r.id, cells: [r.name, r.tin_masked || <span className="text-rose-600">{t('Missing')}</span>, money(r.box1)] }))} />
        <p className="mt-3 text-xs text-slate-500">{t('1099-MISC (rents, royalties, other income) is not generated: Fluxo does not classify those payments yet.')}</p>
        <GenerateBar ok={ok} setOk={setOk} busy={busy} testid="dl-1099pdf" disabled={!d.rows.length} label={t('Download recipient copies (PDF)')} onGenerate={() => act(() => downloadPost('/payroll/forms/1099-nec', { year: y, reviewed: true }, '1099-nec.pdf'), t('Downloaded'))} />
        <div className="mt-5 border-t border-slate-100 pt-4">
          <div className="text-sm font-semibold text-slate-700">{t('CSV for the IRS IRIS Taxpayer Portal')} <span className="ml-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800" data-testid="iris-beta">{t('beta — verify against the current IRIS template before uploading')}</span></div>
          <p className="mt-1 text-sm text-slate-600">{t('Upload and file it yourself in the IRIS Taxpayer Portal. Compare the columns with the template you download from IRIS first.')}</p>
          {owner ? <GenerateBar ok={ok2} setOk={setOk2} busy={busy} testid="dl-iris" disabled={!d.rows.length || problems.length > 0} label={t('Download IRIS CSV (beta)')} onGenerate={() => act(() => downloadPost('/payroll/forms/1099-iris', { year: y, reviewed: true }, 'iris-1099-nec.csv'), t('Downloaded'))} />
            : <p className="mt-2 text-xs text-slate-500">{t('Only the account owner can generate this file, because it contains full taxpayer ID numbers.')}</p>}
        </div>
      </>)}
    </Card>
  );
}

export function TaxForms() {
  return (<>
    <p className="mb-4 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{t('Fluxo fills in the numbers; it never files anything with the IRS or the SSA. Every file asks you to confirm that you reviewed it, and is listed in Audit: payroll files.')}</p>
    <Form941Card /><Form940Card /><W2Card /><Nec1099Card />
    <p className="text-xs text-slate-500">{FEDERAL_ONLY()}</p>
  </>);
}

/* ---------------------------------------- registro dos arquivos ---------------------------------------- */
const KIND = () => ({ nacha: t('Direct deposit file (NACHA)'), form941: 'Form 941', form940: 'Form 940', w2: 'W-2 / W-3', efw2: t('EFW2 file (SSA)'), nec1099_pdf: t('1099-NEC recipient copies'), iris_csv: t('IRIS CSV (1099-NEC)') });
const totalsText = (x) => {
  const T = x.totals || {};
  if (x.kind === 'nacha') return t('{0} deposits · {1}', [T.entries, money(T.credit)]);
  if (x.kind === 'form941' || x.kind === 'form940') return `${t('Line 12')}: ${money(T.line12)}`;
  if (x.kind === 'w2') return `${T.count} W-2 · ${money(T.box1)}`;
  if (x.kind === 'efw2') return `${T.employees} RW · ${money(T.box1)}`;
  return `${T.recipients} · ${money(T.box1)}`;
};
export function FilesAudit() {
  const { data, loading, error, reload } = useLoad(() => api.get('/payroll/files'));
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const K = KIND();
  return (<Card pad={false}>
    <RTable head={[t('File'), t('When'), t('Who'), t('Reference'), t('Totals')]} empty={t('No payroll files generated yet.')}
      rows={data.map((x) => ({ key: x.id, cells: [<><div>{K[x.kind] || x.kind}</div><div className="break-all text-xs font-normal text-slate-500">{x.file_name}</div></>, <span className="whitespace-nowrap">{new Date(`${x.at.replace(' ', 'T')}Z`).toLocaleString()}</span>, x.user_name, x.ref, totalsText(x)] }))} />
  </Card>);
}

/* ------------------------------------------ Configurações > Folha ------------------------------------------ */
export function PayrollSettingsTab() {
  const owner = useOwner();
  const { data, loading, error, reload } = useLoad(async () => { const [s, w] = await Promise.all([api.get('/payroll/settings'), api.get('/payroll/tax-tables')]); return { ...s, watch: w }; });
  const [n, setN] = useState(null); const [e, setE] = useState(null); const [d, setD] = useState(null);
  const [act, busy] = useAction();
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} retry={reload} />;
  const nv = n || { ...data.nacha, nacha_offset_account: data.nacha.nacha_offset_account_mask };
  const ev = e || data.employer;
  const dv = d || { schedule: data.deposits.schedule, lookback: data.deposits.lookback_amount === '' ? '' : fromCents(Number(data.deposits.lookback_amount)) };
  const setNk = (k) => (x) => setN({ ...nv, [k]: x.target.type === 'checkbox' ? x.target.checked : x.target.value });
  const setEk = (k) => (x) => setE({ ...ev, [k]: x.target.type === 'checkbox' ? x.target.checked : x.target.value });
  const ro = !owner;
  const save = (body) => act(async () => { await api.put('/payroll/settings', body); setN(null); setE(null); setD(null); await reload(); }, t('Settings saved'));
  const w = data.watch;
  return (<>
    {ro && <p className="mb-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{t('Only the account owner can change these settings.')}</p>}
    <Card title={t('Bank file (NACHA direct deposit)')} className="mb-4">
      <p className="mb-3 text-sm text-slate-600">{t("Your bank gives you these numbers when it sets up ACH origination for your business. The agreement with the bank is yours; Fluxo only creates the file.")}</p>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('Company name (as the bank knows it, 16 characters)')}><Input disabled={ro} maxLength={16} value={nv.nacha_company_name} onChange={setNk('nacha_company_name')} data-testid="nacha-company" /></Field>
        <Field label={t('Company EIN')}><Input disabled={ro} value={nv.nacha_ein} onChange={setNk('nacha_ein')} data-testid="nacha-ein" /></Field>
        <Field label={t('Company ID prefix')} hint={t('Most banks use 1 + EIN. Ask your bank.')}><Select disabled={ro} value={nv.nacha_company_id_prefix} onChange={setNk('nacha_company_id_prefix')}><option value="1">1</option><option value="9">9</option><option value=" ">{t('Space')}</option><option value="">{t('None')}</option></Select></Field>
        <Field label={t('Your bank routing number (immediate destination)')}><Input disabled={ro} inputMode="numeric" maxLength={9} value={nv.nacha_odfi_routing} onChange={setNk('nacha_odfi_routing')} data-testid="nacha-odfi" /></Field>
        <Field label={t('Bank name')}><Input disabled={ro} maxLength={23} value={nv.nacha_bank_name} onChange={setNk('nacha_bank_name')} /></Field>
        <Field label={t('Immediate origin (optional)')} hint={t('Leave empty to use the company ID. Some banks ask for their routing number here.')}><Input disabled={ro} maxLength={10} value={nv.nacha_origin} onChange={setNk('nacha_origin')} /></Field>
        <Field label={t('Entry description')} hint={t('Shows on the employee bank statement (10 characters).')}><Input disabled={ro} maxLength={10} value={nv.nacha_entry_description} onChange={setNk('nacha_entry_description')} /></Field>
        <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" className="mt-0.5 h-5 w-5" disabled={ro} checked={!!nv.nacha_balanced} onChange={setNk('nacha_balanced')} /><span>{t('Balanced file (adds the debit from your company account). Leave off unless your bank asks: many banks require unbalanced files.')}</span></label>
        {nv.nacha_balanced && <><Field label={t('Company account number (for the balancing debit)')}><Input disabled={ro} value={nv.nacha_offset_account || ''} onFocus={() => String(nv.nacha_offset_account || '').includes('*') && setN({ ...nv, nacha_offset_account: '' })} onChange={setNk('nacha_offset_account')} /></Field>
          <Field label={t('Account type')}><Select disabled={ro} value={nv.nacha_offset_account_type} onChange={setNk('nacha_offset_account_type')}><option value="checking">{t('Checking')}</option><option value="savings">{t('Savings')}</option></Select></Field></>}
      </div>
      {!ro && <Button className="mt-4" disabled={busy || !n} onClick={() => save({ nacha: nv })} data-testid="save-nacha">{t('Save')}</Button>}
    </Card>
    <Card title={t('Employer details for tax forms (941, 940, W-2, EFW2, 1099)')} className="mb-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('Employer EIN')}><Input disabled={ro} value={ev.employer_ein} onChange={setEk('employer_ein')} data-testid="er-ein" /></Field>
        <Field label={t('Legal name')}><Input disabled={ro} value={ev.employer_name} onChange={setEk('employer_name')} /></Field>
        <Field label={t('Street address')} className="md:col-span-2"><Input disabled={ro} value={ev.employer_address} onChange={setEk('employer_address')} data-testid="er-address" /></Field>
        <Field label={t('City')}><Input disabled={ro} value={ev.employer_city} onChange={setEk('employer_city')} data-testid="er-city" /></Field>
        <Field label={t('State (2 letters)')}><Input disabled={ro} maxLength={2} value={ev.employer_state} onChange={setEk('employer_state')} data-testid="er-state" /></Field>
        <Field label={t('ZIP code')}><Input disabled={ro} value={ev.employer_zip} onChange={setEk('employer_zip')} data-testid="er-zip" /></Field>
        <Field label={t('State employer ID (W-2 box 15)')}><Input disabled={ro} value={ev.employer_state_id} onChange={setEk('employer_state_id')} /></Field>
        <Field label={t('Kind of employer')}><Select disabled={ro} value={ev.employer_kind} onChange={setEk('employer_kind')}><option value="N">{t('None of these apply (most businesses)')}</option><option value="T">{t('501(c) non-government')}</option><option value="S">{t('State/local non-501(c)')}</option><option value="Y">{t('State/local 501(c)')}</option><option value="F">{t('Federal government')}</option></Select></Field>
        <Field label={t('SSA BSO User ID (8 characters)')} hint={t('Your login at SSA Business Services Online; needed for the EFW2 file.')}><Input disabled={ro} maxLength={8} value={ev.w2_bso_user_id} onChange={setEk('w2_bso_user_id')} data-testid="er-bso" /></Field>
        <Field label={t('Contact name')}><Input disabled={ro} value={ev.w2_contact_name} onChange={setEk('w2_contact_name')} data-testid="er-contact" /></Field>
        <Field label={t('Contact phone')}><Input disabled={ro} value={ev.w2_contact_phone} onChange={setEk('w2_contact_phone')} data-testid="er-phone" /></Field>
        <Field label={t('Contact email')}><Input disabled={ro} type="email" value={ev.w2_contact_email} onChange={setEk('w2_contact_email')} data-testid="er-email" /></Field>
        <label className="flex items-start gap-2 text-sm md:col-span-2"><input type="checkbox" className="mt-0.5 h-5 w-5" disabled={ro} checked={!!ev.w2_include_rs} onChange={setEk('w2_include_rs')} /><span>{t('Include optional state (RS) records in the EFW2 file')}</span></label>
      </div>
      {!ro && <Button className="mt-4" disabled={busy || !e} onClick={() => save({ employer: ev })} data-testid="save-employer">{t('Save')}</Button>}
    </Card>
    <Card title={t('Federal deposit schedule')} className="mb-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('Schedule')}><Select disabled={ro} value={dv.schedule} onChange={(x) => setD({ ...dv, schedule: x.target.value })}><option value="auto">{t('Automatic (lookback period rule)')}</option><option value="monthly">{t('Monthly')}</option><option value="semiweekly">{t('Semiweekly')}</option></Select></Field>
        <Field label={t('Form 941 tax in the lookback period (optional)')} hint={t('Only if part of the lookback period was paid outside Fluxo. Leave empty to use Fluxo records.')}><Input disabled={ro} inputMode="decimal" value={dv.lookback} onChange={(x) => setD({ ...dv, lookback: x.target.value })} /></Field>
      </div>
      {!ro && <Button className="mt-4" disabled={busy || !d} onClick={() => save({ deposits: { schedule: dv.schedule, lookback_amount: dv.lookback === '' ? '' : toCents(dv.lookback) } })}>{t('Save')}</Button>}
      <p className="mt-2 text-xs text-slate-500">{FEDERAL_ONLY()}</p>
    </Card>
    <Card title={t('IRS tax tables')}>
      <p className="text-sm text-slate-600">{t('Fluxo has tax tables for: {0}.', [w.tableYears.join(', ')])} {w.lastCheck ? t('Last check of the IRS and SSA pages: {0}.', [new Date(w.lastCheck).toLocaleString()]) : t('The IRS and SSA pages have not been checked yet.')}</p>
      <p className="mt-1 text-xs text-slate-500">{t('From October to January Fluxo checks the IRS Publication 15-T and the SSA wage base page every day and warns when they change. It never changes tax numbers by itself.')}</p>
      {Object.values(w.urls || {}).some((u) => u.error) && <p className="mt-1 text-xs text-amber-700">{t('Some pages could not be reached on the last check.')}</p>}
      {w.banner && <p className="mt-2 text-sm font-medium text-amber-800">{t('New IRS tables published for {0} — Fluxo must be updated before the first {0} payroll.', [w.banner.year])}</p>}
      {owner && <Button variant="ghost" className="mt-3" disabled={busy} onClick={() => act(async () => { await api.post('/payroll/tax-tables/check'); await reload(); }, t('Checked'))} data-testid="check-tables">{t('Check now')}</Button>}
    </Card>
  </>);
}
