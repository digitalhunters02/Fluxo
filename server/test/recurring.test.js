import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert, run, setSetting } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let owner = '';
const cust = insert("INSERT INTO contacts(kind,name) VALUES('customer','Acme')");
const vend = insert("INSERT INTO contacts(kind,name) VALUES('vendor','Landlord')");
const tpl = (extra = {}) => ({ contact_id: cust, terms_days: 10, lines: [{ description: 'Retainer', qty: 1, unit_price: 25000, tax_rate: 0 }], ...extra });
const make = (body) => call('/recurring', 'POST', { name: 'Monthly', frequency: 'monthly', next_date: '2026-01-31', auto_post: true, template: tpl(), ...body }, owner);

test('setup', async () => { owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en' })).body.token; assert.ok(owner); });

test('datas: 31 de fevereiro não existe e a série mensal volta ao dia 31', () => {
  assert.equal(acc.isDate('2026-02-31'), false); assert.equal(acc.isDate('2026-04-31'), false); assert.equal(acc.isDate('2028-02-29'), true); assert.equal(acc.isDate('2026-02-29'), false); assert.equal(acc.isDate('2026-13-01'), false);
  let d = '2026-01-31'; const seq = [];
  for (let i = 0; i < 5; i++) { d = acc.advance(d, 'monthly', 31); seq.push(d); }
  assert.deepEqual(seq, ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);          // sem derivar para o dia 28
  assert.equal(acc.advance('2026-11-30', 'quarterly', 30), '2027-02-28');
  assert.equal(acc.advance('2028-02-29', 'yearly', 29), '2029-02-28');
  assert.equal(acc.advance('2026-03-01', 'weekly'), '2026-03-08');
  assert.throws(() => acc.advance('2026-03-01', 'daily'));
});

test('"hoje" respeita o fuso da empresa (à noite nos EUA, UTC já é o dia seguinte)', async () => {
  const night = new Date('2026-03-10T02:30:00Z');                                 // 22h30 em Nova York (horário de verão)
  assert.equal(acc.today(night), '2026-03-09');
  assert.equal((await call('/settings', 'PUT', { timezone: 'America/Los_Angeles' }, owner)).status, 200);
  assert.equal(acc.today(new Date('2026-03-10T06:30:00Z')), '2026-03-09');         // 23h30 em Los Angeles
  assert.equal((await call('/settings', 'PUT', { timezone: 'Mars/Olympus' }, owner)).status, 400);
  await call('/settings', 'PUT', { timezone: 'UTC' }, owner); assert.equal(acc.today(night), '2026-03-10');
  await call('/settings', 'PUT', { timezone: 'America/New_York' }, owner);
});

test('recorrente mensal no dia 31 gera faturas em 31/jan, 28/fev, 31/mar, 30/abr, sem duplicar', async () => {
  const c = await make({}); assert.equal(c.status, 200);
  assert.equal(acc.runRecurring('2026-05-01').length, 4);
  const inv = all("SELECT issue_date, due_date, status FROM docs WHERE recurring_id=? ORDER BY issue_date", c.body.id);
  assert.deepEqual(inv.map((x) => x.issue_date), ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.equal(inv[0].due_date, '2026-02-10'); assert.ok(inv.every((x) => x.status === 'sent'));        // auto-emitidas
  assert.equal(get('SELECT next_date FROM recurring WHERE id=?', c.body.id).next_date, '2026-05-31');
  assert.equal(acc.runRecurring('2026-05-01').length, 0);                                               // rodar de novo não duplica
  assert.equal(acc.runRecurring('2026-05-31').length, 1);
});

test('falha na geração (período fechado) não perde a data nem deixa fatura pela metade; avisa e se recupera', async () => {
  const c = await make({ name: 'Locked', frequency: 'weekly', next_date: '2026-06-01', auto_post: true });
  setSetting('lock_date', '2026-06-30');
  assert.equal(acc.runRecurring('2026-06-10').length, 0);
  const r = get('SELECT * FROM recurring WHERE id=?', c.body.id);
  assert.equal(r.next_date, '2026-06-01'); assert.match(r.last_error, /./);                           // data intacta, erro registrado
  assert.equal(get('SELECT COUNT(*) n FROM docs WHERE recurring_id=?', c.body.id).n, 0);
  assert.equal(get('SELECT COUNT(*) n FROM journal_entries WHERE memo LIKE ?', '%Locked%').n, 0);
  const rem = (await call('/reminders', 'GET', undefined, owner)).body.find((x) => x.kind === 'recurring');
  assert.ok(rem); assert.equal(rem.data.name, 'Locked');                                              // vira lembrete
  setSetting('lock_date', '');
  assert.equal(acc.runRecurring('2026-06-10').length, 2);                                             // 1º e 8 de junho, recuperadas
  assert.equal(get('SELECT last_error FROM recurring WHERE id=?', c.body.id).last_error, '');
  assert.equal((await call('/reminders', 'GET', undefined, owner)).body.some((x) => x.kind === 'recurring'), false);
});

test('data final encerra a série depois da última fatura', async () => {
  const c = await make({ name: 'Ends', frequency: 'weekly', next_date: '2026-07-01', end_date: '2026-07-15', auto_post: false });
  acc.runRecurring('2026-08-30');
  assert.equal(get('SELECT COUNT(*) n FROM docs WHERE recurring_id=?', c.body.id).n, 3);               // 1, 8 e 15 de julho
  const r = get('SELECT * FROM recurring WHERE id=?', c.body.id);
  assert.equal(r.active, 0);
  assert.ok(all('SELECT status FROM docs WHERE recurring_id=?', c.body.id).every((x) => x.status === 'draft'));
});

test('contas a pagar recorrentes (aluguel) geram a conta do fornecedor', async () => {
  const c = await call('/recurring', 'POST', { name: 'Rent', frequency: 'monthly', next_date: '2026-09-01', auto_post: true, template: { type: 'bill', contact_id: vend, terms_days: 5, lines: [{ description: 'Office rent', qty: 1, unit_price: 180000 }] } }, owner);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  acc.runRecurring('2026-10-02');
  const bills = all("SELECT type, status, total, due_date FROM docs WHERE recurring_id=? ORDER BY issue_date", c.body.id);
  assert.deepEqual(bills.map((b) => [b.type, b.status, b.total, b.due_date]), [['bill', 'open', 180000, '2026-09-06'], ['bill', 'open', 180000, '2026-10-06']]);
  assert.equal(get("SELECT SUM(credit-debit) v FROM journal_lines WHERE account_id=(SELECT id FROM accounts WHERE subtype='ap')").v, 360000);   // contas a pagar no razão
  const list = (await call('/recurring', 'GET', undefined, owner)).body;
  assert.equal(list.find((x) => x.id === c.body.id).type, 'bill'); assert.equal(list.find((x) => x.name === 'Monthly').type, 'invoice');
});

test('validações: datas impossíveis, total zero, linha vazia, fornecedor inexistente', async () => {
  assert.equal((await make({ next_date: '2026-02-31' })).status, 400);
  assert.equal((await make({ end_date: '2025-01-01' })).status, 400);
  assert.equal((await make({ template: tpl({ lines: [{ description: 'x', qty: 1, unit_price: 0 }] }) })).status, 400);
  assert.equal((await make({ template: tpl({ lines: [{ description: '', qty: 1, unit_price: 100 }] }) })).status, 400);
  assert.equal((await make({ template: tpl({ contact_id: 99999 }) })).status, 400);
  assert.equal((await make({ frequency: 'daily' })).status, 400);
  assert.equal((await call('/recurring/99999', 'PUT', { active: false }, owner)).status, 404);
  assert.equal((await call('/recurring/99999', 'DELETE', undefined, owner)).status, 404);
});

test('editar: nova data, frequência e pausa; reativar limpa o erro', async () => {
  const c = await make({ name: 'Edit me', frequency: 'monthly', next_date: '2027-01-15' });
  assert.equal((await call(`/recurring/${c.body.id}`, 'PUT', { next_date: '2027-03-31', frequency: 'quarterly', name: 'Renamed', auto_post: false }, owner)).status, 200);
  const r = get('SELECT * FROM recurring WHERE id=?', c.body.id);
  assert.deepEqual([r.next_date, r.frequency, r.name, r.auto_post, r.anchor_day], ['2027-03-31', 'quarterly', 'Renamed', 0, 31]);
  assert.equal((await call(`/recurring/${c.body.id}`, 'PUT', { next_date: '2027-02-30' }, owner)).status, 400);
  assert.equal((await call(`/recurring/${c.body.id}`, 'PUT', { active: false }, owner)).status, 200);
  assert.equal(get('SELECT active FROM recurring WHERE id=?', c.body.id).active, 0);
});

test('permissões e plano: só quem pode vender cria; conta a pagar exige permissão de compras; plano Free não usa', async () => {
  assert.equal((await call('/users', 'POST', { name: 'Vera', email: 'v@x.com', password: 'senha1234', perms: { read: ['sales'], write: ['sales'] } }, owner)).status, 200);
  const vera = (await call('/login', 'POST', { email: 'v@x.com', password: 'senha1234' })).body.token;
  assert.equal((await make({ name: 'By Vera' }).then(() => call('/recurring', 'POST', { name: 'V', frequency: 'monthly', next_date: '2027-05-01', template: tpl() }, vera))).status, 200);
  assert.equal((await call('/recurring', 'POST', { name: 'VB', frequency: 'monthly', next_date: '2027-05-01', template: { type: 'bill', contact_id: vend, lines: [{ description: 'x', qty: 1, unit_price: 100 }] } }, vera)).status, 403);
  assert.equal((await call('/recurring', 'GET', undefined, vera)).body.some((x) => x.type === 'bill'), false);   // não vê as de compras
  await call('/plan', 'PUT', { plan: 'free' }, owner);
  assert.equal((await call('/recurring', 'GET', undefined, owner)).status, 402);
  assert.equal((await call('/recurring/run', 'POST', {}, owner)).status, 402);
});
test.after(() => server.close());
