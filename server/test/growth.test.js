// Pacote de crescimento (uma empresa por instalação): planos, API e webhooks, e-mail de faturas, pagamento online (Stripe Connect),
// migração do QuickBooks/Xero, aprovações, ativos fixos, fechamento do mês, previsão de caixa e exportação de auditoria.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStripeMock } from './mocks/stripe.js';

const { server: mock, S } = createStripeMock();
await new Promise((r) => mock.listen(0, r));
const mailFile = path.join(os.tmpdir(), `fluxo-mail-${process.pid}.jsonl`);
fs.rmSync(mailFile, { force: true });
process.env.FLUXO_DB = ':memory:';
process.env.STRIPE_SECRET_KEY = 'sk_test_123'; process.env.STRIPE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_plat'; process.env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_connect';
process.env.WEBHOOK_ALLOW_INSECURE = '1'; process.env.APP_URL = 'https://app.fluxo.test';

const { get, all, insert, run: runSql } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const mailer = await import('../src/mailer.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const root = `http://127.0.0.1:${server.address().port}`;
let token = '';
const call = async (p, method = 'GET', body, tk = token, headers = {}) => {
  const r = await fetch(`${root}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, body: json, text, headers: r.headers };
};
const t = acc.today();
const day = (n) => acc.addDays(t, n);
const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const setPlan = (plan) => call('/plan', 'PUT', { plan, payroll: true });
const customer = () => insert("INSERT INTO contacts(kind,name,email) VALUES('customer','Acme Co','acme@example.com')");
const vendor = () => insert("INSERT INTO contacts(kind,name) VALUES('vendor','Paper Inc')");
const invoice = (cid, amount = 10000, extra = {}) => acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: t, due_date: day(15), post: true, lines: [{ description: 'service', qty: 1, unit_price: amount }], ...extra }, null);
const bill = (vid, amount, extra = {}) => acc.saveDoc({ type: 'bill', contact_id: vid, issue_date: t, due_date: day(20), post: true, lines: [{ description: 'supplies', qty: 1, unit_price: amount }], ...extra }, { id: 1 });
const sig = (raw, secret, ts = Math.floor(Date.now() / 1000)) => `t=${ts},v1=${crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
const connectHook = (event) => { const raw = JSON.stringify(event); return call('/stripe/connect-webhook', 'POST', raw, '', { 'stripe-signature': sig(raw, 'whsec_connect') }); };

test('setup e planos novos', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'enterprise', lang: 'en' }, '');
  assert.equal(s.status, 200); token = s.body.token;
  const plans = await call('/public/plans', 'GET', undefined, '');
  assert.equal(plans.body.prices.business, 599);
  assert.equal(plans.body.prices.enterprise, null);
  assert.deepEqual(plans.body.order.slice(-3), ['advanced', 'business', 'enterprise']);
  const me = await call('/me');
  assert.equal(me.body.planInfo.features.approvals, true);
  assert.equal(me.body.planInfo.features.sso, true);
  await setPlan('advanced');
  const adv = (await call('/me')).body.planInfo.features;
  assert.equal(adv.api, true); assert.equal(adv.online_payments, true); assert.equal(adv.approvals, false); assert.equal(adv.fixed_assets, false); assert.equal(adv.sso, false);
  await setPlan('enterprise');
});

test('recursos novos são travados pelo plano (402) com o plano mínimo certo', async () => {
  await setPlan('plus');
  const cases = [['/integrations/keys', 'api'], ['/connect/onboard', 'online_payments', 'POST'], ['/approvals', 'approvals'], ['/assets', 'fixed_assets'], ['/close/2026-01', 'close_checklist'], ['/audit/export.csv', 'audit_export']];
  for (const [p, feature, m] of cases) {
    const r = await call(p, m || 'GET', m ? {} : undefined);
    assert.equal(r.status, 402, p); assert.equal(r.body.feature, feature, p);
  }
  assert.equal((await call('/reports/forecast')).status, 200); // Plus tem previsão
  await setPlan('essentials');
  assert.equal((await call('/reports/forecast')).status, 402);
  await setPlan('enterprise');
});

test('API: chave, uso, idempotência, somente leitura e revogação', async () => {
  const cid = customer();
  const k = await call('/integrations/keys', 'POST', { name: 'Website' });
  assert.equal(k.status, 200); assert.match(k.body.key, /^flx_live_\./);
  assert.ok(!JSON.stringify((await call('/integrations/keys')).body).includes(k.body.key), 'a chave inteira nunca é listada de novo');
  assert.equal((await call('/v1/customers', 'GET', undefined, '')).status, 401);
  const auth = { authorization: `Bearer ${k.body.key}` };
  const v1 = (p, m = 'GET', b, h = auth) => call(`/v1${p}`, m, b, '', h);
  const me = await v1('/me');
  assert.equal(me.status, 200); assert.equal(me.body.product, 'fluxo'); assert.equal(me.body.features.api, true);
  assert.equal(typeof me.body.bank.allowed, 'boolean'); assert.equal(me.body.bank.connected, 0);
  const c1 = await v1('/customers', 'POST', { name: 'Web Customer', email: 'w@x.com', externalId: 'web-1' });
  assert.equal(c1.status, 201);
  const c2 = await v1('/customers', 'POST', { name: 'Web Customer', externalId: 'web-1' });
  assert.equal(c2.status, 200); assert.equal(c2.body.duplicate, true); assert.equal(c2.body.customer.id, c1.body.customer.id);
  const inv = await v1('/invoices', 'POST', { customerExternalId: 'web-1', externalId: 'ord-9', dueDate: day(10), lines: [{ description: 'Order 9', qty: 2, unitPriceCents: 5000 }] });
  assert.equal(inv.status, 201, inv.text);
  assert.equal(inv.body.invoice.totalCents, 10000); assert.equal(inv.body.invoice.status, 'sent');
  const dup = await v1('/invoices', 'POST', { customerExternalId: 'web-1', externalId: 'ord-9', lines: [{ description: 'x', unitPriceCents: 1 }] });
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true); assert.equal(dup.body.invoice.id, inv.body.invoice.id);
  assert.equal(all("SELECT id FROM docs WHERE external_id='ord-9'").length, 1);
  assert.equal((await v1('/invoices', 'POST', { customerId: 999999, lines: [{ description: 'x', unitPriceCents: 100 }] })).status, 400);
  const pay = await v1(`/invoices/${inv.body.invoice.id}/payments`, 'POST', { amountCents: 4000, method: 'ach' });
  assert.equal(pay.status, 201); assert.equal(pay.body.invoice.balanceCents, 6000); assert.equal(pay.body.invoice.status, 'partial');
  assert.equal((await v1(`/invoices/${inv.body.invoice.id}/payments`, 'POST', { amountCents: 999999 })).status, 400);
  const got = await v1(`/invoices/${inv.body.invoice.id}`);
  assert.equal(got.body.invoice.lines[0].unitPriceCents, 5000);
  const ro = await call('/integrations/keys', 'POST', { name: 'Reader', scope: 'read' });
  const roAuth = { authorization: `Bearer ${ro.body.key}` };
  assert.equal((await v1('/customers', 'POST', { name: 'Nope' }, roAuth)).status, 403);
  assert.equal((await v1('/customers', 'GET', undefined, roAuth)).status, 200);
  await call(`/integrations/keys/${k.body.id}`, 'DELETE');
  assert.equal((await v1('/customers')).status, 401);
  assert.equal((await v1('/nope', 'GET', undefined, roAuth)).status, 404);
  void cid;
});

