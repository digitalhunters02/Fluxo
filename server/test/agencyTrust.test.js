// Agência de seguros: modelo de plano de contas + custódia (prêmio recebido, repasse à seguradora, comissão retida) enviados pela API.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '', headers = {}) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let owner, key, roKey;
const v1 = (p, m = 'GET', b, k = key) => call(`/v1${p}`, m, b, '', { authorization: `Bearer ${k}` });
const bal = (subtype) => get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.subtype=?`, subtype).v;
const sums = (ids) => ids.map((i) => get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=?', i).v);

test('sem o modelo ligado a API recusa com instrução clara; o dono liga o modelo e ele só acrescenta contas', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en', demo: false })).body.token;
  key = (await call('/integrations/keys', 'POST', { name: 'Binder' }, owner)).body.key;
  roKey = (await call('/integrations/keys', 'POST', { name: 'Leitor', scope: 'read' }, owner)).body.key;
  const before = all('SELECT code,name FROM accounts ORDER BY code');
  const off = await v1('/trust-entries', 'POST', { externalId: 'binder-ledger-1', kind: 'client_payment', amountCents: 1000, date: '2026-10-01' });
  assert.equal(off.status, 409); assert.equal(off.body.code, 'template_required');
  assert.equal((await v1('/me')).body.features.trust, false);
  // o dono tem uma conta própria no 4200: o modelo não mexe nela
  insert("INSERT INTO accounts(code,name,type,subtype) VALUES('4200','Minha receita','income','')");
  const st0 = (await call('/accounts/templates', 'GET', undefined, owner)).body;
  assert.equal(st0.templates[0].applied, false);
  const on = await call('/accounts/templates/insurance-agency', 'POST', {}, owner);
  assert.equal(on.status, 200); assert.equal(on.body.created.length, 10); assert.equal(on.body.applied, true);
  for (const b of before) assert.deepEqual(get('SELECT code,name FROM accounts WHERE code=?', b.code), b, 'conta antiga intacta');
  assert.equal(get("SELECT name FROM accounts WHERE code='4200'").name, 'Minha receita');
  assert.equal(get("SELECT code FROM accounts WHERE subtype='ins_comm_new'").code, '4201', 'achou o próximo código livre');
  assert.equal(get("SELECT type FROM accounts WHERE subtype='trust_bank'").type, 'asset');
  const again = await call('/accounts/templates/insurance-agency', 'POST', {}, owner);
  assert.equal(again.body.created.length, 0, 'ligar de novo não duplica');
  assert.equal((await v1('/me')).body.features.trust, true);
  assert.equal((await call('/accounts/templates/insurance-agency', 'POST', {}, '')).status, 401, 'sem login não liga');
});

test('fluxo completo: prêmio recebido, repasse e comissão retida; a custódia fecha em zero e o caixa da agência não infla', async () => {
  const cashBefore = bal('bank');
  const send = (n, kind, amountCents, extra = {}) => v1('/trust-entries', 'POST', { externalId: `binder-ledger-${n}`, kind, amountCents, date: '2026-10-05', policyNumber: 'GL-100', insuredName: 'Nutmeg Logistics LLC', carrierName: 'Acme Mutual', ...extra });
  assert.equal((await send(1, 'client_payment', 100000)).status, 201);
  assert.equal(bal('trust_bank'), 100000); assert.equal(-bal('ins_payable'), 100000);
  assert.equal((await send(2, 'carrier_remit', 85000)).status, 201);
  assert.equal(bal('trust_bank'), 15000); assert.equal(-bal('ins_payable'), 15000);
  const cm = await send(3, 'commission_retained', 15000, { commissionType: 'renewal' });
  assert.equal(cm.status, 201);
  assert.equal(bal('trust_bank'), 0); assert.equal(bal('ins_payable'), 0);
  assert.equal(-bal('ins_comm_renewal'), 15000, 'renovação vai para a receita de renovação');
  assert.equal(bal('bank') - cashBefore, 15000, 'só a comissão entra no caixa da agência');
  const sum = (await v1('/trust/summary')).body;
  assert.equal(sum.differenceCents, 0); assert.equal(sum.entries, 3);
  // a seguradora virou fornecedor e o a repassar fica ligado a ela
  const vendor = get("SELECT id FROM contacts WHERE name='Acme Mutual' AND kind='vendor'");
  assert.ok(vendor); assert.ok(get('SELECT 1 FROM journal_lines WHERE contact_id=?', vendor.id));
  // todo lançamento fecha (débito = crédito)
  for (const e of all("SELECT id FROM journal_entries WHERE source_type='trust_api'")) {
    const t = get('SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_lines WHERE entry_id=?', e.id);
    assert.equal(t.d, t.c);
  }
});

test('reenviar não duplica; anular cria o lançamento inverso uma só vez; entradas inválidas são recusadas', async () => {
  const dup = await v1('/trust-entries', 'POST', { externalId: 'binder-ledger-1', kind: 'client_payment', amountCents: 100000, date: '2026-10-05' });
  assert.equal(dup.status, 200); assert.equal(dup.body.duplicate, true);
  assert.equal(bal('trust_bank'), 0, 'nada mudou');
  const v = await v1('/trust-entries/binder-ledger-3/void', 'POST', { date: '2026-10-06' });
  assert.equal(v.status, 201);
  assert.equal(bal('trust_bank'), 15000); assert.equal(-bal('ins_payable'), 15000); assert.equal(bal('ins_comm_renewal'), 0);
  const v2 = await v1('/trust-entries/binder-ledger-3/void', 'POST', {});
  assert.equal(v2.status, 200); assert.equal(v2.body.duplicate, true);
  assert.equal(bal('trust_bank'), 15000, 'anular de novo não mexe');
  assert.equal((await v1('/trust-entries/nao-existe/void', 'POST', {})).status, 404);
  for (const bad of [{ kind: 'mágica' }, { amountCents: 0 }, { amountCents: -5 }, { date: '10/05/2026' }, { externalId: '' }]) {
    const r = await v1('/trust-entries', 'POST', { externalId: 'x-1', kind: 'client_payment', amountCents: 100, date: '2026-10-05', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await v1('/trust-entries', 'POST', { externalId: 'ro', kind: 'client_payment', amountCents: 100 }, roKey)).status, 403, 'chave só de leitura não grava');
  assert.equal((await v1('/trust/summary', 'GET', undefined, roKey)).status, 200, 'mas pode ler os saldos');
});

test('mês fechado não aceita lançamento; a conta de custódia aparece para conciliar com o extrato', async () => {
  assert.equal((await call('/lock-date', 'PUT', { date: '2026-09-30' }, owner)).status, 200);
  const r = await v1('/trust-entries', 'POST', { externalId: 'old-1', kind: 'client_payment', amountCents: 500, date: '2026-09-15' });
  assert.equal(r.status, 400); assert.match(r.body.error, /closed/i);
  await call('/lock-date', 'PUT', { date: '' }, owner);
  const banks = (await call('/banking/accounts', 'GET', undefined, owner)).body;
  assert.ok(banks.some((a) => a.subtype === 'trust_bank'), 'conta de custódia pode ser conciliada');
});

test.after(() => server.close());
