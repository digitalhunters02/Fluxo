// Modo multi-empresa (FLUXO_MULTI=1): cada empresa tem o seu próprio arquivo SQLite, isolado dos demais.
// Um pequeno banco de controle guarda só o índice: empresas, e-mails de login e vínculos externos (Stripe/Plaid).
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { als, openDb, dataDir } from './db.js';

export const multiEnabled = () => process.env.FLUXO_MULTI === '1';
const inMemory = () => process.env.FLUXO_DB === ':memory:' || process.env.FLUXO_CONTROL_DB === ':memory:';

let control = null;
const ctl = () => {
  if (control) return control;
  const file = process.env.FLUXO_CONTROL_DB || (inMemory() ? ':memory:' : path.join(dataDir, 'control.db'));
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  control = new DatabaseSync(file);
  control.exec('PRAGMA journal_mode = WAL;');
  control.exec(`
    CREATE TABLE IF NOT EXISTS tenants (slug TEXT PRIMARY KEY, name TEXT NOT NULL, owner_email TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS identities (email TEXT PRIMARY KEY, slug TEXT NOT NULL REFERENCES tenants(slug));
    CREATE TABLE IF NOT EXISTS links (kind TEXT NOT NULL, key TEXT NOT NULL, slug TEXT NOT NULL REFERENCES tenants(slug), PRIMARY KEY (kind, key));
  `);
  if (!control.prepare('PRAGMA table_info(tenants)').all().some((c) => c.name === 'status')) control.exec("ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  return control;
};
const q = (sql, ...p) => ctl().prepare(sql).get(...p);
const qa = (sql, ...p) => ctl().prepare(sql).all(...p);
const qr = (sql, ...p) => ctl().prepare(sql).run(...p);

const cache = new Map();
const tenantFile = (slug) => (inMemory() ? ':memory:' : path.join(process.env.FLUXO_TENANTS_DIR || path.join(dataDir, 'tenants'), `${slug}.db`));

export const tenantExists = (slug) => !!(slug && /^[a-z0-9-]+$/.test(slug) && q('SELECT 1 FROM tenants WHERE slug=?', slug));
export const currentSlug = () => als.getStore()?.slug || '';
export const isSuspended = (slug) => q('SELECT status FROM tenants WHERE slug=?', slug)?.status === 'suspended';
export function setStatus(slug, status) {
  if (!tenantExists(slug)) return false;
  qr('UPDATE tenants SET status=? WHERE slug=?', status === 'suspended' ? 'suspended' : 'active', slug);
  return true;
}
export const listTenants = () => qa('SELECT slug,name,owner_email,status,created_at FROM tenants ORDER BY created_at DESC');
export const allSlugs = () => qa('SELECT slug FROM tenants ORDER BY created_at').map((r) => r.slug);

function openTenant(slug) {
  if (!cache.has(slug)) cache.set(slug, openDb(tenantFile(slug)));
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

/** Cria a empresa (arquivo novo + índice). Quem chama termina a configuração dentro de inTenant(). */
export function createTenant({ name, ownerEmail }) {
  const email = String(ownerEmail).trim().toLowerCase();
  if (slugForEmail(email)) return null;
  const slug = uniqueSlug(name);
  qr('INSERT INTO tenants(slug,name,owner_email) VALUES(?,?,?)', slug, name || '', email);
  registerEmail(email, slug);
  openTenant(slug);
  return slug;
}
/** Desfaz uma empresa cuja configuração inicial falhou. */
export function dropTenant(slug) {
  qr('DELETE FROM links WHERE slug=?', slug); qr('DELETE FROM identities WHERE slug=?', slug); qr('DELETE FROM tenants WHERE slug=?', slug);
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
