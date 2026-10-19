// Limpeza de contas Free abandonadas (só no modo hospedado/multi-empresa).
//
// Regras (todas precisam valer para uma conta ser candidata):
//   1. plano Free, sem assinatura, sem folha de pagamento, sem banco conectado, fora de grupo de empresas e não suspensa;
//   2. nenhum uso há 12 meses (login, uso da API ou qualquer registro criado);
//   3. nenhum dado fiscal recente: nada lançado (faturas, contas, despesas, pagamentos, lançamentos, folha) com data dos últimos 24 meses.
// Uma conta candidata recebe um e-mail de aviso e 30 dias de prazo; entrar na conta nesse prazo cancela tudo. Sem e-mail configurado
// NADA é apagado (não dá para avisar). Cada exclusão fica registrada (empresa, e-mail mascarado, contagens) em cleanup_log.
// A rotina automática só roda com FLUXO_CLEANUP=1; o painel /admin mostra a prévia e permite rodar na hora.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { get, getSetting, dataDir } from './db.js';
import * as tenants from './tenants.js';
import * as mailer from './mailer.js';

const env = () => process.env;
export const cleanupEnabled = () => tenants.multiEnabled() && env().FLUXO_CLEANUP === '1';
export const config = () => ({
  idleMonths: Math.max(1, Number(env().FLUXO_CLEANUP_IDLE_MONTHS) || 12),
  graceDays: Math.max(1, Number(env().FLUXO_CLEANUP_GRACE_DAYS) || 30),
  fiscalMonths: Math.max(1, Number(env().FLUXO_CLEANUP_FISCAL_MONTHS) || 24),
});

const iso = (d) => d.toISOString();
const day = (d) => iso(d).slice(0, 10);
const monthsAgo = (now, n) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - n); return d; };
const daysAhead = (now, n) => new Date(now.getTime() + n * 86400000);
const maxOf = (list) => list.filter(Boolean).map((x) => String(x).slice(0, 10)).sort().at(-1) || '';
export const maskEmail = (e) => { const [u = '', d = ''] = String(e).split('@'); return `${u.slice(0, 1)}***@${d}`; };
const hashEmail = (e) => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex').slice(0, 16);

const scalar = (sql, ...p) => { try { return Object.values(get(sql, ...p) || {})[0] ?? null; } catch { return null; } }; // tabela que não existe (banco antigo) conta como vazia

/** Roda DENTRO da empresa: quando houve o último uso e o último dado fiscal. */
export function activityOf(createdAt = '') {
  return maxOf([
    getSetting('last_activity_at', ''), createdAt,
    scalar('SELECT MAX(created_at) FROM sessions'), scalar('SELECT MAX(at) FROM audit_log'),
    scalar('SELECT MAX(created_at) FROM docs'), scalar('SELECT MAX(created_at) FROM expenses'), scalar('SELECT MAX(created_at) FROM payments'),
    scalar('SELECT MAX(created_at) FROM journal_entries'), scalar('SELECT MAX(created_at) FROM bank_txns'), scalar('SELECT MAX(created_at) FROM contacts'),
    scalar('SELECT MAX(created_at) FROM pay_runs'),
  ]);
}
/** Roda DENTRO da empresa: a data mais recente de qualquer lançamento fiscal (não a data de criação do registro). */
export function lastFiscalDate() {
  return maxOf([
    scalar("SELECT MAX(issue_date) FROM docs WHERE status!='void'"), scalar('SELECT MAX(date) FROM expenses'), scalar('SELECT MAX(date) FROM payments'),
    scalar('SELECT MAX(date) FROM journal_entries'), scalar('SELECT MAX(date) FROM bank_txns'), scalar("SELECT MAX(pay_date) FROM pay_runs WHERE status!='void'"),
    scalar('SELECT MAX(date) FROM payroll_remittances'), scalar('SELECT MAX(date) FROM time_entries'),
  ]);
}
const counts = () => ({
  users: scalar('SELECT COUNT(*) FROM users'), customers: scalar("SELECT COUNT(*) FROM contacts"), documents: scalar('SELECT COUNT(*) FROM docs'), expenses: scalar('SELECT COUNT(*) FROM expenses'),
  journal_entries: scalar('SELECT COUNT(*) FROM journal_entries'), bank_transactions: scalar('SELECT COUNT(*) FROM bank_txns'),
});

