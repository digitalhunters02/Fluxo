import { t } from '../i18n.jsx';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, money, toCents, fromCents } from '../format.js';
import { Button, Card, ErrorBox, Field, Input, Loading, Select, Table, useAction, useLoad, useToast } from '../components/ui.jsx';
import { useAuth } from '../App.jsx';
import { Gate } from '../components/plan.jsx';

const SecretBox = ({ label, value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="secret-box">
      <div className="mb-1 font-semibold text-amber-900">{label}</div>
      <div className="flex items-center gap-2"><code className="min-w-0 flex-1 break-all text-slate-800">{value}</code>
        <Button variant="ghost" onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); }}>{copied ? t('Copied') : t('Copy')}</Button></div>
    </div>
  );
};

/* ------------------------------- API e webhooks ------------------------------- */
function IntegrationsInner() {
  const [run, busy] = useAction();
  const [name, setName] = useState(''); const [scope, setScope] = useState('write'); const [url, setUrl] = useState('');
  const [secret, setSecret] = useState(null); const [testMsg, setTestMsg] = useState('');
  const keys = useLoad(() => api.get('/integrations/keys'));
  const hooks = useLoad(() => api.get('/integrations/webhooks'));
  const email = useLoad(() => api.get('/email/status'));
  const reloadAll = () => { keys.reload(); hooks.reload(); };
  return (
    <div className="space-y-4" data-testid="integrations">
      <Card title={t('API keys')}>
        <p className="mb-3 text-sm text-slate-600">{t('Let other systems read and send data (customers, invoices, payments). Send requests to {0} with the header Authorization: Bearer <key>. Amounts are in cents.', [`${location.origin}/api/v1`])}</p>
        {secret && <SecretBox label={secret.label} value={secret.value} />}
        <form className="mb-4 grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const k = await api.post('/integrations/keys', { name, scope }); setSecret({ label: t('Copy this key now. It will not be shown again:'), value: k.key }); setName(''); reloadAll(); }); }}>
          <Field label={t('Key name (for example: Website form)')} className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
          <Field label={t('Access')}><Select value={scope} onChange={(e) => setScope(e.target.value)}><option value="write">{t('Read and write')}</option><option value="read">{t('Read only')}</option></Select></Field>
          <div className="flex items-end"><Button type="submit" disabled={busy}>{t('Create key')}</Button></div>
        </form>
        {keys.loading ? <Loading /> : keys.error ? <ErrorBox error={keys.error} /> : (
          <Table head={[t('Name'), t('Key'), t('Access'), t('Last used'), '']} empty={t('No keys yet.')}>
            {keys.data.keys.map((k) => <tr key={k.id}><td className="td font-medium">{k.name}</td><td className="td font-mono text-xs">{k.prefix}…</td><td className="td">{k.scope === 'read' ? t('Read only') : t('Read and write')}</td><td className="td">{k.last_used_at ? k.last_used_at.slice(0, 10) : t('never')}</td>
              <td className="td text-right"><button className="text-xs text-rose-600 hover:underline" onClick={() => confirm(t('Revoke this key? Systems using it stop working.')) && run(async () => { await api.del(`/integrations/keys/${k.id}`); reloadAll(); })}>{t('Revoke')}</button></td></tr>)}
          </Table>)}
      </Card>
      <Card title={t('Webhooks')}>
        <p className="mb-3 text-sm text-slate-600">{t('Fluxo calls your address when something happens. Each call is signed in the X-Fluxo-Signature header (HMAC-SHA256).')}</p>
        <form className="mb-3 grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); run(async () => { const w = await api.post('/integrations/webhooks', { url }); setSecret({ label: t('Copy this signing secret now. It will not be shown again:'), value: w.secret }); setUrl(''); reloadAll(); }); }}>
          <Field label={t('Webhook address (https)')} className="sm:col-span-3" hint={hooks.data ? hooks.data.events.join(', ') : ''}><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required /></Field>
          <div className="flex items-end"><Button type="submit" disabled={busy}>{t('Add webhook')}</Button></div>
        </form>
        {testMsg && <p className="mb-2 text-sm text-slate-600" data-testid="hook-test-msg">{testMsg}</p>}
        {hooks.loading ? <Loading /> : hooks.error ? <ErrorBox error={hooks.error} /> : (
          <Table head={[t('Address'), t('Status'), '']} empty={t('No webhooks yet.')}>
            {hooks.data.webhooks.map((w) => <tr key={w.id}><td className="td break-all">{w.url}</td><td className="td text-sm">{w.active ? (w.failures ? t('{0} failures in a row', [w.failures]) : t('Active')) : t('Turned off after failures')}</td>
              <td className="td text-right"><button className="mr-3 text-xs text-brand-700 hover:underline" onClick={() => run(async () => { const r = await api.post(`/integrations/webhooks/${w.id}/test`); setTestMsg(r.ok ? t('Test delivered ({0}).', [r.status]) : t('Test failed: {0}', [r.error || r.status])); hooks.reload(); })}>{t('Send test')}</button>
                <button className="text-xs text-rose-600 hover:underline" onClick={() => run(async () => { await api.del(`/integrations/webhooks/${w.id}`); reloadAll(); })}>{t('Delete')}</button></td></tr>)}
          </Table>)}
      </Card>
      <Card title={t('Email')}>
        <p className="text-sm text-slate-600">{email.data?.ready ? t('Email is set up: you can send invoices and estimates to customers from the document page.') : t('Email is not set up on this server yet. Ask your administrator to configure an email provider.')}</p>
      </Card>
    </div>
  );
}
export const IntegrationsTab = () => <Gate feature="api"><IntegrationsInner /></Gate>;

