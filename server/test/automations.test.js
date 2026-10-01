import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-auto-'));
process.env.FLUXO_DB = path.join(tmp, 'fluxo.db'); process.env.FLUXO_BACKUP_DIR = path.join(tmp, 'backups');
const { get, insert, run } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const auto = await import('../src/automations.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (p, method = 'GET', body, tk = token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const t = acc.today();
const cust = insert("INSERT INTO contacts(kind,name,email) VALUES('customer','Acme Co','ap@acme.com')");
const inv = (due) => acc.saveDoc({ type: 'invoice', contact_id: cust, issue_date: acc.addDays(due, -10), due_date: due, post: true, lines: [{ description: 's', qty: 1, unit_price: 5000 }] }, { id: 1 });

test('setup', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en' }, '');
  token = s.body.token; assert.equal(s.status, 200);
});

test('fatura vencida gera lembrete com dados para cobrar; ao pagar, o lembrete some', async () => {
  const d = inv(acc.addDays(t, -3)); inv(acc.addDays(t, 20));      // só a primeira venceu
  const r = (await call('/reminders')).body.filter((x) => x.kind === 'overdue');
  assert.equal(r.length, 1); assert.equal(r[0].overdue, true);
  assert.deepEqual([r[0].data.email, r[0].data.balance, r[0].data.number], ['ap@acme.com', 5000, d.number]);
  assert.equal(r[0].link, `/document/${d.id}`);
  acc.addPayment(d.id, { date: t, amount: 5000, account_id: get("SELECT id FROM accounts WHERE subtype='bank' LIMIT 1").id }, { id: 1 });
  assert.equal((await call('/reminders')).body.filter((x) => x.kind === 'overdue').length, 0);
});

test('dispensar um lembrete automático não o recria; adiar o esconde por alguns dias', async () => {
  const d = inv(acc.addDays(t, -5));
  let r = (await call('/reminders')).body.find((x) => x.ref_key === `overdue:${d.id}`);
  assert.ok(r);
  assert.equal((await call(`/reminders/${r.id}/snooze`, 'POST', { days: 2 })).status, 200);
  assert.equal((await call('/reminders')).body.some((x) => x.id === r.id), false);
  run('UPDATE reminders SET snoozed_until=NULL WHERE id=?', r.id);
  assert.equal((await call(`/reminders/${r.id}`, 'DELETE')).status, 200);
  assert.equal((await call('/reminders')).body.some((x) => x.ref_key === `overdue:${d.id}`), false);   // continua dispensado
});

test('desligar a automação remove os avisos dela; o limite de dias vale', async () => {
  const d = inv(acc.addDays(t, -2));
  assert.equal((await call('/reminders')).body.some((x) => x.ref_key === `overdue:${d.id}`), true);
  await call('/automations', 'PUT', { overdue_days: 7 });
  assert.equal((await call('/reminders')).body.some((x) => x.ref_key === `overdue:${d.id}`), false);   // ainda não passou de 7 dias
  await call('/automations', 'PUT', { overdue_days: 1, auto_overdue: false });
  assert.equal((await call('/reminders')).body.filter((x) => x.kind === 'overdue').length, 0);
  assert.equal((await call('/automations', 'PUT', { overdue_days: 400 })).status, 400);
  await call('/automations', 'PUT', { auto_overdue: true });
});

test('lembrete manual repetitivo cria o próximo ao concluir', async () => {
  const c = await call('/reminders', 'POST', { title: 'Pay payroll taxes', due_date: '2026-01-31', repeat: 'monthly' });
  assert.equal(c.status, 200);
  assert.equal((await call('/reminders', 'POST', { title: '', due_date: '2026-01-31' })).status, 400);
  assert.equal((await call('/reminders', 'POST', { title: 'x', due_date: 'amanhã' })).status, 400);
  assert.equal((await call(`/reminders/${c.body.id}/done`, 'POST')).status, 200);
  const next = (await call('/reminders')).body.filter((x) => x.title === 'Pay payroll taxes');
  assert.equal(next.length, 1); assert.equal(next[0].repeat, 'monthly');
  assert.ok(next[0].due_date > '2026-01-31');
  assert.equal(auto.nextDate('2026-01-31', 'monthly'), '2026-02-28');           // fim de mês respeitado
  assert.equal(auto.nextDate('2026-11-30', 'quarterly'), '2027-02-28');
  assert.equal(auto.nextDate('2026-03-01', 'weekly'), '2026-03-08');
  assert.equal(auto.nextDate('2026-03-01', ''), null);
});

test('calendário de impostos dos EUA', () => {
  const d = auto.taxDeadlines(2026);
  assert.deepEqual(d.filter((x) => !x.payroll).map((x) => x.date), ['2026-04-15', '2026-06-15', '2026-09-15', '2026-01-15']);
  assert.ok(d.filter((x) => x.payroll).every((x) => /^2026-(04-30|07-31|10-31|01-31)$/.test(x.date)));
});

test('estoque baixo e transações a revisar viram lembretes', async () => {
  const item = insert("INSERT INTO items(name,kind,track_inventory,qty_on_hand,reorder_point) VALUES('Widget','product',1,2,5)");
  insert("INSERT INTO bank_txns(account_id,date,description,amount,hash) VALUES((SELECT id FROM accounts WHERE subtype='bank' LIMIT 1),?,?,?,?)", t, 'COFFEE', -450, 'h1');
  const r = (await call('/reminders')).body;
  assert.ok(r.some((x) => x.kind === 'stock' && x.data.name === 'Widget'));
  assert.ok(r.some((x) => x.kind === 'bank' && x.data.n === 1));
  run('UPDATE items SET qty_on_hand=50 WHERE id=?', item);
  assert.equal((await call('/reminders')).body.some((x) => x.kind === 'stock'), false);
});

test('backup diário: só se ligado, uma vez por dia, mantém 14 arquivos', async () => {
  assert.equal(auto.dailyBackup(), null);                                          // desligado por padrão
  await call('/automations', 'PUT', { auto_backup: true });
  const f = auto.dailyBackup();
  assert.ok(f && fs.existsSync(f)); assert.equal(auto.dailyBackup(), null);        // já fez hoje
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(data.docs.length >= 3 && data.accounts.length > 10);
  assert.equal(fs.statSync(f).mode & 0o077, 0);                                    // só o dono do arquivo lê
  const dir = path.dirname(f);
  for (let i = 1; i <= 20; i++) fs.writeFileSync(path.join(dir, `fluxo-2020-01-${String(i).padStart(2, '0')}.json`), '{}');
  run("UPDATE settings SET value='' WHERE key='last_backup'"); auto.dailyBackup();
  assert.equal(fs.readdirSync(dir).length, 14);
  const dl = await call('/export');
  assert.equal(dl.status, 200); assert.equal(dl.body.settings.some((s) => s.key === 'enc_key'), false);   // o download não leva a chave de criptografia
});

test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
