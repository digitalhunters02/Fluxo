// "Levar tudo": um arquivo ZIP com os dados da empresa em CSV (abre no Excel e em qualquer sistema contábil).
// Promessa do produto: os seus dados são seus, a qualquer momento e em qualquer plano. Fica de fora (de propósito): senhas, chaves,
// códigos de 2FA, segredos de integrações e o número completo de SSN/EIN (sai só o final, como na tela).
import zlib from 'node:zlib';
import { all, getSetting } from './db.js';
import { publicTaxId } from './taxid.js';

/* ------------------------------ CSV ------------------------------ */
const esc = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s)) s = `'${s}`; // texto que começa com = + @ não vira fórmula no Excel
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (cols, rows) => '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n';

/* ------------------------------ ZIP (sem dependências) ------------------------------ */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files, when = new Date()) {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const dosDate = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const parts = [], central = []; let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), data = Buffer.from(f.data, 'utf8'), packed = zlib.deflateRawSync(data), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(packed.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, packed);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/* ------------------------------ o que vai no arquivo ------------------------------ */
const D = (c) => `ROUND(${c}/100.0, 2)`; // centavos -> dólares
// [arquivo, colunas, SQL] (os nomes das colunas do SQL já são os do arquivo)
const TABLES = [
  ['accounts', ['code', 'name', 'type', 'subtype', 'active'], 'SELECT code, name, type, subtype, active FROM accounts ORDER BY code'],
  ['contacts', ['id', 'kind', 'name', 'email', 'phone', 'address', 'notes', 'terms_days', 'is_1099', 'tax_id_last4', 'tax_exempt', 'tax_state', 'active', 'created_at'],
    'SELECT id, kind, name, email, phone, address, notes, terms_days, is_1099, tax_id, tax_exempt, tax_state, active, created_at FROM contacts ORDER BY id'],
  ['items', ['id', 'name', 'sku', 'kind', 'price', 'cost', 'tracks_inventory', 'qty_on_hand', 'tax_rate', 'active'],
    `SELECT id, name, sku, kind, ${D('price')} AS price, ${D('cost')} AS cost, track_inventory AS tracks_inventory, qty_on_hand, tax_rate, active FROM items ORDER BY id`],
  ['documents', ['id', 'type', 'number', 'contact', 'issue_date', 'due_date', 'status', 'subtotal', 'tax', 'total', 'paid', 'notes'],
    `SELECT d.id, d.type, d.number, c.name AS contact, d.issue_date, d.due_date, d.status, ${D('d.subtotal')} AS subtotal, ${D('d.tax')} AS tax, ${D('d.total')} AS total, ${D('d.paid')} AS paid, d.notes
     FROM docs d JOIN contacts c ON c.id=d.contact_id ORDER BY d.issue_date, d.id`],
  ['document_lines', ['doc_type', 'doc_number', 'position', 'description', 'qty', 'unit_price', 'tax_rate', 'tax_name', 'amount', 'tax_amount', 'account'],
    `SELECT d.type AS doc_type, d.number AS doc_number, l.position, l.description, l.qty, ${D('l.unit_price')} AS unit_price, l.tax_rate, l.tax_name, ${D('l.amount')} AS amount, ${D('l.tax_amount')} AS tax_amount, a.code AS account
     FROM doc_lines l JOIN docs d ON d.id=l.doc_id LEFT JOIN accounts a ON a.id=l.account_id ORDER BY d.id, l.position`],
  ['payments', ['id', 'doc_type', 'doc_number', 'date', 'amount', 'account', 'method', 'ref'],
    `SELECT p.id, d.type AS doc_type, d.number AS doc_number, p.date, ${D('p.amount')} AS amount, a.name AS account, p.method, p.ref
     FROM payments p JOIN docs d ON d.id=p.doc_id JOIN accounts a ON a.id=p.account_id ORDER BY p.date, p.id`],
  ['expenses', ['id', 'date', 'vendor', 'category_code', 'category', 'paid_from', 'amount', 'description', 'ref', 'method'],
    `SELECT e.id, e.date, c.name AS vendor, a.code AS category_code, a.name AS category, pf.name AS paid_from, ${D('e.amount')} AS amount, e.description, e.ref, e.method
     FROM expenses e JOIN accounts a ON a.id=e.account_id JOIN accounts pf ON pf.id=e.paid_from_id LEFT JOIN contacts c ON c.id=e.contact_id ORDER BY e.date, e.id`],
  ['general_ledger', ['entry_id', 'date', 'memo', 'source', 'account_code', 'account', 'debit', 'credit', 'contact'],
    `SELECT je.id AS entry_id, je.date, je.memo, je.source_type AS source, a.code AS account_code, a.name AS account, ${D('jl.debit')} AS debit, ${D('jl.credit')} AS credit, c.name AS contact
     FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id JOIN accounts a ON a.id=jl.account_id LEFT JOIN contacts c ON c.id=jl.contact_id ORDER BY je.date, je.id, jl.id`],
  ['bank_transactions', ['id', 'account', 'date', 'description', 'amount', 'status'],
    `SELECT b.id, a.name AS account, b.date, b.description, ${D('b.amount')} AS amount, b.status FROM bank_txns b JOIN accounts a ON a.id=b.account_id ORDER BY b.date, b.id`],
  ['projects', ['id', 'name', 'customer', 'hourly_rate', 'budget', 'status', 'notes'],
    `SELECT p.id, p.name, c.name AS customer, ${D('p.hourly_rate')} AS hourly_rate, ${D('p.budget')} AS budget, p.status, p.notes FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY p.id`],
  ['time_entries', ['id', 'project', 'date', 'hours', 'description', 'billable'],
    `SELECT t.id, p.name AS project, t.date, t.hours, t.description, t.billable FROM time_entries t JOIN projects p ON p.id=t.project_id ORDER BY t.date, t.id`],
  ['tax_rates', ['name', 'state', 'rate', 'notes', 'active'], 'SELECT name, state, rate, notes, active FROM tax_rates ORDER BY name'],
  ['budgets', ['account_code', 'month', 'amount'], `SELECT a.code AS account_code, b.month, ${D('b.amount')} AS amount FROM budgets b JOIN accounts a ON a.id=b.account_id ORDER BY b.month, a.code`],
  ['employees', ['id', 'name', 'email', 'position', 'hire_date', 'tax_id_last4', 'active'], 'SELECT id, name, email, position, hire_date, tax_id, active FROM employees ORDER BY id'],
  ['pay_runs', ['id', 'type', 'period_start', 'period_end', 'pay_date', 'status', 'gross', 'net', 'employee_taxes', 'employer_taxes', 'deductions', 'memo'],
    `SELECT id, type, period_start, period_end, pay_date, status, ${D('gross')} AS gross, ${D('net')} AS net, ${D('employee_taxes')} AS employee_taxes, ${D('employer_taxes')} AS employer_taxes, ${D('deductions')} AS deductions, memo FROM pay_runs ORDER BY pay_date, id`],
  ['fixed_assets', ['id', 'name', 'acquired_date', 'cost', 'salvage', 'life_months', 'status', 'disposed_date', 'notes'],
    `SELECT id, name, acquired_date, ${D('cost')} AS cost, ${D('salvage')} AS salvage, life_months, status, disposed_date, notes FROM fixed_assets ORDER BY id`],
];
const COMPANY_KEYS = ['company_name', 'company_address', 'company_email', 'company_phone', 'currency', 'timezone', 'lang', 'invoice_prefix', 'estimate_prefix', 'bill_prefix', 'default_tax_rate', 'default_terms_days', 'lock_date'];

