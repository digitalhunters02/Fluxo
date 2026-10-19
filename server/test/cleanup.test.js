import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fluxo-cleanup-'));
process.env.FLUXO_DB = ':memory:'; process.env.FLUXO_MULTI = '1'; process.env.APP_URL = 'https://app.fluxo.test'; process.env.FLUXO_BACKUP_DIR = bdir;
const mailer = await import('../src/mailer.js');
const { get, run, getSetting, setSetting } = await import('../src/db.js');
const tenants = await import('../src/tenants.js');
const cleanup = await import('../src/cleanup.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const sent = [];
const later = (days) => new Date(Date.now() + days * 86400000);
const mk = async (company, email, lang = 'pt') => (await call('/setup', 'POST', { company_name: company, name: 'Dono', email, password: 'senha1234', lang })).body.token;
const inT = (slug, fn) => tenants.inTenant(slug, fn);
const states = (r) => Object.fromEntries(r.items.map((i) => [i.slug, i.state]));
let toks = {};

test('preparo: contas de vários tipos', async () => {
  toks.abandoned = await mk('Padaria Parada', 'parada@x.com');
  toks.fiscal = await mk('Tem Dados', 'dados@x.com');
  toks.paid = await mk('Paga Plano', 'paga@x.com');
  toks.sub = await mk('Tem Assinatura', 'sub@x.com');
  toks.active = await mk('Em Uso', 'uso@x.com');
  toks.payroll = await mk('Tem Folha', 'folha@x.com');
  inT('tem-dados', () => { run("INSERT INTO contacts(kind,name) VALUES('customer','C')"); run("INSERT INTO expenses(date,account_id,paid_from_id,amount) VALUES(?,1,1,1000)", new Date().toISOString().slice(0, 10)); });
  inT('paga-plano', () => setSetting('plan', 'plus'));
  inT('tem-assinatura', () => { setSetting('stripe_subscription_id', 'sub_1'); setSetting('subscription_status', 'active'); });
  inT('tem-folha', () => run("INSERT INTO employees(name,hire_date) VALUES('Func','2026-01-01')"));
  inT('em-uso', () => setSetting('last_activity_at', later(40 * 30).toISOString().slice(0, 10)));   // quem usa "hoje" (em qualquer data simulada abaixo) nunca aparece
  assert.equal(tenants.allSlugs().length, 6);
});

test('login e uso gravam a data da última atividade (no máximo 1 gravação por dia)', async () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(inT('padaria-parada', () => getSetting('last_activity_at', '')), today);          // gravado no cadastro (login automático)
  inT('padaria-parada', () => setSetting('last_activity_at', '2020-01-01'));
  await call('/login', 'POST', { email: 'parada@x.com', password: 'senha1234' });
  assert.equal(inT('padaria-parada', () => getSetting('last_activity_at', '')), '2020-01-01');   // mesmo dia já gravado neste processo: não escreve de novo
  const { forgetActivityCache } = await import('../src/activity.js'); forgetActivityCache();
  await call('/login', 'POST', { email: 'parada@x.com', password: 'senha1234' });
  assert.equal(inT('padaria-parada', () => getSetting('last_activity_at', '')), today);
  inT('padaria-parada', () => setSetting('last_activity_at', ''));
});

test('sem e-mail configurado nada é avisado nem apagado', async () => {
  const when = later(14 * 30);
  const r = await cleanup.runCleanup({ now: when });
  assert.deepEqual(states(r), { 'padaria-parada': 'blocked_no_email' });
  assert.equal((await cleanup.runCleanup({ now: later(14 * 30 + 90) })).items.every((i) => i.state === 'blocked_no_email'), true);
  assert.equal(tenants.cleanupWarning('padaria-parada'), null);
  assert.equal(tenants.tenantExists('padaria-parada'), true);
});

test('só a conta Free parada, sem assinatura, folha nem dados fiscais recentes é candidata; a prévia não envia nada', async () => {
  mailer.setTransport(async (m) => { sent.push(m); });
  const dry = await cleanup.runCleanup({ dryRun: true, now: later(14 * 30) });
  assert.deepEqual(states(dry), { 'padaria-parada': 'would_warn' });
  assert.equal(sent.length, 0); assert.equal(tenants.cleanupWarning('padaria-parada'), null);
  // com os dados fiscais já "velhos" (mais de 24 meses), a conta com dados também vira candidata
  const far = await cleanup.runCleanup({ dryRun: true, now: later(27 * 30) });
  assert.equal(states(far)['tem-dados'], 'would_warn');
  assert.equal(states(far)['paga-plano'], undefined); assert.equal(states(far)['tem-assinatura'], undefined); assert.equal(states(far)['tem-folha'], undefined);
});

test('aviso por e-mail com prazo de 30 dias; segunda rodada só espera', async () => {
  const when = later(14 * 30);
  const r = await cleanup.runCleanup({ now: when });
  assert.deepEqual(states(r), { 'padaria-parada': 'warned' });
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'parada@x.com');
  assert.match(sent[0].subject, /será apagada em \d{4}-\d{2}-\d{2}/); assert.match(sent[0].text, /Padaria Parada/); assert.match(sent[0].text, /https:\/\/app\.fluxo\.test/);
  const w = tenants.cleanupWarning('padaria-parada');
  assert.equal(Math.round((new Date(w.delete_after) - new Date(w.warned_at)) / 86400000), 30);
  assert.equal(states(await cleanup.runCleanup({ now: later(14 * 30 + 10) }))['padaria-parada'], 'waiting');
  assert.equal(sent.length, 1);                                                                         // não repete o aviso
  assert.equal(tenants.tenantExists('padaria-parada'), true);
});

