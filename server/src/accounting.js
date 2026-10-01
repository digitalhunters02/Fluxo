// Motor contábil: toda movimentação vira lançamento de partidas dobradas (débito = crédito).
import crypto from 'node:crypto';
import { all, get, run, insert, tx, getSetting, setSetting } from './db.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const MEMOS = {
  invoice: { en: 'Invoice', pt: 'Fatura', es: 'Factura' }, bill: { en: 'Bill', pt: 'Conta a pagar', es: 'Cuenta por pagar' },
  payment: { en: 'Payment', pt: 'Pagamento', es: 'Pago' }, expense: { en: 'Expense', pt: 'Despesa', es: 'Gasto' },
  stock: { en: 'Stock adjustment', pt: 'Ajuste de estoque', es: 'Ajuste de inventario' }, transfer: { en: 'Transfer', pt: 'Transferência', es: 'Transferencia' },
  payroll: { en: 'Payroll', pt: 'Folha de pagamento', es: 'Nómina' }, payroll_tax: { en: 'Payroll tax payment', pt: 'Pagamento de impostos da folha', es: 'Pago de impuestos de nómina' },
};
/** Texto de memorando gerado pelo sistema, no idioma da empresa. */
export const memoText = (key) => { const l = getSetting('lang', 'en'); return MEMOS[key][l] || MEMOS[key].en; };
export const today = () => new Date().toISOString().slice(0, 10);
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const cents = (v) => { const n = Math.round(Number(v)); if (!Number.isFinite(n)) throw bad('Invalid amount'); return n; };

export const sysAccount = (subtype) => {
  const a = get('SELECT * FROM accounts WHERE subtype=? AND active=1 ORDER BY code LIMIT 1', subtype);
  if (!a) throw bad(`System account "${subtype}" not found in the chart of accounts`);
  return a;
};
export const getAccount = (id) => {
  const a = get('SELECT * FROM accounts WHERE id=?', id);
  if (!a) throw bad('Account not found');
  return a;
};

/* ------------------------------ lançamentos ------------------------------ */

