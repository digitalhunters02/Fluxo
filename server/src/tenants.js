// Modo multi-empresa (FLUXO_MULTI=1): cada empresa tem o seu próprio arquivo SQLite, isolado dos demais.
// Um pequeno banco de controle guarda só o índice: empresas, e-mails de login e vínculos externos (Stripe/Plaid).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { als, openDb, dataDir } from './db.js';
import { sealLegacyTaxIds } from './taxid.js';

export const multiEnabled = () => process.env.FLUXO_MULTI === '1';
const inMemory = () => process.env.FLUXO_DB === ':memory:' || process.env.FLUXO_CONTROL_DB === ':memory:';

let control = null;
export const controlFile = () => process.env.FLUXO_CONTROL_DB || (inMemory() ? ':memory:' : path.join(dataDir, 'control.db'));
const ctl = () => {
  if (control) return control;
  const file = controlFile();
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  control = new DatabaseSync(file);
  control.exec('PRAGMA journal_mode = WAL;');
  control.exec(`
    CREATE TABLE IF NOT EXISTS tenants (slug TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS identities (email TEXT PRIMARY KEY, slug TEXT NOT NULL REFERENCES tenants(slug));
    CREATE TABLE IF NOT EXISTS links (kind TEXT NOT NULL, key TEXT NOT NULL, slug TEXT NOT NULL REFERENCES tenants(slug), PRIMARY KEY (kind, key));
    CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_slug TEXT NOT NULL REFERENCES tenants(slug), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS group_members (group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, slug TEXT NOT NULL UNIQUE REFERENCES tenants(slug), joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, slug));
    CREATE TABLE IF NOT EXISTS cleanup_warnings (slug TEXT PRIMARY KEY, warned_at TEXT NOT NULL, delete_after TEXT NOT NULL, last_activity TEXT NOT NULL DEFAULT '', to_email TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS cleanup_log (id INTEGER PRIMARY KEY, at TEXT NOT NULL, slug TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', email_masked TEXT NOT NULL DEFAULT '', email_hash TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', last_activity TEXT NOT NULL DEFAULT '', warned_at TEXT NOT NULL DEFAULT '', counts TEXT NOT NULL DEFAULT '{}', reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS group_invites (code_hash TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, used_at TEXT);
  `);
  if (!control.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'status')) control.exec("ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  // código de afiliado/referência que trouxe o cadastro (opcional); usado só para o Harbor consultar conversões.
  if (!control.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'referral_code')) control.exec('ALTER TABLE tenants ADD COLUMN referral_code TEXT');
  return control;
};
const q = (sql, ...p) => ctl().prepare(sql).get(...p);
const qa = (sql, ...p) => ctl().prepare(sql).all(...p);
const qr = (sql, ...p) => ctl().prepare(sql).run(...p);

const cache = new Map();
export const tenantFile = (slug) => (inMemory() ? ':memory:' : path.join(process.env.FLUXO_TENANTS_DIR || path.join(dataDir, 'tenants'), `${slug}.db`));

export const tenantExists = (slug) => !!(slug && /^[a-z0-9-]+$/.test(slug) && q('SELECT 1 FROM tenants WHERE slug=?', slug));
export const currentSlug = () => als.getStore()?.slug || '';
export const isSuspended = (slug) => q('SELECT status FROM tenants WHERE slug=?', slug)?.status === 'suspended';
export function setStatus(slug, status) {
  if (!tenantExists(slug)) return false;
  qr('UPDATE tenants SET status=? WHERE slug=?', status === 'suspended' ? 'suspended' : 'active', slug);
  return true;
}
export const listTenants = () => qa('SELECT slug,name,owner_email,status,created_at FROM tenants ORDER BY created_at DESC');
/** Empresa que veio de um código de afiliado específico (cadastro público com ?ref=CODE). Usado só pelo Harbor. */
export const tenantByReferralCode = (code) => (code ? q('SELECT slug,name,owner_email,status,created_at,referral_code FROM tenants WHERE referral_code=?', String(code).trim()) : null);
export const allSlugs = () => qa('SELECT slug FROM tenants ORDER BY created_at').map((r) => r.slug);

