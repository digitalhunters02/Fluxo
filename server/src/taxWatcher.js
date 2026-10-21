// Vigia das tabelas de impostos: de outubro a janeiro olha a Pub. 15-T do IRS e a página do teto do Social Security (SSA), guarda um resumo
// (SHA-256) e a data de alteração de cada endereço e, quando algo muda — ou quando o ano corrente não tem tabela no payroll.js —, avisa:
//   - faixa no app para os administradores ("Novas tabelas do IRS para 2027 — o Fluxo precisa ser atualizado antes da primeira folha de 2027");
//   - e-mail para o dono da plataforma (OWNER_EMAILS / FLUXO_ADMIN_EMAIL), se houver e-mail configurado;
//   - tarefa no Harbor (POST {HARBOR_API_URL}/api/public/product-alerts, X-Product-Key = ADMIN_SUMMARY_KEY), com dedupeKey.
// NUNCA muda número de imposto sozinho: quem atualiza é uma pessoa, no código (TABLES em payroll.js).
// Estado guardado nas configurações do banco PADRÃO (global, não por empresa).
import crypto from 'node:crypto';
import { db, runInDb, getSetting, setSetting } from './db.js';
import { TABLES, hasTable } from './payroll.js';
import * as mailer from './mailer.js';

export const DEFAULT_URLS = { irs: 'https://www.irs.gov/pub/irs-pdf/p15t.pdf', ssa: 'https://www.ssa.gov/oact/cola/cbb.html' };
export const watchUrls = () => ({ irs: process.env.TAXWATCH_IRS_URL || DEFAULT_URLS.irs, ssa: process.env.TAXWATCH_SSA_URL || DEFAULT_URLS.ssa });
const KEY = 'taxwatch_state';
const inMain = (fn) => runInDb(db, fn);
export const readState = () => inMain(() => { try { return JSON.parse(getSetting(KEY, '{}')); } catch { return {}; } });
const writeState = (s) => inMain(() => setSetting(KEY, JSON.stringify(s)));
/** Meses em que o vigia roda sozinho (out, nov, dez, jan). */
export const inSeason = (d = new Date()) => [9, 10, 11, 0].includes(d.getUTCMonth());
/** Ano para o qual as tabelas novas importam: a partir de outubro, o ano que vem. */
export const targetYear = (d = new Date()) => (d.getUTCMonth() >= 9 ? d.getUTCFullYear() + 1 : d.getUTCFullYear());

