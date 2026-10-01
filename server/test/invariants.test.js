import test from 'node:test';
import assert from 'node:assert/strict';

// Teste de propriedades: milhares de operações aleatórias e, depois de cada rodada, as regras da contabilidade precisam continuar valendo.
process.env.FLUXO_DB = ':memory:';
const { get, all, insert, run } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const rep = await import('../src/reports.js');

let seed = Number(process.env.SEED || 20260101);
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const A = (sub) => get('SELECT id FROM accounts WHERE subtype=?', sub).id;
const bank = () => get("SELECT id FROM accounts WHERE subtype='bank' LIMIT 1").id;
const expAcc = () => get("SELECT id FROM accounts WHERE type='expense' AND subtype='' LIMIT 1").id;
const user = { id: 1 };
const cust = [1, 2, 3].map((i) => insert("INSERT INTO contacts(kind,name) VALUES('customer',?)", `C${i}`));
const vend = [1, 2].map((i) => insert("INSERT INTO contacts(kind,name) VALUES('vendor',?)", `V${i}`));
const items = [1, 2, 3].map((i) => insert("INSERT INTO items(name,kind,price,cost,track_inventory,qty_on_hand) VALUES(?,?,?,?,1,0)", `Item${i}`, 'product', 1000 * i, 400 * i));
const stock = (item_id, q) => acc.adjustStock({ item_id, qty_delta: q, date: '2026-01-01', offset_account_id: A('retained') }, user);
items.forEach((i) => stock(i, 500));

const date = () => acc.addDays('2026-01-01', int(0, 200));
const lines = (inv) => Array.from({ length: int(1, 3) }, () => {
  const it = inv && rnd() < 0.5 ? pick(items) : null;
  return { item_id: it, description: 'line', qty: pick([1, 2, 3, 0.5, 1.5]), unit_price: int(1, 99999), tax_rate: pick([0, 0, 5, 7.25, 8.875]) };
});
const tryDo = (fn) => { try { return fn(); } catch (e) { if (!(e instanceof acc.HttpError)) throw e; return null; } };   // recusas de regra são válidas; erros inesperados quebram o teste

const ops = {
  invoice: () => acc.saveDoc({ type: 'invoice', contact_id: pick(cust), issue_date: date(), due_date: acc.addDays(date(), 30), post: rnd() < 0.8, lines: lines(true) }, user),
  bill: () => acc.saveDoc({ type: 'bill', contact_id: pick(vend), issue_date: date(), due_date: acc.addDays(date(), 30), post: rnd() < 0.8, lines: lines(false).map((l) => ({ ...l, account_id: expAcc(), tax_rate: undefined })) }, user),
  credit: () => acc.saveDoc({ type: 'credit', contact_id: pick(cust), issue_date: date(), due_date: date(), post: true, lines: lines(false) }, user),
  edit: () => { const d = pick(all("SELECT id,type,contact_id,issue_date,due_date FROM docs WHERE type IN ('invoice','bill') AND status!='void'")); return d && acc.saveDoc({ id: d.id, type: d.type, contact_id: d.contact_id, issue_date: d.issue_date, due_date: d.due_date, post: true, lines: d.type === 'invoice' ? lines(true) : lines(false).map((l) => ({ ...l, account_id: expAcc() })) }, user); },
  issue: () => { const d = pick(all("SELECT id FROM docs WHERE status='draft' AND type IN ('invoice','credit')")); return d && acc.setDocStatus(d.id, 'post', user); },
  void: () => { const d = pick(all("SELECT id FROM docs WHERE status!='void' AND type IN ('invoice','bill','credit')")); return d && acc.setDocStatus(d.id, 'void', user); },
  del: () => { const d = pick(all("SELECT id FROM docs WHERE status IN ('draft','void')")); return d && acc.deleteDoc(d.id); },
  pay: () => { const d = pick(all("SELECT id,total,paid,issue_date FROM docs WHERE type IN ('invoice','bill') AND status IN ('sent','open','partial') AND total>paid")); return d && acc.addPayment(d.id, { date: acc.addDays(d.issue_date, int(0, 40)), amount: rnd() < 0.5 ? d.total - d.paid : int(1, d.total - d.paid), account_id: bank() }, user); },
  unpay: () => { const p = pick(all('SELECT id FROM payments')); return p && acc.deletePayment(p.id); },
  apply: () => { const c = pick(all("SELECT id,total,paid,contact_id FROM docs WHERE type='credit' AND status IN ('open','partial') AND total>paid")); if (!c) return null; const i = pick(all("SELECT id,total,paid FROM docs WHERE type='invoice' AND contact_id=? AND status IN ('sent','partial') AND total>paid", c.contact_id)); return i && acc.applyCredit(c.id, { invoice_id: i.id, amount: Math.min(c.total - c.paid, i.total - i.paid, int(1, 50000)), date: '2026-09-01' }); },
  refund: () => { const c = pick(all("SELECT id,total,paid FROM docs WHERE type='credit' AND status IN ('open','partial') AND total>paid")); return c && acc.refundCredit(c.id, { amount: int(1, c.total - c.paid), account_id: bank(), date: '2026-09-01' }, user); },
  unapply: () => { const a = pick(all('SELECT id FROM credit_applications')); return a && acc.removeCreditApplication(a.id); },
  expense: () => acc.saveExpense({ date: date(), account_id: expAcc(), paid_from_id: bank(), amount: int(1, 90000), description: 'exp' }, user),
  delexp: () => { const e = pick(all('SELECT id FROM expenses')); return e && acc.deleteExpense(e.id); },
  stock: () => acc.adjustStock({ item_id: pick(items), qty_delta: pick([-3, -1, 2, 10]), date: date(), offset_account_id: pick([A('retained'), A('cogs')]) }, user),
};

