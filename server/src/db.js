import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const here = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = process.env.FLUXO_DB && process.env.FLUXO_DB !== ':memory:' ? path.dirname(process.env.FLUXO_DB) : path.join(here, '..', 'data');
const dbPath = process.env.FLUXO_DB || path.join(dataDir, 'fluxo.db');

/** Banco da requisição atual. No modo multi-empresa cada empresa tem o seu arquivo; fora de uma empresa vale o banco padrão. */
export const als = new AsyncLocalStorage();
let defaultDb = null;
const current = () => als.getStore()?.db ?? defaultDb;
export const runInDb = (database, fn) => als.run({ db: database, slug: als.getStore()?.slug }, fn);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'viewer', custom_role_id INTEGER, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
  subtype TEXT NOT NULL DEFAULT '', is_system INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','vendor','both')),
  name TEXT NOT NULL, email TEXT DEFAULT '', phone TEXT DEFAULT '', tax_id TEXT DEFAULT '',
  address TEXT DEFAULT '', notes TEXT DEFAULT '', terms_days INTEGER NOT NULL DEFAULT 15, is_1099 INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, sku TEXT DEFAULT '', kind TEXT NOT NULL DEFAULT 'service' CHECK (kind IN ('product','service')),
  price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, track_inventory INTEGER NOT NULL DEFAULT 0,
  qty_on_hand REAL NOT NULL DEFAULT 0, reorder_point REAL NOT NULL DEFAULT 0,
  income_account_id INTEGER REFERENCES accounts(id), tax_rate REAL NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, contact_id INTEGER REFERENCES contacts(id), hourly_rate INTEGER NOT NULL DEFAULT 0,
  budget INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  notes TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('invoice','estimate','bill','credit','po')),
  number TEXT NOT NULL, contact_id INTEGER NOT NULL REFERENCES contacts(id), project_id INTEGER REFERENCES projects(id),
  issue_date TEXT NOT NULL, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft',
  subtotal INTEGER NOT NULL DEFAULT 0, tax INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '', share_token TEXT UNIQUE, converted_to INTEGER, recurring_id INTEGER, accepted_by TEXT, accepted_at TEXT,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (type, number)
);
CREATE TABLE IF NOT EXISTS doc_lines (
  id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE, position INTEGER NOT NULL DEFAULT 0,
  item_id INTEGER REFERENCES items(id), description TEXT NOT NULL DEFAULT '', qty REAL NOT NULL DEFAULT 1,
  unit_price INTEGER NOT NULL DEFAULT 0, tax_rate REAL NOT NULL DEFAULT 0, account_id INTEGER REFERENCES accounts(id),
  amount INTEGER NOT NULL DEFAULT 0, tax_amount INTEGER NOT NULL DEFAULT 0, time_entry_id INTEGER, class_id INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE, date TEXT NOT NULL,
  amount INTEGER NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id), method TEXT DEFAULT '', ref TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, contact_id INTEGER REFERENCES contacts(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
  paid_from_id INTEGER NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL, description TEXT DEFAULT '', ref TEXT DEFAULT '',
  project_id INTEGER REFERENCES projects(id), class_id INTEGER, receipt TEXT, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, memo TEXT DEFAULT '', source_type TEXT NOT NULL DEFAULT 'manual', source_id INTEGER,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_je_source ON journal_entries(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_je_date ON journal_entries(date);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id), debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0,
  contact_id INTEGER REFERENCES contacts(id), reconciliation_id INTEGER, class_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);
