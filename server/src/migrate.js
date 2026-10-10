// Migração a partir do QuickBooks Online e do Xero (arquivos CSV exportados): plano de contas, clientes/fornecedores e saldos iniciais.
// Nada é gravado em "preview"; "apply" grava. Reaplicar o mesmo arquivo não duplica (contas e contatos são reconhecidos pelo nome).
// Faturas e contas em aberto ainda não são importadas: os saldos de contas a receber/pagar entram pelo balancete de abertura.
import { all, get, run, insert, tx } from './db.js';
import { HttpError, isDate, postEntry, sysAccount } from './accounting.js';

const bad = (m) => new HttpError(400, m);
const norm = (h) => String(h || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^\*/, '').replace(/[^a-z0-9#]+/g, ' ').trim();

/** CSV (RFC 4180) simples: aspas, vírgulas e quebras de linha dentro de aspas, BOM e CRLF. */
export function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

/** Acha a linha de cabeçalho (os exports do QuickBooks têm títulos antes) e devolve registros por nome de coluna normalizado. */
function table(csv, mustHave) {
  const rows = parseCsv(csv);
  if (!rows.length) throw bad('The file is empty');
  // no balancete do QuickBooks a primeira coluna (nome da conta) vem sem título
  const heads = (r) => { const hs = r.map(norm); if (hs[0] === '' && hs.includes('debit')) hs[0] = 'account'; return hs; };
  const at = rows.findIndex((r) => { const hs = heads(r); return mustHave.every((alts) => alts.some((a) => hs.includes(a))); });
  if (at < 0) throw bad(`Could not find the columns this import needs (${mustHave.map((a) => a[0]).join(', ')}). Check that you exported the right report as CSV`);
  const head = heads(rows[at]);
  const records = rows.slice(at + 1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
  return { head, records };
}
const pick = (rec, alts) => { for (const a of alts) if (rec[a]) return rec[a]; return ''; };

export function toCents(v) {
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-') || /-$/.test(s);
  const n = Number(s.replace(/[$,()\s-]/g, ''));
  if (!Number.isFinite(n)) throw bad(`Not a number: "${s}"`);
  return Math.round((neg ? -n : n) * 100);
}

/* ------------------------------------- plano de contas ------------------------------------- */
const TYPE_MAP = [
  [/^bank$/, 'asset', 'bank'], [/^credit card$/, 'liability', 'credit_card'], [/accounts? receivable|^a r$/, 'asset', 'ar'], [/accounts? payable|^a p$/, 'liability', 'ap'],
  [/^inventory/, 'asset', 'inventory'], [/fixed asset|non current asset|noncurrent asset|property|equipment/, 'asset', 'fixed_asset'], [/asset|prepayment/, 'asset', ''],
  [/retained earnings/, 'equity', 'retained'], [/equity/, 'equity', ''], [/liabilit/, 'liability', ''],
  [/cost of goods|direct cost/, 'expense', 'cogs'], [/expense|overhead|depreciation/, 'expense', ''], [/income|revenue|sales/, 'income', ''],
];
const RANGE = { asset: 1100, liability: 2600, equity: 3300, income: 4200, expense: 6000 };
const mapType = (raw) => { const t = norm(raw); for (const [re, type, sub] of TYPE_MAP) if (re.test(t)) return { type, subtype: sub }; return null; };

function freeCode(type, used) {
  const hi = Math.floor(RANGE[type] / 1000) * 1000 + 999;
  for (let c = RANGE[type]; c <= hi; c += 10) { const s = String(c); if (!used.has(s)) { used.add(s); return s; } }
  for (let c = hi + 1; ; c++) { const s = String(c); if (!used.has(s)) { used.add(s); return s; } }
}

function importAccounts(csv, apply) {
  const { records } = table(csv, [['account', 'name', 'account name', 'full name'], ['type', 'account type']]);
  const used = new Set(all('SELECT code FROM accounts').map((r) => r.code));
  const byName = new Map(all('SELECT id,code,name FROM accounts').map((a) => [a.name.toLowerCase(), a]));
  const out = { created: 0, exists: 0, mapped: 0, invalid: 0, rows: [] };
  tx(() => {
    for (const rec of records) {
      const name = pick(rec, ['account name', 'name', 'account', 'full name']);
      const tRaw = pick(rec, ['account type', 'type']);
      if (!name) continue;
      const m = mapType(tRaw);
      if (!m) { out.invalid++; out.rows.push({ name, status: 'invalid', reason: `Unknown type "${tRaw}"` }); continue; }
      if (byName.has(name.toLowerCase())) { out.exists++; out.rows.push({ name, status: 'exists' }); continue; }
      // contas de controle já existem no Fluxo (uma só de cada): a conta do arquivo aponta para elas
      if (['ar', 'ap', 'retained'].includes(m.subtype)) { const sys = get('SELECT code FROM accounts WHERE subtype=? AND active=1', m.subtype); if (sys) { out.mapped++; out.rows.push({ name, status: 'mapped', to: sys.code }); continue; } }
      // Xero manda o código ("*Code"); o QuickBooks muitas vezes não: nesse caso o Fluxo escolhe um livre na faixa do tipo
      const given = pick(rec, ['code', 'account #', 'account number', 'number']);
      let code = /^\d{3,8}$/.test(given) && !used.has(given) ? given : freeCode(m.type, used);
      used.add(code);
      if (apply) insert('INSERT INTO accounts(code,name,type,subtype,is_system) VALUES(?,?,?,?,0)', code, name.slice(0, 120), m.type, ['ar', 'ap', 'retained'].includes(m.subtype) ? '' : m.subtype);
      byName.set(name.toLowerCase(), { code, name }); // o mesmo nome repetido no arquivo não conta duas vezes
      out.created++; out.rows.push({ name, status: 'create', code, type: m.type });
    }
  });
  return out;
}

/* ------------------------------------- clientes e fornecedores ------------------------------------- */
function importContacts(csv, apply, kindHint) {
  const { head, records } = table(csv, [['customer', 'vendor', 'contactname', 'contact name', 'display name', 'name', 'full name', 'company']]);
  const out = { created: 0, exists: 0, updated: 0, invalid: 0, rows: [] };
  const byName = new Map(all('SELECT id,name,kind FROM contacts').map((c) => [c.name.toLowerCase(), c]));
  tx(() => {
    for (const rec of records) {
      const name = pick(rec, ['display name', 'contactname', 'contact name', 'customer', 'vendor', 'company', 'name', 'full name']);
      if (!name || /^total/i.test(name)) continue;
      let kind = kindHint === 'vendor' ? 'vendor' : 'customer';
      if (kindHint === 'auto') {
        const isSup = /^(true|yes|1|y)$/i.test(rec.issupplier || ''), isCus = /^(true|yes|1|y)$/i.test(rec.iscustomer || '');
        kind = isSup && isCus ? 'both' : isSup ? 'vendor' : head.includes('vendor') && !head.includes('customer') ? 'vendor' : 'customer';
      }
      const email = pick(rec, ['email', 'emailaddress', 'email address', 'e mail']).slice(0, 200);
      const phone = pick(rec, ['phone', 'phonenumber', 'phone number', 'mobile', 'main phone']).slice(0, 60);
      const address = [pick(rec, ['billing address', 'street', 'poaddressline1', 'address']), pick(rec, ['city', 'pocity']), pick(rec, ['state', 'poregion']), pick(rec, ['zip', 'zip code', 'popostalcode'])].filter(Boolean).join(', ').slice(0, 300);
      const taxId = pick(rec, ['taxnumber', 'tax id', 'ein', 'tax number']).slice(0, 40);
      const ex = byName.get(name.toLowerCase());
      if (ex) {
        if (ex.kind !== kind && ex.kind !== 'both' && kind !== 'both') { if (apply) run("UPDATE contacts SET kind='both' WHERE id=?", ex.id); out.updated++; out.rows.push({ name, status: 'updated', note: 'now customer and vendor' }); }
        else { out.exists++; out.rows.push({ name, status: 'exists' }); }
        continue;
      }
      if (apply) { const cid = insert('INSERT INTO contacts(kind,name,email,phone,address,tax_id) VALUES(?,?,?,?,?,?)', kind, name.slice(0, 160), email, phone, address, taxId); byName.set(name.toLowerCase(), { id: cid, name, kind }); }
      out.created++; out.rows.push({ name, status: 'create', kind });
    }
  });
  return out;
}

/* ------------------------------------- saldos iniciais ------------------------------------- */
function importOpening(csv, apply, asof, user) {
  if (!isDate(asof)) throw bad('Choose the opening balance date');
  if (get("SELECT 1 FROM journal_entries WHERE source_type='opening' LIMIT 1")) throw new HttpError(409, 'Opening balances were already imported');
  const { records } = table(csv, [['account', 'account name', 'name'], ['debit', 'debit year to date', 'debit ytd']]);
  const out = { lines: [], unknown: [], totalDebit: 0, totalCredit: 0, applied: false };
  const accounts = all('SELECT id,code,name,type,subtype FROM accounts WHERE active=1');
  const byName = new Map(accounts.map((a) => [a.name.toLowerCase(), a])), byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const rec of records) {
    const label = pick(rec, ['account name', 'account', 'name']);
    if (!label || /^total/i.test(label)) continue;
    const debit = toCents(pick(rec, ['debit', 'debit year to date', 'debit ytd'])), credit = toCents(pick(rec, ['credit', 'credit year to date', 'credit ytd']));
    if (!debit && !credit) continue;
    let a = byCode.get(pick(rec, ['account code', 'code'])) || byName.get(label.toLowerCase());
    if (!a) { // contas de controle: nome do QuickBooks/Xero → conta de sistema
      if (/accounts? receivable|^a\/r/i.test(label)) a = sysAccount('ar'); else if (/accounts? payable|^a\/p/i.test(label)) a = sysAccount('ap'); else if (/retained earnings/i.test(label)) a = sysAccount('retained');
    }
    if (!a) { out.unknown.push({ account: label }); continue; }
    const net = debit - credit;
    out.lines.push({ account_id: a.id, account: a.name, code: a.code, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  // agrupa a mesma conta que aparece mais de uma vez
  const merged = new Map();
  for (const l of out.lines) { const m = merged.get(l.account_id) || { ...l, debit: 0, credit: 0 }; m.debit += l.debit; m.credit += l.credit; merged.set(l.account_id, m); }
  out.lines = [...merged.values()].map((l) => { const n = l.debit - l.credit; return { ...l, debit: n > 0 ? n : 0, credit: n < 0 ? -n : 0 }; }).filter((l) => l.debit || l.credit);
  out.totalDebit = out.lines.reduce((s, l) => s + l.debit, 0); out.totalCredit = out.lines.reduce((s, l) => s + l.credit, 0);
  out.difference = out.totalDebit - out.totalCredit;
  out.balanced = out.difference === 0 && out.lines.length > 1;
  if (apply) {
    if (out.unknown.length) throw new HttpError(409, `Import the chart of accounts first: ${out.unknown.length} account(s) were not found`, { unknown: out.unknown });
    if (!out.balanced) throw new HttpError(409, 'The opening balances do not balance (debits and credits differ). Nothing was saved', { difference: out.difference });
    postEntry({ date: asof, memo: 'Opening balances', source_type: 'opening', lines: out.lines.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit })), user_id: user?.id });
    out.applied = true;
  }
  return out;
}

export function runMigration({ kind, csv, apply = false, asof, contactKind = 'auto' }, user) {
  if (typeof csv !== 'string' || !csv.trim()) throw bad('Choose a CSV file first');
  if (csv.length > 5_000_000) throw bad('The file is too large (5 MB maximum)');
  if (kind === 'accounts') return importAccounts(csv, apply);
  if (kind === 'contacts') return importContacts(csv, apply, ['customer', 'vendor', 'auto'].includes(contactKind) ? contactKind : 'auto');
  if (kind === 'opening') return importOpening(csv, apply, asof, user);
  throw bad('Unknown import');
}
