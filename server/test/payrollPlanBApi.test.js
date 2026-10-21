// Folha "Plano B" pela API: complemento (402), só administrador (403), confirmação "conferi" (400), arquivos e registro de auditoria.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let owner = '', acct = '';
const call = async (p, method = 'GET', body, tk = owner) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = {}; try { json = JSON.parse(buf.toString()); } catch { /* arquivo */ }
  return { status: r.status, body: json, buf, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '' };
};
let empId, runId, bankId;

test('prepara: dono, contador (papel accountant), funcionário e configurações', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en' }, '')).body.token;
  assert.ok(owner);
  assert.equal((await call('/users', 'POST', { name: 'Ana Acc', email: 'a@x.com', password: 'senha1234', role: 'accountant' })).status, 200);
  acct = (await call('/login', 'POST', { email: 'a@x.com', password: 'senha1234' }, '')).body.token;
  const e = await call('/payroll/employees', 'POST', { name: 'Maria Silva', hire_date: '2026-01-05', pay_basis: 'year', pay_rate: 5_200_000, frequency: 'biweekly', filing_status: 'single', tax_id: '123-45-6789', address: '1 Elm St', city: 'Miami', state: 'fl', zip: '33101' });
  assert.equal(e.status, 200, JSON.stringify(e.body)); empId = e.body.id; assert.equal(e.body.state, 'FL'); assert.equal(e.body.has_bank, false);
  bankId = (await call('/banking/accounts')).body.find((a) => a.subtype === 'bank').id;
});

test('conta bancária do funcionário: só o dono vê/edita; cifrada no banco; mascarada na API', async () => {
  assert.equal((await call(`/payroll/employees/${empId}/bank`, 'PUT', { routing: '021000022', account: '123456789', type: 'checking' })).status, 400); // dígito verificador
  const r = await call(`/payroll/employees/${empId}/bank`, 'PUT', { routing: '021000021', account: '123456789', type: 'checking' });
  assert.equal(r.status, 200); assert.equal(r.body.account_mask, '****6789');
  const raw = get('SELECT bank_account_enc FROM employees WHERE id=?', empId).bank_account_enc;
  assert.ok(raw.startsWith('enc1:') && !raw.includes('123456789'));
  const list = await call('/payroll/employees');
  assert.ok(!list.buf.toString().includes('123456789') && !list.buf.toString().includes('enc1:'));
  assert.equal(list.body[0].bank_account_mask, '****6789');
  // contador: vê só "tem conta"; não lê nem muda os dados do banco
  const al = await call('/payroll/employees', 'GET', undefined, acct);
  assert.equal(al.status, 200); assert.equal(al.body[0].has_bank, true); assert.equal(al.body[0].bank_routing, undefined); assert.equal(al.body[0].bank_account_mask, undefined);
  assert.equal((await call(`/payroll/employees/${empId}/bank`, 'GET', undefined, acct)).status, 403);
  assert.equal((await call(`/payroll/employees/${empId}/bank`, 'PUT', { routing: '021000021', account: '99999999' }, acct)).status, 403);
  assert.equal((await call('/payroll/settings', 'PUT', { nacha: { nacha_odfi_routing: '021000021' } }, acct)).status, 403);
  assert.equal((await call(`/payroll/employees/${empId}/bank`)).body.routing, '021000021');
});

