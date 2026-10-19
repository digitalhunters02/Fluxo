// Backup de todos os bancos e RESTAURAÇÃO de verdade: os dados voltam iguais, o arquivo adulterado é recusado, /healthz é útil.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-backup-test-'));
const data = path.join(root, 'data'), bk = path.join(root, 'bk');
Object.assign(process.env, { FLUXO_DB: path.join(data, 'fluxo.db'), FLUXO_MULTI: '1', FLUXO_ENCRYPTION_KEY: 'chave-de-teste-1', FLUXO_BACKUP_DIR: bk, APP_URL: 'https://app.fluxo.test', FLUXO_ADMIN_EMAIL: 'root@fluxo.test', FLUXO_ADMIN_PASSWORD: 'uma-senha-bem-longa-123' });
delete process.env.FLUXO_BACKUP_DAILY;
const here = path.dirname(fileURLToPath(import.meta.url)), srv = path.join(here, '..', 'src');
const backup = await import('../src/backup.js');
const core = await import('../src/backupCore.js');
const tenants = await import('../src/tenants.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const toks = {};
let archive, manifest;

test('preparo: duas empresas com clientes (um com SSN cifrado) e faturas', async () => {
  for (const [k, name, email] of [['a', 'Alfa Ltda', 'a@alfa.test'], ['b', 'Beta Inc', 'b@beta.test']]) {
    const r = await call('/setup', 'POST', { company_name: name, name: k, email, password: 'senha1234', lang: 'pt' });
    assert.equal(r.status, 200); toks[k] = r.body.token;
  }
  const c = await call('/contacts', 'POST', { kind: 'vendor', name: 'Fornecedor Secreto', tax_id: '123-45-6789', is_1099: true }, toks.a);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const cu = await call('/contacts', 'POST', { kind: 'customer', name: 'Cliente A' }, toks.a);
  for (let i = 1; i <= 3; i++) assert.equal((await call('/docs/invoice', 'POST', { contact_id: cu.body.id, issue_date: '2026-10-0' + i, due_date: '2026-11-01', post: true, lines: [{ description: `Serviço ${i}`, qty: i, unit_price: 10000 }] }, toks.a)).status, 200);
});

test('/healthz: versão, banco ok, backup e avisos úteis para monitoramento', async () => {
  const r = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  const h = await r.json();
  assert.equal(r.status, 200); assert.equal(h.ok, true); assert.equal(h.db, 'ok'); assert.match(h.version, /^\d+\.\d+\.\d+$/); assert.ok(h.uptime_s >= 0);
  assert.equal(h.backup.enabled, true); assert.equal(h.backup.last_at, null);
  assert.ok(h.warnings.includes('email_not_configured')); assert.equal(h.email, 'not_configured');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('backup: um .zip com manifesto, integridade ok e contagens de cada banco (a chave de criptografia não vai junto)', () => {
  const r = backup.runBackup({ now: new Date('2026-10-19T12:00:00Z') });
  archive = r.file; manifest = r.manifest;
  assert.match(path.basename(archive), /^fluxo-backup-20261019-1200\.zip$/);
  assert.deepEqual(manifest.files.map((f) => f.name).sort(), ['control.db', 'main.db', 'tenants/alfa-ltda.db', 'tenants/beta-inc.db']);
  assert.ok(manifest.files.every((f) => f.integrity === 'ok' && /^[0-9a-f]{64}$/.test(f.sha256) && /^[0-9a-f]{64}$/.test(f.content_sha256)));
  const alfa = manifest.files.find((f) => f.name === 'tenants/alfa-ltda.db');
  assert.equal(alfa.counts.docs, 3); assert.equal(alfa.counts.contacts, 2);
  assert.equal(manifest.files.find((f) => f.name === 'control.db').counts.tenants, 2);
  const raw = fs.readFileSync(archive); assert.equal(raw.includes(Buffer.from('chave-de-teste-1')), false);
  assert.equal(manifest.encryption_key.length, 12); assert.notEqual(manifest.encryption_key, 'chave-de-teste-1');
  assert.equal(fs.statSync(archive).mode & 0o077, 0);                                                   // só o dono do servidor lê
});

test('restaurar numa pasta nova devolve os MESMOS dados (conteúdo de todas as tabelas confere com o do momento do backup)', async () => {
  // depois do backup, os dados "originais" são estragados: apaga faturas, cria empresa, muda senha
  await call('/setup', 'POST', { company_name: 'Gama SA', name: 'g', email: 'g@gama.test', password: 'senha1234', lang: 'en' });
  tenants.inTenant('alfa-ltda', () => { /* apaga de verdade no arquivo vivo */ });
  const { run } = await import('../src/db.js');
  tenants.inTenant('alfa-ltda', () => { run('DELETE FROM payments'); run('DELETE FROM doc_lines'); run('DELETE FROM journal_lines'); run('DELETE FROM journal_entries'); run('DELETE FROM docs'); });
  const live = backup.describeDb(tenants.tenantFile('alfa-ltda'));
  assert.equal(live.counts.docs, 0);                                                                     // o "desastre" aconteceu
  const to = path.join(root, 'restored');
  const res = core.restoreBackup(archive, to);
  assert.equal(res.ok, true); assert.equal(res.keyMatches, true);
  for (const f of manifest.files) {
    const file = f.name === 'main.db' ? path.join(to, 'fluxo.db') : f.name === 'control.db' ? path.join(to, 'control.db') : path.join(to, f.name);
    const d = backup.describeDb(file);
    assert.equal(d.content_sha256, f.content_sha256, `${f.name}: conteúdo idêntico ao do backup`);
    assert.deepEqual(d.counts, f.counts);
  }
  assert.equal(backup.describeDb(path.join(to, 'tenants', 'alfa-ltda.db')).counts.docs, 3);               // as 3 faturas voltaram
  assert.equal(fs.existsSync(path.join(to, 'tenants', 'gama-sa.db')), false);                           // a empresa criada depois do backup não existia
});

test('o servidor sobe com os dados restaurados: login funciona, faturas e SSN cifrado voltam (mesma chave)', async () => {
  const to = path.join(root, 'restored');
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn(process.execPath, ['--no-warnings', path.join(srv, 'index.js')], { env: { ...process.env, PORT: String(port), FLUXO_DB: path.join(to, 'fluxo.db'), FLUXO_BACKUP_DIR: path.join(root, 'bk2') }, stdio: 'ignore' });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.ok(up, 'servidor restaurado subiu');
    const call2 = async (p, method = 'GET', body, tk = '') => { const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
    const login = await call2('/login', 'POST', { email: 'a@alfa.test', password: 'senha1234' });
    assert.equal(login.status, 200);
    const invoices = await call2('/docs/invoice', 'GET', undefined, login.body.token);
    assert.equal(invoices.body.length, 3); assert.deepEqual(invoices.body.map((i) => i.total).sort((a, b) => a - b), [10000, 20000, 30000]);
    const vendors = await call2('/contacts?kind=vendor', 'GET', undefined, login.body.token);
    const v = (Array.isArray(vendors.body) ? vendors.body : vendors.body.contacts || []).find((x) => x.name === 'Fornecedor Secreto');
    assert.ok(v, 'fornecedor voltou');
    const reveal = await call2(`/contacts/${v.id}/tax-id`, 'GET', undefined, login.body.token);
    assert.equal(reveal.body.tax_id, '123-45-6789');                                    // o SSN cifrado abre com a mesma chave
    assert.equal((await call2('/login', 'POST', { email: 'g@gama.test', password: 'senha1234' })).status, 401);   // quem se cadastrou depois do backup não existe aqui
  } finally { child.kill(); }
});

test('segurança do restore: arquivo adulterado é recusado; não sobrescreve sem --force; com --force guarda o antigo', () => {
  const bad = path.join(root, 'adulterado.zip'), raw = Buffer.from(fs.readFileSync(archive));
  raw[Math.floor(raw.length / 2)] ^= 0xff; fs.writeFileSync(bad, raw);
  assert.throws(() => core.readArchive(bad), /damaged|checksum|valid|inflate|incorrect|invalid/i);
  assert.throws(() => core.restoreBackup(archive, path.join(root, 'restored')), /already data/);
  const r = core.restoreBackup(archive, path.join(root, 'restored'), { force: true });
  assert.equal(r.ok, true); assert.match(r.savedTo, /_before-restore-/); assert.ok(fs.existsSync(path.join(r.savedTo, 'control.db')));
  assert.throws(() => core.readArchive(path.join(root, 'restored', 'fluxo.db')), /not a valid backup/);
});

test('rodízio: guarda só os N mais novos; no máximo um backup por dia na rotina automática', () => {
  const dir = path.join(root, 'rot');
  for (const day of ['20', '21', '22', '23']) backup.runBackup({ dir, keep: 2, now: new Date(`2026-10-${day}T03:00:00Z`) });
  assert.deepEqual(backup.listBackups(dir).map((f) => f.name), ['fluxo-backup-20261023-0300.zip', 'fluxo-backup-20261022-0300.zip']);
  assert.equal(backup.runIfDue(new Date('2026-10-19T20:00:00Z')), null);                                // já houve um em 19/10 na pasta padrão
  assert.ok(backup.runIfDue(new Date('2026-10-20T01:00:00Z')));                                         // dia seguinte: faz
  assert.equal(backup.runIfDue(new Date('2026-10-20T09:00:00Z')), null);
});

test('comando (CLI): backup, verify e restore, com mensagens em português', () => {
  const env = { ...process.env, FLUXO_CLI_LANG: 'pt' }, cli = path.join(srv, 'backupCli.js'), run = (...a) => spawnSync(process.execPath, ['--no-warnings', cli, ...a], { env, encoding: 'utf8' });
  const b = run('backup', '--dir', path.join(root, 'cli'), '--keep', '3');
  assert.equal(b.status, 0, b.stderr); assert.match(b.stdout, /Backup salvo: .*fluxo-backup-\d{8}-\d{4}\.zip/);
  const file = b.stdout.match(/salvo: (\S+\.zip)/)[1];
  const v = run('verify', file); assert.equal(v.status, 0); assert.match(v.stdout, /O backup está íntegro/);
  const r = run('restore', file, '--to', path.join(root, 'cli-restored')); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /idêntico/);
  assert.equal(fs.existsSync(path.join(root, 'cli-restored', 'fluxo.db')), true);
  const again = run('restore', file, '--to', path.join(root, 'cli-restored')); assert.equal(again.status, 1); assert.match(again.stderr, /--force/);
  const wrongKey = spawnSync(process.execPath, ['--no-warnings', cli, 'verify', file], { env: { ...env, FLUXO_ENCRYPTION_KEY: 'outra-chave' }, encoding: 'utf8' });
  assert.match(wrongKey.stdout, /ATENÇÃO: a chave de criptografia/);                                     // avisa se a chave de agora é outra
});

test('painel do administrador lista e roda backups; sem login nada passa', async () => {
  assert.equal((await call('/admin/backups')).status, 401);
  const tk = (await call('/admin/login', 'POST', { email: 'root@fluxo.test', password: 'uma-senha-bem-longa-123' })).body.token;
  const run = await call('/admin/backups/run', 'POST', {}, tk);
  assert.equal(run.status, 200); assert.equal(run.body.databases, 5); assert.match(run.body.name, /^fluxo-backup-/);
  const list = await call('/admin/backups', 'GET', undefined, tk);
  assert.equal(list.body.enabled, true); assert.ok(list.body.files.length >= 1);
  const h = await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`)).json();
  assert.ok(h.backup.last_at); assert.ok(h.backup.age_hours <= 1); assert.equal(h.warnings.includes('backup_stale'), false);
});
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
