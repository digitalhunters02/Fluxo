// Folha "Plano B" — depósito direto SEM mexer em dinheiro: o Fluxo guarda a conta do funcionário (cifrada) e GERA o arquivo
// NACHA (ACH, PPD) de uma folha finalizada. Quem envia o arquivo ao banco é a própria empresa, no portal de ACH do banco dela.
//  - número da conta: AES-256-GCM (secure.js, chave FLUXO_ENCRYPTION_KEY) com o prefixo "enc1:"; a API devolve só "****1234";
//  - roteamento (ABA): 9 dígitos com dígito verificador (3,7,1);
//  - arquivo: registros de 94 caracteres, blocagem 10 (preenche com linhas de "9"), totais e "entry hash" nos controles;
//    desbalanceado (só créditos, classe 220) por padrão; balanceado (classe 200) acrescenta o débito na conta da própria empresa.
import { get, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './secure.js';
import { HttpError } from './accounting.js';
import { loadRun } from './payroll.js';

const bad = (m) => new HttpError(400, m);
const ENC = 'enc1:';

/* ------------------------------------------ ABA / conta ------------------------------------------ */
/** Dígito verificador do roteamento ABA: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function abaValid(routing) {
  const s = String(routing ?? '');
  if (!/^\d{9}$/.test(s) || /^0{9}$/.test(s)) return false;
  const d = [...s].map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
/** O 9º dígito que completa os 8 primeiros (para gerar exemplos/testes). */
export function abaCheckDigit(first8) {
  const d = [...String(first8)].map(Number);
  const sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5]);
  return (10 - (sum % 10)) % 10;
}
export const cleanAccount = (v) => String(v ?? '').replace(/[\s-]/g, '');
export const accountValid = (v) => /^\d{4,17}$/.test(cleanAccount(v));
export const sealAccount = (plain) => ENC + encrypt(cleanAccount(plain));
export function openAccount(v) {
  if (!v) return '';
  if (!String(v).startsWith(ENC)) return String(v);
  try { return decrypt(String(v).slice(ENC.length)); } catch { return ''; }
}
export const maskAccount = (last4) => (last4 ? `****${last4}` : '');
export const ACCOUNT_TYPES = ['checking', 'savings'];

/** Campos de banco a gravar a partir do formulário (conta mascarada ou vazia = mantém a atual). */
export function prepareBank(body, cur = {}) {
  const routing = String(body.routing ?? '').trim();
  const type = body.type || cur.bank_account_type || 'checking';
  if (!ACCOUNT_TYPES.includes(type)) throw bad('Account type must be checking or savings');
  if (!abaValid(routing)) throw bad('Invalid routing number (it must have 9 digits and a valid check digit)');
  const raw = String(body.account ?? '').trim();
  let enc = cur.bank_account_enc || '', last4 = cur.bank_account_last4 || '';
  if (raw && !raw.includes('*')) {
    if (!accountValid(raw)) throw bad('Invalid account number (4 to 17 digits)');
    enc = sealAccount(raw); last4 = cleanAccount(raw).slice(-4);
  }
  if (!enc) throw bad('Enter the account number');
  return { bank_routing: routing, bank_account_enc: enc, bank_account_last4: last4, bank_account_type: type };
}
/** O que a API mostra de um funcionário: nunca o número cifrado; dados do banco (roteamento, tipo, final) só para administrador. */
export function publicBank(e, isAdmin) {
  const { bank_account_enc, ...rest } = e;
  const has = !!(bank_account_enc && e.bank_routing);
  const out = { ...rest, has_bank: has };
  if (!isAdmin) { delete out.bank_routing; delete out.bank_account_last4; delete out.bank_account_type; return out; }
  return { ...out, bank_account_mask: has ? maskAccount(e.bank_account_last4) : '' };
}