test('folha finalizada → arquivo NACHA: exige "conferi", só o dono, registros de 94 e registro de auditoria', async () => {
  const s = await call('/payroll/settings', 'PUT', { nacha: { nacha_company_name: 'Acme', nacha_ein: '12-3456789', nacha_odfi_routing: '021000021', nacha_bank_name: 'Chase' } });
  assert.equal(s.status, 200); assert.equal(s.body.nacha.nacha_ein, '123456789');
  const r = await call('/payroll/runs', 'POST', { type: 'regular', period_start: '2026-10-01', period_end: '2026-10-14', pay_date: '2026-10-16', lines: [{ employee_id: empId }] });
  runId = r.body.id;
  assert.equal((await call(`/payroll/runs/${runId}/nacha`, 'POST', { reviewed: true })).status, 400); // rascunho
  assert.equal((await call(`/payroll/runs/${runId}/finalize`, 'POST', { paid_from_id: bankId })).status, 200);
  const pv = await call(`/payroll/runs/${runId}/nacha`);
  assert.equal(pv.body.rows[0].method, 'deposit'); assert.equal(pv.body.configured, true);
  const noReview = await call(`/payroll/runs/${runId}/nacha`, 'POST', {});
  assert.equal(noReview.status, 400); assert.equal(noReview.body.code, 'review_required');
  assert.equal((await call(`/payroll/runs/${runId}/nacha`, 'POST', { reviewed: true }, acct)).status, 403);
  const f = await call(`/payroll/runs/${runId}/nacha`, 'POST', { reviewed: true });
  assert.equal(f.status, 200); assert.match(f.disp, /\.ach"/);
  const lines = f.buf.toString().trimEnd().split('\r\n');
  assert.ok(lines.every((l) => l.length === 94)); assert.equal(lines.length % 10, 0);
  assert.ok(lines[2].includes('123456789'));
  const txt = await call(`/payroll/runs/${runId}/nacha`, 'POST', { reviewed: true, ext: 'txt', effective_date: '2026-10-19' });
  assert.match(txt.disp, /2026-10-19.*\.txt"/);
  const log = await call('/payroll/files');
  assert.equal(log.body.length, 2); assert.equal(log.body[1].kind, 'nacha'); assert.equal(log.body[1].user_name, 'Dono'); assert.equal(log.body[1].totals.entries, 1); assert.equal(log.body[1].sha256.length, 64);
  assert.ok(get("SELECT 1 FROM audit_log WHERE entity='payroll_file'"));
});

test('depósitos: lista, marcar como pago (contador pode), recibo, 941 abate o depósito', async () => {
  const d = await call('/payroll/deposits?year=2026', 'GET', undefined, acct);
  assert.equal(d.status, 200);
  const oct = d.body.deposits.find((x) => x.key === '941:M:2026-10');
  assert.equal(oct.due_date, '2026-11-16'); assert.equal(d.body.schedules[0].schedule, 'monthly');
  const p = await call('/payroll/deposits/pay', 'POST', { key: oct.key, paid_date: '2026-10-20', account_id: bankId, eftps_confirmation: '2700123', receipt: 'data:image/png;base64,iVBORw0KGgo=', receipt_name: 'eftps.png' }, acct);
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const after = (await call('/payroll/deposits?year=2026')).body.deposits.find((x) => x.key === oct.key);
  assert.equal(after.status, 'paid');
  assert.equal((await call(`/payroll/deposits/${after.payment.id}/receipt`)).body.name, 'eftps.png');
  const f941 = await call('/payroll/forms/941?year=2026&quarter=4');
  assert.equal(f941.body.lines[13], oct.amount); assert.equal(f941.body.lines[12], oct.amount); assert.equal(f941.body.lines[14], 0);
  assert.equal(f941.body.official, false);
  assert.equal((await call(`/payroll/deposits/${after.payment.id}`, 'DELETE')).status, 200);
  assert.equal((await call('/payroll/deposits/pay', 'POST', { key: oct.key, paid_date: '2026-10-20', account_id: bankId })).status, 200);
});

test('formulários: confirmação obrigatória (400), PDFs/arquivos; EFW2 e CSV do IRIS só para o dono', async () => {
  for (const [p, body] of [['/payroll/forms/941', { year: 2026, quarter: 4 }], ['/payroll/forms/940', { year: 2026 }], ['/payroll/forms/w2', { year: 2026 }]]) {
    const no = await call(p, 'POST', body); assert.equal(no.status, 400, p); assert.equal(no.body.code, 'review_required');
    const yes = await call(p, 'POST', { ...body, reviewed: true }, acct); assert.equal(yes.status, 200, p); assert.match(yes.type, /pdf/); assert.equal(yes.buf.slice(0, 5).toString(), '%PDF-');
  }
  assert.equal((await call('/payroll/forms/efw2', 'POST', { year: 2026, reviewed: true }, acct)).status, 403);
  const miss = await call('/payroll/forms/efw2', 'POST', { year: 2026, reviewed: true });
  assert.equal(miss.status, 400); assert.ok(miss.body.missing.includes('BSO User ID'));
  await call('/payroll/settings', 'PUT', { employer: { employer_ein: '123456789', employer_name: 'Acme', employer_address: '1 Main', employer_city: 'Miami', employer_state: 'FL', employer_zip: '33101', w2_bso_user_id: 'AB12CD34', w2_contact_name: 'Dono', w2_contact_phone: '3055550100', w2_contact_email: 'o@x.com' } });
  const ef = await call('/payroll/forms/efw2', 'POST', { year: 2026, reviewed: true });
  assert.equal(ef.status, 200); assert.ok(ef.buf.toString().split('\r\n').filter(Boolean).every((r) => r.length === 512));
  const w2 = await call('/payroll/forms/w2?year=2026', 'GET', undefined, acct);
  assert.deepEqual(w2.body.problems, []); assert.ok(!w2.buf.toString().includes('123-45-6789')); assert.equal(w2.body.rows[0].ssn_masked, '***-**-6789');
  assert.equal((await call('/payroll/forms/1099-iris', 'POST', { year: 2026, reviewed: true }, acct)).status, 403);
  assert.equal((await call('/payroll/forms/1099-iris', 'POST', { year: 2026 })).status, 400);
  const kinds = (await call('/payroll/files')).body.map((x) => x.kind);
  for (const k of ['form941', 'form940', 'w2', 'efw2']) assert.ok(kinds.includes(k), k);
});

test('vigia das tabelas: status para todos com folha; "verificar agora" só o dono', async () => {
  const s = await call('/payroll/tax-tables', 'GET', undefined, acct);
  assert.equal(s.status, 200); assert.deepEqual(s.body.tableYears, [2026]);
  assert.equal((await call('/payroll/tax-tables/check', 'POST', {}, acct)).status, 403);
});

test('sem o complemento de folha: todas as rotas novas respondem 402', async () => {
  assert.equal((await call('/plan', 'PUT', { payroll: false })).status, 200);
  for (const [p, m] of [[`/payroll/employees/${empId}/bank`, 'GET'], [`/payroll/runs/${runId}/nacha`, 'POST'], ['/payroll/deposits', 'GET'], ['/payroll/deposits/pay', 'POST'], ['/payroll/forms/941?year=2026&quarter=1', 'GET'],
    ['/payroll/forms/940', 'POST'], ['/payroll/forms/w2', 'POST'], ['/payroll/forms/efw2', 'POST'], ['/payroll/forms/1099', 'GET'], ['/payroll/forms/1099-iris', 'POST'], ['/payroll/files', 'GET'], ['/payroll/settings', 'GET'], ['/payroll/tax-tables', 'GET']]) {
    const r = await call(p, m, m === 'POST' ? { reviewed: true } : undefined);
    assert.equal(r.status, 402, p); assert.equal(r.body.feature, 'payroll');
  }
  await call('/plan', 'PUT', { payroll: true });
});

test('lembrete no sino 3 dias antes e no dia do depósito', async () => {
  const auto = await import('../src/automations.js');
  const dep = await import('../src/payrollDeposits.js');
  const all = dep.depositNotices('2026-11-13').map((d) => [d.key, d.stage]);
  assert.deepEqual(all.filter(([k]) => k.startsWith('941')), []); // outubro já pago
  await call(`/payroll/deposits/${get('SELECT id FROM tax_deposits').id}`, 'DELETE');
  assert.deepEqual(dep.depositNotices('2026-11-13').filter((d) => d.key === '941:M:2026-10').map((d) => d.stage), ['soon']);
  assert.deepEqual(dep.depositNotices('2026-11-16').filter((d) => d.key === '941:M:2026-10').map((d) => d.stage), ['due']);
  assert.deepEqual(dep.depositNotices('2026-11-10').filter((d) => d.key === '941:M:2026-10'), []);
  auto.generate();
  assert.ok(typeof auto.listReminders === 'function');
});

test.after(() => server.close());