test('falha ao enviar o aviso: nada é apagado e a próxima rodada tenta de novo', async () => {
  toks.flaky = await mk('Falha Aviso', 'falha@x.com', 'en');
  mailer.setTransport(async () => { throw new Error('smtp down'); });
  const r = await cleanup.runCleanup({ now: later(14 * 30) });
  assert.equal(states(r)['falha-aviso'], 'warn_failed'); assert.equal(tenants.cleanupWarning('falha-aviso'), null);
  assert.equal((await cleanup.runCleanup({ now: later(14 * 30 + 5) })).items.find((i) => i.slug === 'falha-aviso').state, 'warn_failed');   // sem aviso, nunca apaga
  mailer.setTransport(async (m) => { sent.push(m); });
  assert.equal(states(await cleanup.runCleanup({ now: later(14 * 30) }))['falha-aviso'], 'warned');   // voltou o e-mail: agora o aviso sai
  assert.equal(tenants.tenantExists('falha-aviso'), true);
});

test('voltou a usar durante o prazo: o aviso é cancelado e a conta fica', async () => {
  await call('/login', 'POST', { email: 'falha@x.com', password: 'senha1234' });                      // volta a entrar (hoje real)
  inT('falha-aviso', () => setSetting('last_activity_at', later(14 * 30 + 15).toISOString().slice(0, 10)));
  const r = await cleanup.runCleanup({ now: later(14 * 30 + 20) });
  assert.equal(states(r)['falha-aviso'], 'cancelled'); assert.equal(tenants.tenantExists('falha-aviso'), true);
});

test('passado o prazo sem uso: apaga, registra o que foi apagado e libera o e-mail', async () => {
  fs.mkdirSync(path.join(bdir, 'padaria-parada'), { recursive: true }); fs.writeFileSync(path.join(bdir, 'padaria-parada', 'fluxo-2026-01-01.json'), '{}');
  const r = await cleanup.runCleanup({ now: later(14 * 30 + 31) });
  assert.equal(states(r)['padaria-parada'], 'deleted');
  assert.equal(tenants.tenantExists('padaria-parada'), false); assert.equal(tenants.slugForEmail('parada@x.com'), null);
  assert.equal(fs.existsSync(path.join(bdir, 'padaria-parada')), false);                              // a cópia em arquivo também sai
  assert.equal((await call('/login', 'POST', { email: 'parada@x.com', password: 'senha1234' })).status, 401);
  const log = tenants.cleanupLog();
  assert.equal(log.length, 1); assert.equal(log[0].slug, 'padaria-parada'); assert.equal(log[0].company, 'Padaria Parada');
  assert.equal(log[0].email_masked, 'p***@x.com'); assert.match(log[0].email_hash, /^[0-9a-f]{16}$/); assert.equal(log[0].counts.users, 1); assert.match(log[0].reason, /idle 12 months/);
  assert.equal(JSON.stringify(log).includes('parada@x.com'), false);                                  // o registro não guarda o e-mail inteiro
  for (const s of ['tem-dados', 'paga-plano', 'tem-assinatura', 'em-uso', 'tem-folha']) assert.equal(tenants.tenantExists(s), true, s);
  assert.equal(tenants.cleanupWarning('padaria-parada'), null);
});

test('conta em grupo de empresas e conta suspensa nunca são candidatas', async () => {
  toks.g = await mk('Grupo Um', 'g1@x.com'); toks.s = await mk('Suspensa', 's@x.com');
  tenants.createGroup('G', 'grupo-um'); tenants.setStatus('suspensa', 'suspended');
  const r = await cleanup.runCleanup({ dryRun: true, now: later(14 * 30) });
  assert.equal(states(r)['grupo-um'], undefined); assert.equal(states(r)['suspensa'], undefined);
});

test('painel do administrador: prévia, rodar agora e histórico (só com login de administrador)', async () => {
  assert.equal((await call('/admin/cleanup')).status, 404);                                          // sem FLUXO_ADMIN_* o painel nem existe
  process.env.FLUXO_ADMIN_EMAIL = 'root@fluxo.test'; process.env.FLUXO_ADMIN_PASSWORD = 'uma-senha-bem-longa-123';
  assert.equal((await call('/admin/cleanup')).status, 401);
  const tk = (await call('/admin/login', 'POST', { email: 'root@fluxo.test', password: 'uma-senha-bem-longa-123' })).body.token;
  const o = await call('/admin/cleanup', 'GET', undefined, tk);
  assert.equal(o.status, 200); assert.equal(o.body.enabled, false); assert.equal(o.body.mailReady, true); assert.equal(o.body.log.length, 1);
  assert.deepEqual(o.body.config, { idleMonths: 12, graceDays: 30, fiscalMonths: 24 });
  const run_ = await call('/admin/cleanup/run', 'POST', { dryRun: true }, tk);
  assert.equal(run_.status, 200); assert.equal(run_.body.dryRun, true);
  assert.equal((await call('/admin/cleanup/run', 'POST', {}, toks.active)).status, 401);             // cliente comum não roda a limpeza
});

test('rotina diária: desligada por padrão; ligada, roda uma vez por dia', async () => {
  assert.equal(await cleanup.runDaily(later(14 * 30)), null);                                        // FLUXO_CLEANUP não está ligado
  process.env.FLUXO_CLEANUP = '1';
  const a = await cleanup.runDaily(later(14 * 30));
  assert.ok(a && Array.isArray(a.items));
  assert.equal(await cleanup.runDaily(later(14 * 30)), null);                                        // mesmo dia: não repete
  delete process.env.FLUXO_CLEANUP;
});
test.after(() => { server.close(); fs.rmSync(bdir, { recursive: true, force: true }); void get; });
