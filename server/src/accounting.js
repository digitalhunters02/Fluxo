// Motor contábil: toda movimentação vira lançamento de partidas dobradas (débito = crédito).
import crypto from 'node:crypto';
import { all, get, run, insert, tx, getSetting, setSetting } from './db.js';
import { emit } from './events.js';
import { approvalBlocksPayment } from './guard.js';

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const bad = (m) => new HttpError(400, m);

const MEMOS = {
  invoice: { en: 'Invoice', pt: 'Fatura', es: 'Factura' }, bill: { en: 'Bill', pt: 'Conta a pagar', es: 'Cuenta por pagar' },
  payment: { en: 'Payment', pt: 'Pagamento', es: 'Pago' }, expense: { en: 'Expense', pt: 'Despesa', es: 'Gasto' },
  stock: { en: 'Stock adjustment', pt: 'Ajuste de estoque', es: 'Ajuste de inventario' }, transfer: { en: 'Transfer', pt: 'Transferência', es: 'Transferencia' },
  credit: { en: 'Credit memo', pt: 'Nota de crédito', es: 'Nota de crédito' }, refund: { en: 'Refund', pt: 'Reembolso', es: 'Reembolso' },
  payroll: { en: 'Payroll', pt: 'Folha de pagamento', es: 'Nómina' }, payroll_tax: { en: 'Payroll tax payment', pt: 'Pagamento de impostos da folha', es: 'Pago de impuestos de nómina' },
};
/** Texto de memorando gerado pelo sistema, no idioma da empresa. */
export const memoText = (key) => { const l = getSetting('lang', 'en'); return MEMOS[key][l] || MEMOS[key].en; };
const QUOTES = ['estimate', 'po']; // documentos que não geram lançamento contábil
export const isQuote = (type) => QUOTES.includes(type);
export const TIMEZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Puerto_Rico', 'UTC'];
/** "Hoje" no fuso da empresa (e não em UTC, que à noite nos EUA já é o dia seguinte). */
export const today = (now = new Date()) => {
  let zone = getSetting('timezone', 'America/New_York');
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now); }
  catch { zone = 'UTC'; return now.toISOString().slice(0, 10); }
};
export const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const addMonths = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
};
/** Data real no formato AAAA-MM-DD (recusa 2026-02-31, que o Date.parse aceitaria como 3 de março). */
export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
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

/** Fechamento de período: nada pode ser lançado ou desfeito em data anterior ou igual à data de bloqueio. */
export function assertOpenPeriod(date) {
  const lock = getSetting('lock_date', '');
  if (lock && date <= lock) throw bad(`Books are closed through ${lock}`);
}

