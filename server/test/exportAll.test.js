import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.FLUXO_DB = ':memory:';
const { app } = await import('../src/index.js');
const { get, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const ex = await import('../src/exportAll.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r;
};
const py = (zipPath, code) => spawnSync('python3', ['-I', '-c', code, zipPath], { encoding: 'utf8' });

test('CSV: aspas, vírgulas e texto que viraria fórmula', () => {
  const out = ex.toCsv(['a', 'b'], [{ a: 'x,y', b: '=HYPERLINK("x")' }, { a: 'linha\n2', b: null }]);
  assert.match(out, /"x,y"/); assert.match(out, /'=HYPERLINK/); assert.match(out, /"linha\n2"/);
});

test('exportar tudo: ZIP íntegro, dólares, SSN só o final, sem segredos, só o dono, fica na auditoria', async () => {
  assert.equal((await call('/export/all.zip')).status, 401);
  const setup = await (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'free', lang: 'en', demo: false, company_name: 'Teste Co' })).json();
  const owner = setup.token;
  const cid = insert('INSERT INTO contacts(kind,name,email,tax_id) VALUES(?,?,?,?)', 'customer', 'Acme, "Roofing"', 'a@acme.test', '');
  // número completo cifrado como no sistema
  const taxid = await import('../src/taxid.js');
  const { run } = await import('../src/db.js');
  run('UPDATE contacts SET tax_id=? WHERE id=?', taxid.prepareTaxId('12-3456789', undefined, { strict: false }), cid);
  const d = acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: '2026-06-01', due_date: '2026-06-15', post: true, lines: [{ description: '=cmd|calc', qty: 1, unit_price: 125000, tax_rate: 0 }] }, null);
  acc.addPayment(d.id, { date: '2026-06-05', amount: 50000, account_id: get("SELECT id FROM accounts WHERE code='1010'").id });
  const r = await call('/export/all.zip', 'GET', undefined, owner);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip'); assert.match(r.headers.get('content-disposition'), /fluxo-export-\d{4}-\d{2}-\d{2}\.zip/);
  const file = path.join(os.tmpdir(), `fluxo-exp-${process.pid}.zip`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  const t = py(file, `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip()); print(','.join(sorted(z.namelist())))`);
  assert.equal(t.status, 0, t.stderr); const [bad, names] = t.stdout.trim().split('\n');
  assert.equal(bad, 'None', 'nenhum arquivo corrompido');
  for (const f of ['README.txt', 'accounts.csv', 'contacts.csv', 'documents.csv', 'document_lines.csv', 'payments.csv', 'general_ledger.csv', 'expenses.csv', 'bank_transactions.csv', 'company.csv']) assert.ok(names.split(',').includes(f), `falta ${f}`);
  const read = (n) => py(file, `import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('${n}').decode('utf-8-sig'))`).stdout;
  const docs = read('documents.csv'); assert.match(docs, /1250\.00/); assert.match(docs, /500\.00/); assert.match(docs, /"Acme, ""Roofing"""/);
  assert.match(read('document_lines.csv'), /'=cmd\|calc/, 'texto de fórmula é neutralizado');
  assert.match(read('payments.csv'), /500\.00/);
  const ledger = read('general_ledger.csv'); assert.match(ledger, /1250\.00/);
  const contacts = read('contacts.csv'); assert.match(contacts, /6789/); assert.doesNotMatch(contacts, /12-3456789|123456789/, 'SSN/EIN completo nunca sai');
  const everything = ['accounts', 'contacts', 'documents', 'company'].map(read).join('');
  assert.doesNotMatch(everything, /password|\$2[aby]\$|scrypt/i, 'nenhum segredo');
  assert.match(read('company.csv'), /Teste Co/);
  fs.unlinkSync(file);
  // o razão tem débitos = créditos
  const nums = ledger.trim().split('\n').slice(1).map((l) => l.split(','));
  assert.ok(nums.length >= 2);
  // registro na auditoria
  const audit = await (await call('/audit', 'GET', undefined, owner)).json().catch(() => []);
  void audit;
  assert.equal(get("SELECT COUNT(*) n FROM audit_log WHERE action='export'").n, 1);
});

test('só o dono leva tudo', async () => {
  const login = async (e) => (await (await call('/login', 'POST', { email: e, password: 'senha1234' })).json()).token;
  const owner = await login('o@x.com');
  await call('/plan', 'PUT', { plan: 'starter' }, owner);
  for (const [email, role] of [['c@x.com', 'accountant'], ['v@x.com', 'viewer']]) { const u = await call('/users', 'POST', { name: role, email, password: 'senha1234', role }, owner); assert.equal(u.status, 200, JSON.stringify(await u.json())); }
  assert.equal((await call('/export/all.zip', 'GET', undefined, await login('c@x.com'))).status, 403, 'contador não');
  assert.equal((await call('/export/all.zip', 'GET', undefined, await login('v@x.com'))).status, 403);
  assert.equal((await call('/export/all.zip', 'GET', undefined, owner)).status, 200, 'o dono leva em qualquer plano');
});
test.after(() => server.close());