/** Roda DENTRO da empresa. Devolve {eligible, protectedBy[], lastActivity, lastFiscal, plan}. */
export function evaluate(meta, now = new Date(), cfg = config()) {
  const plan = getSetting('plan', 'free'), status = getSetting('subscription_status', '');
  const lastActivity = activityOf(meta.created_at), lastFiscal = lastFiscalDate();
  const why = [];
  if (plan !== 'free') why.push('paid_plan');
  if ((scalar('SELECT COUNT(*) FROM pay_runs') || 0) > 0 || (scalar('SELECT COUNT(*) FROM employees') || 0) > 0) why.push('payroll'); // folha de pagamento (funcionários ou folhas feitas): nunca
  if (['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(status) || (getSetting('stripe_subscription_id', '') && status !== 'canceled') || getSetting('billing_managed', '0') === '1') why.push('subscription');
  if ((scalar('SELECT COUNT(*) FROM plaid_items') || 0) > 0) why.push('bank_connected');
  if (tenants.groupOf(meta.slug)) why.push('in_group');
  if (meta.status === 'suspended') why.push('suspended');
  if (lastActivity > day(monthsAgo(now, cfg.idleMonths))) why.push('recent_use');
  if (lastFiscal && lastFiscal >= day(monthsAgo(now, cfg.fiscalMonths))) why.push('recent_fiscal_data');
  return { eligible: why.length === 0, protectedBy: [...new Set(why)], lastActivity, lastFiscal, plan };
}

const emailLang = () => { const l = getSetting('lang', 'en'); return ['en', 'pt', 'es'].includes(l) ? l : 'en'; };
const backupFolder = (slug) => path.join(env().FLUXO_BACKUP_DIR || path.join(dataDir, 'backups'), slug);

/** Passa por todas as empresas. dryRun=true só descreve o que faria (nada é enviado nem apagado). */
export async function runCleanup({ dryRun = false, now = new Date() } = {}) {
  if (!tenants.multiEnabled()) return { dryRun, items: [], note: 'single-company install' };
  const cfg = config(), items = [], mailReady = mailer.recoveryReady();
  for (const slug of tenants.allSlugs()) {
    const meta = tenants.getTenant(slug);
    if (!meta) continue;
    let ev;
    try { ev = tenants.inTenant(slug, () => evaluate(meta, now, cfg)); } catch (e) { items.push({ slug, company: meta.name, state: 'error', error: e.message }); continue; }
    const warn = tenants.cleanupWarning(slug);
    const base = { slug, company: meta.name, owner: maskEmail(meta.owner_email), lastActivity: ev.lastActivity, lastFiscal: ev.lastFiscal };
    if (!ev.eligible) {
      if (warn) { if (!dryRun) tenants.clearCleanupWarning(slug); items.push({ ...base, state: 'cancelled', protectedBy: ev.protectedBy }); } // voltou a usar (ou virou plano pago): o aviso some
      continue;                                                      // contas em uso não aparecem na lista
    }
    if (!warn) {
      if (!mailReady) { items.push({ ...base, state: 'blocked_no_email' }); continue; }   // não dá para avisar, então não se apaga
      const deleteOn = daysAhead(now, cfg.graceDays);
      if (dryRun) { items.push({ ...base, state: 'would_warn', deleteAfter: day(deleteOn) }); continue; }
      try {
        const mail = tenants.inTenant(slug, () => mailer.idleWarningEmail(emailLang(), { company: meta.name || slug, lastUse: ev.lastActivity, deleteOn: day(deleteOn), url: mailer.appUrl() }));
        await mailer.sendMail({ to: meta.owner_email, ...mail });
        tenants.saveCleanupWarning({ slug, warned_at: iso(now), delete_after: iso(deleteOn), last_activity: ev.lastActivity, to_email: meta.owner_email });
        items.push({ ...base, state: 'warned', deleteAfter: day(deleteOn) });
      } catch (e) { items.push({ ...base, state: 'warn_failed', error: e.message }); }  // tenta de novo na próxima rodada
      continue;
    }
    if (iso(now) < warn.delete_after) { items.push({ ...base, state: 'waiting', deleteAfter: warn.delete_after.slice(0, 10) }); continue; }
    if (dryRun) { items.push({ ...base, state: 'would_delete' }); continue; }
    // prazo vencido e a conta continua parada: registra o que será apagado e apaga
    const entry = tenants.inTenant(slug, () => ({ plan: ev.plan, counts: counts() }));
    tenants.addCleanupLog({ at: iso(now), slug, company: meta.name, email_masked: maskEmail(meta.owner_email), email_hash: hashEmail(meta.owner_email), plan: entry.plan, created_at: meta.created_at, last_activity: ev.lastActivity, warned_at: warn.warned_at, counts: entry.counts, reason: `idle ${cfg.idleMonths} months, warned ${warn.warned_at.slice(0, 10)}, no activity in the ${cfg.graceDays}-day notice` });
    tenants.dropTenant(slug);
    try { fs.rmSync(backupFolder(slug), { recursive: true, force: true }); } catch { /* sem cópia em arquivo */ }
    items.push({ ...base, state: 'deleted', counts: entry.counts });
  }
  return { dryRun, mailReady, config: cfg, items };
}

/** Chamada de hora em hora pelo servidor: no máximo uma rodada por dia, e só se FLUXO_CLEANUP=1. */
export async function runDaily(now = new Date()) {
  if (!cleanupEnabled() || tenants.getMeta('last_cleanup_run') === day(now)) return null;
  tenants.setMeta('last_cleanup_run', day(now));
  const r = await runCleanup({ now });
  const done = r.items.filter((i) => ['warned', 'deleted'].includes(i.state));
  if (done.length) console.log(`cleanup: ${done.map((i) => `${i.state} ${i.slug}`).join(', ')}`);
  return r;
}

/** O que o painel mostra: configuração, prévia (sem enviar nada) e o histórico de exclusões. */
export async function overview() {
  const r = await runCleanup({ dryRun: true });
  return { enabled: cleanupEnabled(), mailReady: mailer.recoveryReady(), config: config(), items: r.items, log: tenants.cleanupLog(100) };
}
