// Importar do QuickBooks e do Xero (ou de qualquer planilha CSV): produtos e serviços, faturas em aberto e contas a pagar em aberto.
// (Plano de contas, clientes/fornecedores e saldos de abertura já vêm do migrate.js.) Mostra uma prévia com as colunas que
// reconheceu e só grava depois da confirmação, tudo ou nada.
//
// Como as faturas e contas em aberto entram, sem inventar receita nem contar em dobro:
//   * cada uma é gravada com o total original e o que já foi pago (só o aberto fica a receber/pagar), com as datas de verdade;
//   * se os saldos de abertura (balancete) JÁ foram importados, o contas a receber/pagar já está no livro: a fatura entra só como
//     detalhe (quem deve, quanto e até quando), sem novo lançamento. Receber depois baixa o contas a receber normalmente;
//   * se NÃO há saldos de abertura, cada uma lança Débito Contas a Receber / Crédito "Opening Balance Equity" na data de corte
//     (ou o inverso nas contas a pagar), nunca receita; a conta "Opening Balance Equity" é criada se não existir;
//   * a tela confere o total das faturas abertas contra a conta Contas a Receber do livro e mostra a diferença.
import { all, get, run, insert, tx, getSetting, setSetting } from './db.js';
import { HttpError, isDate, postEntry, sysAccount } from './accounting.js';
import crypto from 'node:crypto';

const bad = (m) => new HttpError(400, m);
export const KINDS = ['items', 'invoices', 'bills'];
export const SOURCES = ['quickbooks', 'xero', 'other'];
const MAX_ROWS = 20000;
const MAX_TEXT = 4_000_000;

/* ------------------------------- leitura do CSV ------------------------------- */

/** CSV com aspas; o delimitador (vírgula, ponto e vírgula ou tab) vem da linha com mais separadores entre as primeiras. */
export function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const sample = text.split(/\r?\n/).slice(0, 15);
  const count = (d) => sample.reduce((s, l) => s + (l.match(new RegExp(d === '\t' ? '\t' : `\\${d}`, 'g')) || []).length, 0);
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/^\*/, '').replace(/[^a-z0-9#]+/g, ' ').trim();

/** "$1,234.56", "(1,234.56)", "1.234,56", "-12" -> centavos; vazio ou ilegível -> null. */
export function parseMoney(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith('-')) { neg = true; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) s = s.length - lastComma - 1 <= 2 && s.indexOf(',') === lastComma ? s.replace(',', '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const c = Math.round(n * 100);
  return neg ? -c : c;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const iso = (y, m, d) => { const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; return isDate(s) ? s : null; };
/** fmt: 'us' (mês/dia/ano), 'dmy' (dia/mês/ano) ou 'auto' (se um dos números passa de 12, ele é o dia; na dúvida, padrão dos EUA). */
export function parseDateStr(v, fmt = 'auto') {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    let a = Number(m[1]), b = Number(m[2]);
    const dayFirst = fmt === 'dmy' ? true : fmt === 'us' ? false : (a > 12 && b <= 12);
    return dayFirst ? iso(y, b, a) : iso(y, a, b);
  }
  m = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ ,-]+(\d{2}|\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()]) return iso(m[3].length === 2 ? 2000 + Number(m[3]) : m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);
  m = s.match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);
  return null;
}

/* --------------------------- colunas (nomes que cada sistema usa) --------------------------- */

