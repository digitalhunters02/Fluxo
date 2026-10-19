// Backup e restauração de TODOS os bancos (control.db, banco principal e um arquivo por empresa) num único .zip com manifesto.
//  - A cópia usa VACUUM INTO: consistente mesmo com o servidor em uso (nada precisa parar).
//  - O manifesto guarda, para cada banco, o SHA-256 do arquivo, o resultado do integrity_check, contagens e um "hash do conteúdo"
//    (todas as tabelas e linhas), para provar depois que a restauração devolveu exatamente os mesmos dados.
//  - A CHAVE DE CRIPTOGRAFIA (FLUXO_ENCRYPTION_KEY) NÃO vai no arquivo: sem ela, SSN/EIN, tokens do Plaid e segredos do 2FA não abrem.
//    O manifesto guarda só uma "impressão" dela para o restore avisar se a chave de agora é outra.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, mainDbFile, snapshotTo, get } from './db.js';
import * as tenants from './tenants.js';
import * as mailer from './mailer.js';
import { zip } from './exportAll.js';
import { FORMAT, sha256, version, keyFingerprint, stamp, describeDb } from './backupCore.js';
export { unzip, readArchive, verifyBackup, restoreBackup, describeDb, version } from './backupCore.js';

const env = () => process.env;
export const backupDir = () => path.join(env().FLUXO_BACKUP_DIR || path.join(dataDir, 'backups'), '_platform');
export const keepCount = () => Math.max(1, Number(env().FLUXO_BACKUP_KEEP) || 7);
/** Backup automático diário: ligado por padrão na hospedagem multi-empresa; FLUXO_BACKUP_DAILY=0/1 decide. */
export const dailyEnabled = () => (env().FLUXO_BACKUP_DAILY === undefined ? tenants.multiEnabled() : env().FLUXO_BACKUP_DAILY === '1') && mainDbFile !== ':memory:';

/* ------------------------------------- backup ------------------------------------- */
function sources() {
  if (mainDbFile === ':memory:' || process.env.FLUXO_DB === ':memory:') throw new Error('Backups need database files, but this server uses a memory database (FLUXO_DB=:memory:).');
  const list = [{ name: 'main.db', snap: (f) => snapshotTo(f) }];
  if (tenants.multiEnabled()) {
    list.push({ name: 'control.db', snap: (f) => tenants.snapshotControl(f) });
    for (const slug of tenants.allSlugs()) list.push({ name: `tenants/${slug}.db`, snap: (f) => tenants.inTenant(slug, () => snapshotTo(f)) });
  }
  return list;
}

/** Faz o backup agora. Devolve {file, bytes, manifest}. */
export function runBackup({ dir = backupDir(), keep = keepCount(), now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
  try {
    const files = [], manifest = { format: FORMAT, created_at: now.toISOString(), app_version: version(), commit: env().SOURCE_COMMIT || env().GIT_COMMIT || '', mode: tenants.multiEnabled() ? 'multi' : 'single',
      main_name: path.basename(mainDbFile), control_name: tenants.multiEnabled() ? path.basename(tenants.controlFile()) : '', encryption_key: keyFingerprint(), files: [] };
    for (const s of sources()) {
      const out = path.join(tmp, s.name.replace('/', '__'));
      s.snap(out);
      const data = fs.readFileSync(out);
      manifest.files.push({ name: s.name, bytes: data.length, sha256: sha256(data), ...describeDb(out) });
      files.push({ name: s.name, data });
      fs.rmSync(out, { force: true });
    }
    if (manifest.files.some((f) => f.integrity !== 'ok')) throw new Error('The database failed its integrity check; the backup was not saved.');
    const buf = zip([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) }, ...files], now);
    const file = path.join(dir, `fluxo-backup-${stamp(now)}.zip`);
    fs.writeFileSync(`${file}.part`, buf, { mode: 0o600 });
    fs.renameSync(`${file}.part`, file);
    for (const old of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, old.name), { force: true }); // guarda os `keep` mais novos
    return { file, bytes: buf.length, manifest };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export function listBackups(dir = backupDir()) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^fluxo-backup-\d{8}-\d{4}\.zip$/.test(f)).sort().reverse()
    .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, bytes: st.size, at: st.mtime.toISOString() }; });
}
/** Roda o backup se ainda não houve um hoje (chamado de hora em hora pelo servidor). */
export function runIfDue(now = new Date()) {
  const last = listBackups()[0];
  if (last && last.name.slice(13, 21) === stamp(now).slice(0, 8)) return null;
  return runBackup({ now });
}

/* ---------------------------------------- /healthz ---------------------------------------- */
const started = Date.now();
/** Resposta de /healthz para monitoramento: versão, banco ok, backup em dia. HTTP 503 só quando o banco não responde. */
export function health() {
  let db = 'ok';
  try { get('SELECT 1'); if (tenants.multiEnabled()) tenants.tenantCount(); } catch { db = 'error'; }
  const out = { ok: db === 'ok', version: version(), commit: env().SOURCE_COMMIT || env().GIT_COMMIT || '', db, uptime_s: Math.round((Date.now() - started) / 1000), email: mailer.mailConfigured() ? 'configured' : 'not_configured' };
  const warnings = [];
  if (mainDbFile !== ':memory:') {
    const last = listBackups()[0], ageH = last ? Math.round((Date.now() - new Date(last.at).getTime()) / 36e5) : null;
    out.backup = { enabled: dailyEnabled(), last_at: last?.at || null, age_hours: ageH };
    if (dailyEnabled() && (ageH === null ? Date.now() - started > 36e5 * 3 : ageH > 36)) warnings.push('backup_stale');
    if (!dailyEnabled()) warnings.push('backup_off');
  }
  if (!mailer.mailConfigured()) warnings.push('email_not_configured');
  out.warnings = warnings;
  return out;
}