test('API exige o plano Advanced', async () => {
  const k = await call('/integrations/keys', 'POST', { name: 'Plan test' });
  await setPlan('plus');
  const r = await call('/v1/customers', 'GET', undefined, '', { authorization: `Bearer ${k.body.key}` });
  assert.equal(r.status, 402); assert.equal(r.body.required, 'advanced');
  await setPlan('enterprise');
});

test('webhooks: assinados, entregues e protegidos contra endereços internos', async () => {
  const got = [];
  const recv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ h: req.headers, body: b }); res.end('ok'); }); });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${recv.address().port}/hook`;
  assert.equal((await call('/integrations/webhooks', 'POST', { url: 'ftp://x' })).status, 400);
  assert.equal((await call('/integrations/webhooks', 'POST', { url, events: ['nope'] })).status, 400);
  const w = await call('/integrations/webhooks', 'POST', { url, events: ['invoice.created', 'payment.received', 'invoice.paid'] });
  assert.equal(w.status, 200);
  const cid = customer();
  const inv = invoice(cid, 5000);
  acc.addPayment(inv.id, { date: t, amount: 5000, account_id: A('1010') }, null);
  for (let i = 0; i < 50 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 50));
  const events = got.map((g) => JSON.parse(g.body).event).sort();
  assert.deepEqual(events, ['invoice.created', 'invoice.paid', 'payment.received']);
  const first = got[0];
  const [tp, vp] = first.h['x-fluxo-signature'].split(',');
  assert.equal(vp.slice(3), crypto.createHmac('sha256', w.body.secret).update(`${tp.slice(2)}.${first.body}`).digest('hex'));
  const test_ = await call(`/integrations/webhooks/${w.body.id}/test`, 'POST');
  assert.equal(test_.body.ok, true);
  const { isPrivateIp } = await import('../src/events.js');
  for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '172.16.0.1', '::1', 'fd00::1']) assert.equal(isPrivateIp(ip), true, ip);
  assert.equal(isPrivateIp('8.8.8.8'), false);
  recv.close();
});

test('e-mail de faturas pelo sistema', async () => {
  const cid = customer();
  const inv = invoice(cid, 7000);
  assert.equal((await call(`/doc/${inv.id}/email`, 'POST', { to: 'a@b.com' })).status, 503); // sem provedor de e-mail
  process.env.FLUXO_MAIL_FILE = mailFile;
  assert.equal((await call('/email/status')).body.ready, true);
  assert.equal((await call(`/doc/${inv.id}/email`, 'POST', { to: 'not-an-email' })).status, 400);
  const draft = acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: t, due_date: t, post: false, lines: [{ description: 'd', qty: 1, unit_price: 100 }] }, null);
  assert.equal((await call(`/doc/${draft.id}/email`, 'POST', { to: 'a@b.com' })).status, 400);
  const ok = await call(`/doc/${inv.id}/email`, 'POST', { message: 'Thanks for your business' });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.body.sentTo, 'acme@example.com');
  const mails = fs.readFileSync(mailFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const m = mails.at(-1);
  assert.match(m.subject, /Invoice .* —/); assert.match(m.text, /Thanks for your business/);
  assert.match(m.text, new RegExp(`https://app\\.fluxo\\.test/p/${get('SELECT share_token FROM docs WHERE id=?', inv.id).share_token}`));
  assert.ok(get('SELECT emailed_at FROM docs WHERE id=?', inv.id).emailed_at);
  await setPlan('starter');
  assert.equal((await call(`/doc/${inv.id}/email`, 'POST', {})).status, 402);
  await setPlan('enterprise');
  delete process.env.FLUXO_MAIL_FILE;
  void mailer;
});

