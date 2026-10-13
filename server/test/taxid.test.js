import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const taxid = await import('../src/taxid.js');
const pay = await import('../src/payroll.js');
const { app } = await import('../src/index.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (path, method = 'GET', body, tk = token) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* sem corpo */ }
  return { status: r.status, body: json, text };
};
const raw = (id) => get('SELECT tax_id FROM contacts WHERE id=?', id).tax_id;

test('prepara o ambiente (plano Plus, dono)', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'plus', lang: 'en' }, '');
  assert.equal(s.status, 200); token = s.body.token;
});

test('SSN/EIN do prestador: cifrado no banco, mascarado na API, completo só para o dono e com registro', async () => {
  const c = await call('/contacts', 'POST', { kind: 'vendor', name: 'Ana', tax_id: '987-65-4321', is_1099: 1 });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.body.tax_id, '***-**-4321'); assert.equal(c.body.has_tax_id, true);
  assert.ok(!c.text.includes('987654321') && !c.text.includes('987-65-4321'));
  assert.ok(taxid.isSealed(raw(c.body.id)), 'no banco está cifrado');
  assert.ok(!raw(c.body.id).includes('987'), 'nenhum dígito aberto no banco');
  // listas e extrato
  assert.ok(!(await call('/contacts')).text.includes('987654321'));
  assert.ok(!(await call(`/contacts/${c.body.id}/statement`)).text.includes('987-65-4321'));
  // relatório 1099 mostra mascarado, e sabe que há número
  const r = pay.report1099(new Date().getFullYear()).rows.find((x) => x.name === 'Ana');
  assert.equal(r.tax_id, '***-**-4321'); assert.equal(r.missingTaxId, false);
  // editar devolvendo o mascarado não troca nem apaga
  const up = await call(`/contacts/${c.body.id}`, 'PUT', { ...c.body, tax_id: c.body.tax_id });
  assert.equal(up.status, 200); assert.equal(taxid.open(raw(c.body.id)), '987-65-4321');
  // número novo vale; vazio apaga
  await call(`/contacts/${c.body.id}`, 'PUT', { ...c.body, tax_id: '12-3456789' });
  assert.equal(taxid.open(raw(c.body.id)), '123-45-6789');
  // mostrar o número completo: dono pode e fica no registro de auditoria (sem o número)
  const rev = await call(`/contacts/${c.body.id}/tax-id`);
  assert.equal(rev.status, 200); assert.equal(rev.body.tax_id, '123-45-6789');
  const log = all("SELECT detail, action FROM audit_log WHERE action='reveal'");
  assert.equal(log.length, 1); assert.ok(!JSON.stringify(log).includes('123'));
  await call(`/contacts/${c.body.id}`, 'PUT', { ...c.body, tax_id: '' });
  assert.equal(raw(c.body.id), ''); assert.equal(pay.report1099(new Date().getFullYear()).rows.find((x) => x.name === 'Ana').missingTaxId, true);
});

test('formato: prestador 1099 e funcionário exigem 9 números; cliente aceita texto livre (também cifrado)', async () => {
  for (const bad of ['12345', '111-11-1111', 'ABC-12-3456', '1234567890']) {
    assert.equal((await call('/contacts', 'POST', { kind: 'vendor', name: 'X', tax_id: bad, is_1099: 1 })).status, 400, bad);
  }
  const cust = await call('/contacts', 'POST', { kind: 'customer', name: 'Cliente BR', tax_id: 'CNPJ 12.345.678/0001-95' });
  assert.equal(cust.status, 200); assert.ok(taxid.isSealed(raw(cust.body.id))); assert.ok(!cust.text.includes('12.345.678'));
  const emp = await call('/payroll/employees', 'POST', { name: 'Func', hire_date: '2026-01-01', pay_basis: 'year', pay_rate: 5000000, frequency: 'monthly', filing_status: 'single', tax_id: '222-33-4444' });
  assert.equal(emp.status, 200, emp.text);
  assert.equal(emp.body.tax_id, '***-**-4444'); assert.ok(!emp.text.includes('222334444') && !emp.text.includes('222-33-4444'));
  assert.ok(taxid.isSealed(get('SELECT tax_id FROM employees WHERE id=?', emp.body.id).tax_id));
  assert.ok(!(await call('/payroll/employees')).text.includes('222-33-4444'));
  assert.equal((await call(`/payroll/employees/${emp.body.id}/tax-id`)).body.tax_id, '222-33-4444');
  assert.equal((await call('/payroll/employees', 'POST', { name: 'Func2', hire_date: '2026-01-01', pay_basis: 'year', pay_rate: 5000000, frequency: 'monthly', filing_status: 'single', tax_id: '12' })).status, 400);
});

test('quem não é o dono não vê o número completo; link público de documento não mostra o número', async () => {
  const c = await call('/contacts', 'POST', { kind: 'customer', name: 'Cliente Doc', tax_id: '99-1234567' });
  const u = await call('/users', 'POST', { name: 'Contab', email: 'c@x.com', password: 'senha1234', role: 'accountant' });
  assert.equal(u.status, 200, u.text);
  const login = await call('/login', 'POST', { email: 'c@x.com', password: 'senha1234' }, '');
  assert.equal(login.status, 200, login.text);
  assert.equal((await call(`/contacts/${c.body.id}/tax-id`, 'GET', undefined, login.body.token)).status, 403);
  const acc = await import('../src/accounting.js');
  const inv = acc.saveDoc({ type: 'invoice', contact_id: c.body.id, issue_date: acc.today(), due_date: acc.today(), post: true, lines: [{ description: 's', qty: 1, unit_price: 1000 }] });
  const tokenRow = get('SELECT share_token FROM docs WHERE id=?', inv.id).share_token || (await call(`/docs/${inv.id}/share`, 'POST')).body.token;
  const pub = await call(`/public/doc/${tokenRow}`, 'GET', undefined, '');
  assert.equal(pub.status, 200, pub.text);
  assert.ok(!pub.text.includes('99-1234567'));
});

test('registros antigos em texto puro são cifrados na subida e continuam legíveis', () => {
  const id1 = insert("INSERT INTO contacts(kind,name,tax_id,is_1099) VALUES('vendor','Antigo','333-22-1111',1)");
  const id2 = insert("INSERT INTO employees(name,tax_id,hire_date,pay_basis,pay_rate,frequency,filing_status) VALUES('Func Antigo','555-44-3333','2026-01-01','year',100000,'monthly','single')");
  assert.ok(!taxid.isSealed(raw(id1)));
  const n = taxid.sealLegacyTaxIds();
  assert.ok(n >= 2);
  assert.ok(taxid.isSealed(raw(id1))); assert.equal(taxid.open(raw(id1)), '333-22-1111');
  assert.equal(taxid.open(get('SELECT tax_id FROM employees WHERE id=?', id2).tax_id), '555-44-3333');
  assert.equal(taxid.sealLegacyTaxIds(), 0, 'rodar de novo não faz nada');
  assert.equal(taxid.mask('333-22-1111'), '***-**-1111', 'texto puro antigo também sai mascarado');
});

test.after(() => server.close());