// campo -> nomes possíveis do cabeçalho (já sem acento/pontuação, em minúsculas), do mais para o menos específico.
const SPEC = {
  items: {
    name: ['product service name', 'item name', 'name', 'product name', 'service name', 'item'],
    sku: ['sku', 'item code', 'code', 'itemcode'],
    type: ['type', 'item type'],
    price: ['sales price rate', 'sales price', 'salesunitprice', 'sales unit price', 'price', 'rate', 'unit price', 'selling price'],
    cost: ['purchase cost', 'purchasesunitprice', 'purchases unit price', 'cost', 'unit cost'],
  },
  docs: {
    number: ['invoice number', 'invoicenumber', 'bill number', 'bill no', 'invoice no', 'num', 'number', 'doc number', 'ref no', 'reference no', 'reference number', 'no', 'reference'],
    contact: ['contactname', 'contact name', 'customer name', 'vendor name', 'customer', 'vendor', 'supplier', 'client', 'name', 'contact'],
    date: ['invoicedate', 'invoice date', 'bill date', 'issue date', 'transaction date', 'date', 'create date'],
    due: ['duedate', 'due date', 'due'],
    amount: ['original amount', 'invoice amount', 'invoice total', 'total', 'amount', 'gross', 'amount original'],
    open: ['open balance', 'amountdue', 'amount due', 'balance due', 'outstanding', 'amount open', 'balance'],
    type: ['transaction type', 'type'],
    description: ['description', 'memo description', 'memo', 'item description'],
    qty: ['quantity', 'qty'],
    unit: ['unitamount', 'unit amount', 'unit price', 'unit cost', 'rate', 'price'],
  },
};
const REQUIRED = { items: ['name'], docs: ['number', 'contact', 'date'] };
const specFor = (kind) => SPEC[kind === 'invoices' || kind === 'bills' ? 'docs' : kind];
const IMPORTANT = { items: ['price', 'cost'], docs: ['amount', 'open', 'due'] };
const requiredFor = (kind) => REQUIRED[kind === 'invoices' || kind === 'bills' ? 'docs' : kind];

/** Acha a linha de cabeçalho (os relatórios do QuickBooks têm título e data nas primeiras linhas) e as colunas de cada campo. */
function locate(kind, rows, mapping = {}) {
  const spec = specFor(kind), req = requiredFor(kind);
  let best = { idx: -1, score: -1 };
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = new Set(rows[i].map(norm));
    const score = Object.entries(spec).filter(([field, syn]) => syn.some((s) => cells.has(s)) || (mapping[field] && cells.has(norm(mapping[field])))).length;
    if (score > best.score) best = { idx: i, score };
  }
  if (best.score < Math.min(2, req.length)) {
    // não reconheceu nenhuma coluna: usa a primeira linha com 2+ células como cabeçalho e deixa a pessoa escolher as colunas na tela
    const guess = rows.findIndex((r, i) => i < 40 && r.filter((c) => String(c).trim()).length >= 2);
    if (guess < 0 || guess >= rows.length - 1) throw bad('Could not find the header row. Check that this is the right file for this step.');
    best = { idx: guess, score: 0 };
  }
  const headers = rows[best.idx].map((h) => String(h ?? '').trim());
  const normHeaders = headers.map(norm);
  const cols = {};
  for (const [field, syns] of Object.entries(spec)) {
    const forced = mapping[field];
    if (forced !== undefined && forced !== null && forced !== '') {
      const k = normHeaders.indexOf(norm(forced));
      if (k >= 0) { cols[field] = k; continue; }
    }
    for (const s of syns) { const k = normHeaders.indexOf(s); if (k >= 0) { cols[field] = k; break; } }
  }
  return { headerIdx: best.idx, headers, cols, dataRows: rows.slice(best.idx + 1) };
}

/* ------------------------------ produtos e serviços ------------------------------ */

function analyzeItems(L) {
  const existing = new Set(all('SELECT name FROM items').map((i) => norm(i.name)));
  const out = [], skipped = [], seen = new Set();
  L.dataRows.forEach((r, i) => {
    const line = L.headerIdx + 2 + i;
    const g = (f) => (L.cols[f] !== undefined ? String(r[L.cols[f]] ?? '').trim() : '');
    const name = g('name');
    if (!name || /^total/i.test(name)) return;
    if (seen.has(norm(name))) { skipped.push({ line, name, reason: 'Repeated in the file' }); return; }
    seen.add(norm(name));
    if (existing.has(norm(name))) { skipped.push({ line, name, reason: 'An item with this name already exists' }); return; }
    const kind = /inventory|product|non inventory|noninventory|goods/i.test(g('type')) ? 'product' : 'service';
    out.push({ name: name.slice(0, 120), sku: g('sku').slice(0, 60), kind, price: Math.max(0, parseMoney(g('price')) ?? 0), cost: Math.max(0, parseMoney(g('cost')) ?? 0) });
  });
  return { rows: out, skipped, summary: { create: out.length, note: 'Stock quantities are not imported; record them with a stock adjustment.' } };
}
function applyItems(a) {
  let created = 0;
  for (const r of a.rows) { insert('INSERT INTO items(name,sku,kind,price,cost,track_inventory) VALUES(?,?,?,?,?,0)', r.name, r.sku, r.kind, r.price, r.cost); created++; }
  return { created };
}

