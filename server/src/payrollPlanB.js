// Rotas da folha "Plano B" (todas atrás do complemento de folha: api.use('/payroll', requireFeature('payroll')) em index.js).
// Regra de ouro (decisão do dono, 21/10/2026): o Fluxo NUNCA movimenta dinheiro e NUNCA envia nada a órgão do governo.
// Ele CALCULA e GERA arquivos/formulários/lembretes; a empresa confere, sobe no banco, paga no EFTPS e envia os formulários.
// Todo gerador exige a confirmação "conferi os valores" (reviewed: true → senão 400) e fica no registro "Audit: payroll files".
import crypto from 'node:crypto';
import { all, get, run, insert, getSetting } from './db.js';
import { HttpError, today } from './accounting.js';
import * as bank from './payrollBank.js';
import * as dep from './payrollDeposits.js';
import * as forms from './payrollForms.js';
import * as pdf from './payrollPdf.js';
import * as watcher from './taxWatcher.js';
import * as mailer from './mailer.js';

const bad = (m) => new HttpError(400, m);
const isAdmin = (req) => req.user?.role === 'owner';
/** Só o administrador (dono) vê/muda dados bancários e gera arquivos com número de conta ou SSN/TIN completos. */
const requireAdmin = (req, _res, next) => next(isAdmin(req) ? undefined : new HttpError(403, 'Only the account owner can do this'));
const requireReview = (req) => { if (req.body?.reviewed !== true) throw new HttpError(400, 'Confirm that you reviewed the amounts before generating the file', { code: 'review_required' }); };
const yearOf = (req) => { const y = Number(req.query.year || req.body?.year) || new Date().getFullYear(); if (y < 2000 || y > 2100) throw bad('Invalid year'); return y; };

export const FILE_KINDS = ['nacha', 'form941', 'form940', 'w2', 'efw2', 'nec1099_pdf', 'iris_csv'];
function logFile(req, kind, ref, fileName, content, totals) {
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  insert('INSERT INTO payroll_file_log(user_id,user_name,kind,ref,file_name,totals,sha256) VALUES(?,?,?,?,?,?,?)', req.user?.id ?? null, req.user?.name || '', kind, String(ref), fileName, JSON.stringify(totals || {}), sha);
  run('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', req.user?.id ?? null, req.user?.name ?? 'sistema', 'generate', 'payroll_file', null, `${kind} ${ref} ${fileName}`.slice(0, 300));
}
function sendFile(res, name, type, content) {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.isBuffer(content) ? content : Buffer.from(content, 'latin1'));
}