/* ------------------------------- pagamento online ------------------------------- */
function PaymentsInner() {
  const [run, busy] = useAction();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const st = useLoad(() => api.get('/connect/status'));
  const accounts = useLoad(() => api.get('/accounts/lookup'));
  useEffect(() => { if (params.get('connect') === 'done') { toast(t('Back from Stripe. Updating…')); st.reload(); setParams({ tab: undefined }, { replace: true }); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (st.loading) return <Loading />; if (st.error) return <ErrorBox error={st.error} retry={st.reload} />;
  const s = st.data;
  const banks = (accounts.data || []).filter((a) => a.type === 'asset' && a.subtype === 'bank');
  return (
    <Card title={t('Online payments')} className="max-w-3xl" >
      <p className="mb-3 text-sm text-slate-600">{t('Your customers pay invoices by card or bank transfer from the invoice link. The money goes straight to your own Stripe account and the payment is recorded in Fluxo automatically.')}</p>
      {!s.configured && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('Online payments are not configured on this server yet.')}</p>}
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.ready ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`} data-testid="connect-state">{s.ready ? t('Ready to take payments') : s.connected ? t('Finish setting up in Stripe') : t('Not connected')}</span>
        {s.feePct > 0 && <span className="text-slate-500">{t('Platform fee: {0}% per payment', [s.feePct])}</span>}
      </div>
      <Button disabled={busy || !s.configured} onClick={() => run(async () => { const r = await api.post('/connect/onboard'); window.location.href = r.url; })}>{s.connected ? t('Continue in Stripe') : t('Connect with Stripe')}</Button>
      {s.ready && banks.length > 0 && (
        <div className="mt-5 max-w-sm"><Field label={t('Deposit online payments into')} hint={t('The bank account in your books that receives these payments.')}>
          <Select value={s.depositAccountId || ''} onChange={(e) => run(async () => { await api.put('/connect/settings', { deposit_account_id: Number(e.target.value) }); st.reload(); }, t('Saved'))}>
            <option value="">{t('First bank account')}</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field></div>)}
    </Card>
  );
}
export const PaymentsTab = () => <Gate feature="online_payments"><PaymentsInner /></Gate>;

/* ------------------------------- aprovações ------------------------------- */
function ApprovalsInner() {
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(() => api.get('/approvals'));
  const [limit, setLimit] = useState(null); const [sod, setSod] = useState(null);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  const lim = limit ?? fromCents(data.settings.threshold), seg = sod ?? data.settings.segregation;
  return (
    <div className="max-w-3xl space-y-4" data-testid="approvals">
      <Card title={t('Bill approvals')}>
        <p className="mb-3 text-sm text-slate-600">{t('Bills at or above this amount cannot be paid until someone approves them. Leave 0 to turn approvals off.')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('Approval limit ($)')}><Input inputMode="decimal" value={lim} onChange={(e) => setLimit(e.target.value)} /></Field>
          <label className="flex items-end gap-2 pb-2 text-sm sm:col-span-2"><input type="checkbox" checked={seg} onChange={(e) => setSod(e.target.checked)} /> {t('The person who entered a bill cannot approve it')}</label>
        </div>
        <Button className="mt-3" disabled={busy} onClick={() => run(async () => { await api.put('/approvals/settings', { threshold: toCents(lim), segregation: seg }); setLimit(null); setSod(null); reload(); }, t('Saved'))}>{t('Save')}</Button>
      </Card>
      <Card title={t('Waiting for approval')} pad={false}>
        <Table head={[t('Bill'), t('Vendor'), t('Due'), { label: t('Amount'), right: true }, '']} empty={t('Nothing is waiting for approval.')}>
          {data.pending.map((b) => <tr key={b.id}><td className="td font-medium">{b.number}{b.status === 'rejected' && <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-xs text-rose-700">{t('Rejected')}</span>}</td><td className="td">{b.vendor}</td><td className="td">{date(b.due_date)}</td><td className="td num text-right">{money(b.total)}</td>
            <td className="td text-right"><Button variant="ghost" disabled={busy} onClick={() => run(async () => { await api.post(`/doc/${b.id}/approve`); reload(); }, t('Approved'))}>{t('Approve')}</Button>{b.status !== 'rejected' && <Button variant="ghost" disabled={busy} onClick={() => run(async () => { await api.post(`/doc/${b.id}/reject`); reload(); }, t('Rejected'))}>{t('Reject')}</Button>}</td></tr>)}
        </Table>
      </Card>
    </div>
  );
}
export const ApprovalsTab = () => <Gate feature="approvals"><ApprovalsInner /></Gate>;

/* ------------------------------- login único ------------------------------- */
function SsoInner() {
  const [run, busy] = useAction();
  const { data, loading, error, reload } = useLoad(() => api.get('/sso/settings'));
  const [f, setF] = useState({});
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} retry={reload} />;
  const v = { ...data, ...f }; const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const redirect = `${location.origin}/api/sso/callback`;
  return (
    <Card title={t('Single sign-on (SSO)')} className="max-w-3xl">
      <p className="mb-3 text-sm text-slate-600">{t('Let your team sign in with your company identity provider (Google Workspace, Microsoft Entra ID, Okta or any OpenID Connect provider). People still need to be added as users here first.')}</p>
      <p className="mb-3 text-sm text-slate-600">{t('Redirect address to register at the provider: {0}', [redirect])}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('Provider address')} hint="https://accounts.google.com"><Input value={v.issuer} onChange={set('issuer')} /></Field>
        <Field label={t('Client ID')}><Input value={v.client_id} onChange={set('client_id')} /></Field>
        <Field label={t('Client secret')} hint={data.has_secret ? t('Saved. Type a new one only to replace it.') : ''}><Input type="password" value={f.client_secret || ''} onChange={set('client_secret')} autoComplete="new-password" /></Field>
        <Field label={t('Allowed email domains (optional)')}><Input value={v.domains} onChange={set('domains')} placeholder="company.com" /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled ?? data.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> {t('Turn on single sign-on')}</label>
      <Button className="mt-4" disabled={busy} onClick={() => run(async () => { await api.put('/sso/settings', f); setF({}); reload(); }, t('Saved'))}>{t('Save')}</Button>
    </Card>
  );
}
export const SsoTab = () => <Gate feature="sso"><SsoInner /></Gate>;

/* ------------------------------- migração ------------------------------- */
const KINDS = () => ({
  accounts: [t('Chart of accounts'), t('QuickBooks: Reports > Account List, export as CSV. Xero: Accounting > Chart of accounts > Export.')],
  contacts: [t('Customers and vendors'), t('QuickBooks: Reports > Customer Contact List (or Vendor), export as CSV. Xero: Contacts > Export.')],
  opening: [t('Opening balances'), t('QuickBooks or Xero: Trial Balance report as of the day before you start in Fluxo, export as CSV. Import the chart of accounts first.')],
});
export function ImportTab() {
  const [run, busy] = useAction();
  const [kind, setKind] = useState('accounts'); const [csv, setCsv] = useState(''); const [fileName, setFileName] = useState('');
  const [asof, setAsof] = useState(''); const [ck, setCk] = useState('auto');
  const [res, setRes] = useState(null); const [done, setDone] = useState(false);
  const K = KINDS();
  const send = (apply) => run(async () => { const r = await api.post(`/migrate/${kind}`, { csv, apply, asof, contact_kind: ck }); setRes(r); if (apply) setDone(true); }, apply ? t('Import finished') : undefined);
  const pick = async (e) => { const f = e.target.files?.[0]; setRes(null); setDone(false); if (!f) { setCsv(''); setFileName(''); return; } setCsv(await f.text()); setFileName(f.name); };
  return (
    <div className="max-w-4xl space-y-4" data-testid="import">
      <Card title={t('Import from QuickBooks or Xero')}>
        <p className="mb-3 text-sm text-slate-600">{t('Bring your data from another system in three steps: chart of accounts, then customers and vendors, then opening balances. Check the preview first; nothing is saved until you press Import.')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('What to import')}><Select value={kind} onChange={(e) => { setKind(e.target.value); setRes(null); setDone(false); }}>{Object.entries(K).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select></Field>
          {kind === 'contacts' && <Field label={t('These are')}><Select value={ck} onChange={(e) => setCk(e.target.value)}><option value="auto">{t('Detect from the file')}</option><option value="customer">{t('Customers')}</option><option value="vendor">{t('Vendors')}</option></Select></Field>}
          {kind === 'opening' && <Field label={t('Balances as of')}><Input type="date" value={asof} onChange={(e) => setAsof(e.target.value)} /></Field>}
          <Field label={t('CSV file')}><input type="file" accept=".csv,text/csv" onChange={pick} data-testid="import-file" className="text-sm" /></Field>
        </div>
        <p className="mt-2 text-xs text-slate-500">{K[kind][1]}</p>
        <div className="mt-4 flex gap-2"><Button variant="ghost" disabled={busy || !csv} onClick={() => send(false)}>{t('Preview')}</Button><Button disabled={busy || !csv || !res || done} onClick={() => send(true)}>{t('Import')}</Button></div>
        {fileName && <p className="mt-2 text-xs text-slate-400">{fileName}</p>}
      </Card>
      {res && (
        <Card title={done ? t('Imported') : t('Preview')} className="import-result">
          {kind === 'opening' ? (
            <>
              <p className="mb-2 text-sm">{t('Total debits {0} · total credits {1}', [money(res.totalDebit), money(res.totalCredit)])} {res.balanced ? '✓' : `· ${t('Difference {0}', [money(res.difference)])}`}</p>
              {res.unknown.length > 0 && <p className="mb-2 rounded bg-amber-50 p-2 text-sm text-amber-800">{t('These accounts were not found. Import the chart of accounts first:')} {res.unknown.map((u) => u.account).join(', ')}</p>}
              <Table head={[t('Account'), { label: t('Debit'), right: true }, { label: t('Credit'), right: true }]}>{res.lines.map((l) => <tr key={l.account_id}><td className="td">{l.code} {l.account}</td><td className="td num text-right">{l.debit ? money(l.debit) : ''}</td><td className="td num text-right">{l.credit ? money(l.credit) : ''}</td></tr>)}</Table>
            </>
          ) : (
            <>
              <p className="mb-2 text-sm">{t('{0} to create · {1} already exist · {2} linked to existing accounts · {3} with problems', [res.created, res.exists, res.mapped ?? res.updated ?? 0, res.invalid])}</p>
              <Table head={[t('Name'), t('Result')]}>{res.rows.slice(0, 200).map((r, i) => <tr key={i}><td className="td">{r.name}</td><td className="td text-sm text-slate-600">{({ create: t('will be created'), exists: t('already exists'), mapped: t('linked to existing'), updated: t('updated'), invalid: r.reason })[r.status] || r.status}</td></tr>)}</Table>
            </>)}
        </Card>)}
    </div>
  );
}

/* ------------------------------- grupo de empresas ------------------------------- */
export function GroupTab() {
  const [run, busy] = useAction();
  const { has } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get('/group'));
  const [name, setName] = useState(''); const [code, setCode] = useState(''); const [invite, setInvite] = useState(null);
  if (loading) return <Loading />; if (error) return <ErrorBox error={error} />;
  const g = data.group;
  return (
    <div className="max-w-3xl space-y-4" data-testid="group">
      <Card title={t('Group of companies')}>
        <p className="mb-3 text-sm text-slate-600">{t('Put several companies in a group to see their numbers added together in the Reports (Group income statement and balance sheet). Each company keeps its own books. Name accounts between your companies "Intercompany …" and they are taken out of the totals.')}</p>
        {!g ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Field label={t('New group name')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Button className="mt-2" disabled={busy || !name.trim() || !has('multi_company')} onClick={() => run(async () => { await api.post('/group', { name }); reload(); })}>{t('Create group')}</Button>
              {!has('multi_company') && <p className="mt-2 text-xs text-amber-700">{t('Creating a group needs the Business plan.')}</p>}
            </div>
            <div>
              <Field label={t('Have an invitation code?')}><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" /></Field>
              <Button className="mt-2" variant="ghost" disabled={busy || !code.trim()} onClick={() => run(async () => { await api.post('/group/join', { code }); setCode(''); reload(); }, t('Joined the group'))}>{t('Join group')}</Button>
            </div>
          </div>
        ) : (
          <>
            <h3 className="font-semibold">{g.name}</h3>
            <p className="mb-2 text-xs text-slate-500">{g.limit != null ? t('Up to {0} companies on this plan.', [g.limit]) : t('No limit on the number of companies.')}</p>
            <ul className="mb-3 space-y-1 text-sm">{g.members.map((m) => <li key={m.slug}>• {m.name}{m.owner ? ` (${t('owner')})` : ''}</li>)}</ul>
            {invite && <SecretBox label={t('Give this code to the owner of the other company. It works once, for 7 days:')} value={invite} />}
            <div className="flex gap-2">
              {g.isOwner && <Button disabled={busy} onClick={() => run(async () => { const r = await api.post('/group/invite'); setInvite(r.code); })}>{t('Invite a company')}</Button>}
              <Button variant="ghost" disabled={busy} onClick={() => confirm(g.isOwner ? t('Leaving closes the whole group for everyone. Continue?') : t('Leave this group?')) && run(async () => { await api.post('/group/leave'); setInvite(null); reload(); })}>{g.isOwner ? t('Close group') : t('Leave group')}</Button>
            </div>
          </>)}
      </Card>
    </div>
  );
}

/* ------------------------------- exportar auditoria ------------------------------- */
export function AuditExport() {
  const { has } = useAuth();
  const [run, busy] = useAction();
  if (!has('audit_export')) return <p className="mb-3 text-xs text-slate-400">{t('Exporting the audit log to CSV is part of the Business plan.')}</p>;
  return <div className="mb-3"><Button variant="ghost" disabled={busy} onClick={() => run(async () => {
    const r = await fetch('/api/audit/export.csv', { headers: { Authorization: `Bearer ${localStorage.getItem('fluxo_token')}` } });
    if (!r.ok) throw new Error(t('Could not export'));
    const url = URL.createObjectURL(await r.blob()); const a = document.createElement('a'); a.href = url; a.download = 'fluxo-audit-log.csv'; a.click(); URL.revokeObjectURL(url);
  })}>{t('Export audit log (CSV)')}</Button></div>;
}
