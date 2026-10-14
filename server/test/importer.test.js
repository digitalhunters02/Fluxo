import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, setSetting } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const imp = await import('../src/importer.js');
const mig = await import('../src/migrate.js');

const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
const bal = (id) => get('SELECT COALESCE(SUM(debit-credit),0) v FROM journal_lines WHERE account_id=?', id).v;
const totals = () => get('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines');
const C = (n) => Math.round(n * 100);

// ---- exportações no formato dos sistemas (cabeçalhos e linhas de título como eles geram)
const QBO_AR = `A/R Aging Detail
Impact Digital LLC
As of December 31, 2025

,Date,Transaction type,Num,Customer,Due date,Amount,Open balance
Current
,12/15/2025,Invoice,1001,Acme Roofing,01/14/2026,"2,500.00","2,500.00"
,12/20/2025,Invoice,1002,Bravo Builders,01/19/2026,"2,000.00","1,500.00"
Total for Current,,,,,,"4,500.00","4,000.00"
1 - 30
,11/01/2025,Credit Memo,CM-1,Acme Roofing,11/01/2025,-100.00,-100.00
,11/05/2025,Payment,,Acme Roofing,11/05/2025,-50.00,-50.00
,11/09/2025,Invoice,1003,Bravo Builders,12/09/2025,300.00,0.00
,13/09/2025,Invoice,1004,Bravo Builders,12/09/2025,300.00,300.00
Total,,,,,,"x","y"`;
const QBO_AP = `A/P Aging Detail
,Date,Transaction type,Num,Vendor,Due date,Amount,Open balance
,12/10/2025,Bill,B-77,Paper Co,01/10/2026,"1,500.00","1,500.00"`;
const XERO_INV = `*ContactName,EmailAddress,*InvoiceNumber,Reference,*InvoiceDate,*DueDate,Description,*Quantity,*UnitAmount,*AccountCode,*TaxType
Paper Co,,INV-0040,PO 9,15/12/2025,14/01/2026,Printing,10,25.50,200,Tax Exempt
Paper Co,,INV-0040,PO 9,15/12/2025,14/01/2026,Delivery,1,45,200,Tax Exempt
Acme Roofing,,INV-0041,,03/12/2025,02/01/2026,Flyers,2,100,200,Tax Exempt`;
const TB = `Trial Balance\n,Debit,Credit\nChecking Account,"1,000.00",\nAccounts Receivable (A/R),"300.00",\nOwner Capital,,"1,300.00"`;