CREATE INDEX IF NOT EXISTS idx_jl_entry ON journal_lines(entry_id);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), qty_delta REAL NOT NULL, unit_cost INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL, source_id INTEGER, date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sm_source ON stock_moves(source_type, source_id);
CREATE TABLE IF NOT EXISTS bank_txns (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), date TEXT NOT NULL, description TEXT NOT NULL,
  amount INTEGER NOT NULL, hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','categorized','matched','ignored')),
  suggested_account_id INTEGER REFERENCES accounts(id), suggested_line_id INTEGER, suggestion_source TEXT DEFAULT '',
  entry_id INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bank_rules (
  id INTEGER PRIMARY KEY, pattern TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id), contact_id INTEGER REFERENCES contacts(id),
  direction TEXT NOT NULL DEFAULT 'any' CHECK (direction IN ('any','in','out'))
);
CREATE TABLE IF NOT EXISTS reconciliations (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id), statement_date TEXT NOT NULL,
  statement_balance INTEGER NOT NULL, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), user_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL, hours REAL NOT NULL, description TEXT DEFAULT '', billable INTEGER NOT NULL DEFAULT 1, invoice_id INTEGER
);
CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, template TEXT NOT NULL, frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','quarterly','yearly')),
  next_date TEXT NOT NULL, end_date TEXT, auto_post INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, user_id INTEGER, user_name TEXT,
  action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER, detail TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS classes (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, month TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, UNIQUE (account_id, month)
);
CREATE TABLE IF NOT EXISTS roles (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, read TEXT NOT NULL DEFAULT '[]', write TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS credit_applications (
  id INTEGER PRIMARY KEY, credit_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE, invoice_id INTEGER REFERENCES docs(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL, date TEXT NOT NULL, account_id INTEGER REFERENCES accounts(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plaid_items (
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL UNIQUE, access_token_enc TEXT NOT NULL, institution_name TEXT NOT NULL DEFAULT '', institution_id TEXT DEFAULT '',
  cursor TEXT, status TEXT NOT NULL DEFAULT 'ok', error_code TEXT DEFAULT '', last_sync TEXT, demo INTEGER NOT NULL DEFAULT 0, created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS plaid_accounts (
  id INTEGER PRIMARY KEY, item_id TEXT NOT NULL REFERENCES plaid_items(item_id) ON DELETE CASCADE, account_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, official_name TEXT DEFAULT '',
  mask TEXT DEFAULT '', type TEXT DEFAULT '', subtype TEXT DEFAULT '', balance_current INTEGER, balance_available INTEGER, currency TEXT DEFAULT 'USD',
  linked_account_id INTEGER REFERENCES accounts(id), balance_at TEXT
);
CREATE TABLE IF NOT EXISTS plaid_transactions (
  transaction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, date TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', merchant TEXT DEFAULT '', amount INTEGER NOT NULL,
  category_primary TEXT DEFAULT '', category_detailed TEXT DEFAULT '', pending INTEGER NOT NULL DEFAULT 0, currency TEXT DEFAULT 'USD', imported INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ptx_account ON plaid_transactions(account_id, date);
CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT DEFAULT '', tax_id TEXT DEFAULT '', position TEXT DEFAULT '', hire_date TEXT NOT NULL,
  pay_basis TEXT NOT NULL DEFAULT 'year' CHECK (pay_basis IN ('hour','year')), pay_rate INTEGER NOT NULL DEFAULT 0,
  frequency TEXT NOT NULL DEFAULT 'biweekly' CHECK (frequency IN ('weekly','biweekly','semimonthly','monthly')),
  filing_status TEXT NOT NULL DEFAULT 'single' CHECK (filing_status IN ('single','married')), credits INTEGER NOT NULL DEFAULT 0,
  extra_withholding INTEGER NOT NULL DEFAULT 0, state_pct REAL NOT NULL DEFAULT 0,
  pretax_deduction INTEGER NOT NULL DEFAULT 0, other_deduction INTEGER NOT NULL DEFAULT 0, other_deduction_label TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pay_runs (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'regular' CHECK (type IN ('regular','bonus')),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL, pay_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','void')),
  paid_from_id INTEGER REFERENCES accounts(id), memo TEXT DEFAULT '', gross INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0,
  employee_taxes INTEGER NOT NULL DEFAULT 0, employer_taxes INTEGER NOT NULL DEFAULT 0, deductions INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pay_run_lines (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE, employee_id INTEGER NOT NULL REFERENCES employees(id),
  hours REAL NOT NULL DEFAULT 0, overtime_hours REAL NOT NULL DEFAULT 0, bonus INTEGER NOT NULL DEFAULT 0, other_earnings INTEGER NOT NULL DEFAULT 0,
  pretax_deduction INTEGER NOT NULL DEFAULT 0, other_deduction INTEGER NOT NULL DEFAULT 0,
  gross INTEGER NOT NULL DEFAULT 0, net INTEGER NOT NULL DEFAULT 0, details TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS payroll_remittances (
  id INTEGER PRIMARY KEY, component TEXT NOT NULL, amount INTEGER NOT NULL, date TEXT NOT NULL, account_id INTEGER NOT NULL REFERENCES accounts(id),
  memo TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, scope TEXT NOT NULL DEFAULT 'write',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', active INTEGER NOT NULL DEFAULT 1,
  failures INTEGER NOT NULL DEFAULT 0, last_status INTEGER, last_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE, event TEXT NOT NULL, status INTEGER, ok INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS fixed_assets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, acquired_date TEXT NOT NULL, cost INTEGER NOT NULL, salvage INTEGER NOT NULL DEFAULT 0, life_months INTEGER NOT NULL,
  asset_account_id INTEGER NOT NULL REFERENCES accounts(id), accum_account_id INTEGER NOT NULL REFERENCES accounts(id), expense_account_id INTEGER NOT NULL REFERENCES accounts(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disposed')), disposed_date TEXT, disposal_proceeds INTEGER, notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS asset_depr (
  id INTEGER PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE, period TEXT NOT NULL, amount INTEGER NOT NULL, entry_id INTEGER,
  UNIQUE (asset_id, period)
);
CREATE TABLE IF NOT EXISTS close_tasks (
  period TEXT NOT NULL, key TEXT NOT NULL, done_by TEXT, done_at TEXT, PRIMARY KEY (period, key)
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, ref_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, detail TEXT DEFAULT '', link TEXT DEFAULT '', data TEXT DEFAULT '',
  due_date TEXT, snoozed_until TEXT, done_at TEXT, repeat TEXT NOT NULL DEFAULT '', manual INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

/** Abre (ou cria) um banco de empresa com o esquema completo e as configurações padrão. */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  d.exec(SCHEMA);
  const addColumn = (table, col, ddl) => { if (!d.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };
  addColumn('users', 'totp_secret_enc', 'TEXT');                   // 2FA: segredo do aplicativo autenticador (cifrado)
  addColumn('users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'totp_last_step', 'INTEGER NOT NULL DEFAULT 0'); // evita reaproveitar o mesmo código
  addColumn('users', 'recovery_codes', 'TEXT');                     // resumos (SHA-256) dos códigos de recuperação ainda não usados
  addColumn('sessions', 'verified_at', 'TEXT');                     // última vez que a pessoa confirmou a senha nesta sessão
  d.exec("UPDATE sessions SET verified_at = created_at WHERE verified_at IS NULL");
  addColumn('users', 'custom_perms', 'TEXT');                       // acesso por aba definido por usuário
  addColumn('recurring', 'anchor_day', 'INTEGER');                  // dia do mês original: evita que "dia 31" derive para 28 depois de fevereiro
  addColumn('recurring', 'last_error', "TEXT NOT NULL DEFAULT ''");  // por que a última geração falhou (aparece na tela e vira lembrete)
  addColumn('recurring', 'last_run', 'TEXT');
  addColumn('docs', 'external_id', 'TEXT');                         // id do outro sistema (API): reenviar o mesmo id nunca duplica
  addColumn('contacts', 'external_id', 'TEXT');
  addColumn('docs', 'emailed_at', 'TEXT');                          // quando a fatura foi enviada por e-mail pelo sistema
  addColumn('docs', 'approval_status', "TEXT NOT NULL DEFAULT ''"); // '', approved, rejected (aprovação de contas a pagar)
  addColumn('docs', 'approved_by', 'TEXT');
  addColumn('docs', 'approved_at', 'TEXT');
  addColumn('docs', 'approved_total', 'INTEGER');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_external ON docs(external_id) WHERE external_id IS NOT NULL');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_external ON contacts(external_id) WHERE external_id IS NOT NULL');
  als.run({ db: d }, ensureDefaults);
  return d;
}

/** Run fn inside a transaction; rolls back on throw. Nested calls join the outer transaction. */
const depths = new WeakMap();
export function tx(fn) {
  const d = current();
  if (depths.get(d) > 0) return fn();
  d.exec('BEGIN');
  depths.set(d, 1);
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    depths.set(d, 0);
  }
}

// node:sqlite throws (instead of treating it as NULL) when a bound parameter is undefined, which turned
// missing/invalid ids (a bad account_id, an unset contact_id) into an uncaught 500 instead of the intended
// "not found"/validation error. Normalizing undefined -> null here makes every query site behave as already written.
const nullify = (p) => p.map((v) => (v === undefined ? null : v));
export const all = (sql, ...p) => current().prepare(sql).all(...nullify(p)).map((r) => ({ ...r }));
export const get = (sql, ...p) => {
  const r = current().prepare(sql).get(...nullify(p));
  return r ? { ...r } : undefined;
};
export const run = (sql, ...p) => current().prepare(sql).run(...nullify(p));
export const insert = (sql, ...p) => Number(current().prepare(sql).run(...nullify(p)).lastInsertRowid);

export const getSetting = (k, d = '') => get('SELECT value FROM settings WHERE key=?', k)?.value ?? d;
export const setSetting = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));

// [code, {en, pt, es}, type, subtype]
export const DEFAULT_ACCOUNTS = [
  ['1010', { en: 'Checking Account', pt: 'Conta Corrente', es: 'Cuenta corriente' }, 'asset', 'bank'],
  ['1020', { en: 'Cash', pt: 'Caixa', es: 'Caja' }, 'asset', 'bank'],
  ['1030', { en: 'Savings', pt: 'Poupança', es: 'Ahorros' }, 'asset', 'bank'],
  ['1200', { en: 'Accounts Receivable', pt: 'Contas a Receber', es: 'Cuentas por cobrar' }, 'asset', 'ar'],
  ['1300', { en: 'Inventory', pt: 'Estoque', es: 'Inventario' }, 'asset', 'inventory'],
  ['1500', { en: 'Equipment', pt: 'Equipamentos', es: 'Equipos' }, 'asset', 'fixed_asset'],
  ['2000', { en: 'Accounts Payable', pt: 'Contas a Pagar', es: 'Cuentas por pagar' }, 'liability', 'ap'],
  ['2100', { en: 'Credit Card', pt: 'Cartão de Crédito', es: 'Tarjeta de crédito' }, 'liability', 'credit_card'],
  ['2200', { en: 'Sales Tax Payable', pt: 'Impostos a Recolher', es: 'Impuestos por pagar' }, 'liability', 'tax'],
  ['2300', { en: 'Payroll Liabilities', pt: 'Obrigações da Folha', es: 'Pasivos de nómina' }, 'liability', 'payroll_liab'],
  ['2500', { en: 'Loans', pt: 'Empréstimos', es: 'Préstamos' }, 'liability', 'loan'],
  ['3000', { en: 'Owner Capital', pt: 'Capital Social', es: 'Capital social' }, 'equity', 'capital'],
  ['3100', { en: 'Retained Earnings', pt: 'Lucros Acumulados', es: 'Utilidades retenidas' }, 'equity', 'retained'],
  ['3200', { en: 'Owner Draws', pt: 'Retiradas dos Sócios', es: 'Retiros de socios' }, 'equity', 'draw'],
  ['4000', { en: 'Sales Revenue', pt: 'Receita de Vendas', es: 'Ingresos por ventas' }, 'income', 'sales'],
  ['4100', { en: 'Service Revenue', pt: 'Receita de Serviços', es: 'Ingresos por servicios' }, 'income', 'services'],
  ['4900', { en: 'Other Income', pt: 'Outras Receitas', es: 'Otros ingresos' }, 'income', 'other_income'],
  ['5000', { en: 'Cost of Goods Sold', pt: 'Custo das Mercadorias Vendidas', es: 'Costo de ventas' }, 'expense', 'cogs'],
  ['6000', { en: 'Rent', pt: 'Aluguel', es: 'Alquiler' }, 'expense', ''],
  ['6100', { en: 'Salaries & Wages', pt: 'Salários e Encargos', es: 'Sueldos y salarios' }, 'expense', 'payroll_wages'],
  ['6110', { en: 'Payroll Taxes & Contributions', pt: 'Encargos Patronais', es: 'Cargas sociales' }, 'expense', 'payroll_exp'],
  ['6200', { en: 'Marketing & Advertising', pt: 'Marketing e Publicidade', es: 'Marketing y publicidad' }, 'expense', ''],
  ['6300', { en: 'Software & Subscriptions', pt: 'Software e Assinaturas', es: 'Software y suscripciones' }, 'expense', ''],
  ['6400', { en: 'Professional Services', pt: 'Serviços Profissionais', es: 'Servicios profesionales' }, 'expense', ''],
  ['6500', { en: 'Utilities & Internet', pt: 'Água, Luz e Internet', es: 'Agua, luz e internet' }, 'expense', ''],
  ['6600', { en: 'Travel & Transportation', pt: 'Transporte e Viagens', es: 'Transporte y viajes' }, 'expense', ''],
  ['6700', { en: 'Office Supplies', pt: 'Material de Escritório', es: 'Material de oficina' }, 'expense', ''],
  ['6800', { en: 'Bank Fees', pt: 'Taxas Bancárias', es: 'Comisiones bancarias' }, 'expense', ''],
  ['6900', { en: 'Taxes & Licenses', pt: 'Impostos e Taxas', es: 'Impuestos y tasas' }, 'expense', ''],
  ['6990', { en: 'Miscellaneous Expenses', pt: 'Despesas Diversas', es: 'Gastos varios' }, 'expense', ''],
];
export const LANGS = ['en', 'pt', 'es'];

export const LANG_DEFAULTS = {
  en: { locale: 'en-US', currency: 'USD', invoice_prefix: 'INV-', estimate_prefix: 'EST-', bill_prefix: 'BILL-', invoice_footer: 'Thank you for your business!', company_name: 'My Company' },
  pt: { locale: 'pt-BR', currency: 'USD', invoice_prefix: 'FAT-', estimate_prefix: 'ORC-', bill_prefix: 'CP-', invoice_footer: 'Obrigado pela preferência!', company_name: 'Minha Empresa' },
  es: { locale: 'es-US', currency: 'USD', invoice_prefix: 'FAC-', estimate_prefix: 'PRE-', bill_prefix: 'CP-', invoice_footer: '¡Gracias por su preferencia!', company_name: 'Mi Empresa' },
};

/** Renomeia contas padrão e ajusta defaults de numeração/moeda para o idioma escolhido (só antes de haver movimento). */
export function applyLanguage(lang, { currency } = {}) {
  if (!LANGS.includes(lang)) lang = 'en';
  tx(() => {
    for (const [code, names] of DEFAULT_ACCOUNTS) run('UPDATE accounts SET name=? WHERE code=?', names[lang], code);
    const d = LANG_DEFAULTS[lang];
    for (const k of ['locale', 'currency', 'invoice_prefix', 'estimate_prefix', 'bill_prefix', 'invoice_footer', 'company_name']) setSetting(k, d[k]);
    if (currency) setSetting('currency', currency);
    setSetting('lang', lang);
  });
}

const SYSTEM_SUBTYPES = ['ar', 'ap', 'inventory', 'tax', 'cogs', 'retained', 'payroll_liab', 'payroll_exp', 'payroll_wages'];
export function ensureDefaults() {
  tx(() => {
    const fresh = !get('SELECT 1 FROM accounts LIMIT 1');
    for (const [code, names, type, subtype] of DEFAULT_ACCOUNTS) {
      if (!get('SELECT 1 FROM accounts WHERE code=?', code)) {
        // bancos existentes ganham apenas as contas novas de folha; banco vazio recebe o plano completo
        if (!fresh && !['payroll_liab', 'payroll_exp', 'payroll_wages'].includes(subtype)) continue;
        run('INSERT INTO accounts(code,name,type,subtype,is_system) VALUES(?,?,?,?,?)', code, names.en, type, subtype, SYSTEM_SUBTYPES.includes(subtype) ? 1 : 0);
      }
    }
    // contas antigas (sem subtipo de folha) passam a servir de salário
    run("UPDATE accounts SET subtype='payroll_wages', is_system=1 WHERE code='6100' AND subtype=''");
  });
  const defaults = { ...LANG_DEFAULTS.en, lang: 'en', next_invoice: '1001', next_estimate: '1001', next_bill: '1001', default_tax_rate: '0', default_terms_days: '15',
    payroll_suta_rate: '0', payroll_suta_base: '0', default_tax_rate: '0', credit_prefix: 'CM-', po_prefix: 'PO-', next_credit: '1001', next_po: '1001',
    plan: 'advanced', addon_payroll: '1', lock_date: '', company_logo: '', brand_color: '#4338CA',
    timezone: 'America/New_York', auto_overdue: '1', overdue_days: '1', auto_bills: '1', bills_days: '3', auto_estimates: '1', estimate_days: '3', auto_lowstock: '1', auto_bank: '1', auto_tax_calendar: '1', auto_backup: '0', last_backup: '',
    stripe_customer_id: '', stripe_subscription_id: '', subscription_status: '', subscription_period_end: '', subscription_cancel_at_end: '0', billing_managed: '0' };
  for (const [k, v] of Object.entries(defaults)) if (get('SELECT 1 FROM settings WHERE key=?', k) === undefined) setSetting(k, v);
}

/** Banco padrão (modo uma empresa por instalação; no modo multi-empresa guarda só o que for global). */
export const db = defaultDb = openDb(dbPath);