function check(label) {
  // 1) razão em equilíbrio: cada lançamento e o total
  const unbalanced = all('SELECT entry_id, SUM(debit)-SUM(credit) AS d FROM journal_lines GROUP BY entry_id HAVING d != 0');
  assert.deepEqual(unbalanced, [], `${label}: lançamento desbalanceado`);
  const tb = rep.trialBalance('2099-12-31');
  assert.equal(tb.rows.reduce((s, r) => s + r.debit - r.credit, 0), 0, `${label}: balancete`);
  // 2) contas a receber / a pagar no razão == subsidiário (faturas abertas menos créditos)
  const gl = (sub) => get('SELECT COALESCE(SUM(l.debit-l.credit),0) v FROM journal_lines l JOIN accounts a ON a.id=l.account_id WHERE a.subtype=?', sub).v;
  assert.equal(gl('ar'), rep.aging('receivable', '2099-12-31').totals.total, `${label}: A/R do razão != aging`);
  assert.equal(Math.abs(gl('ap')) === 0 ? 0 : -gl('ap'), rep.aging('payable', '2099-12-31').totals.total, `${label}: A/P do razão != aging`);
  // 3) estoque no razão == soma de quantidade x custo
  const inv = rep.inventoryValuation().total;
  assert.ok(Math.abs(gl('inventory') - inv) <= items.length, `${label}: estoque ${gl('inventory')} != ${inv}`);       // tolerância: arredondamento por item
  // 4) cada documento: pago == pagamentos + créditos aplicados, saldo nunca negativo
  for (const d of all("SELECT id,type,total,paid,status FROM docs WHERE type IN ('invoice','bill','credit')")) {
    assert.ok(d.paid >= 0 && d.paid <= d.total, `${label}: doc ${d.id} pago ${d.paid} de ${d.total}`);
    if (d.status === 'void') assert.equal(d.paid, 0, `${label}: documento anulado com pagamento`);
  }
  for (const d of all("SELECT d.id,d.type,d.paid, COALESCE((SELECT SUM(amount) FROM payments WHERE doc_id=d.id),0) AS pay, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE invoice_id=d.id),0) AS ap, COALESCE((SELECT SUM(amount) FROM credit_applications WHERE credit_id=d.id),0) AS used FROM docs d WHERE d.type IN ('invoice','bill','credit')")) {
    const expected = d.type === 'credit' ? d.used : d.pay + d.ap;
    assert.equal(d.paid, expected, `${label}: doc ${d.id} (${d.type}) paid=${d.paid} esperado=${expected}`);
  }
  // 5) nenhum lançamento com data impossível ou linha com débito e crédito juntos
  assert.equal(get("SELECT COUNT(*) n FROM journal_lines WHERE debit<0 OR credit<0 OR (debit>0 AND credit>0)").n, 0, `${label}: linha inválida`);
}

for (const s of Array.from({ length: Number(process.env.SEEDS || 5) }, (_, i) => i + 1)) {
  test(`invariantes contábeis com ${600} operações aleatórias (semente ${s})`, () => {
    seed = 1000 * s + 7;
    const names = Object.keys(ops);
    let done = 0;
    for (let i = 0; i < 600; i++) {
      const name = pick(names);
      if (tryDo(ops[name]) !== null) done++;
      if (i % 25 === 0) check(`op ${i} (${name})`);
    }
    check('fim');
    assert.ok(done > 150, `poucas operações válidas (${done})`);
  });
}

test('arredondamento de centavos: meio centavo sempre sobe, sem erro de ponto flutuante', () => {
  const one = (qty, unit_price, tax_rate = 0) => acc.computeLines('invoice', [{ description: 'x', qty, unit_price, tax_rate }]);
  assert.equal(one(1.5, 333).subtotal, 500);                      // 499.5 -> 500
  assert.equal(one(1, 10, 5).tax, 1);                             // 0.5 -> 1
  assert.equal(one(3, 1, 50).tax, 2);                             // 1.5 -> 2
  assert.equal(one(1, 1005, 10).tax, 101);                        // 100.5 -> 101 (1005*10/100 em float dá 100.5 exato, mas 1.005*100 não)
  assert.equal(one(1.15, 100).subtotal, 115);                     // 1.15*100 = 114.99999999999999
  assert.equal(one(2.675, 1000).subtotal, 2675);
  assert.equal(one(1, 2500, 8.875).tax, 222);                     // 221.875 -> 222
  assert.equal(one(1, 1000, 7.25).total, 1073);                   // 72.5 -> 73
  for (let i = 0; i < 2000; i++) {                               // contra aritmética exata em inteiros: sempre igual
    const unit = int(1, 99999), rate = pick([0, 5, 6.25, 7, 7.25, 8.25, 8.875, 10]);
    const exact = Math.floor((unit * Math.round(rate * 1000) + 50000) / 100000);   // unit*rate/100, meio sobe, tudo em inteiros
    assert.equal(one(1, unit, rate).tax, exact, `unit=${unit} rate=${rate}`);
  }
});
