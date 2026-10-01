// Automações e lembretes: tarefas repetitivas que o Fluxo faz sozinho ou lembra de fazer.
// Tudo é local (sem custo): gera avisos dentro do app e, se ligado, um backup diário em arquivo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, insert, tx, getSetting, setSetting, dataDir } from './db.js';
import { currentSlug } from './tenants.js';
import { HttpError, today, addDays } from './accounting.js';
import { hasFeature } from './plans.js';

export const AUTOMATION_KEYS = {
  auto_overdue: 'bool', overdue_days: 'days', auto_bills: 'bool', bills_days: 'days', auto_estimates: 'bool', estimate_days: 'days',
  auto_lowstock: 'bool', auto_bank: 'bool', auto_tax_calendar: 'bool', auto_backup: 'bool',
};
export function getAutomations() {
  return Object.fromEntries(Object.entries(AUTOMATION_KEYS).map(([k, type]) => [k, type === 'bool' ? getSetting(k, '0') === '1' : Number(getSetting(k, '1'))]));
}
export function setAutomations(body) {
  for (const [k, type] of Object.entries(AUTOMATION_KEYS)) {
    if (!(k in body)) continue;
    if (type === 'bool') setSetting(k, body[k] ? '1' : '0');
    else { const n = Number(body[k]); if (!Number.isInteger(n) || n < 0 || n > 90) throw new HttpError(400, 'Days must be between 0 and 90'); setSetting(k, n); }
  }
  return getAutomations();
}

/** Prazos federais recorrentes (a data pode mudar quando cai em fim de semana ou feriado). */
export const taxDeadlines = (year) => [
  { key: `est-q1-${year}`, date: `${year}-04-15`, title: 'Federal estimated tax payment (Q1)', payroll: false },
  { key: `est-q2-${year}`, date: `${year}-06-15`, title: 'Federal estimated tax payment (Q2)', payroll: false },
  { key: `est-q3-${year}`, date: `${year}-09-15`, title: 'Federal estimated tax payment (Q3)', payroll: false },
  { key: `est-q4-${year}`, date: `${year}-01-15`, title: 'Federal estimated tax payment (Q4)', payroll: false },
  { key: `941-q1-${year}`, date: `${year}-04-30`, title: 'Form 941 due (Q1)', payroll: true },
  { key: `941-q2-${year}`, date: `${year}-07-31`, title: 'Form 941 due (Q2)', payroll: true },
  { key: `941-q3-${year}`, date: `${year}-10-31`, title: 'Form 941 due (Q3)', payroll: true },
  { key: `941-q4-${year}`, date: `${year}-01-31`, title: 'Form 941 due (Q4)', payroll: true },
  { key: `w2-${year}`, date: `${year}-01-31`, title: 'W-2 and 1099-NEC forms due', payroll: true },
];