test('leitura: valores e datas dos dois sistemas', () => {
  assert.equal(imp.parseMoney('$1,234.56'), 123456);
  assert.equal(imp.parseMoney('(1,234.56)'), -123456);
  assert.equal(imp.parseMoney('-12'), -1200);
  assert.equal(imp.parseMoney('1.234,56'), 123456);
  assert.equal(imp.parseMoney('12,5'), 1250);
  assert.equal(imp.parseMoney(''), null);
  assert.equal(imp.parseMoney('abc'), null);
  assert.equal(imp.parseDateStr('12/31/2025'), '2025-12-31');
  assert.equal(imp.parseDateStr('31/12/2025'), '2025-12-31');
  assert.equal(imp.parseDateStr('03/04/2025', 'us'), '2025-03-04');
  assert.equal(imp.parseDateStr('03/04/2025', 'dmy'), '2025-04-03');
  assert.equal(imp.parseDateStr('15 Dec 2025'), '2025-12-15');
  assert.equal(imp.parseDateStr('Dec 15, 2025'), '2025-12-15');
  assert.equal(imp.parseDateStr('2025-02-31'), null);
  assert.deepEqual(imp.parseCsv('a;b\n"x;1";2'), [['a', 'b'], ['x;1', '2']]);
  assert.deepEqual(imp.parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('faturas em aberto (A/R do QuickBooks), sem saldos de abertura: só o aberto, pelo valor aberto, nunca receita', () => {
  const a = imp.analyze('invoices', QBO_AR, { source: 'quickbooks' });
  assert.equal(a.summary.layout, 'balance'); assert.equal(a.summary.mode, 'post');
  assert.deepEqual(a.rows.map((r) => r.number).sort(), ['1001', '1002']);
  assert.ok(a.skipped.some((s) => /Credit Memo/.test(s.reason)) && a.skipped.some((s) => /Payment/.test(s.reason)));
  assert.ok(a.skipped.some((s) => /Already paid/.test(s.reason)), '1003 já foi paga');
  assert.ok(a.skipped.some((s) => /Unreadable date/.test(s.reason)), '13/09 no formato dos EUA é data inválida: avisa');
  const r1002 = a.rows.find((r) => r.number === '1002');
  assert.equal(r1002.total, C(2000)); assert.equal(r1002.open, C(1500)); assert.equal(r1002.paid, C(500));
  assert.throws(() => imp.runImport('invoices', QBO_AR, { source: 'quickbooks' }), /conversion date/);
  assert.equal(all('SELECT 1 FROM docs').length, 0, 'falha não grava nada');
  const r = imp.runImport('invoices', QBO_AR, { source: 'quickbooks', asOf: '2025-12-31' });
  assert.equal(r.created, 2); assert.equal(r.mode, 'post'); assert.equal(r.newContacts, 2);
  const d = get("SELECT * FROM docs WHERE number='1002'");
  assert.equal(d.status, 'partial'); assert.equal(d.total, C(2000)); assert.equal(d.paid, C(500)); assert.equal(d.type, 'invoice'); assert.equal(d.issue_date, '2025-12-20'); assert.equal(d.due_date, '2026-01-19');
  assert.equal(get("SELECT status FROM docs WHERE number='1001'").status, 'sent');
  assert.equal(bal(A('1200')), C(4000), 'A/R = soma do aberto');
  assert.equal(bal(A('4000')) + bal(A('4100')), 0, 'nenhuma receita');
  const obe = get("SELECT id FROM accounts WHERE subtype='opening'");
  assert.ok(obe, 'Opening Balance Equity criada'); assert.equal(bal(obe.id), -C(4000));
  const t = totals(); assert.equal(t.d, t.c);
  assert.equal(r.check.receivable.difference, 0, 'o detalhe bate com a conta do livro');
  // receber de uma fatura importada baixa o A/R normalmente
  const bank = A('1010');
  acc.addPayment(d.id, { date: '2026-01-10', amount: C(1500), account_id: bank });
  assert.equal(get('SELECT status FROM docs WHERE id=?', d.id).status, 'paid');
  assert.equal(bal(A('1200')), C(2500));
  // importar de novo não duplica
  assert.throws(() => imp.runImport('invoices', QBO_AR, { source: 'quickbooks', asOf: '2025-12-31' }), /Nothing to import/);
  // editar a fatura importada reposta como fatura normal (o lançamento de abertura sai)
  const doc = acc.loadDoc(get("SELECT id FROM docs WHERE number='1001'").id);
  assert.equal(doc.lines[0].amount, C(2500));
});

test('contas a pagar em aberto', () => {
  const r = imp.runImport('bills', QBO_AP, { source: 'quickbooks', asOf: '2025-12-31' });
  assert.equal(r.created, 1);
  assert.equal(get("SELECT type, status FROM docs WHERE number='B-77'").type, 'bill');
  assert.equal(bal(A('2000')), -C(1500));
  assert.equal(r.check.payable.difference, 0);
  assert.equal(r.check.openingBalanceEquity, C(4000 - 1500), 'Opening Balance Equity guarda a diferença entre A/R e A/P abertos');
  const t = totals(); assert.equal(t.d, t.c);
});

test('faturas do Xero (modelo com linhas, datas dia/mês/ano)', () => {
  const a = imp.analyze('invoices', XERO_INV, { source: 'xero' });
  assert.equal(a.summary.layout, 'lines'); assert.equal(a.summary.dateFormat, 'dmy');
  assert.equal(a.rows.length, 2);
  const i40 = a.rows.find((r) => r.number === 'INV-0040');
  assert.equal(i40.total, C(10 * 25.5 + 45)); assert.equal(i40.lines.length, 2); assert.equal(i40.date, '2025-12-15'); assert.equal(i40.due, '2026-01-14');
  imp.runImport('invoices', XERO_INV, { source: 'xero', asOf: '2025-12-31' });
  const doc = acc.loadDoc(get("SELECT id FROM docs WHERE number='INV-0040'").id);
  assert.equal(doc.lines.length, 2); assert.equal(doc.total, C(300)); assert.equal(doc.contact_name, 'Paper Co');
  assert.match(doc.notes, /Imported from Xero/);
});

test('produtos e serviços', () => {
  const csv = `Product/Service Name,SKU,Type,Sales Price / Rate,Purchase Cost,Quantity On Hand\nRoof inspection,RI-1,Service,"150.00",,\nShingle bundle,SH-1,Inventory,32.5,20,100\nRoof inspection,RI-1,Service,150,,`;
  const r = imp.runImport('items', csv, { source: 'quickbooks' });
  assert.equal(r.created, 2);
  const it = get("SELECT * FROM items WHERE name='Shingle bundle'");
  assert.equal(it.kind, 'product'); assert.equal(it.price, C(32.5)); assert.equal(it.cost, C(20)); assert.equal(it.track_inventory, 0);
  assert.throws(() => imp.runImport('items', csv, {}), /Nothing to import/);
});

test('saldos de abertura já importados: a fatura entra só como detalhe, sem lançar de novo', () => {
  // livro novo na mesma base: troca o A/R pelo saldo do balancete e importa o detalhe
  const before = bal(A('1200'));
  const out = mig.runMigration({ kind: 'opening', csv: TB, apply: true, asof: '2026-02-01' }, { id: null });
  assert.equal(out.applied, true);
  assert.equal(bal(A('1200')), before + C(300));
  const csv = `Date,Transaction type,Num,Customer,Due date,Amount,Open balance\n01/20/2026,Invoice,2001,Delta Co,02/20/2026,300.00,300.00`;
  const a = imp.analyze('invoices', csv, { source: 'quickbooks' });
  assert.equal(a.summary.mode, 'detail');
  const r = imp.runImport('invoices', csv, { source: 'quickbooks' });
  assert.equal(r.mode, 'detail'); assert.equal(r.created, 1);
  assert.equal(bal(A('1200')), before + C(300), 'o livro não mexeu: o saldo já veio do balancete');
  assert.equal(r.check.receivable.difference, 0, 'detalhe + livro batem');
  assert.equal(r.check.openingBalancesImported, true);
  assert.equal(all("SELECT 1 FROM journal_entries WHERE source_type='doc' AND source_id=?", get("SELECT id FROM docs WHERE number='2001'").id).length, 0);
  // receber baixa o A/R do livro
  acc.addPayment(get("SELECT id FROM docs WHERE number='2001'").id, { date: '2026-02-10', amount: C(300), account_id: A('1010') });
  assert.equal(bal(A('1200')), before);
});

test('período fechado: nada é gravado pela metade', () => {
  setSetting('lock_date', '2026-12-31');
  const csv = `Date,Transaction type,Num,Vendor,Due date,Amount,Open balance\n12/10/2025,Bill,B-99,Paper Co,01/10/2026,50.00,50.00`;
  const n = all('SELECT id FROM docs').length;
  assert.throws(() => imp.runImport('bills', csv, { asOf: '2025-12-31', ledgerMode: 'post' }), /closed/);
  assert.equal(all('SELECT id FROM docs').length, n, 'a fatura também não ficou');
  setSetting('lock_date', '');
});

test('arquivo errado: mensagem clara; a pessoa pode escolher a coluna', () => {
  assert.throws(() => imp.analyze('invoices', 'foo', {}), /header row/);
  const odd = imp.analyze('invoices', 'Titulo da fatura,Cliente,Quando,Total aberto\n77,X Ltda,12/10/2025,100.00', {});
  assert.equal(odd.ready, false); assert.deepEqual(odd.missing.sort(), ['contact', 'date', 'number']); assert.ok(odd.headers.includes('Cliente'));
  const fixed = imp.analyze('invoices', 'Titulo da fatura,Cliente,Quando,Total aberto\n77,X Ltda,12/10/2025,100.00', { mapping: { number: 'Titulo da fatura', contact: 'Cliente', date: 'Quando', open: 'Total aberto' } });
  assert.equal(fixed.rows.length, 1); assert.equal(fixed.rows[0].open, 10000);
  assert.throws(() => imp.analyze('items', '', {}), /empty/);
  assert.throws(() => imp.analyze('opening', 'a', {}), /Unknown/);
  const a = imp.analyze('invoices', `Num,Client,Date,Open balance\n77,X Ltda,12/10/2025,100.00`, {});
  assert.equal(a.rows.length, 1, 'colunas reconhecidas sozinhas');
  const m = imp.analyze('items', 'Titulo,Preco\nCorte,10', { mapping: { name: 'Titulo' } });
  assert.equal(m.rows[0].name, 'Corte', 'a pessoa escolhe a coluna');
});