const README = (counts, date) => `Fluxo — full data export (${date})

This ZIP has your company's data as CSV files. They open in Excel, Google Sheets and any accounting system.
- Money is in dollars (for example 1250.00). Dates are YYYY-MM-DD.
- general_ledger.csv has every journal line (debit and credit): it is the complete bookkeeping record.
- documents.csv and document_lines.csv hold invoices, bills, estimates, credit memos and purchase orders; payments.csv the payments on them.
- Social Security / EIN numbers are NOT exported in full (only the last 4 digits). Passwords, API keys, 2FA codes and integration secrets are never exported.
- Payroll: employees and pay-run totals only. Use the Payroll reports for tax forms.

Rows per file:
${Object.entries(counts).map(([k, n]) => `  ${k}.csv: ${n}`).join('\n')}

---
Fluxo — exportação completa dos dados (${date})
Este ZIP traz os dados da empresa em arquivos CSV (abrem no Excel e em qualquer sistema contábil). Valores em dólares, datas AAAA-MM-DD.
general_ledger.csv é o livro completo (todas as linhas de débito e crédito). SSN/EIN saem só com os 4 últimos dígitos; senhas, chaves e segredos nunca saem.

Fluxo — exportación completa de datos (${date})
Este ZIP contiene los datos de la empresa en archivos CSV. Importes en dólares, fechas AAAA-MM-DD. general_ledger.csv es el libro completo.
El SSN/EIN sale solo con los últimos 4 dígitos; contraseñas, claves y secretos nunca se exportan.
`;

const MONEY = new Set(['price', 'cost', 'subtotal', 'tax', 'total', 'paid', 'unit_price', 'amount', 'tax_amount', 'debit', 'credit', 'hourly_rate', 'budget', 'gross', 'net', 'employee_taxes', 'employer_taxes', 'deductions', 'salvage']);
const fix = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, MONEY.has(k) && typeof v === 'number' ? v.toFixed(2) : v])));

/** Monta o ZIP. Uma tabela que não existir (banco antigo) é só pulada. */
export function buildExport(now = new Date()) {
  const files = [], counts = {};
  for (const [name, cols, sql] of TABLES) {
    let rows;
    try { rows = all(sql); } catch { continue; }
    if (name === 'contacts' || name === 'employees') rows = rows.map((r) => { const p = publicTaxId({ tax_id: r.tax_id }); return { ...r, tax_id_last4: p.tax_id }; }); // só o final do número
    rows = fix(rows);
    counts[name] = rows.length;
    files.push({ name: `${name}.csv`, data: toCsv(cols, rows) });
  }
  files.push({ name: 'company.csv', data: toCsv(['setting', 'value'], COMPANY_KEYS.map((k) => ({ setting: k, value: getSetting(k, '') }))) });
  const date = now.toISOString().slice(0, 10);
  files.unshift({ name: 'README.txt', data: README(counts, date) });
  return { buffer: zip(files, now), counts, filename: `fluxo-export-${date}.zip` };
}