test('pagamento online (Stripe Connect): conectar, cobrar na conta conectada, registrar uma única vez', async () => {
  assert.equal((await call('/connect/status')).body.connected, false);
  const ob = await call('/connect/onboard', 'POST', {});
  assert.equal(ob.status, 200); assert.match(ob.body.url, /^https:\/\/connect\.stripe\.test\/setup\/acct_/);
  const acctId = get("SELECT value FROM settings WHERE key='connect_account_id'").value;
  assert.equal((await call('/connect/status')).body.ready, false);
  const cid = customer();
  const inv = invoice(cid, 20000);
  const token_ = get('SELECT share_token FROM docs WHERE id=?', inv.id).share_token;
  assert.equal((await call(`/public/doc/${token_}`, 'GET', undefined, '')).body.payOnline, false);
  assert.equal((await call(`/public/doc/${token_}/pay`, 'POST', {}, '')).status, 400); // ainda não pode receber
  // o Stripe avisa que a conta foi liberada
  assert.equal((await call('/stripe/connect-webhook', 'POST', '{}', '', { 'stripe-signature': 't=1,v1=bad' })).status, 400);
  S.accounts[acctId].charges_enabled = true;
  assert.equal((await connectHook({ id: 'evt_acc', type: 'account.updated', account: acctId, data: { object: { id: acctId, charges_enabled: true } } })).status, 200);
  const st = await call('/connect/status');
  assert.equal(st.body.ready, true);
  const pub = await call(`/public/doc/${token_}`, 'GET', undefined, '');
  assert.equal(pub.body.payOnline, true);
  process.env.CONNECT_FEE_PCT = '2';
  const pay = await call(`/public/doc/${token_}/pay`, 'POST', {}, '');
  assert.equal(pay.status, 200, pay.text); assert.match(pay.body.url, /checkout\.stripe\.test/);
  const sess = Object.values(S.sessions).at(-1);
  assert.equal(sess.account, acctId, 'a cobrança é feita na conta conectada');
  assert.equal(sess.params.line_items['0'].price_data.unit_amount, '20000');
  assert.equal(sess.params.payment_intent_data.application_fee_amount, '400', 'taxa de 2% da plataforma');
  assert.equal(sess.params.metadata.fluxo_doc_id, String(inv.id));
  delete process.env.CONNECT_FEE_PCT;
  const done = { id: 'evt_pay1', type: 'checkout.session.completed', account: acctId, data: { object: { id: sess.id, payment_status: 'paid', amount_total: 20000, metadata: { fluxo_doc_id: String(inv.id) } } } };
  const r1 = await connectHook(done);
  assert.equal(r1.body.handled, 'checkout.session.completed');
  assert.equal(acc.loadDoc(inv.id).status, 'paid');
  assert.equal(acc.loadDoc(inv.id).payments.length, 1);
  assert.equal((await connectHook(done)).body.duplicate, true);
  assert.equal((await connectHook({ ...done, id: 'evt_pay2' })).body.handled, 'already_recorded');
  assert.equal(acc.loadDoc(inv.id).payments.length, 1, 'o mesmo pagamento nunca entra duas vezes');
  assert.equal(acc.loadDoc(inv.id).payments[0].method, 'card (online)');
  assert.equal((await call(`/public/doc/${token_}/pay`, 'POST', {}, '')).status, 400); // já paga
  assert.equal((await call(`/public/doc/${token_}`, 'GET', undefined, '')).body.payOnline, false);
  await setPlan('plus');
  assert.equal((await call('/connect/onboard', 'POST', {})).status, 402);
  await setPlan('enterprise');
});