/** Cria os lembretes automáticos que valem hoje e remove os que deixaram de valer (fatura paga, por exemplo). Lembretes já dispensados não voltam. */
export function generate() {
  const cfg = getAutomations(), t = today();
  const wanted = {}; // kind -> [{ref_key,...}]
  const want = (kind, r) => (wanted[kind] ||= []).push({ kind, ...r });
  if (cfg.auto_overdue) {
    for (const d of all(`SELECT d.id, d.number, d.due_date, d.total-d.paid AS balance, c.name, c.email FROM docs d JOIN contacts c ON c.id=d.contact_id
      WHERE d.type='invoice' AND d.status IN ('sent','partial') AND d.total-d.paid>0 AND d.due_date <= ?`, addDays(t, -cfg.overdue_days))) {
      want('overdue', { ref_key: `overdue:${d.id}`, title: 'Invoice {0} is overdue', detail: `${d.name}`, link: `/document/${d.id}`, due_date: d.due_date, data: { number: d.number, name: d.name, email: d.email, balance: d.balance, id: d.id } });
    }
  }
  if (cfg.auto_bills && hasFeature('bills')) {
    for (const d of all(`SELECT d.id, d.number, d.due_date, d.total-d.paid AS balance, c.name FROM docs d JOIN contacts c ON c.id=d.contact_id
      WHERE d.type='bill' AND d.status IN ('open','partial') AND d.total-d.paid>0 AND d.due_date <= ?`, addDays(t, cfg.bills_days))) {
      want('bill', { ref_key: `bill:${d.id}`, title: 'Bill {0} is due', detail: d.name, link: `/document/${d.id}`, due_date: d.due_date, data: { number: d.number, name: d.name, balance: d.balance, id: d.id } });
    }
  }
  if (cfg.auto_estimates) {
    for (const d of all(`SELECT d.id, d.number, d.due_date, d.total, c.name FROM docs d JOIN contacts c ON c.id=d.contact_id
      WHERE d.type='estimate' AND d.status='sent' AND d.due_date <= ?`, addDays(t, cfg.estimate_days))) {
      want('estimate', { ref_key: `estimate:${d.id}`, title: 'Estimate {0} expires soon', detail: d.name, link: `/document/${d.id}`, due_date: d.due_date, data: { number: d.number, name: d.name, id: d.id } });
    }
  }
  if (cfg.auto_lowstock && hasFeature('inventory')) {
    for (const i of all('SELECT id, name, qty_on_hand, reorder_point FROM items WHERE track_inventory=1 AND active=1 AND qty_on_hand <= reorder_point AND reorder_point > 0')) {
      want('stock', { ref_key: `stock:${i.id}:${Math.floor(i.qty_on_hand)}`, title: 'Low stock: {0}', detail: `${i.qty_on_hand} / ${i.reorder_point}`, link: '/products', due_date: t, data: { name: i.name } });
    }
  }
  if (cfg.auto_bank) {
    const n = get("SELECT COUNT(*) n FROM bank_txns WHERE status='pending'").n;
    if (n > 0) want('bank', { ref_key: `bank:${t.slice(0, 7)}:${Math.min(Math.floor(n / 10), 20)}`, title: '{0} bank transactions need review', detail: '', link: '/banking', due_date: t, data: { n } });
  }
  if (cfg.auto_tax_calendar) {
    const payroll = hasFeature('payroll') && get('SELECT 1 FROM employees LIMIT 1');
    const y = Number(t.slice(0, 4));
    for (const d of [...taxDeadlines(y - 1), ...taxDeadlines(y), ...taxDeadlines(y + 1)]) {
      if (d.payroll && !payroll) continue;
      if (d.date >= t && d.date <= addDays(t, 14)) want('tax', { ref_key: `tax:${d.key}`, title: d.title, detail: 'Dates can move when they fall on a weekend or holiday. Confirm with the IRS.', link: '', due_date: d.date, data: {} });
    }
  }
  tx(() => {
    for (const kind of ['overdue', 'bill', 'estimate', 'stock', 'bank', 'tax']) {
      const keys = (wanted[kind] || []).map((r) => r.ref_key);
      const enabled = { overdue: cfg.auto_overdue, bill: cfg.auto_bills, estimate: cfg.auto_estimates, stock: cfg.auto_lowstock, bank: cfg.auto_bank, tax: cfg.auto_tax_calendar }[kind];
      // abertos que não valem mais (ou automação desligada) somem; os dispensados ficam como marcador
      for (const r of all('SELECT id, ref_key FROM reminders WHERE manual=0 AND kind=? AND done_at IS NULL', kind)) if (!enabled || !keys.includes(r.ref_key)) run('DELETE FROM reminders WHERE id=?', r.id);
      for (const r of wanted[kind] || []) run('INSERT OR IGNORE INTO reminders(kind,ref_key,title,detail,link,data,due_date) VALUES(?,?,?,?,?,?,?)', r.kind, r.ref_key, r.title, r.detail, r.link, JSON.stringify(r.data), r.due_date);
    }
  });
}

export function listReminders() {
  generate();
  const t = today();
  return all('SELECT * FROM reminders WHERE done_at IS NULL AND (snoozed_until IS NULL OR snoozed_until <= ?) ORDER BY COALESCE(due_date, ?) , id', t, t)
    .map((r) => ({ ...r, data: r.data ? JSON.parse(r.data) : {}, overdue: !!r.due_date && r.due_date < t, manual: !!r.manual }));
}

