import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, insert } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const st = await import('../src/salestax.js');
const C = (n) => Math.round(n * 100);

const contact = (name, extra = {}) => {
  const id = insert('INSERT INTO contacts(kind,name) VALUES(?,?)', 'customer', name);
  for (const [k, v] of Object.entries(extra)) acc && get('SELECT 1') && insert(`UPDATE contacts SET ${k}=? WHERE id=${id}`, v);
  return id;
};
const inv = (contact_id, amount, extra = {}) => acc.saveDoc({ type: 'invoice', contact_id, issue_date: extra.date || '2026-06-10', due_date: extra.date || '2026-06-10', post: true,
  lines: [{ description: 'Work', qty: 1, unit_price: C(amount), tax_rate: extra.rate ?? 0, tax_name: extra.name || '' }] }, null);

test('alíquotas: validação, nome único e apagar solta o cliente', () => {
  assert.throws(() => st.saveRate({ name: '', rate: 5 }), /name/);
  assert.throws(() => st.saveRate({ name: 'X', rate: 31 }), /between/);
  assert.throws(() => st.saveRate({ name: 'X', rate: 5, state: 'ZZ' }), /valid US state/);
  const tx = st.saveRate({ name: 'Texas + Austin', state: 'tx', rate: 8.25 });
  assert.equal(tx.state, 'TX'); assert.equal(tx.rate, 8.25);
  assert.throws(() => st.saveRate({ name: 'texas + austin', rate: 1 }), /already exists/);
  const upd = st.saveRate({ id: tx.id, name: 'Texas + Austin', state: 'TX', rate: 8, active: false });
  assert.equal(upd.rate, 8); assert.equal(upd.active, 0);
  const c = contact('Cliente A'); insert('UPDATE contacts SET tax_rate_id=? WHERE id=?', tx.id, c);
  st.deleteRate(tx.id);
  assert.equal(get('SELECT tax_rate_id FROM contacts WHERE id=?', c).tax_rate_id, null);
  assert.equal(st.listRates().length, 0);
});

test('alíquotas estaduais de base: só as que faltam, nunca mexe nas editadas', () => {
  st.saveRate({ name: 'Texas state sales tax', state: 'TX', rate: 6.5, notes: 'meu valor' });
  const r = st.addStateBaseRates();
  assert.ok(r.added > 40 && r.added < 52, `adicionou ${r.added}`);
  assert.deepEqual(r.noSalesTax.sort(), ['AK', 'DE', 'MT', 'NH', 'OR']);
  assert.equal(get("SELECT rate FROM tax_rates WHERE state='TX' AND name LIKE 'Texas%'").rate, 6.5, 'a que a pessoa editou fica');
  assert.equal(st.addStateBaseRates().added, 0, 'rodar de novo não duplica');
  assert.equal(get("SELECT COUNT(*) n FROM tax_rates WHERE state='OR'").n, 0, 'estado sem imposto não ganha alíquota');
});

test('cliente isento: o servidor zera o imposto, até pela API', () => {
  const ex = contact('ONG Verde'); insert('UPDATE contacts SET tax_exempt=1, tax_exempt_note=? WHERE id=?', 'CERT-123', ex);
  const normal = contact('Loja Azul');
  const a = inv(normal, 100, { rate: 8.25, name: 'Texas + Austin' });
  assert.equal(a.tax, C(8.25)); assert.equal(a.lines[0].tax_name, 'Texas + Austin');
  const b = inv(ex, 100, { rate: 8.25, name: 'Texas + Austin' });
  assert.equal(b.tax, 0); assert.equal(b.total, C(100)); assert.equal(b.lines[0].tax_rate, 0); assert.equal(b.lines[0].tax_name, '');
  // conta a pagar nunca leva imposto de venda e não é afetada
  const v = contact('Fornecedor'); insert('UPDATE contacts SET tax_exempt=1 WHERE id=?', v);
  assert.equal(acc.saveDoc({ type: 'bill', contact_id: v, issue_date: '2026-06-10', due_date: '2026-06-10', lines: [{ description: 'x', qty: 1, unit_price: C(10) }] }).total, C(10));
});