const QBO_ACCOUNTS = ['Account List', 'As of October 10 2026', '', 'Account,Type,Detail Type,Balance',
  'Business Checking,Bank,Checking,"$1,000.00"', 'Accounts Receivable (A/R),Accounts receivable (A/R),Accounts Receivable (A/R),0',
  'Consulting Income,Income,Service/Fee Income,0', 'Shop Supplies,Expenses,Supplies & Materials,0', 'Truck Loan,Long Term Liabilities,Loan Payable,0', 'Business Checking,Bank,Checking,0', 'Mystery,Weird Thing,x,0'].join('\n');
const XERO_ACCOUNTS = ['*Code,*Name,*Type,*Tax Code,Description', '4300,Training Revenue,Revenue,Tax Exempt,', '7000,Coffee & Snacks,Expense,Tax Exempt,', '1100,Petty Cash Box,Current Asset,Tax Exempt,'].join('\n');

test('migração do QuickBooks e do Xero: contas, contatos e saldos iniciais', async () => {
  const pre = await call('/migrate/accounts', 'POST', { csv: QBO_ACCOUNTS });
  assert.equal(pre.status, 200, pre.text);
  assert.equal(pre.body.created, 4); assert.equal(pre.body.mapped, 1); assert.equal(pre.body.exists, 1); assert.equal(pre.body.invalid, 1);
  assert.equal(get("SELECT 1 FROM accounts WHERE name='Shop Supplies'"), undefined, 'prévia não grava nada');
  const real = await call('/migrate/accounts', 'POST', { csv: QBO_ACCOUNTS, apply: true });
  assert.equal(real.body.created, 4);
  const supplies = get("SELECT * FROM accounts WHERE name='Shop Supplies'");
  assert.equal(supplies.type, 'expense'); assert.match(supplies.code, /^6\d{3}$/);
  assert.equal(get("SELECT type FROM accounts WHERE name='Truck Loan'").type, 'liability');
  assert.equal(get("SELECT COUNT(*) AS n FROM accounts WHERE subtype='ar'").n, 1, 'conta a receber do arquivo aponta para a de sistema');
  const again = await call('/migrate/accounts', 'POST', { csv: QBO_ACCOUNTS, apply: true });
  assert.equal(again.body.created, 0);
  const x = await call('/migrate/accounts', 'POST', { csv: XERO_ACCOUNTS, apply: true });
  assert.equal(x.body.created, 3);
  assert.equal(get("SELECT code,type FROM accounts WHERE name='Training Revenue'").code, '4300');
  assert.equal(get("SELECT type FROM accounts WHERE name='Coffee & Snacks'").type, 'expense');
  assert.equal((await call('/migrate/accounts', 'POST', { csv: 'foo,bar\n1,2' })).status, 400);
  assert.equal((await call('/migrate/nope', 'POST', { csv: 'a' })).status, 400);

  const qboCust = ['Customer Contact List', '', 'Customer,Email,Phone Numbers,Billing Address', 'Blue Bakery,blue@bakery.test,555-0100,"12 Main St, Austin TX"', 'Acme Co,acme@example.com,,'].join('\n');
  const c = await call('/migrate/contacts', 'POST', { csv: qboCust, contact_kind: 'customer', apply: true });
  assert.equal(c.body.created, 1); assert.equal(c.body.exists, 1);
  assert.equal(get("SELECT email FROM contacts WHERE name='Blue Bakery'").email, 'blue@bakery.test');
  const xeroC = ['*ContactName,EmailAddress,IsSupplier,IsCustomer', 'Blue Bakery,,TRUE,FALSE', 'Flour Mill,mill@x.test,TRUE,FALSE'].join('\n');
  const xc = await call('/migrate/contacts', 'POST', { csv: xeroC, apply: true });
  assert.equal(xc.body.created, 1); assert.equal(xc.body.updated, 1);
  assert.equal(get("SELECT kind FROM contacts WHERE name='Blue Bakery'").kind, 'both');

  // saldos iniciais (balancete)
  const tb = (rows) => ['Trial Balance', 'As of 2025-12-31', '', ',Debit,Credit', ...rows, 'TOTAL,,'].join('\n');
  const good = tb(['Business Checking,"$1,500.00",', 'Accounts Receivable (A/R),500.00,', 'Truck Loan,,"1,000.00"', "Owner's Equity - Capital,,\"1,000.00\""]);
  const unknown = await call('/migrate/opening', 'POST', { csv: good, asof: '2025-12-31' });
  assert.equal(unknown.body.unknown.length, 1);
  assert.equal((await call('/migrate/opening', 'POST', { csv: good, asof: '2025-12-31', apply: true })).status, 409, 'conta desconhecida bloqueia');
  const withCapital = tb(['Business Checking,"$1,500.00",', 'Accounts Receivable (A/R),500.00,', 'Truck Loan,,"1,000.00"', 'Owner Capital,,"1,000.00"']);
  const off = tb(['Business Checking,"$1,500.00",', 'Truck Loan,,"1,000.00"']);
  const offR = await call('/migrate/opening', 'POST', { csv: off, asof: '2025-12-31', apply: true });
  assert.equal(offR.status, 409); assert.equal(offR.body.difference, 50000);
  assert.equal((await call('/migrate/opening', 'POST', { csv: withCapital, apply: true })).status, 400, 'a data é obrigatória');
  const applied = await call('/migrate/opening', 'POST', { csv: withCapital, asof: '2025-12-31', apply: true });
  assert.equal(applied.status, 200, applied.text); assert.equal(applied.body.applied, true);
  const checking = get("SELECT id FROM accounts WHERE name='Business Checking'").id;
  assert.equal(get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=?', checking).v, 150000);
  assert.equal(get("SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.source_type='opening' AND jl.account_id=?", A('1200')).v, 50000, 'A/R do arquivo caiu na conta de sistema');
  assert.equal((await call('/migrate/opening', 'POST', { csv: withCapital, asof: '2025-12-31', apply: true })).status, 409, 'só uma vez');
  const bs = await call('/reports/balance-sheet?asof=2025-12-31');
  assert.equal(bs.body.balanced, true);
});

test('aprovação de contas a pagar com limite e separação de funções', async () => {
  const v = vendor();
  const owner = get("SELECT id FROM users WHERE role='owner'");
  const b = bill(v, 100000, { created_by: owner.id });
  const small = bill(v, 10000);
  assert.equal((await call('/approvals')).body.pending.length, 0, 'sem limite, nada pede aprovação');
  const set = await call('/approvals/settings', 'PUT', { threshold: 50000, segregation: true });
  assert.equal(set.body.threshold, 50000);
  const list = await call('/approvals');
  assert.deepEqual(list.body.pending.map((x) => x.id), [b.id]);
  const blocked = await call(`/doc/${b.id}/payments`, 'POST', { date: t, amount: 100000, account_id: A('1010') });
  assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'approval_required');
  assert.equal((await call(`/doc/${small.id}/payments`, 'POST', { date: t, amount: 10000, account_id: A('1010') })).status, 200, 'abaixo do limite paga normalmente');
  // quem lançou não aprova a própria conta
  runSql('UPDATE docs SET created_by=? WHERE id=?', owner.id, b.id);
  const self = await call(`/doc/${b.id}/approve`, 'POST', {});
  assert.equal(self.status, 403);
  await call('/approvals/settings', 'PUT', { segregation: false });
  const rej = await call(`/doc/${b.id}/reject`, 'POST', {});
  assert.equal(rej.body.approval_status, 'rejected');
  assert.match((await call(`/doc/${b.id}/payments`, 'POST', { date: t, amount: 100000, account_id: A('1010') })).body.error, /rejected/);
  const app_ = await call(`/doc/${b.id}/approve`, 'POST', {});
  assert.equal(app_.body.approval_status, 'approved');
  assert.equal((await call('/approvals')).body.pending.length, 0);
  // o valor sobe depois da aprovação: pede aprovação de novo
  acc.saveDoc({ id: b.id, type: 'bill', contact_id: v, issue_date: t, due_date: day(20), post: true, lines: [{ description: 'supplies', qty: 1, unit_price: 150000 }] }, { id: 1 });
  assert.equal((await call('/approvals')).body.pending.length, 1);
  assert.equal((await call(`/doc/${b.id}/payments`, 'POST', { date: t, amount: 150000, account_id: A('1010') })).status, 409);
  await call(`/doc/${b.id}/approve`, 'POST', {});
  assert.equal((await call(`/doc/${b.id}/payments`, 'POST', { date: t, amount: 150000, account_id: A('1010') })).status, 200);
  assert.equal((await call('/approvals/settings', 'PUT', { threshold: -5 })).status, 400);
});