/* ------------------------------ faturas e contas a pagar em aberto ------------------------------ */

function analyzeDocs(L, kind, opts) {
  const type = kind === 'bills' ? 'bill' : 'invoice';
  const fmt = ['us', 'dmy'].includes(opts.dateFormat) ? opts.dateFormat : opts.source === 'xero' ? 'dmy' : 'us';
  const linesLayout = L.cols.qty !== undefined && L.cols.unit !== undefined;
  const existing = new Set(all('SELECT number FROM docs WHERE type=?', type).map((d) => d.number));
  const groups = new Map(), skipped = [];
  let anon = 0;
  L.dataRows.forEach((r, i) => {
    const line = L.headerIdx + 2 + i;
    const g = (f) => (L.cols[f] !== undefined ? String(r[L.cols[f]] ?? '').trim() : '');
    const contact = g('contact');
    const date = parseDateStr(g('date'), fmt);
    if (!date) {
      // linhas de grupo ("Current", "1 - 30", totais) não têm número nem valor: não são faturas. Se tem, a data é que não foi entendida.
      if (g('number') && (parseMoney(g('amount')) !== null || parseMoney(g('open')) !== null)) skipped.push({ line, name: g('number'), reason: `Unreadable date "${g('date')}" (try the other date format)` });
      return;
    }
    const tt = g('type');
    if (tt && !new RegExp(`^${type}s?$`, 'i').test(tt)) { skipped.push({ line, name: g('number') || contact, reason: `Transaction type "${tt}" is not imported` }); return; }
    if (!contact) { skipped.push({ line, name: g('number'), reason: 'No customer/vendor name' }); return; }
    const number = (g('number') || `IMP-${++anon}`).slice(0, 40);
    const key = `${number}\u0000${norm(contact)}`;
    const grp = groups.get(key) || { number, contact: contact.slice(0, 120), date, due: parseDateStr(g('due'), fmt) || date, lines: [], amount: null, open: null, firstLine: line };
    if (linesLayout) {
      const qty = Number(String(g('qty')).replace(/,/g, '')) || 1, unit = parseMoney(g('unit')) ?? 0;
      grp.lines.push({ description: g('description').slice(0, 200) || `Imported ${type}`, qty, unit_price: unit });
    }
    const amount = parseMoney(g('amount')), open = parseMoney(g('open'));
    if (amount !== null && grp.amount === null) grp.amount = amount;
    if (open !== null && grp.open === null) grp.open = open;
    groups.set(key, grp);
  });
  const out = [];
  for (const grp of groups.values()) {
    const sum = grp.lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price), 0);
    let total = linesLayout && sum > 0 ? sum : (grp.amount ?? grp.open ?? 0);
    let open = grp.open ?? total;
    if (total <= 0 && open <= 0) { skipped.push({ line: grp.firstLine, name: grp.number, reason: 'No amount' }); continue; }
    if (open <= 0) { skipped.push({ line: grp.firstLine, name: grp.number, reason: 'Already paid in full (nothing open)' }); continue; }
    if (open > total) total = open;
    if (existing.has(grp.number)) { skipped.push({ line: grp.firstLine, name: grp.number, reason: `${type === 'bill' ? 'Bill' : 'Invoice'} number already exists` }); continue; }
    const lines = linesLayout && sum > 0 ? grp.lines : [{ description: `Imported ${type} ${grp.number}`, qty: 1, unit_price: total }];
    if (linesLayout && sum > 0 && total !== sum) lines.push({ description: 'Adjustment', qty: 1, unit_price: total - sum });
    out.push({ number: grp.number, contact: grp.contact, date: grp.date, due: grp.due < grp.date ? grp.date : grp.due, total, open, paid: total - open, lines });
  }
  const sumOpen = out.reduce((s, d) => s + d.open, 0);
  return { rows: out, skipped, summary: { create: out.length, openTotal: sumOpen, layout: linesLayout ? 'lines' : 'balance', dateFormat: fmt } };
}