const REPEAT = ['', 'weekly', 'monthly', 'quarterly', 'yearly'];
function addMonths(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n, ny = Math.floor(total / 12), nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export const nextDate = (date, repeat) => ({ weekly: () => addDays(date, 7), monthly: () => addMonths(date, 1), quarterly: () => addMonths(date, 3), yearly: () => addMonths(date, 12) }[repeat]?.() ?? null);

export function createReminder({ title, due_date, repeat = '', detail = '' }) {
  const name = String(title || '').trim();
  if (!name) throw new HttpError(400, 'Enter a title');
  if (name.length > 160) throw new HttpError(400, 'The title is too long');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(due_date || ''))) throw new HttpError(400, 'Choose a due date');
  if (!REPEAT.includes(repeat)) throw new HttpError(400, 'Invalid repeat option');
  return insert('INSERT INTO reminders(kind,ref_key,title,detail,due_date,repeat,manual) VALUES(?,?,?,?,?,?,1)', 'manual', `manual:${crypto.randomUUID()}`, name, String(detail).slice(0, 400), due_date, repeat);
}
/** Conclui um lembrete. Os que se repetem já criam o próximo (é assim que tarefas repetitivas ficam automáticas). */
export function completeReminder(id) {
  const r = get('SELECT * FROM reminders WHERE id=?', id);
  if (!r) throw new HttpError(404, 'Reminder not found');
  tx(() => {
    run('UPDATE reminders SET done_at=? WHERE id=?', new Date().toISOString(), id);
    if (r.manual && r.repeat) {
      let next = nextDate(r.due_date, r.repeat);
      while (next && next <= today() && next <= r.due_date) next = nextDate(next, r.repeat);
      if (next) insert('INSERT INTO reminders(kind,ref_key,title,detail,due_date,repeat,manual) VALUES(?,?,?,?,?,?,1)', 'manual', `manual:${crypto.randomUUID()}`, r.title, r.detail, next, r.repeat);
    }
  });
  return { done: true };
}
export function snoozeReminder(id, days) {
  const n = Math.min(Math.max(Number(days) || 1, 1), 30);
  if (!get('SELECT 1 FROM reminders WHERE id=?', id)) throw new HttpError(404, 'Reminder not found');
  run('UPDATE reminders SET snoozed_until=? WHERE id=?', addDays(today(), n), id);
  return { snoozed: true };
}
export function deleteReminder(id) {
  const r = get('SELECT manual FROM reminders WHERE id=?', id);
  if (!r) throw new HttpError(404, 'Reminder not found');
  if (!r.manual) return completeReminder(id); // automático: só dispensa
  run('DELETE FROM reminders WHERE id=?', id);
  return { deleted: true };
}

/* --------------------------------- backup --------------------------------- */
const BACKUP_TABLES = ['settings', 'accounts', 'contacts', 'items', 'projects', 'docs', 'doc_lines', 'payments', 'expenses', 'journal_entries', 'journal_lines', 'bank_txns', 'bank_rules', 'time_entries', 'recurring', 'employees', 'pay_runs', 'pay_run_lines', 'payroll_remittances', 'classes', 'budgets', 'credit_applications', 'reminders'];
/** Cópia completa dos dados da empresa. Para download, a chave de criptografia fica de fora. */
export function exportAll({ forDownload = false } = {}) {
  return Object.fromEntries(BACKUP_TABLES.map((tbl) => [tbl, all(`SELECT * FROM ${tbl}`).filter((r) => !(forDownload && tbl === 'settings' && ['enc_key'].includes(r.key)))]));
}
const backupDir = () => path.join(process.env.FLUXO_BACKUP_DIR || path.join(dataDir, 'backups'), currentSlug() || 'default');
/** Backup diário em arquivo (mantém os 14 mais recentes). Devolve o caminho, ou null se não era hora. */
export function dailyBackup() {
  if (getSetting('auto_backup', '0') !== '1' || getSetting('last_backup', '') === today()) return null;
  if (process.env.FLUXO_DB === ':memory:') return null;
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `fluxo-${today()}.json`);
  fs.writeFileSync(file, JSON.stringify(exportAll()), { mode: 0o600 });
  for (const old of fs.readdirSync(dir).filter((f) => /^fluxo-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -14)) fs.rmSync(path.join(dir, old), { force: true });
  setSetting('last_backup', today());
  return file;
}