test('ativos fixos: depreciação linear mês a mês, sem duplicar, e baixa com ganho ou perda', async () => {
  const bad = await call('/assets', 'POST', { name: 'X', acquired_date: '2026-01-15', cost: 1000, salvage: 2000, life_months: 12 });
  assert.equal(bad.status, 400);
  const cost = 1200100; // US$ 12.001,00 — o último mês absorve o centavo que sobra
  const a = await call('/assets', 'POST', { name: 'Delivery truck', acquired_date: '2026-01-15', cost, salvage: 100, life_months: 12 });
  assert.equal(a.status, 200, a.text);
  const depr = await call('/assets/depreciate', 'POST', { through: '2026-03' });
  assert.equal(depr.body.posted.length, 3);
  const per = Math.floor((cost - 100) / 12);
  assert.equal(depr.body.total, per * 3);
  assert.equal((await call('/assets/depreciate', 'POST', { through: '2026-03' })).body.posted.length, 0, 'sem duplicar');
  const la = (await call('/assets')).body.assets[0];
  assert.equal(la.depreciated, per * 3); assert.equal(la.book_value, cost - per * 3);
  const tb = await call(`/reports/trial-balance?asof=${day(400)}`);
  assert.equal(tb.body.totalDebit, tb.body.totalCredit, 'o balancete segue fechando');
  const accum = get("SELECT id FROM accounts WHERE subtype='accum_depr'").id;
  assert.equal(get('SELECT COALESCE(SUM(credit-debit),0) AS v FROM journal_lines WHERE account_id=?', accum).v, per * 3);
  assert.equal((await call(`/assets/${la.id}`, 'DELETE')).status, 400, 'com depreciação não apaga');
  // até o fim da vida útil: o total depreciado é exatamente custo - residual
  await call('/assets/depreciate', 'POST', { through: '2027-12' });
  const done = (await call('/assets')).body.assets[0];
  assert.equal(done.depreciated, cost - 100); assert.equal(done.fully_depreciated, true);
  // baixa (venda) com ganho
  const sold = await call(`/assets/${la.id}/dispose`, 'POST', { date: '2028-01-10', proceeds: 500000, deposit_account_id: A('1010') });
  assert.equal(sold.status, 200, sold.text);
  assert.equal(sold.body.gain, 500000 + (cost - 100) - cost); assert.equal(sold.body.loss, 0);
  assert.equal((await call(`/assets/${la.id}/dispose`, 'POST', { date: '2028-01-11', proceeds: 0 })).status, 400);
  const tb2 = await call('/reports/trial-balance');
  assert.equal(tb2.body.totalDebit, tb2.body.totalCredit);
  // outro ativo vendido com perda
  const b = (await call('/assets', 'POST', { name: 'Laptop', acquired_date: '2026-06-01', cost: 300000, salvage: 0, life_months: 36 })).body;
  const lost = await call(`/assets/${b.id}/dispose`, 'POST', { date: '2026-08-20', proceeds: 100000, deposit_account_id: A('1010') });
  assert.equal(lost.body.loss, 300000 - 3 * Math.floor(300000 / 36) - 100000); assert.equal(lost.body.gain, 0);
  const tb3 = await call('/reports/trial-balance');
  assert.equal(tb3.body.totalDebit, tb3.body.totalCredit);
  // período fechado: pula e avisa
  const c = (await call('/assets', 'POST', { name: 'Printer', acquired_date: '2026-02-01', cost: 120000, life_months: 12 })).body;
  await call('/lock-date', 'PUT', { date: '2026-02-28' }).catch(() => {});
  const lockedRun = await call('/assets/depreciate', 'POST', { through: '2026-03' });
  assert.ok(lockedRun.body.skipped.some((s) => s.asset === 'Printer' && s.period === '2026-02'));
  await call('/lock-date', 'PUT', { date: '' }).catch(() => {});
  void c;
});