/** Conta "Opening Balance Equity": cria se não existir (ou reaproveita a que veio do plano de contas importado). */
function openingEquity() {
  const found = get(`SELECT * FROM accounts WHERE subtype='opening' ORDER BY code LIMIT 1`);
  if (found) return found;
  const byName = get(`SELECT * FROM accounts WHERE lower(name)='opening balance equity' AND type='equity' ORDER BY code LIMIT 1`);
  if (byName) { run(`UPDATE accounts SET subtype='opening' WHERE id=?`, byName.id); return { ...byName, subtype: 'opening' }; }
  const used = new Set(all('SELECT code FROM accounts').map((a) => a.code));
  let n = 3900; while (used.has(String(n)) && n < 3999) n++;
  const id = insert(`INSERT INTO accounts(code,name,type,subtype,is_system) VALUES(?,?,'equity','opening',0)`, String(n), 'Opening Balance Equity');
  return get('SELECT * FROM accounts WHERE id=?', id);
}

/** Os saldos de abertura (balancete) já estão no livro? Então contas a receber/pagar já têm o saldo e a fatura entra só como detalhe. */
export const hasOpeningBalances = () => !!get(`SELECT 1 FROM journal_entries WHERE source_type='opening' LIMIT 1`);

function applyDocs(a, kind, opts, user) {
  const type = kind === 'bills' ? 'bill' : 'invoice';
  const detailOnly = opts.ledgerMode === 'detail' || (opts.ledgerMode !== 'post' && hasOpeningBalances());
  if (!detailOnly && !isDate(opts.asOf)) throw bad('Enter the conversion date (the date your balances are as of).');
  const obe = detailOnly ? null : openingEquity(), control = sysAccount(type === 'bill' ? 'ap' : 'ar');
  const srcLabel = opts.source === 'xero' ? 'Xero' : opts.source === 'quickbooks' ? 'QuickBooks' : 'your previous system';
  let created = 0, newContacts = 0;
  for (const d of a.rows) {
    let c = get('SELECT * FROM contacts WHERE lower(name)=lower(?)', d.contact);
    if (!c) { const cid = insert('INSERT INTO contacts(kind,name,terms_days) VALUES(?,?,15)', type === 'bill' ? 'vendor' : 'customer', d.contact); c = get('SELECT * FROM contacts WHERE id=?', cid); newContacts++; }
    else if (c.kind !== 'both' && c.kind !== (type === 'bill' ? 'vendor' : 'customer')) run(`UPDATE contacts SET kind='both' WHERE id=?`, c.id);
    const status = d.paid > 0 ? 'partial' : (type === 'invoice' ? 'sent' : 'open');
    const note = `Imported from ${srcLabel}. Original total ${(d.total / 100).toFixed(2)}, open at import ${(d.open / 100).toFixed(2)}.`;
    const id = insert(`INSERT INTO docs(type,number,contact_id,issue_date,due_date,status,subtotal,tax,total,paid,notes,share_token,created_by) VALUES(?,?,?,?,?,?,?,0,?,?,?,?,?)`,
      type, d.number, c.id, d.date, d.due, status, d.total, d.total, d.paid, note, crypto.randomBytes(12).toString('hex'), user?.id ?? null);
    d.lines.forEach((l, pos) => run('INSERT INTO doc_lines(doc_id,position,description,qty,unit_price,amount) VALUES(?,?,?,?,?,?)', id, pos, l.description, l.qty, l.unit_price, Math.round(l.qty * l.unit_price)));
    if (!detailOnly) {
      const lines = type === 'invoice'
        ? [{ account_id: control.id, debit: d.open, contact_id: c.id }, { account_id: obe.id, credit: d.open }]
        : [{ account_id: obe.id, debit: d.open }, { account_id: control.id, credit: d.open, contact_id: c.id }];
      postEntry({ date: opts.asOf, memo: `Opening balance ${d.number}`, source_type: 'doc', source_id: id, lines, user_id: user?.id ?? null });
    }
    created++;
  }
  return { created, newContacts, mode: detailOnly ? 'detail' : 'post' };
}