export function registerPayrollPlanB(api, { wrap, ok, can, audit, id }) {
  /* ------------------------------- dados bancários do funcionário ------------------------------- */
  api.get('/payroll/employees/:id/bank', can('payroll'), requireAdmin, wrap((req, res) => {
    const e = get('SELECT id, name, bank_routing, bank_account_enc, bank_account_last4, bank_account_type FROM employees WHERE id=?', id(req));
    if (!e) throw new HttpError(404, 'Employee not found');
    res.set('Cache-Control', 'no-store');
    ok(res, { routing: e.bank_routing, type: e.bank_account_type, account_mask: e.bank_account_enc ? bank.maskAccount(e.bank_account_last4) : '', has_bank: !!(e.bank_account_enc && e.bank_routing) });
  }));
  api.put('/payroll/employees/:id/bank', can('payroll', true), requireAdmin, wrap((req, res) => {
    const eid = id(req); const cur = get('SELECT * FROM employees WHERE id=?', eid); if (!cur) throw new HttpError(404, 'Employee not found');
    const b = bank.prepareBank(req.body || {}, cur);
    run('UPDATE employees SET bank_routing=?, bank_account_enc=?, bank_account_last4=?, bank_account_type=? WHERE id=?', b.bank_routing, b.bank_account_enc, b.bank_account_last4, b.bank_account_type, eid);
    audit(req, 'update', 'employee_bank', eid, `${cur.name} ****${b.bank_account_last4}`);
    ok(res, { routing: b.bank_routing, type: b.bank_account_type, account_mask: bank.maskAccount(b.bank_account_last4), has_bank: true });
  }));
  api.delete('/payroll/employees/:id/bank', can('payroll', true), requireAdmin, wrap((req, res) => {
    const eid = id(req); const cur = get('SELECT name FROM employees WHERE id=?', eid); if (!cur) throw new HttpError(404, 'Employee not found');
    run("UPDATE employees SET bank_routing='', bank_account_enc='', bank_account_last4='', bank_account_type='checking' WHERE id=?", eid);
    audit(req, 'delete', 'employee_bank', eid, cur.name); ok(res, { has_bank: false });
  }));

  /* ------------------------------------- configurações ------------------------------------- */
  api.get('/payroll/settings', can('payroll'), wrap((req, res) => ok(res, { nacha: bank.nachaSettings(), employer: forms.employerSettings(), deposits: dep.depositSettings(), admin: isAdmin(req), mail: mailer.mailConfigured() })));
  api.put('/payroll/settings', can('payroll', true), requireAdmin, wrap((req, res) => {
    const b = req.body || {};
    if (b.nacha) bank.saveNachaSettings(b.nacha);
    if (b.employer) forms.saveEmployerSettings(b.employer);
    if (b.deposits) dep.saveDepositSettings(b.deposits);
    audit(req, 'update', 'payroll_settings', null, Object.keys(b).join(','));
    ok(res, { nacha: bank.nachaSettings(), employer: forms.employerSettings(), deposits: dep.depositSettings(), admin: true, mail: mailer.mailConfigured() });
  }));

  /* ------------------------------------------ NACHA ------------------------------------------ */
  api.get('/payroll/runs/:id/nacha', can('payroll'), wrap((req, res) => ok(res, bank.nachaPreview(id(req)))));
  api.post('/payroll/runs/:id/nacha', can('payroll', true), requireAdmin, wrap((req, res) => {
    requireReview(req);
    const f = bank.nachaForRun(id(req), { effectiveDate: req.body.effective_date || undefined });
    const name = `fluxo-direct-deposit-${f.effectiveDate}-run${f.run.id}.${req.body.ext === 'txt' ? 'txt' : 'ach'}`;
    logFile(req, 'nacha', `run ${f.run.id}`, name, f.text, { ...f.totals, checks: f.checks.length });
    sendFile(res, name, 'text/plain; charset=us-ascii', f.text);
  }));

  /* --------------------------------------- depósitos federais --------------------------------------- */
  api.get('/payroll/deposits', can('payroll'), wrap((req, res) => ok(res, dep.listDeposits({ year: req.query.year ? yearOf(req) : undefined }))));
  api.post('/payroll/deposits/pay', can('payroll', true), wrap((req, res) => {
    const r = dep.markPaid(req.body || {}, req.user);
    audit(req, 'deposit_paid', 'payroll', r.id, `${req.body.key} ${r.total}`); ok(res, r);
  }));
  api.delete('/payroll/deposits/:id', can('payroll', true), wrap((req, res) => { const r = dep.unmarkPaid(id(req)); audit(req, 'deposit_unpaid', 'payroll', id(req)); ok(res, r); }));
  api.get('/payroll/deposits/:id/receipt', can('payroll'), wrap((req, res) => ok(res, dep.depositReceipt(id(req)))));

  /* --------------------------------------------- 941 / 940 --------------------------------------------- */
  const quarterOf = (req) => { const q = Number(req.query.quarter || req.body?.quarter); if (!(q >= 1 && q <= 4)) throw bad('Quarter must be 1–4'); return q; };
  api.get('/payroll/forms/941', can('payroll'), wrap((req, res) => ok(res, { ...forms.form941Lines(yearOf(req), quarterOf(req)), official: pdf.officialAvailable('f941', yearOf(req)) })));
  api.post('/payroll/forms/941', can('payroll', true), wrap(async (req, res) => {
    requireReview(req);
    const y = yearOf(req), q = quarterOf(req), f = forms.form941Lines(y, q);
    const bytes = pdf.officialAvailable('f941', y) ? await pdf.fillOfficial('f941', y, f.lines) : await pdf.form941Pdf(f, forms.employerSettings());
    const name = `form-941-${y}-Q${q}-worksheet.pdf`;
    logFile(req, 'form941', `${y} Q${q}`, name, bytes, { line12: f.lines[12], line13: f.lines[13], line14: f.lines[14] });
    sendFile(res, name, 'application/pdf', bytes);
  }));
  api.get('/payroll/forms/940', can('payroll'), wrap((req, res) => ok(res, forms.form940Lines(yearOf(req)))));
  api.post('/payroll/forms/940', can('payroll', true), wrap(async (req, res) => {
    requireReview(req);
    const y = yearOf(req), f = forms.form940Lines(y);
    const bytes = await pdf.form940Pdf(f, forms.employerSettings());
    const name = `form-940-${y}-worksheet.pdf`;
    logFile(req, 'form940', String(y), name, bytes, { line12: f.lines[12], line13: f.lines[13], line14: f.lines[14] });
    sendFile(res, name, 'application/pdf', bytes);
  }));

  /* -------------------------------------------- W-2 / EFW2 -------------------------------------------- */
  const w2Public = (d) => ({ year: d.year, w3: d.w3, rows: d.rows.map(({ ssn, ...r }) => r), employer: { ...d.employer } });
  api.get('/payroll/forms/w2', can('payroll'), wrap((req, res) => { const d = forms.w2Data(yearOf(req)); ok(res, { ...w2Public(d), problems: forms.w2Problems(d), efw2Problems: forms.w2Problems(d, { efw2: true }) }); }));
  api.post('/payroll/forms/w2', can('payroll', true), wrap(async (req, res) => {
    requireReview(req);
    const y = yearOf(req), d = forms.w2Data(y);
    if (!d.rows.length) throw bad('No finalized payroll in this year');
    const bytes = await pdf.w2Pdf(d);
    const name = `w2-w3-${y}-worksheets.pdf`;
    logFile(req, 'w2', String(y), name, bytes, d.w3);
    sendFile(res, name, 'application/pdf', bytes);
  }));
  api.post('/payroll/forms/efw2', can('payroll', true), requireAdmin, wrap((req, res) => {
    requireReview(req);
    const y = yearOf(req), f = forms.buildEfw2(y);
    const name = `W2REPORT-${y}.txt`;
    logFile(req, 'efw2', String(y), name, f.text, f.totals);
    sendFile(res, name, 'text/plain; charset=us-ascii', f.text);
  }));

  /* ----------------------------------------------- 1099 ----------------------------------------------- */
  api.get('/payroll/forms/1099', can('payroll'), wrap((req, res) => { const d = forms.data1099(yearOf(req)); ok(res, { ...d, rows: d.rows.map(({ tin, ...r }) => r), columns: forms.IRIS_NEC_COLUMNS }); }));
  api.post('/payroll/forms/1099-nec', can('payroll', true), wrap(async (req, res) => {
    requireReview(req);
    const y = yearOf(req), d = forms.data1099(y);
    if (!d.rows.length) throw bad('No contractor reached the 1099 threshold this year');
    const bytes = await pdf.nec1099Pdf(d);
    const name = `1099-nec-${y}-recipient-worksheets.pdf`;
    logFile(req, 'nec1099_pdf', String(y), name, bytes, { recipients: d.rows.length, box1: d.rows.reduce((s, r) => s + r.box1, 0) });
    sendFile(res, name, 'application/pdf', bytes);
  }));
  api.post('/payroll/forms/1099-iris', can('payroll', true), requireAdmin, wrap((req, res) => {
    requireReview(req);
    const y = yearOf(req), f = forms.irisNecCsv(y);
    const name = `iris-1099-nec-${y}-BETA.csv`;
    logFile(req, 'iris_csv', String(y), name, f.text, f.totals);
    sendFile(res, name, 'text/csv; charset=utf-8', Buffer.from(f.text, 'utf8'));
  }));

  /* -------------------------------------------- auditoria -------------------------------------------- */
  api.get('/payroll/files', can('payroll'), wrap((_req, res) => ok(res, all('SELECT id, at, user_name, kind, ref, file_name, totals, sha256 FROM payroll_file_log ORDER BY id DESC LIMIT 500').map((r) => ({ ...r, totals: JSON.parse(r.totals || '{}') })))));

  /* -------------------------------------- vigia das tabelas -------------------------------------- */
  api.get('/payroll/tax-tables', can('payroll'), wrap((_req, res) => ok(res, watcher.status())));
  api.post('/payroll/tax-tables/check', can('payroll', true), requireAdmin, wrap(async (req, res) => { const s = await watcher.checkNow(); audit(req, 'check', 'tax_tables', null, s.banner ? `banner ${s.banner.year}` : 'ok'); ok(res, s); }));
}