test('fechamento do mês: itens automáticos e manuais, e trava ao concluir', async () => {
  const p = '2025-11';
  const c0 = await call(`/close/${p}`);
  assert.equal(c0.status, 200);
  const keys = c0.body.items.map((i) => i.key);
  assert.deepEqual(keys, ['bank_rec', 'depreciation', 'approvals', 'payroll', 'review_ar', 'review_ap', 'review_reports']);
  assert.equal(c0.body.ready, false);
  assert.equal((await call(`/close/${p}/lock`, 'POST', {})).status, 409);
  assert.equal((await call(`/close/${p}/bank_rec`, 'POST', { done: true })).status, 400, 'item automático não se marca');
  for (const k of ['review_ar', 'review_ap', 'review_reports']) assert.equal((await call(`/close/${p}/${k}`, 'POST', { done: true })).status, 200);
  const undo = await call(`/close/${p}/review_ap`, 'POST', { done: false });
  assert.equal(undo.body.items.find((i) => i.key === 'review_ap').done, false);
  await call(`/close/${p}/review_ap`, 'POST', { done: true });
  const ready = await call(`/close/${p}`);
  assert.equal(ready.body.ready, true, JSON.stringify(ready.body.items.filter((i) => !i.done)));
  const locked = await call(`/close/${p}/lock`, 'POST', {});
  assert.equal(locked.status, 200); assert.equal(locked.body.locked, true);
  assert.equal(get("SELECT value FROM settings WHERE key='lock_date'").value, '2025-11-30');
  assert.equal((await call('/close/2025-13')).status, 400);
  await call('/lock-date', 'PUT', { date: '' }).catch(() => {});
});