function openTenant(slug) {
  if (!cache.has(slug)) {
    const d = openDb(tenantFile(slug));
    cache.set(slug, d);
    try { als.run({ db: d }, sealLegacyTaxIds); } catch (e) { console.error('SSN/EIN (empresa ' + slug + '):', e.message); }
  }
  return cache.get(slug);
}
/** Executa fn com o banco da empresa; todo get/run/insert dentro dele enxerga só essa empresa. */
export const inTenant = (slug, fn) => als.run({ db: openTenant(slug), slug }, fn);
/** Roda fn uma vez por empresa (tarefas em segundo plano), isolando falhas. */
export async function eachTenant(fn) {
  for (const slug of allSlugs()) {
    try { await inTenant(slug, fn); } catch (e) { console.error(`tenant ${slug}:`, e.message); }
  }
}

const RESERVED = new Set(['admin', 'api', 'p', 'pricing', 'welcome', 'setup', 'login', 'www', 'app', 'static', 'assets']);
export const slugify = (name) => (String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)) || 'company';
function uniqueSlug(name) {
  const base = slugify(name);
  if (!RESERVED.has(base) && !q('SELECT 1 FROM tenants WHERE slug=?', base)) return base;
  for (;;) { const s = `${base}-${crypto.randomBytes(2).toString('hex')}`; if (!q('SELECT 1 FROM tenants WHERE slug=?', s)) return s; }
}

export const slugForEmail = (email) => q('SELECT slug FROM identities WHERE email=?', String(email).trim().toLowerCase())?.slug || null;
/** Cada e-mail pertence a uma única empresa, porque o login é só e-mail e senha. Devolve false se já for de outra. */
export function registerEmail(email, slug) {
  const e = String(email).trim().toLowerCase();
  const cur = q('SELECT slug FROM identities WHERE email=?', e);
  if (cur) return cur.slug === slug;
  qr('INSERT INTO identities(email,slug) VALUES(?,?)', e, slug);
  return true;
}

/** Cria a empresa (arquivo novo + índice). Quem chama termina a configuração dentro de inTenant().
 * `referralCode`, quando vier do cadastro público (?ref=CODE), é só gravado aqui para o Harbor consultar depois. */
export function createTenant({ name, ownerEmail, referralCode }) {
  const email = String(ownerEmail).trim().toLowerCase();
  if (slugForEmail(email)) return null;
  const slug = uniqueSlug(name);
  const ref = referralCode ? String(referralCode).trim().slice(0, 64) : null;
  qr('INSERT INTO tenants(slug,name,owner_email,referral_code) VALUES(?,?,?,?)', slug, name || '', email, ref || null);
  registerEmail(email, slug);
  openTenant(slug);
  return slug;
}
/** Desfaz uma empresa (cadastro que falhou, ou conta Free abandonada apagada pela limpeza): índice, vínculos e o arquivo do banco. */
export function dropTenant(slug) {
  qr('DELETE FROM links WHERE slug=?', slug); qr('DELETE FROM identities WHERE slug=?', slug); qr('DELETE FROM cleanup_warnings WHERE slug=?', slug); qr('DELETE FROM tenants WHERE slug=?', slug);
  try { cache.get(slug)?.close(); } catch { /* já fechado */ }
  cache.delete(slug);
  const f = tenantFile(slug);
  if (f !== ':memory:') for (const x of ['', '-wal', '-shm']) fs.rmSync(f + x, { force: true });
}

/** Vínculos externos (cliente/assinatura do Stripe, item do Plaid) para achar a empresa certa nos webhooks. */
export function link(kind, key, slug = currentSlug()) {
  if (!multiEnabled() || !slug || !key) return;
  qr('INSERT INTO links(kind,key,slug) VALUES(?,?,?) ON CONFLICT(kind,key) DO UPDATE SET slug=excluded.slug', kind, String(key), slug);
}
export const slugForLink = (kind, key) => (key ? q('SELECT slug FROM links WHERE kind=? AND key=?', kind, String(key))?.slug || null : null);