/* ------------------------------ entrada principal ------------------------------ */

/** Lê o arquivo e devolve o que SERIA feito (sem gravar nada). */
export function analyze(kind, text, opts = {}) {
  if (!KINDS.includes(kind)) throw bad('Unknown import type');
  if (typeof text !== 'string' || !text.trim()) throw bad('The file is empty');
  if (text.length > MAX_TEXT) throw bad('The file is too large (4 MB maximum). Split it in two.');
  const rows = parseCsv(text);
  if (rows.length > MAX_ROWS) throw bad(`Too many rows (${MAX_ROWS} maximum per file)`);
  const L = locate(kind, rows, opts.mapping || {});
  const missing = requiredFor(kind).filter((f) => L.cols[f] === undefined);
  const base = { kind, headers: L.headers, mapping: Object.fromEntries(Object.keys(specFor(kind)).map((f) => [f, L.cols[f] !== undefined ? (L.headers[L.cols[f]] || '(first column)') : null])), required: requiredFor(kind), missing, unmapped: (IMPORTANT[kind === 'items' ? 'items' : 'docs'] || []).filter((f) => L.cols[f] === undefined) };
  if (missing.length) return { ...base, rows: [], skipped: [], summary: {}, ready: false };
  const r = kind === 'items' ? analyzeItems(L) : analyzeDocs(L, kind, opts);
  if (kind !== 'items') r.summary.mode = opts.ledgerMode === 'detail' || (opts.ledgerMode !== 'post' && hasOpeningBalances()) ? 'detail' : 'post';
  return { ...base, ...r, ready: r.rows.length > 0 };
}

/** Grava (tudo ou nada). Refaz a leitura no servidor: o que vale é o arquivo, não o que a tela mandou de volta. */
export function runImport(kind, text, opts, user) {
  const a = analyze(kind, text, opts);
  if (a.missing.length) throw bad(`Missing column: ${a.missing.join(', ')}`);
  if (!a.rows.length) throw bad('Nothing to import from this file.');
  const result = tx(() => (kind === 'items' ? applyItems(a) : applyDocs(a, kind, opts, user)));
  const log = JSON.parse(getSetting('import_history', '[]'));
  log.unshift({ at: new Date().toISOString(), kind, source: opts.source || 'other', ...result, skipped: a.skipped.length });
  setSetting('import_history', JSON.stringify(log.slice(0, 30)));
  return { kind, ...result, skipped: a.skipped.length, check: subledgerCheck() };
}

/** Faturas e contas a pagar abertas (o detalhe) contra a conta de controle do livro: quem importou confere se bate. */
export function subledgerCheck() {
  const bal = (sub, sign) => (get(`SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.subtype=?`, sub)?.v || 0) * sign;
  const open = (type, sts) => get(`SELECT COALESCE(SUM(total - paid),0) AS v FROM docs WHERE type=? AND status IN (${sts})`, type)?.v || 0;
  const ar = { ledger: bal('ar', 1), documents: open('invoice', "'sent','partial'") };
  const ap = { ledger: bal('ap', -1), documents: open('bill', "'open','partial'") };
  const obe = get(`SELECT id FROM accounts WHERE subtype='opening' ORDER BY code LIMIT 1`);
  return {
    receivable: { ...ar, difference: ar.ledger - ar.documents }, payable: { ...ap, difference: ap.ledger - ap.documents },
    openingBalanceEquity: obe ? (get('SELECT COALESCE(SUM(credit-debit),0) AS v FROM journal_lines WHERE account_id=?', obe.id)?.v || 0) : 0,
    openingBalancesImported: hasOpeningBalances(),
  };
}

export function importStatus() {
  return { history: JSON.parse(getSetting('import_history', '[]')), check: subledgerCheck() };
}