/* -------------------------------------------- configurações ------------------------------------------- */
export const NACHA_KEYS = ['nacha_company_name', 'nacha_company_id_prefix', 'nacha_ein', 'nacha_odfi_routing', 'nacha_bank_name', 'nacha_origin', 'nacha_origin_name', 'nacha_balanced', 'nacha_offset_account_type', 'nacha_entry_description'];
export function nachaSettings({ withSecret = false } = {}) {
  const s = Object.fromEntries(NACHA_KEYS.map((k) => [k, getSetting(k, '')]));
  s.nacha_company_id_prefix = s.nacha_company_id_prefix === '' ? '1' : s.nacha_company_id_prefix;
  s.nacha_balanced = s.nacha_balanced === '1';
  s.nacha_offset_account_type = s.nacha_offset_account_type || 'checking';
  s.nacha_entry_description = s.nacha_entry_description || 'PAYROLL';
  const offEnc = getSetting('nacha_offset_account_enc', '');
  s.nacha_offset_account_mask = offEnc ? maskAccount(openAccount(offEnc).slice(-4)) : '';
  if (withSecret) s.nacha_offset_account = openAccount(offEnc);
  return s;
}
export function saveNachaSettings(b) {
  const prefix = b.nacha_company_id_prefix ?? '1';
  if (!['1', '9', ' ', ''].includes(prefix)) throw bad('Company ID prefix must be 1, 9, a space or nothing');
  const ein = String(b.nacha_ein ?? '').replace(/\D/g, '');
  if (ein && ein.length !== 9) throw bad('EIN must have 9 digits');
  const odfi = String(b.nacha_odfi_routing ?? '').trim();
  if (odfi && !abaValid(odfi)) throw bad('Invalid routing number (it must have 9 digits and a valid check digit)');
  const origin = String(b.nacha_origin ?? '').trim();
  if (origin.length > 10) throw bad('Immediate origin has at most 10 characters');
  if (b.nacha_offset_account_type && !ACCOUNT_TYPES.includes(b.nacha_offset_account_type)) throw bad('Account type must be checking or savings');
  setSetting('nacha_company_name', String(b.nacha_company_name ?? '').slice(0, 16));
  setSetting('nacha_company_id_prefix', prefix);
  setSetting('nacha_ein', ein);
  setSetting('nacha_odfi_routing', odfi);
  setSetting('nacha_bank_name', String(b.nacha_bank_name ?? '').slice(0, 23));
  setSetting('nacha_origin', origin);
  setSetting('nacha_origin_name', String(b.nacha_origin_name ?? '').slice(0, 23));
  setSetting('nacha_balanced', b.nacha_balanced ? '1' : '0');
  setSetting('nacha_offset_account_type', b.nacha_offset_account_type || 'checking');
  setSetting('nacha_entry_description', String(b.nacha_entry_description || 'PAYROLL').slice(0, 10));
  const off = String(b.nacha_offset_account ?? '').trim();
  if (off && !off.includes('*')) { if (!accountValid(off)) throw bad('Invalid account number (4 to 17 digits)'); setSetting('nacha_offset_account_enc', sealAccount(off)); }
  if (b.nacha_offset_account === '') setSetting('nacha_offset_account_enc', '');
  return nachaSettings();
}

/* --------------------------------------------- arquivo ------------------------------------------------ */
const ascii = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 .,&'\-/]/g, ' ').replace(/\s+/g, ' ').trim();
/** Texto alinhado à esquerda, preenchido com espaços, cortado no tamanho. */
export const alpha = (s, n) => ascii(s).slice(0, n).padEnd(n, ' ');
/** Número alinhado à direita com zeros. */
export const num = (v, n) => { const s = String(Math.round(Number(v) || 0)); if (s.length > n || s.startsWith('-')) throw bad('Amount too large for the bank file'); return s.padStart(n, '0'); };
const yymmdd = (iso) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

export const TX = { checking: { credit: '22', debit: '27' }, savings: { credit: '32', debit: '37' } };

/**
 * Monta o arquivo NACHA a partir de dados já prontos (função pura, testável).
 * cfg: { companyName, companyId (10), odfiRouting (9), bankName, origin (10), originName, effectiveDate (YYYY-MM-DD), now (Date), balanced, offset: {account, type}, description, fileIdModifier }
 * entries: [{ routing, account, type, amount (centavos), id, name }]
 */
export function buildNacha(cfg, entries) {
  if (!abaValid(cfg.odfiRouting)) throw bad('Set your bank\'s routing number in Settings > Payroll > Bank file');
  if (!entries.length) throw bad('No employee in this pay run has direct deposit information');
  const now = cfg.now || new Date();
  const odfi8 = cfg.odfiRouting.slice(0, 8);
  const lines = [];
  const companyId = String(cfg.companyId).slice(0, 10).padEnd(10, ' ');
  const origin = String(cfg.origin || companyId).slice(0, 10).padStart(10, ' ');
  const hhmm = String(now.getUTCHours()).padStart(2, '0') + String(now.getUTCMinutes()).padStart(2, '0');
  const created = now.toISOString().slice(0, 10);
  // 1 — cabeçalho do arquivo
  lines.push('1' + '01' + (' ' + cfg.odfiRouting) + origin + yymmdd(created) + hhmm + (cfg.fileIdModifier || 'A') + '094' + '10' + '1'
    + alpha(cfg.bankName, 23) + alpha(cfg.originName || cfg.companyName, 23) + alpha('', 8));
  const serviceClass = cfg.balanced ? '200' : '220';
  // 5 — cabeçalho do lote
  lines.push('5' + serviceClass + alpha(cfg.companyName, 16) + alpha('', 20) + companyId + 'PPD' + alpha(cfg.description || 'PAYROLL', 10)
    + yymmdd(cfg.effectiveDate) + yymmdd(cfg.effectiveDate) + '   ' + '1' + odfi8 + '0000001');
  let seq = 0, hash = 0, credit = 0, debit = 0;
  const entry = (code, routing, account, amount, id, name) => {
    seq += 1; hash += Number(routing.slice(0, 8));
    lines.push('6' + code + routing.slice(0, 8) + routing[8] + alpha(account, 17) + num(amount, 10) + alpha(id, 15) + alpha(name, 22) + '  ' + '0' + odfi8 + String(seq).padStart(7, '0'));
  };
  for (const e of entries) {
    if (!abaValid(e.routing)) throw bad(`Invalid routing number for ${e.name}`);
    if (!accountValid(e.account)) throw bad(`Invalid account number for ${e.name}`);
    if (!(e.amount > 0)) continue;
    entry(TX[e.type || 'checking'].credit, e.routing, cleanAccount(e.account), e.amount, e.id, e.name);
    credit += e.amount;
  }
  if (!seq) throw bad('No employee in this pay run has direct deposit information');
  if (cfg.balanced) {
    if (!cfg.offset?.account || !accountValid(cfg.offset.account)) throw bad('A balanced file needs your company account number in Settings > Payroll > Bank file');
    entry(TX[cfg.offset.type || 'checking'].debit, cfg.odfiRouting, cleanAccount(cfg.offset.account), credit, 'OFFSET', cfg.companyName);
    debit = credit;
  }
  const hash10 = String(hash).slice(-10).padStart(10, '0');
  // 8 — controle do lote
  lines.push('8' + serviceClass + num(seq, 6) + hash10 + num(debit, 12) + num(credit, 12) + companyId + ' '.repeat(19) + ' '.repeat(6) + odfi8 + '0000001');
  const blocks = Math.ceil((lines.length + 1) / 10);
  // 9 — controle do arquivo
  lines.push('9' + num(1, 6) + num(blocks, 6) + num(seq, 8) + hash10 + num(debit, 12) + num(credit, 12) + ' '.repeat(39));
  while (lines.length % 10) lines.push('9'.repeat(94)); // blocagem 10
  for (const l of lines) if (l.length !== 94) throw new Error(`NACHA record with ${l.length} characters`);
  return { text: lines.join('\r\n') + '\r\n', totals: { entries: seq, credit, debit, hash: hash10, blocks, records: lines.length } };
}