/* --------------------------------------------- Harbor --------------------------------------------- */
let harborWarned = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Cria uma tarefa no Harbor. Nunca lança erro e nunca leva dado de cliente. Devolve 'sent' | 'duplicate' | 'skipped' | 'failed'. */
export async function harborAlert({ title, detail, dueAt, dedupeKey }, { fetchImpl = globalThis.fetch, retries = 3, backoffMs = 1000 } = {}) {
  const base = String(process.env.HARBOR_API_URL || '').trim().replace(/\/+$/, '');
  const key = process.env.ADMIN_SUMMARY_KEY;
  if (!base || !key) { if (!harborWarned) { console.log('[harbor-alert] HARBOR_API_URL or ADMIN_SUMMARY_KEY not set: Harbor tasks are off'); harborWarned = true; } return 'skipped'; }
  const body = JSON.stringify({ title: String(title).slice(0, 200), detail: String(detail || '').slice(0, 2000), ...(dueAt ? { dueAt } : {}), dedupeKey: String(dedupeKey).slice(0, 120) });
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const r = await fetchImpl(`${base}/api/public/product-alerts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Product-Key': key }, body, signal: AbortSignal.timeout(10_000) });
      if (r.status === 201) return 'sent';
      if (r.status === 200) { const j = await r.json().catch(() => ({})); return j.duplicate ? 'duplicate' : 'sent'; }
      if (r.status === 401 || r.status === 400) { console.error(`[harbor-alert] Harbor answered HTTP ${r.status}`); return 'failed'; } // não adianta repetir
      console.error(`[harbor-alert] Harbor answered HTTP ${r.status}`);
    } catch (e) { console.error(`[harbor-alert] could not reach Harbor: ${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : e?.message || 'error'}`); }
    if (attempt < retries) await sleep(backoffMs * 2 ** attempt);
  }
  return 'failed';
}
/** Prazo da tarefa: 15/dez do ano anterior ao ano das tabelas, ou hoje + 3 dias se isso já passou. */
export function harborDue(year, now = new Date()) {
  const dec15 = `${year - 1}-12-15`;
  const plus3 = new Date(now.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  return dec15 < plus3 ? plus3 : dec15;
}

/* ----------------------------------------------- avisos ----------------------------------------------- */
const ownerEmails = () => [...new Set(String(process.env.OWNER_EMAILS || '').split(',').concat(process.env.FLUXO_ADMIN_EMAIL || '').map((x) => x.trim().toLowerCase()).filter((x) => /@/.test(x)))];
async function notify(kind, year, state, { fetchImpl, backoffMs, now = new Date() } = {}) {
  const sent = state.notified || (state.notified = {});
  const dedupeKey = { irs: `fluxo-irs-tables-${year}`, ssa: `fluxo-ssa-wagebase-${year}`, missing: `fluxo-missing-table-${year}` }[kind];
  if (sent[dedupeKey]) return sent[dedupeKey];
  const title = {
    irs: `IRS publicou as tabelas de ${year} — atualizar a folha do Fluxo`,
    ssa: `SSA publicou o teto do Social Security de ${year} — atualizar a folha do Fluxo`,
    missing: `Fluxo sem tabela de impostos de ${year} — folhas de ${year} estão bloqueadas`,
  }[kind];
  const detail = {
    irs: `A página da Pub. 15-T do IRS mudou (${watchUrls().irs}). Conferir as tabelas de retenção de ${year} e acrescentar ${year} em TABLES (server/src/payroll.js) antes da primeira folha de ${year}. O Fluxo não muda os números sozinho.`,
    ssa: `A página do teto do Social Security (SSA) mudou (${watchUrls().ssa}). Conferir o "wage base" de ${year} e atualizar TABLES (server/src/payroll.js) antes da primeira folha de ${year}.`,
    missing: `O ano ${year} não tem tabela em server/src/payroll.js. Os clientes não conseguem finalizar folhas datadas em ${year} até a atualização.`,
  }[kind];
  const res = { at: new Date().toISOString(), harbor: await harborAlert({ title, detail, dueAt: harborDue(year, now), dedupeKey }, { fetchImpl, backoffMs }), email: 'skipped' };
  const to = ownerEmails();
  if (mailer.mailConfigured() && to.length) {
    try { for (const addr of to) await mailer.sendMail({ to: addr, subject: `Fluxo: ${title}`, text: `${detail}\n\nNew IRS tables published for ${year} — Fluxo must be updated before the first ${year} payroll.` }); res.email = 'sent'; } catch (e) { res.email = 'failed'; console.error('[taxwatch] email failed:', e.message); }
  }
  if (res.harbor !== 'failed') sent[dedupeKey] = res; // Harbor fora do ar: tenta de novo na próxima verificação
  return res;
}

/** Busca as páginas e compara com o que estava guardado. fetchImpl injetável para teste. Nunca lança erro. */
export async function checkNow({ fetchImpl = globalThis.fetch, now = new Date(), backoffMs } = {}) {
  const state = readState();
  state.urls ||= {};
  const year = targetYear(now);
  for (const [kind, url] of Object.entries(watchUrls())) {
    const prev = state.urls[kind] || {};
    const cur = { url, checkedAt: now.toISOString() };
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Fluxo tax-table watcher' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      cur.hash = crypto.createHash('sha256').update(buf).digest('hex');
      cur.lastModified = r.headers.get('last-modified') || '';
      const changed = prev.hash && prev.url === url && (prev.hash !== cur.hash || (cur.lastModified && prev.lastModified && cur.lastModified !== prev.lastModified));
      cur.changedAt = changed ? now.toISOString() : prev.changedAt || '';
      cur.changedFor = changed ? year : prev.changedFor || null;
      cur.error = '';
    } catch (e) { Object.assign(cur, { hash: prev.hash, lastModified: prev.lastModified, changedAt: prev.changedAt || '', changedFor: prev.changedFor || null, error: e.message }); }
    state.urls[kind] = cur;
  }
  state.lastCheck = now.toISOString();
  for (const kind of ['irs', 'ssa']) if (state.urls[kind].changedFor === year && !hasTable(year)) await notify(kind, year, state, { fetchImpl, backoffMs, now });
  const cy = now.getUTCFullYear();
  if (!hasTable(cy)) await notify('missing', cy, state, { fetchImpl, backoffMs, now });
  writeState(state);
  return status(now);
}

/** O que a tela mostra: faixa ligada ou não, e por quê. */
export function status(now = new Date()) {
  const s = readState();
  const year = targetYear(now), cy = now.getUTCFullYear();
  const changed = Object.entries(s.urls || {}).filter(([, v]) => v.changedFor === year).map(([k]) => k);
  const banner = !hasTable(cy) ? { year: cy, reason: 'missing' } : changed.length && !hasTable(year) ? { year, reason: 'published', sources: changed } : null;
  return { banner, lastCheck: s.lastCheck || null, urls: s.urls || {}, inSeason: inSeason(now), tableYears: Object.keys(TABLES).map(Number) };
}

/** Rodada automática: só na temporada (out–jan) e no máximo uma vez por dia. Também roda fora da temporada se o ano corrente estiver sem tabela. */
export async function scheduledCheck({ fetchImpl, now = new Date() } = {}) {
  const s = readState();
  const today = now.toISOString().slice(0, 10);
  if (s.lastCheck?.slice(0, 10) === today) return null;
  if (!inSeason(now) && hasTable(now.getUTCFullYear())) return null;
  return checkNow({ fetchImpl, now });
}
