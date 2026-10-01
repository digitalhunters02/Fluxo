import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
let owner = '';
test('busca global encontra clientes, documentos, produtos, despesas e contas, e respeita as permissões', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en' })).body.token;
  const c = insert("INSERT INTO contacts(kind,name,email) VALUES('customer','Maple Street Bakery','owner@maple.com')");
  insert("INSERT INTO contacts(kind,name) VALUES('vendor','Maple Supplies')");
  insert("INSERT INTO items(name,sku,kind) VALUES('Maple syrup','SYR-1','product')");
  const t = acc.today();
  const d = acc.saveDoc({ type: 'invoice', contact_id: c, issue_date: t, due_date: t, post: true, lines: [{ description: 'x', qty: 1, unit_price: 100 }] }, { id: 1 });
  insert('INSERT INTO expenses(date,account_id,paid_from_id,amount,description) VALUES(?,?,?,?,?)', t, 1, 1, 500, 'Maple tree trimming');
  assert.deepEqual((await call('/search?q=m', 'GET', undefined, owner)).body, []);                          // menos de 2 letras: nada
  const r = (await call('/search?q=maple', 'GET', undefined, owner)).body;
  const kinds = r.map((x) => x.type);
  for (const k of ['contact', 'item', 'expense']) assert.ok(kinds.includes(k), `falta ${k}`);
  assert.equal(r.filter((x) => x.type === 'contact').length, 2);
  assert.equal((await call(`/search?q=${d.number}`, 'GET', undefined, owner)).body[0].link, `/document/${d.id}`);   // acha pelo número da fatura
  assert.equal((await call('/search?q=owner@maple', 'GET', undefined, owner)).body[0].title, 'Maple Street Bakery');
  assert.equal((await call('/search?q=Cash', 'GET', undefined, owner)).body.some((x) => x.type === 'account'), true);
  assert.deepEqual((await call('/search?q=100%25', 'GET', undefined, owner)).body, []);                      // % e _ não viram curinga
  assert.deepEqual((await call('/search?q=%27%20OR%201=1--', 'GET', undefined, owner)).body, []);            // sem injeção de SQL
  assert.equal((await call('/search?q=maple')).status, 401);
  // um usuário só de relatórios não vê vendas nem despesas
  assert.equal((await call('/users', 'POST', { name: 'Rita', email: 'r@x.com', password: 'senha1234', role: 'viewer', perms: { read: ['reports'], write: [] } }, owner)).status, 200);
  const rt = (await call('/login', 'POST', { email: 'r@x.com', password: 'senha1234' })).body.token;
  assert.deepEqual((await call('/search?q=maple', 'GET', undefined, rt)).body, []);
});
test.after(() => server.close());