export function postEntry({ date, memo = '', source_type = 'manual', source_id = null, lines, user_id = null }) {
  if (!isDate(date)) throw bad('Invalid date');
  const ls = lines.map((l) => ({ account_id: l.account_id, debit: cents(l.debit || 0), credit: cents(l.credit || 0), contact_id: l.contact_id || null }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (ls.some((l) => l.debit < 0 || l.credit < 0 || (l.debit && l.credit))) throw bad('Invalid journal line');
  const d = ls.reduce((s, l) => s + l.debit, 0), c = ls.reduce((s, l) => s + l.credit, 0);
  if (ls.length < 2 || d !== c || d === 0) throw bad(`Out of balance (debit ${d} ≠ credit ${c})`);
  return tx(() => {
    const id = insert('INSERT INTO journal_entries(date,memo,source_type,source_id,created_by) VALUES(?,?,?,?,?)', date, memo, source_type, source_id, user_id);
    for (const l of ls) {
      getAccount(l.account_id);
      run('INSERT INTO journal_lines(entry_id,account_id,debit,credit,contact_id) VALUES(?,?,?,?,?)', id, l.account_id, l.debit, l.credit, l.contact_id);
    }
    return id;
  });
}

export function removeEntries(source_type, source_id) {
  const locked = get(`SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.source_type=? AND je.source_id=? AND jl.reconciliation_id IS NOT NULL LIMIT 1`, source_type, source_id);
  if (locked) throw bad('This entry has already been reconciled with the bank statement and cannot be changed');
  run('UPDATE bank_txns SET status=\'pending\', entry_id=NULL WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type=? AND source_id=?)', source_type, source_id);
  run('DELETE FROM journal_entries WHERE source_type=? AND source_id=?', source_type, source_id);
}

/* -------------------------------- documentos ------------------------------ */

export function computeLines(type, lines) {
  let subtotal = 0, tax = 0;
  const out = lines.map((l, i) => {
    const qty = Number(l.qty ?? 1), unit = cents(l.unit_price ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) throw bad(`Invalid quantity on line ${i + 1}`);
    const amount = Math.round(qty * unit);
    const rate = type === 'bill' ? 0 : Number(l.tax_rate || 0);
    if (!(rate >= 0 && rate <= 100)) throw bad('Invalid tax rate');
    const tax_amount = Math.round((amount * rate) / 100);
    subtotal += amount; tax += tax_amount;
    return { ...l, qty, unit_price: unit, amount, tax_rate: rate, tax_amount, position: i };
  });
  return { lines: out, subtotal, tax, total: subtotal + tax };
}

export function loadDoc(id) {
  const d = get(`SELECT d.*, c.name AS contact_name, c.email AS contact_email, p.name AS project_name FROM docs d
    JOIN contacts c ON c.id=d.contact_id LEFT JOIN projects p ON p.id=d.project_id WHERE d.id=?`, id);
  if (!d) return null;
  d.lines = all('SELECT l.*, i.name AS item_name FROM doc_lines l LEFT JOIN items i ON i.id=l.item_id WHERE doc_id=? ORDER BY position, id', id);
  d.payments = all('SELECT p.*, a.name AS account_name FROM payments p JOIN accounts a ON a.id=p.account_id WHERE doc_id=? ORDER BY date, id', id);
  d.balance = d.total - d.paid;
  d.overdue = d.type !== 'estimate' && ['sent', 'open', 'partial'].includes(d.status) && d.due_date < today() && d.balance > 0;
  return d;
}

const isPosted = (d) => d.type !== 'estimate' && !['draft', 'void'].includes(d.status);

function stockMove(item, qty_delta, unit_cost, source_type, source_id, date) {
  run('INSERT INTO stock_moves(item_id,qty_delta,unit_cost,source_type,source_id,date) VALUES(?,?,?,?,?,?)', item.id, qty_delta, unit_cost, source_type, source_id, date);
  run('UPDATE items SET qty_on_hand = qty_on_hand + ? WHERE id=?', qty_delta, item.id);
}
function revertStock(source_type, source_id) {
  for (const m of all('SELECT * FROM stock_moves WHERE source_type=? AND source_id=?', source_type, source_id)) {
    run('UPDATE items SET qty_on_hand = qty_on_hand - ? WHERE id=?', m.qty_delta, m.item_id);
  }
  run('DELETE FROM stock_moves WHERE source_type=? AND source_id=?', source_type, source_id);
}

function postDoc(doc, user_id) {
  if (doc.type === 'estimate') return;
  const group = new Map();
  const add = (account_id, debit, credit, contact_id = null) => {
    const k = `${account_id}:${contact_id}`;
    const g = group.get(k) || { account_id, debit: 0, credit: 0, contact_id };
    g.debit += debit; g.credit += credit; group.set(k, g);
  };
  const salesAcc = () => get('SELECT id FROM accounts WHERE subtype=\'sales\' AND active=1 ORDER BY code LIMIT 1')?.id;
  const svcAcc = () => get('SELECT id FROM accounts WHERE subtype=\'services\' AND active=1 ORDER BY code LIMIT 1')?.id;
  const miscExp = () => get('SELECT id FROM accounts WHERE code=\'6990\'')?.id ?? get('SELECT id FROM accounts WHERE type=\'expense\' AND subtype=\'\' ORDER BY code LIMIT 1').id;

  if (doc.type === 'invoice') {
    add(sysAccount('ar').id, doc.total, 0, doc.contact_id);
    const cogsAcc = sysAccount('cogs').id, invAcc = sysAccount('inventory').id;
    for (const l of doc.lines) {
      const item = l.item_id ? get('SELECT * FROM items WHERE id=?', l.item_id) : null;
      const acc = l.account_id || item?.income_account_id || (item?.kind === 'product' ? salesAcc() : svcAcc()) || salesAcc();
      add(acc, 0, l.amount);
      if (item?.track_inventory) {
        const cogs = Math.round(l.qty * item.cost);
        stockMove(item, -l.qty, item.cost, 'doc', doc.id, doc.issue_date);
        add(cogsAcc, cogs, 0); add(invAcc, 0, cogs);
      }
    }
    if (doc.tax) add(sysAccount('tax').id, 0, doc.tax);
  } else {
    const invAcc = sysAccount('inventory').id;
    for (const l of doc.lines) {
      const item = l.item_id ? get('SELECT * FROM items WHERE id=?', l.item_id) : null;
      if (item?.track_inventory) {
        const onHand = Math.max(item.qty_on_hand, 0);
        const newCost = onHand + l.qty > 0 ? Math.round((onHand * item.cost + l.amount) / (onHand + l.qty)) : l.unit_price;
        stockMove(item, l.qty, l.unit_price, 'doc', doc.id, doc.issue_date);
        run('UPDATE items SET cost=? WHERE id=?', newCost, item.id);
        add(invAcc, l.amount, 0);
      } else {
        add(l.account_id || miscExp(), l.amount, 0);
      }
    }
    add(sysAccount('ap').id, 0, doc.total, doc.contact_id);
  }
  postEntry({ date: doc.issue_date, memo: `${memoText(doc.type)} ${doc.number}`, source_type: 'doc', source_id: doc.id, lines: [...group.values()], user_id });
}

function unpostDoc(doc) {
  removeEntries('doc', doc.id);
  revertStock('doc', doc.id);
}

export function recomputeStatus(id) {
  const d = get('SELECT * FROM docs WHERE id=?', id);
  if (!d || d.type === 'estimate' || ['draft', 'void'].includes(d.status)) return;
  const base = d.type === 'invoice' ? 'sent' : 'open';
  const status = d.total > 0 && d.paid >= d.total ? 'paid' : d.paid > 0 ? 'partial' : base;
  run('UPDATE docs SET status=? WHERE id=?', status, id);
}

function nextNumber(type) {
  const key = `next_${type}`, prefix = getSetting(`${type}_prefix`, '');
  for (;;) {
    const n = Number(getSetting(key, '1001'));
    setSetting(key, n + 1);
    const number = `${prefix}${n}`;
    if (!get('SELECT 1 FROM docs WHERE type=? AND number=?', type, number)) return number;
  }
}

export function saveDoc(input, user) {
  const type = input.type;
  if (!['invoice', 'estimate', 'bill'].includes(type)) throw bad('Invalid document type');
  if (!get('SELECT 1 FROM contacts WHERE id=?', input.contact_id)) throw bad('Select a contact');
  if (!isDate(input.issue_date)) throw bad('Invalid issue date');
  const due = input.due_date || input.issue_date;
  if (!isDate(due) || due < input.issue_date) throw bad('Invalid due date');
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw bad('Add at least one line');
  const calc = computeLines(type, input.lines);
  if (calc.lines.some((l) => !l.description && !l.item_id)) throw bad('Every line needs a description or an item');
  if (calc.total <= 0) throw bad('The total must be greater than zero');

  return tx(() => {
    let id = input.id, existing = null;
    if (id) {
      existing = loadDoc(id);
      if (!existing || existing.type !== type) throw new HttpError(404, 'Document not found');
      if (existing.status === 'void') throw bad('A voided document cannot be edited');
      if (isPosted(existing)) {
        if (calc.total < existing.paid) throw bad('The new total is less than the amount already paid');
        unpostDoc(existing);
      }
    }
    const wantPost = type === 'bill' ? input.post !== false : !!input.post;
    let status;
    if (existing && isPosted(existing)) status = existing.status;
    else if (existing && existing.status === 'accepted') status = 'accepted';
    else status = wantPost ? (type === 'bill' ? 'open' : 'sent') : 'draft';
    if (existing && isPosted(existing) && !wantPost && existing.paid > 0) status = existing.status;

    const fields = [input.contact_id, input.project_id || null, input.issue_date, due, calc.subtotal, calc.tax, calc.total, input.notes || '', status];
    if (existing) {
      run('UPDATE docs SET contact_id=?,project_id=?,issue_date=?,due_date=?,subtotal=?,tax=?,total=?,notes=?,status=? WHERE id=?', ...fields, id);
      run('UPDATE time_entries SET invoice_id=NULL WHERE invoice_id=?', id);
      run('DELETE FROM doc_lines WHERE doc_id=?', id);
    } else {
      id = insert(`INSERT INTO docs(contact_id,project_id,issue_date,due_date,subtotal,tax,total,notes,status,type,number,share_token,created_by,recurring_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...fields, type, nextNumber(type), crypto.randomBytes(12).toString('hex'), user?.id ?? null, input.recurring_id ?? null);
    }
    for (const l of calc.lines) {
      run('INSERT INTO doc_lines(doc_id,position,item_id,description,qty,unit_price,tax_rate,account_id,amount,tax_amount,time_entry_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        id, l.position, l.item_id || null, l.description || '', l.qty, l.unit_price, l.tax_rate, l.account_id || null, l.amount, l.tax_amount, l.time_entry_id || null);
      if (l.time_entry_id) run('UPDATE time_entries SET invoice_id=? WHERE id=?', id, l.time_entry_id);
    }
    const doc = loadDoc(id);
    if (isPosted(doc)) { postDoc(doc, user?.id); recomputeStatus(id); }
    return loadDoc(id);
  });
}

export function setDocStatus(id, action, user) {
  return tx(() => {
    const d = loadDoc(id);
    if (!d) throw new HttpError(404, 'Document not found');
    if (action === 'post') {
      if (d.type === 'estimate' || d.status !== 'draft') throw bad('Only drafts can be issued');
      run('UPDATE docs SET status=? WHERE id=?', d.type === 'bill' ? 'open' : 'sent', id);
      postDoc(loadDoc(id), user?.id); recomputeStatus(id);
    } else if (action === 'void') {
      if (d.status === 'void') throw bad('Already voided');
      if (d.payments.length) throw bad('Remove the payments before voiding');
      if (isPosted(d)) unpostDoc(d);
      run('UPDATE time_entries SET invoice_id=NULL WHERE invoice_id=?', id);
      run('UPDATE docs SET status=\'void\' WHERE id=?', id);
    } else if (['accept', 'decline', 'send'].includes(action) && d.type === 'estimate') {
      run('UPDATE docs SET status=? WHERE id=?', { accept: 'accepted', decline: 'declined', send: 'sent' }[action], id);
    } else throw bad('Invalid action');
    return loadDoc(id);
  });
}

export function deleteDoc(id) {
  return tx(() => {
    const d = loadDoc(id);
    if (!d) throw new HttpError(404, 'Document not found');
    if (isPosted(d)) throw bad('Void the document before deleting it');
    run('UPDATE time_entries SET invoice_id=NULL WHERE invoice_id=?', id);
    run('DELETE FROM docs WHERE id=?', id);
  });
}

export function convertEstimate(id, user) {
  return tx(() => {
    const e = loadDoc(id);
    if (!e || e.type !== 'estimate') throw new HttpError(404, 'Estimate not found');
    if (e.converted_to) throw bad('Estimate already converted');
    if (['declined', 'void'].includes(e.status)) throw bad('A declined or voided estimate cannot be converted');
    const terms = get('SELECT terms_days FROM contacts WHERE id=?', e.contact_id)?.terms_days ?? 15;
    const inv = saveDoc({ type: 'invoice', contact_id: e.contact_id, project_id: e.project_id, issue_date: today(), due_date: addDays(today(), terms),
      notes: e.notes, lines: e.lines, post: false }, user);
    run('UPDATE docs SET converted_to=?, status=\'invoiced\' WHERE id=?', inv.id, id);
    return inv;
  });
}

/* -------------------------------- pagamentos ------------------------------ */

export function addPayment(doc_id, { date, amount, account_id, method = '', ref = '' }, user) {
  return tx(() => {
    const d = loadDoc(doc_id);
    if (!d || !isPosted(d)) throw bad('This document cannot take payments (issue it first)');
    const amt = cents(amount);
    if (!isDate(date)) throw bad('Invalid date');
    if (amt <= 0) throw bad('Amount must be positive');
    if (amt > d.balance) throw bad('Amount is larger than the open balance');
    const acc = getAccount(account_id);
    if (!['asset', 'liability'].includes(acc.type) || ['ar', 'ap', 'tax'].includes(acc.subtype)) throw bad('Invalid payment account');
    const pid = insert('INSERT INTO payments(doc_id,date,amount,account_id,method,ref) VALUES(?,?,?,?,?,?)', doc_id, date, amt, account_id, method, ref);
    const ctrl = sysAccount(d.type === 'invoice' ? 'ar' : 'ap').id;
    const lines = d.type === 'invoice'
      ? [{ account_id, debit: amt }, { account_id: ctrl, credit: amt, contact_id: d.contact_id }]
      : [{ account_id: ctrl, debit: amt, contact_id: d.contact_id }, { account_id, credit: amt }];
    postEntry({ date, memo: `${memoText('payment')} ${d.number}`, source_type: 'payment', source_id: pid, lines, user_id: user?.id });
    run('UPDATE docs SET paid = paid + ? WHERE id=?', amt, doc_id);
    recomputeStatus(doc_id);
    return loadDoc(doc_id);
  });
}

export function deletePayment(id) {
  return tx(() => {
    const p = get('SELECT * FROM payments WHERE id=?', id);
    if (!p) throw new HttpError(404, 'Payment not found');
    removeEntries('payment', id);
    run('DELETE FROM payments WHERE id=?', id);
    run('UPDATE docs SET paid = paid - ? WHERE id=?', p.amount, p.doc_id);
    recomputeStatus(p.doc_id);
    return loadDoc(p.doc_id);
  });
}

/* --------------------------------- despesas ------------------------------- */

export function saveExpense(input, user) {
  const amount = cents(input.amount);
  if (amount <= 0) throw bad('Amount must be positive');
  if (!isDate(input.date)) throw bad('Invalid date');
  const exp = getAccount(input.account_id), from = getAccount(input.paid_from_id);
  if (exp.type !== 'expense' && exp.type !== 'asset') throw bad('Invalid expense category');
  if (!['asset', 'liability'].includes(from.type)) throw bad('Invalid payment account');
  if (input.receipt && String(input.receipt).length > 2_500_000) throw bad('Receipt is too large (max ~1.8 MB)');
  return tx(() => {
    let id = input.id;
    if (id) {
      if (!get('SELECT 1 FROM expenses WHERE id=?', id)) throw new HttpError(404, 'Expense not found');
      removeEntries('expense', id);
      run('UPDATE expenses SET date=?,contact_id=?,account_id=?,paid_from_id=?,amount=?,description=?,ref=?,project_id=?,receipt=COALESCE(?,receipt) WHERE id=?',
        input.date, input.contact_id || null, input.account_id, input.paid_from_id, amount, input.description || '', input.ref || '', input.project_id || null, input.receipt ?? null, id);
    } else {
      id = insert('INSERT INTO expenses(date,contact_id,account_id,paid_from_id,amount,description,ref,project_id,receipt,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        input.date, input.contact_id || null, input.account_id, input.paid_from_id, amount, input.description || '', input.ref || '', input.project_id || null, input.receipt || null, user?.id ?? null);
    }
    postEntry({ date: input.date, memo: input.description || memoText('expense'), source_type: 'expense', source_id: id, user_id: user?.id,
      lines: [{ account_id: input.account_id, debit: amount, contact_id: input.contact_id || null }, { account_id: input.paid_from_id, credit: amount }] });
    return get('SELECT * FROM expenses WHERE id=?', id);
  });
}

export function deleteExpense(id) {
  return tx(() => {
    if (!get('SELECT 1 FROM expenses WHERE id=?', id)) throw new HttpError(404, 'Expense not found');
    removeEntries('expense', id);
    run('DELETE FROM expenses WHERE id=?', id);
  });
}

/* --------------------------------- estoque -------------------------------- */

export function adjustStock({ item_id, qty_delta, date, offset_account_id }, user) {
  const item = get('SELECT * FROM items WHERE id=?', item_id);
  if (!item || !item.track_inventory) throw bad('Item does not track inventory');
  const q = Number(qty_delta);
  if (!Number.isFinite(q) || q === 0) throw bad('Invalid quantity');
  const d = date || today();
  const offset = offset_account_id ? getAccount(offset_account_id).id : sysAccount('cogs').id;
  return tx(() => {
    const sid = insert('INSERT INTO stock_moves(item_id,qty_delta,unit_cost,source_type,source_id,date) VALUES(?,?,?,?,?,?)', item.id, q, item.cost, 'adjust', null, d);
    run('UPDATE items SET qty_on_hand = qty_on_hand + ? WHERE id=?', q, item.id);
    const value = Math.round(Math.abs(q) * item.cost);
    if (value > 0) {
      const inv = sysAccount('inventory').id;
      postEntry({ date: d, memo: `${memoText('stock')}: ${item.name}`, source_type: 'adjust', source_id: sid, user_id: user?.id,
        lines: q > 0 ? [{ account_id: inv, debit: value }, { account_id: offset, credit: value }] : [{ account_id: offset, debit: value }, { account_id: inv, credit: value }] });
    }
    return get('SELECT * FROM items WHERE id=?', item.id);
  });
}

/* ------------------------------ recorrências ------------------------------ */

export function advance(date, frequency) {
  return { weekly: () => addDays(date, 7), monthly: () => addMonths(date, 1), quarterly: () => addMonths(date, 3), yearly: () => addMonths(date, 12) }[frequency]();
}

export function runRecurring(now = today(), user = null) {
  const created = [];
  for (const r of all('SELECT * FROM recurring WHERE active=1 AND next_date<=?', now)) {
    let guard = 0;
    let rec = r;
    while (rec.next_date <= now && guard++ < 60) {
      if (rec.end_date && rec.next_date > rec.end_date) { run('UPDATE recurring SET active=0 WHERE id=?', rec.id); break; }
      const t = JSON.parse(rec.template);
      const terms = Number(t.terms_days ?? 15);
      try {
        const doc = saveDoc({ type: 'invoice', contact_id: t.contact_id, project_id: t.project_id, issue_date: rec.next_date, due_date: addDays(rec.next_date, terms),
          notes: t.notes || '', lines: t.lines, post: !!rec.auto_post, recurring_id: rec.id }, user);
        created.push(doc);
      } catch (e) { console.error(`Recurring invoice ${rec.id} failed:`, e.message); break; }
      run('UPDATE recurring SET next_date=? WHERE id=?', advance(rec.next_date, rec.frequency), rec.id);
      rec = get('SELECT * FROM recurring WHERE id=?', rec.id);
    }
  }
  return created;
}