test('previsão de caixa semanal', async () => {
  const cid = customer(), v = vendor();
  const before = (await call('/reports/forecast?weeks=8')).body;
  invoice(cid, 30000, { due_date: day(10) });
  bill(v, 12000, { due_date: day(20) });
  const f = (await call('/reports/forecast?weeks=8')).body;
  assert.equal(f.rows.length, 8);
  assert.equal(f.startingCash, before.startingCash);
  const w2 = f.rows[1], w3 = f.rows[2];
  assert.equal(w2.inflow - before.rows[1].inflow, 30000); // dia 10 cai na semana 2
  assert.equal(w3.outflow - before.rows[2].outflow, 12000);
  let run = f.startingCash;
  for (const r of f.rows) { run += r.inflowTotal - r.outflowTotal; assert.equal(r.ending, run); }
  assert.equal(f.endingCash, run);
  assert.equal((await call('/reports/forecast?weeks=999')).body.weeks, 52);
});

test('exportação da auditoria (CSV) neutraliza fórmulas e respeita o plano', async () => {
  await call('/contacts', 'POST', { kind: 'customer', name: '=HYPERLINK("http://x")' });
  const r = await call('/audit/export.csv');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.ok(r.text.split('\n').length > 3);
  assert.ok(!/(^|,)=HYPERLINK/.test(r.text));
  await setPlan('advanced');
  assert.equal((await call('/audit/export.csv')).status, 402);
  await setPlan('enterprise');
});

test.after(() => { server.close(); mock.close(); fs.rmSync(mailFile, { force: true }); setTimeout(() => process.exit(0), 100).unref(); });