/* ------------------------------ e-mail de depósito (3 dias antes e no dia) ------------------------------ */
const fmtUsd = (c) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MAIL = {
  en: (d) => ({ subject: d.stage === 'due' ? `Federal tax deposit due ${d.due_date}: ${fmtUsd(d.amount)}` : `Federal tax deposit due in 3 days (${d.due_date}): ${fmtUsd(d.amount)}`, text: `${d.kind === 'futa' ? 'FUTA' : 'Federal payroll tax (Form 941)'} deposit for ${d.period}: ${fmtUsd(d.amount)}, due ${d.due_date}.\n\nPay at EFTPS.gov — Fluxo does not pay taxes for you. After paying, open Payroll > Tax deposits in Fluxo and choose "Mark as paid".` }),
  pt: (d) => ({ subject: d.stage === 'due' ? `Depósito de imposto federal vence ${d.due_date}: ${fmtUsd(d.amount)}` : `Depósito de imposto federal vence em 3 dias (${d.due_date}): ${fmtUsd(d.amount)}`, text: `Depósito ${d.kind === 'futa' ? 'do FUTA' : 'de impostos da folha (Form 941)'} do período ${d.period}: ${fmtUsd(d.amount)}, vence em ${d.due_date}.\n\nPague no EFTPS.gov — o Fluxo não paga impostos por você. Depois de pagar, abra Folha de pagamento > Depósitos de impostos no Fluxo e clique em "Marcar como pago".` }),
  es: (d) => ({ subject: d.stage === 'due' ? `Depósito de impuesto federal vence ${d.due_date}: ${fmtUsd(d.amount)}` : `Depósito de impuesto federal vence en 3 días (${d.due_date}): ${fmtUsd(d.amount)}`, text: `Depósito ${d.kind === 'futa' ? 'del FUTA' : 'de impuestos de nómina (Form 941)'} del período ${d.period}: ${fmtUsd(d.amount)}, vence el ${d.due_date}.\n\nPague en EFTPS.gov — Fluxo no paga impuestos por usted. Después de pagar, abra Nómina > Depósitos de impuestos en Fluxo y elija "Marcar como pagado".` }),
};
/** Manda (uma vez por depósito e por etapa) o e-mail para os donos da empresa. Roda dentro do banco da empresa. */
export async function sendDepositEmails(t = today()) {
  if (!mailer.mailConfigured()) return 0;
  const owners = all("SELECT email FROM users WHERE role='owner' AND active=1 AND email<>''").map((u) => u.email);
  if (!owners.length) return 0;
  let n = 0;
  for (const d of dep.depositNotices(t)) {
    const key = `deposit:${d.key}:${d.stage}`;
    if (get('SELECT 1 FROM payroll_notices WHERE key=?', key)) continue;
    run('INSERT INTO payroll_notices(key) VALUES(?)', key);
    const m = (MAIL[getSetting('lang', 'en')] || MAIL.en)(d);
    for (const to of owners) { try { await mailer.sendMail({ to, ...m }); n += 1; } catch (e) { console.error('deposit email', e.message); } }
  }
  return n;
}