export function postEntry({ date, memo = '', source_type = 'manual', source_id = null, lines, user_id = null }) {
  if (!isDate(date)) throw bad('Invalid date');
  assertOpenPeriod(date);
  const ls = lines.map((l) => ({ account_id: l.account_id, debit: cents(l.debit || 0), credit: cents(l.credit || 0), contact_id: l.contact_id || null, class_id: l.class_id || null }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  if (ls.some((l) => l.debit < 0 || l.credit < 0 || (l.debit && l.credit))) throw bad('Invalid journal line');
  const d = ls.reduce((s, l) => s + l.debit, 0), c = ls.reduce((s, l) => s + l.credit, 0);
  if (ls.length < 2 || d !== c || d === 0) throw bad(`Out of balance (debit ${d} ≠ credit ${c})`);
  return tx(() => {
    const id = insert('INSERT INTO journal_entries(date,memo,source_type,source_id,created_by) VALUES(?,?,?,?,?)', date, memo, source_type, source_id, user_id);
    for (const l of ls) {
      getAccount(l.account_id);
      run('INSERT INTO journal_lines(entry_id,account_id,debit,credit,contact_id,class_id) VALUES(?,?,?,?,?,?)', id, l.account_id, l.debit, l.credit, l.contact_id, l.class_id);
    }
    return id;
  });
}

export function removeEntries(source_type, source_id) {
  for (const e of all('SELECT date FROM journal_entries WHERE source_type=? AND source_id=?', source_type, source_id)) assertOpenPeriod(e.date);
  const locked = get(`SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE je.source_type=? AND je.source_id=? AND jl.reconciliation_id IS NOT NULL LIMIT 1`, source_type, source_id);
  if (locked) throw bad('This entry has already been reconciled with the bank statement and cannot be changed');
  run('UPDATE bank_txns SET status=\'pending\', entry_id=NULL WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type=? AND source_id=?)', source_type, source_id);
  run('DELETE FROM journal_entries WHERE source_type=? AND source_id=?', source_type, source_id);
}

/* -------------------------------- documentos ------------------------------ */

/** Arredonda para o centavo (meio centavo sobe) ignorando o ruído de ponto flutuante: 2.4999999999999996 conta como 2.5. */
const roundCents = (x) => Math.round(Number(x.toPrecision(12)));
export function computeLines(type, lines) {
  let subtotal = 0, tax = 0;
  const out = lines.map((l, i) => {
    const qty = Number(l.qty ?? 1), unit = cents(l.unit_price ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) throw bad(`Invalid quantity on line ${i + 1}`);
    const amount = roundCents(qty * unit);
    const rate = ['bill', 'po'].includes(type) ? 0 : Number(l.tax_rate || 0);
    if (!(rate >= 0 && rate <= 100)) throw bad('Invalid tax rate');
    const tax_amount = roundCents((amount * rate) / 100);
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
  d.applications = all(`SELECT ca.*, cd.number AS credit_number, inv.number AS invoice_number, a.name AS account_name FROM credit_applications ca JOIN docs cd ON cd.id=ca.credit_id
    LEFT JOIN docs inv ON inv.id=ca.invoice_id LEFT JOIN accounts a ON a.id=ca.account_id WHERE ca.credit_id=? OR ca.invoice_id=? ORDER BY ca.date, ca.id`, id, id);
  d.balance = d.total - d.paid;
  d.overdue = ['invoice', 'bill'].includes(d.type) && ['sent', 'open', 'partial'].includes(d.status) && d.due_date < today() && d.balance > 0;
  return d;
}

const isPosted = (d) => !isQuote(d.type) && !['draft', 'void'].includes(d.status);

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
  if (isQuote(doc.type)) return;
  const group = new Map();
  const add = (account_id, debit, credit, contact_id = null, class_id = null) => {
    const k = `${account_id}:${contact_id}:${class_id}`;
    const g = group.get(k) || { account_id, debit: 0, credit: 0, contact_id, class_id };
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
      add(acc, 0, l.amount, null, l.class_id);
      if (item?.track_inventory) {
        const cogs = Math.round(l.qty * item.cost);
        stockMove(item, -l.qty, item.cost, 'doc', doc.id, doc.issue_date);
        add(cogsAcc, cogs, 0); add(invAcc, 0, cogs);
      }
    }
    if (doc.tax) add(sysAccount('tax').id, 0, doc.tax);
  } else if (doc.type === 'credit') {
    add(sysAccount('ar').id, 0, doc.total, doc.contact_id);
    for (const l of doc.lines) {
      const item = l.item_id ? get('SELECT * FROM items WHERE id=?', l.item_id) : null;
      const acc = l.account_id || item?.income_account_id || (item?.kind === 'product' ? salesAcc() : svcAcc()) || salesAcc();
      add(acc, l.amount, 0, null, l.class_id);
    }
    if (doc.tax) add(sysAccount('tax').id, doc.tax, 0);
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
        add(l.account_id || miscExp(), l.amount, 0, null, l.class_id);
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
  if (!d || isQuote(d.type) || ['draft', 'void'].includes(d.status)) return;
  const base = d.type === 'invoice' ? 'sent' : 'open';
  const full = d.type === 'credit' ? 'used' : 'paid';
  const status = d.total > 0 && d.paid >= d.total ? full : d.paid > 0 ? 'partial' : base;
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
  if (!['invoice', 'estimate', 'bill', 'credit', 'po'].includes(type)) throw bad('Invalid document type');
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
    const postedStatus = { invoice: 'sent', estimate: 'sent', po: 'sent', bill: 'open', credit: 'open' }[type];
    let status;
    if (existing && isPosted(existing)) status = existing.status;
    else if (existing && existing.status === 'accepted') status = 'accepted';
    else status = wantPost ? postedStatus : 'draft';
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
      run('INSERT INTO doc_lines(doc_id,position,item_id,description,qty,unit_price,tax_rate,account_id,amount,tax_amount,time_entry_id,class_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id, l.position, l.item_id || null, l.description || '', l.qty, l.unit_price, l.tax_rate, l.account_id || null, l.amount, l.tax_amount, l.time_entry_id || null, l.class_id || null);
      if (l.time_entry_id) run('UPDATE time_entries SET invoice_id=? WHERE id=?', id, l.time_entry_id);
    }
    const doc = loadDoc(id);
    if (isPosted(doc)) { postDoc(doc, user?.id); recomputeStatus(id); }
    const saved = loadDoc(id);
    if (!existing && isPosted(saved)) emitDoc(saved);
    return saved;
  });
}

/** Avisa os webhooks que uma fatura ou conta a pagar foi emitida. */
function emitDoc(d) {
  if (d.type === 'invoice') emit('invoice.created', { id: d.id, number: d.number, customerId: d.contact_id, totalCents: d.total, dueDate: d.due_date, externalId: d.external_id || null });
  else if (d.type === 'bill') emit('bill.created', { id: d.id, number: d.number, vendorId: d.contact_id, totalCents: d.total, dueDate: d.due_date });
}

export function setDocStatus(id, action, user) {
  return tx(() => {
    const d = loadDoc(id);
    if (!d) throw new HttpError(404, 'Document not found');
    if (action === 'post') {
      if (isQuote(d.type) || d.status !== 'draft') throw bad('Only drafts can be issued');
      run('UPDATE docs SET status=? WHERE id=?', ['bill', 'credit'].includes(d.type) ? 'open' : 'sent', id);
      postDoc(loadDoc(id), user?.id); recomputeStatus(id);
      emitDoc(loadDoc(id));
    } else if (action === 'void') {
      if (d.status === 'void') throw bad('Already voided');
      if (d.payments.length) throw bad('Remove the payments before voiding');
      if (get('SELECT 1 FROM credit_applications WHERE credit_id=? OR invoice_id=?', id, id)) throw bad('Remove the credit applications before voiding');
      if (isPosted(d)) unpostDoc(d);
      run('UPDATE time_entries SET invoice_id=NULL WHERE invoice_id=?', id);
      run('UPDATE docs SET status=\'void\' WHERE id=?', id);
    } else if (['accept', 'decline', 'send'].includes(action) && isQuote(d.type)) {
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

export function convertPO(id, user) {
  return tx(() => {
    const p = loadDoc(id);
    if (!p || p.type !== 'po') throw new HttpError(404, 'Purchase order not found');
    if (p.converted_to) throw bad('Purchase order already converted');
    if (['declined', 'void'].includes(p.status)) throw bad('A declined or voided purchase order cannot be converted');
    const terms = get('SELECT terms_days FROM contacts WHERE id=?', p.contact_id)?.terms_days ?? 15;
    const bill = saveDoc({ type: 'bill', contact_id: p.contact_id, project_id: p.project_id, issue_date: today(), due_date: addDays(today(), terms), notes: p.notes, lines: p.lines, post: false }, user);
    run("UPDATE docs SET converted_to=?, status='billed' WHERE id=?", bill.id, id);
    return bill;
  });
}

/* ------------------------ notas de crédito e reembolsos ------------------- */

export function applyCredit(credit_id, { invoice_id, amount, date }) {
  return tx(() => {
    const c = loadDoc(credit_id), inv = loadDoc(invoice_id);
    if (!c || c.type !== 'credit' || !isPosted(c)) throw bad('Issue the credit memo first');
    if (!inv || inv.type !== 'invoice' || !isPosted(inv)) throw bad('Choose an issued invoice');
    if (c.contact_id !== inv.contact_id) throw bad('The credit and the invoice belong to different customers');
    const amt = cents(amount);
    if (amt <= 0) throw bad('Amount must be positive');
    if (amt > c.balance) throw bad('Amount is larger than the credit balance');
    if (amt > inv.balance) throw bad('Amount is larger than the open balance');
    if (!isDate(date)) throw bad('Invalid date');
    insert('INSERT INTO credit_applications(credit_id,invoice_id,amount,date) VALUES(?,?,?,?)', credit_id, invoice_id, amt, date);
    run('UPDATE docs SET paid = paid + ? WHERE id IN (?,?)', amt, credit_id, invoice_id);
    recomputeStatus(credit_id); recomputeStatus(invoice_id);
    return loadDoc(credit_id);
  });
}

export function refundCredit(credit_id, { amount, account_id, date }, user) {
  return tx(() => {
    const c = loadDoc(credit_id);
    if (!c || c.type !== 'credit' || !isPosted(c)) throw bad('Issue the credit memo first');
    const amt = cents(amount);
    if (amt <= 0) throw bad('Amount must be positive');
    if (amt > c.balance) throw bad('Amount is larger than the credit balance');
    if (!isDate(date)) throw bad('Invalid date');
    const acc = getAccount(account_id);
    if (acc.type !== 'asset' || acc.subtype !== 'bank') throw bad('Invalid payment account');
    const aid = insert('INSERT INTO credit_applications(credit_id,invoice_id,amount,date,account_id) VALUES(?,NULL,?,?,?)', credit_id, amt, date, account_id);
    postEntry({ date, memo: `${memoText('refund')} ${c.number}`, source_type: 'refund', source_id: aid, user_id: user?.id,
      lines: [{ account_id: sysAccount('ar').id, debit: amt, contact_id: c.contact_id }, { account_id, credit: amt }] });
    run('UPDATE docs SET paid = paid + ? WHERE id=?', amt, credit_id);
    recomputeStatus(credit_id);
    return loadDoc(credit_id);
  });
}

export function removeCreditApplication(app_id) {
  return tx(() => {
    const a = get('SELECT * FROM credit_applications WHERE id=?', app_id);
    if (!a) throw new HttpError(404, 'Application not found');
    if (!a.invoice_id) removeEntries('refund', app_id);
    run('DELETE FROM credit_applications WHERE id=?', app_id);
    run('UPDATE docs SET paid = paid - ? WHERE id=?', a.amount, a.credit_id);
    if (a.invoice_id) run('UPDATE docs SET paid = paid - ? WHERE id=?', a.amount, a.invoice_id);
    recomputeStatus(a.credit_id); if (a.invoice_id) recomputeStatus(a.invoice_id);
    return loadDoc(a.credit_id);
  });
}

/** Cria uma fatura para vários clientes de uma vez, a partir das mesmas linhas. */
export function batchInvoices({ contact_ids, issue_date, terms_days, lines, notes = '', post }, user) {
  if (!Array.isArray(contact_ids) || !contact_ids.length) throw bad('Select at least one customer');
  if (contact_ids.length > 200) throw bad('A batch can have at most 200 customers');
  return tx(() => contact_ids.map((cid) => {
    const terms = terms_days ?? get('SELECT terms_days FROM contacts WHERE id=?', cid)?.terms_days ?? 15;
    return saveDoc({ type: 'invoice', contact_id: cid, issue_date, due_date: addDays(issue_date, Number(terms)), notes, lines, post: !!post }, user).id;
  }));
}

/* -------------------------------- pagamentos ------------------------------ */

export function addPayment(doc_id, { date, amount, account_id, method = '', ref = '' }, user) {
  return tx(() => {
    const d = loadDoc(doc_id);
    if (!d || !isPosted(d) || !['invoice', 'bill'].includes(d.type)) throw bad('This document cannot take payments (issue it first)');
    const amt = cents(amount);
    if (!isDate(date)) throw bad('Invalid date');
    if (amt <= 0) throw bad('Amount must be positive');
    if (amt > d.balance) throw bad('Amount is larger than the open balance');
    const blocked = approvalBlocksPayment(d);
    if (blocked) throw new HttpError(409, blocked, { code: 'approval_required' });
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
    const after = loadDoc(doc_id);
    emit('payment.received', { id: pid, documentId: doc_id, number: d.number, type: d.type, amountCents: amt, date, method });
    if (d.type === 'invoice' && after.status === 'paid') emit('invoice.paid', { id: doc_id, number: d.number, totalCents: after.total });
    return after;
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
  if (input.receipt) {
    const r = String(input.receipt);
    if (r.length > 2_500_000) throw bad('Receipt is too large (max ~1.8 MB)');
    // só imagem ou PDF em base64: um link "javascript:" ou HTML aqui executaria no navegador de quem abrir o comprovante
    if (!/^data:(image\/(png|jpeg|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/]+={0,2}$/.test(r)) throw bad('The receipt must be an image or a PDF');
  }
  return tx(() => {
    let id = input.id;
    if (id) {
      if (!get('SELECT 1 FROM expenses WHERE id=?', id)) throw new HttpError(404, 'Expense not found');
      removeEntries('expense', id);
      run('UPDATE expenses SET date=?,contact_id=?,account_id=?,paid_from_id=?,amount=?,description=?,ref=?,project_id=?,receipt=COALESCE(?,receipt) WHERE id=?',
        input.date, input.contact_id || null, input.account_id, input.paid_from_id, amount, input.description || '', input.ref || '', input.project_id || null, input.receipt ?? null, id);
      run('UPDATE expenses SET class_id=? WHERE id=?', input.class_id || null, id);
    } else {
      id = insert('INSERT INTO expenses(date,contact_id,account_id,paid_from_id,amount,description,ref,project_id,receipt,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)',
        input.date, input.contact_id || null, input.account_id, input.paid_from_id, amount, input.description || '', input.ref || '', input.project_id || null, input.receipt || null, user?.id ?? null);
      run('UPDATE expenses SET class_id=? WHERE id=?', input.class_id || null, id);
    }
    postEntry({ date: input.date, memo: input.description || memoText('expense'), source_type: 'expense', source_id: id, user_id: user?.id,
      lines: [{ account_id: input.account_id, debit: amount, contact_id: input.contact_id || null, class_id: input.class_id || null }, { account_id: input.paid_from_id, credit: amount }] });
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

/** Próxima data da série. Com `anchor` (dia do mês original) uma série de "dia 31" volta ao 31 depois de fevereiro. */
export function advance(date, frequency, anchor = null) {
  const months = { monthly: 1, quarterly: 3, yearly: 12 }[frequency];
  if (frequency === 'weekly') return addDays(date, 7);
  if (!months) throw new HttpError(400, 'Invalid frequency');
  const d = new Date(`${date}T00:00:00Z`);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months, y = Math.floor(total / 12), m = total % 12;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(anchor || d.getUTCDate(), last))).toISOString().slice(0, 10);
}

/** Gera as faturas (ou contas a pagar) recorrentes que venceram. Cada uma e o avanço da data são gravados juntos: se algo falhar no meio, nada fica pela metade nem duplica. */
export function runRecurring(now = today(), user = null) {
  const created = [];
  for (const r of all('SELECT * FROM recurring WHERE active=1 AND next_date<=?', now)) {
    let rec = r, guard = 0;
    while (rec && rec.active && rec.next_date <= now && guard++ < 60) {
      if (rec.end_date && rec.next_date > rec.end_date) { run('UPDATE recurring SET active=0 WHERE id=?', rec.id); break; }
      const t = JSON.parse(rec.template);
      const type = t.type === 'bill' ? 'bill' : 'invoice';
      const terms = Number(t.terms_days ?? 15);
      try {
        const doc = tx(() => {
          const d = saveDoc({ type, contact_id: t.contact_id, project_id: t.project_id, issue_date: rec.next_date, due_date: addDays(rec.next_date, terms),
            notes: t.notes || '', lines: t.lines, post: !!rec.auto_post, recurring_id: rec.id }, user);
          const next = advance(rec.next_date, rec.frequency, rec.anchor_day);
          run("UPDATE recurring SET next_date=?, last_error='', last_run=?, active=? WHERE id=?", next, now, rec.end_date && next > rec.end_date ? 0 : 1, rec.id);
          return d;
        });
        created.push(doc);
      } catch (e) {
        run('UPDATE recurring SET last_error=? WHERE id=?', String(e.message || e).slice(0, 200), rec.id);
        console.error(`Recurring ${type} ${rec.id} failed:`, e.message);
        break; // tenta de novo na próxima rodada; o erro aparece na tela e como lembrete
      }
      rec = get('SELECT * FROM recurring WHERE id=?', rec.id);
    }
  }
  return created;
}