/* ------------------------- grupos de empresas (consolidação) ------------------------- */
// Uma empresa pode estar em um único grupo. Entrar exige um código gerado pelo dono do grupo e entregue ao dono da outra empresa.
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
export const tenantName = (slug) => q('SELECT name FROM tenants WHERE slug=?', slug)?.name || slug;
export const groupOf = (slug) => q('SELECT g.id,g.name,g.owner_slug FROM groups g JOIN group_members m ON m.group_id=g.id WHERE m.slug=?', slug) || null;
export const groupMembers = (groupId) => qa('SELECT m.slug, t.name FROM group_members m JOIN tenants t ON t.slug=m.slug WHERE m.group_id=? ORDER BY m.joined_at, m.slug', groupId);
export function createGroup(name, slug) {
  if (groupOf(slug)) return null;
  const id = crypto.randomUUID();
  qr('INSERT INTO groups(id,name,owner_slug) VALUES(?,?,?)', id, String(name).trim().slice(0, 120), slug);
  qr('INSERT INTO group_members(group_id,slug) VALUES(?,?)', id, slug);
  return id;
}
export function createInvite(groupId) {
  const code = crypto.randomBytes(6).toString('hex').toUpperCase().replace(/(.{4})/g, '$1-').slice(0, -1);
  qr('INSERT INTO group_invites(code_hash,group_id,expires_at) VALUES(?,?,?)', sha(code), groupId, new Date(Date.now() + 7 * 86400000).toISOString());
  return code;
}
/** Grupo a que um código convida (sem consumir), ou null se for inválido/expirado/usado. */
export function peekInvite(code) {
  const inv = q('SELECT i.group_id, g.owner_slug FROM group_invites i JOIN groups g ON g.id=i.group_id WHERE i.code_hash=? AND i.used_at IS NULL AND i.expires_at>=?', sha(String(code).trim().toUpperCase()), new Date().toISOString());
  return inv || null;
}
/** Consome o código e põe a empresa no grupo. Devolve {groupId} ou {error}. */
export function joinWithCode(code, slug, maxMembers) {
  const inv = q('SELECT * FROM group_invites WHERE code_hash=?', sha(String(code).trim().toUpperCase()));
  if (!inv || inv.used_at || inv.expires_at < new Date().toISOString()) return { error: 'This code is invalid or has expired' };
  if (groupOf(slug)) return { error: 'This company already belongs to a group' };
  if (maxMembers != null && groupMembers(inv.group_id).length >= maxMembers) return { error: 'This group has reached the limit of companies for its plan' };
  qr('UPDATE group_invites SET used_at=? WHERE code_hash=?', new Date().toISOString(), inv.code_hash);
  qr('INSERT INTO group_members(group_id,slug) VALUES(?,?)', inv.group_id, slug);
  return { groupId: inv.group_id };
}
export function leaveGroup(slug) {
  const g = groupOf(slug);
  if (!g) return false;
  if (g.owner_slug === slug) { qr('DELETE FROM groups WHERE id=?', g.id); return true; } // o dono desfaz o grupo inteiro
  qr('DELETE FROM group_members WHERE slug=?', slug);
  return true;
}

/* ------------------------- apoio à limpeza de contas abandonadas (cleanup.js) ------------------------- */
export const getTenant = (slug) => q('SELECT slug,name,owner_email,status,created_at FROM tenants WHERE slug=?', slug) || null;
export const cleanupWarning = (slug) => q('SELECT * FROM cleanup_warnings WHERE slug=?', slug) || null;
export const listCleanupWarnings = () => qa('SELECT * FROM cleanup_warnings ORDER BY warned_at');
export function saveCleanupWarning({ slug, warned_at, delete_after, last_activity, to_email }) {
  qr('INSERT INTO cleanup_warnings(slug,warned_at,delete_after,last_activity,to_email) VALUES(?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET warned_at=excluded.warned_at, delete_after=excluded.delete_after, last_activity=excluded.last_activity, to_email=excluded.to_email', slug, warned_at, delete_after, last_activity, to_email);
}
export const clearCleanupWarning = (slug) => qr('DELETE FROM cleanup_warnings WHERE slug=?', slug);
export function addCleanupLog(e) {
  qr('INSERT INTO cleanup_log(at,slug,company,email_masked,email_hash,plan,created_at,last_activity,warned_at,counts,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)', e.at, e.slug, e.company, e.email_masked, e.email_hash, e.plan, e.created_at, e.last_activity, e.warned_at, JSON.stringify(e.counts || {}), e.reason || '');
}
export const cleanupLog = (limit = 100) => qa('SELECT * FROM cleanup_log ORDER BY id DESC LIMIT ?', limit).map((r) => ({ ...r, counts: (() => { try { return JSON.parse(r.counts); } catch { return {}; } })() }));
export const getMeta = (key, d = '') => q('SELECT value FROM meta WHERE key=?', key)?.value ?? d;
export const setMeta = (key, value) => qr('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));

/** Cópia consistente do banco de controle (índice de empresas, e-mails de login, vínculos). */
export const snapshotControl = (file) => { ctl().exec(`VACUUM INTO '${String(file).replace(/'/g, "''")}'`); };
export const tenantCount = () => q('SELECT COUNT(*) n FROM tenants').n;
