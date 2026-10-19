// Parte de backup.js que NÃO abre nenhum banco do servidor: ler, verificar e restaurar um .zip de backup.
// (O comando de restauração usa só este arquivo; assim ele nunca cria um banco vazio na pasta de dados antes de restaurar.)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const FORMAT = 'fluxo-backup-1';
const env = () => process.env;
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')); } catch { return {}; } })();
export const version = () => pkg.version || '0.0.0';
const NAME_OK = /^(main\.db|control\.db|tenants\/[a-z0-9-]+\.db)$/;
export const keyFingerprint = () => (env().FLUXO_ENCRYPTION_KEY ? sha256(`fluxo-key-check|${env().FLUXO_ENCRYPTION_KEY}`).slice(0, 12) : 'in-database');
export const stamp = (d) => d.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-'); // 20261019-1530

/* ------------------------------- conteúdo de um banco ------------------------------- */
const jsonRow = (r) => JSON.stringify(r, (_k, v) => (v instanceof Uint8Array ? `0x${Buffer.from(v).toString('hex')}` : typeof v === 'bigint' ? `${v}n` : v));
/** Resumo do que há num arquivo SQLite: integridade, contagens e um hash de TODAS as linhas de TODAS as tabelas. */
export function describeDb(file) {
  const d = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = d.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join(',');
    const names = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const h = crypto.createHash('sha256'), rows = {};
    for (const t of names) {
      let list;
      try { list = d.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all(); } catch { list = d.prepare(`SELECT * FROM "${t}"`).all(); }
      rows[t] = list.length; h.update(`#${t}\n`);
      for (const r of list) h.update(`${jsonRow(r)}\n`);
    }
    const pick = ['tenants', 'users', 'contacts', 'docs', 'expenses', 'journal_entries'];
    return { integrity, tables: names.length, counts: Object.fromEntries(pick.filter((t) => t in rows).map((t) => [t, rows[t]])), content_sha256: h.digest('hex') };
  } finally { d.close(); }
}

/* ------------------------------- ler / verificar / restaurar ------------------------------- */
/** Lê um .zip feito por zip() (entradas guardadas ou comprimidas com deflate). */
export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('This file is not a valid backup (zip).');
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The backup file is damaged.');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), raw = buf.subarray(start, start + csize);
    out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
/** Abre o arquivo e confere o manifesto e o SHA-256 de cada banco. Lança erro se algo não bater. */
export function readArchive(archive) {
  const entries = unzip(fs.readFileSync(archive));
  if (!entries.has('manifest.json')) throw new Error('This file is not a Fluxo backup (no manifest).');
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  if (manifest.format !== FORMAT) throw new Error(`Unknown backup format: ${manifest.format}`);
  for (const f of manifest.files) {
    if (!NAME_OK.test(f.name)) throw new Error(`Unexpected file name in the backup: ${f.name}`);
    const data = entries.get(f.name);
    if (!data) throw new Error(`The backup is missing ${f.name}.`);
    if (sha256(data) !== f.sha256 || data.length !== f.bytes) throw new Error(`The backup is damaged: ${f.name} does not match its checksum.`);
  }
  return { manifest, entries };
}
const withTemp = (name, data, fn) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-verify-')); const f = path.join(dir, name.replace('/', '__')); fs.writeFileSync(f, data); try { return fn(f); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };
/** Verifica sem restaurar nada: checksums, integridade e conteúdo de cada banco comparados ao manifesto. */
export function verifyBackup(archive) {
  const { manifest, entries } = readArchive(archive);
  const files = manifest.files.map((f) => { const d = withTemp(f.name, entries.get(f.name), describeDb); return { name: f.name, ok: d.integrity === 'ok' && d.content_sha256 === f.content_sha256, counts: d.counts }; });
  return { manifest, files, ok: files.every((f) => f.ok), keyMatches: manifest.encryption_key === keyFingerprint() };
}
/**
 * Restaura os bancos de um backup para `to` (a pasta de dados do servidor: /data no Docker). O servidor deve estar PARADO.
 * Se já houver bancos lá, exige force=true e guarda os antigos numa pasta "_antes-da-restauracao-<data>".
 */
export function restoreBackup(archive, to, { force = false } = {}) {
  const { manifest, entries } = readArchive(archive);
  const layout = (name) => (name === 'main.db' ? path.join(to, manifest.main_name || 'fluxo.db') : name === 'control.db' ? path.join(to, manifest.control_name || 'control.db') : path.join(to, name));
  const targets = manifest.files.map((f) => ({ f, dest: layout(f.name) }));
  const existing = targets.filter((x) => fs.existsSync(x.dest));
  if (existing.length && !force) throw new Error(`There is already data in ${to}. Stop the server and run again with --force (the old files are kept in a "before-restore" folder).`);
  fs.mkdirSync(to, { recursive: true });
  let savedTo = '';
  if (existing.length) {
    savedTo = path.join(to, `_before-restore-${stamp(new Date())}`);
    for (const x of existing) { const keep = path.join(savedTo, path.relative(to, x.dest)); fs.mkdirSync(path.dirname(keep), { recursive: true }); for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(x.dest + sfx)) fs.renameSync(x.dest + sfx, keep + sfx); }
  }
  const report = [];
  for (const { f, dest } of targets) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (const sfx of ['-wal', '-shm']) fs.rmSync(dest + sfx, { force: true });
    fs.writeFileSync(`${dest}.part`, entries.get(f.name), { mode: 0o600 });
    fs.renameSync(`${dest}.part`, dest);
    const d = describeDb(dest);                                           // abre o que foi gravado e compara com o que foi guardado no backup
    report.push({ name: f.name, file: dest, ok: d.integrity === 'ok' && d.content_sha256 === f.content_sha256, counts: d.counts });
  }
  return { manifest, report, savedTo, ok: report.every((r) => r.ok), keyMatches: manifest.encryption_key === keyFingerprint() };
}