test('relatório por jurisdição: imposto por nome, isentos separados, nota de crédito subtrai', () => {
  const aust = contact('Cliente Austin'), fl = contact('Cliente FL'), ex = get("SELECT id FROM contacts WHERE name='ONG Verde'").id;
  insert("UPDATE contacts SET tax_state='TX' WHERE id=?", aust); insert("UPDATE contacts SET tax_state='FL' WHERE id=?", fl);
  inv(aust, 1000, { date: '2026-03-05', rate: 8.25, name: 'Texas + Austin' });
  inv(aust, 500, { date: '2026-03-09', rate: 8.25, name: 'Texas + Austin' });
  inv(fl, 200, { date: '2026-03-10', rate: 7, name: 'Florida + Miami-Dade' });
  inv(fl, 300, { date: '2026-03-11', rate: 0 });
  inv(ex, 400, { date: '2026-03-12', rate: 8.25 });
  const credit = acc.saveDoc({ type: 'credit', contact_id: aust, issue_date: '2026-03-20', due_date: '2026-03-20', post: true, lines: [{ description: 'Devolução', qty: 1, unit_price: C(100), tax_rate: 8.25, tax_name: 'Texas + Austin' }] }, null);
  assert.ok(credit.id);
  inv(aust, 999, { date: '2026-04-01', rate: 8.25, name: 'Texas + Austin' }); // fora do período
  const r = st.jurisdictionReport('2026-03-01', '2026-03-31');
  const tex = r.rows.find((x) => x.name === 'Texas + Austin');
  assert.equal(tex.base, C(1000 + 500 - 100)); assert.equal(tex.tax, Math.round(C(1000) * 0.0825) + Math.round(C(500) * 0.0825) - Math.round(C(100) * 0.0825));
  assert.equal(r.rows.find((x) => x.name === 'Florida + Miami-Dade').tax, C(14));
  assert.equal(r.exempt, C(400), 'vendas a clientes isentos'); assert.equal(r.zeroRated, C(300), 'vendas sem imposto a clientes comuns');
  assert.equal(r.collected, r.rows.reduce((s, x) => s + x.tax, 0));
  assert.equal(r.byState.find((x) => x.state === 'TX').sales, C(1400));
  assert.throws(() => st.jurisdictionReport('x', '2026-03-31'), /Invalid dates/);
});

test('alerta de obrigação: janela de 12 meses, limites por estado, estado de origem fora, sem estado à parte', () => {
  const ca = contact('Cliente CA'), fl = contact('Cliente FL2'), ny = contact('Cliente NY'), tn = contact('Cliente TN'), none = contact('Sem estado'), or = contact('Cliente OR');
  for (const [id, s] of [[ca, 'CA'], [fl, 'FL'], [ny, 'NY'], [tn, 'TN'], [or, 'OR']]) insert('UPDATE contacts SET tax_state=? WHERE id=?', s, id);
  inv(ca, 450000, { date: '2026-05-01' });           // 90% de US$ 500 mil
  inv(fl, 100000, { date: '2026-05-02' });           // 100% de US$ 100 mil
  inv(tn, 20000, { date: '2024-01-01' });            // fora da janela de 12 meses
  inv(tn, 1000, { date: '2026-05-03' });
  inv(ny, 600000, { date: '2026-05-04' });           // passou das vendas, mas Nova York exige também 100 vendas
  inv(or, 300000, { date: '2026-05-05' });           // Oregon não tem imposto estadual
  inv(none, 5000, { date: '2026-05-06' });
  acc.saveDoc({ type: 'invoice', contact_id: fl, issue_date: '2026-05-07', due_date: '2026-05-07', post: false, lines: [{ description: 'rascunho', qty: 1, unit_price: C(900000) }] }, null); // rascunho não conta
  st.setHomeState('TX');
  const n = st.nexusStatus('2026-06-30');
  const by = Object.fromEntries(n.rows.map((r) => [r.state, r]));
  assert.equal(by.CA.status, 'near'); assert.equal(by.CA.pct, 90);
  assert.equal(by.FL.status, 'over'); assert.equal(by.FL.sales, C(100000 + 200 + 300), 'inclui as vendas do teste anterior ao mesmo estado');
  assert.equal(by.TN.status, 'ok'); assert.equal(by.TN.sales, C(1000), 'vendas de 2024 ficam de fora');
  assert.equal(by.NY.status, 'ok', 'Nova York precisa das duas condições'); assert.ok(by.NY.both);
  assert.equal(by.OR.status, 'no_tax');
  assert.equal(by.TX.status, 'home', 'o estado de origem nunca alerta');
  assert.ok(n.unassigned.sales >= C(5000), 'vendas a clientes sem estado aparecem à parte'); assert.ok(n.customersWithoutState >= 1);
  assert.deepEqual(n.alerts.map((a) => a.state).sort(), ['CA', 'FL']);
  // o estado de origem nunca alerta
  const tx = contact('Cliente TX'); insert("UPDATE contacts SET tax_state='TX' WHERE id=?", tx); inv(tx, 900000, { date: '2026-05-08' });
  assert.equal(st.nexusStatus('2026-06-30').rows.find((r) => r.state === 'TX').status, 'home', 'mesmo com vendas altas');
  // limite editado
  st.saveThreshold('TN', { sales: C(1000), txns: 0 });
  assert.equal(st.nexusStatus('2026-06-30').rows.find((r) => r.state === 'TN').status, 'over');
  assert.throws(() => st.saveThreshold('ZZ', { sales: 1, txns: 1 }), /valid US state/);
  assert.throws(() => st.saveThreshold('TN', { sales: -1, txns: 1 }), /zero or more/);
});