/** Arquivo de depósito direto de uma folha FINALIZADA. Funcionário sem conta → "pagar com cheque" (fica fora do arquivo). */
export function nachaForRun(runId, { effectiveDate, now } = {}) {
  const r = loadRun(runId);
  if (!r) throw new HttpError(404, 'Pay run not found');
  if (r.status !== 'final') throw bad('Only finalized pay runs can generate a bank file');
  const s = nachaSettings({ withSecret: true });
  const ein = s.nacha_ein || String(getSetting('company_tax_id', '')).replace(/\D/g, '');
  if (!/^\d{9}$/.test(ein)) throw bad('Set the company EIN in Settings > Payroll > Bank file');
  const companyName = s.nacha_company_name || getSetting('company_name', '');
  if (!companyName.trim()) throw bad('Set the company name in Settings > Payroll > Bank file');
  const date = effectiveDate || r.pay_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw bad('Invalid date');
  const companyId = (s.nacha_company_id_prefix.trim() + ein).slice(0, 10);
  const deposit = [], checks = [];
  for (const l of r.lines) {
    const e = get('SELECT id, name, bank_routing, bank_account_enc, bank_account_type FROM employees WHERE id=?', l.employee_id);
    const account = openAccount(e?.bank_account_enc);
    if (e && e.bank_routing && account && l.net > 0) deposit.push({ routing: e.bank_routing, account, type: e.bank_account_type, amount: l.net, id: `EMP${e.id}`, name: e.name, employee_id: e.id });
    else checks.push({ employee_id: l.employee_id, name: l.employee_name, net: l.net });
  }
  const built = buildNacha({ companyName, companyId, odfiRouting: s.nacha_odfi_routing, bankName: s.nacha_bank_name, origin: s.nacha_origin || companyId, originName: s.nacha_origin_name || companyName,
    effectiveDate: date, now, balanced: s.nacha_balanced, offset: { account: s.nacha_offset_account, type: s.nacha_offset_account_type }, description: s.nacha_entry_description }, deposit);
  return { ...built, run: { id: r.id, pay_date: r.pay_date, net: r.net }, effectiveDate: date, deposits: deposit.map(({ account, routing, ...x }) => x), checks };
}

/** Prévia sem gerar o arquivo: quem recebe por depósito e quem fica para cheque. */
export function nachaPreview(runId) {
  const r = loadRun(runId);
  if (!r) throw new HttpError(404, 'Pay run not found');
  const rows = r.lines.map((l) => {
    const e = get('SELECT bank_routing, bank_account_enc, bank_account_last4, bank_account_type FROM employees WHERE id=?', l.employee_id) || {};
    const has = !!(e.bank_routing && e.bank_account_enc);
    return { employee_id: l.employee_id, name: l.employee_name, net: l.net, method: has && l.net > 0 ? 'deposit' : 'check', account_mask: has ? maskAccount(e.bank_account_last4) : '', type: has ? e.bank_account_type : '' };
  });
  const s = nachaSettings();
  return { run: { id: r.id, status: r.status, pay_date: r.pay_date, net: r.net }, rows, deposit_total: rows.filter((x) => x.method === 'deposit').reduce((a, x) => a + x.net, 0),
    check_total: rows.filter((x) => x.method === 'check').reduce((a, x) => a + x.net, 0), configured: abaValid(s.nacha_odfi_routing) && !!(s.nacha_ein || getSetting('company_tax_id', '')), balanced: s.nacha_balanced };
}
