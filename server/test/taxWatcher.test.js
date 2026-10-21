// Vigia das tabelas do IRS/SSA (busca simulada): detecta mudança, mostra a faixa, manda e-mail e cria UMA tarefa no Harbor; nunca muda imposto.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
process.env.OWNER_EMAILS = 'boss@impact.test';
const mailer = await import('../src/mailer.js');
const w = await import('../src/taxWatcher.js');
const pay = await import('../src/payroll.js');

const mails = [];
mailer.setTransport(async (m) => { mails.push(m); });
let pages = { irs: 'p15t v1', ssa: 'cbb v1' };
let harborCalls = [];
let harborMode = 'ok'; // ok | dup | down
const fetchImpl = async (url, opts = {}) => {
  if (url.includes('/api/public/product-alerts')) {
    harborCalls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) });
    if (harborMode === 'down') throw new Error('ECONNREFUSED');
    if (harborMode === 'dup') return new Response(JSON.stringify({ duplicate: true }), { status: 200 });
    return new Response('{}', { status: 201 });
  }
  const body = url.includes('irs') ? pages.irs : pages.ssa;
  return new Response(body, { status: 200, headers: { 'last-modified': 'Tue, 01 Oct 2026 00:00:00 GMT' } });
};
const OCT = new Date('2026-10-21T12:00:00Z');

test('Harbor desligado (sem HARBOR_API_URL): pula em silêncio', async () => {
  delete process.env.HARBOR_API_URL;
  assert.equal(await w.harborAlert({ title: 't', dedupeKey: 'k' }, { fetchImpl }), 'skipped');
  assert.equal(harborCalls.length, 0);
});

test('primeira verificação só guarda a referência; sem faixa enquanto nada muda', async () => {
  process.env.HARBOR_API_URL = 'https://harbor.test/';
  process.env.ADMIN_SUMMARY_KEY = 'secret-key';
  const s = await w.checkNow({ fetchImpl, now: OCT });
  assert.equal(s.banner, null); assert.ok(s.urls.irs.hash && s.urls.ssa.hash);
  assert.equal(harborCalls.length, 0); assert.equal(mails.length, 0);
});

test('página do IRS mudou em outubro: faixa de 2027, e-mail ao dono e uma tarefa no Harbor (com dedupe)', async () => {
  pages.irs = 'p15t v2 (2027)';
  const s = await w.checkNow({ fetchImpl, now: OCT });
  assert.deepEqual(s.banner, { year: 2027, reason: 'published', sources: ['irs'] });
  assert.equal(harborCalls.length, 1);
  const h = harborCalls[0];
  assert.equal(h.url, 'https://harbor.test/api/public/product-alerts'); assert.equal(h.headers['X-Product-Key'], 'secret-key');
  assert.equal(h.body.dedupeKey, 'fluxo-irs-tables-2027'); assert.match(h.body.title, /IRS publicou as tabelas de 2027/); assert.equal(h.body.dueAt, '2026-12-15');
  assert.ok(!JSON.stringify(h.body).includes('@'), 'nenhum dado de cliente');
  assert.equal(mails.length, 1); assert.equal(mails[0].to, 'boss@impact.test'); assert.match(mails[0].text, /New IRS tables published for 2027/);
  // de novo: não manda outra vez
  await w.checkNow({ fetchImpl, now: new Date('2026-10-22T12:00:00Z') });
  assert.equal(harborCalls.length, 1); assert.equal(mails.length, 1);
  assert.deepEqual(Object.keys(pay.TABLES), ['2026'], 'nunca muda tabela sozinho');
});

test('SSA mudou com o Harbor fora do ar: não trava o vigia, tenta 4 vezes e tenta de novo na próxima', async () => {
  pages.ssa = 'cbb v2';
  harborMode = 'down';
  const before = harborCalls.length;
  const s = await w.checkNow({ fetchImpl, now: new Date('2026-12-20T12:00:00Z'), backoffMs: 1 });
  assert.deepEqual(s.banner.sources.sort(), ['irs', 'ssa']);
  assert.equal(harborCalls.length - before, 4); // 1 + 3 novas tentativas
  assert.equal(harborCalls.at(-1).body.dedupeKey, 'fluxo-ssa-wagebase-2027');
  assert.equal(harborCalls.at(-1).body.dueAt, '2026-12-23'); // 15/dez já passou: hoje + 3 dias
  harborMode = 'dup';
  await w.checkNow({ fetchImpl, now: new Date('2026-12-21T12:00:00Z'), backoffMs: 1 });
  assert.equal(harborCalls.at(-1).body.dedupeKey, 'fluxo-ssa-wagebase-2027');
  const n = harborCalls.length;
  await w.checkNow({ fetchImpl, now: new Date('2026-12-22T12:00:00Z'), backoffMs: 1 });
  assert.equal(harborCalls.length, n, 'duplicado no Harbor conta como entregue');
});

test('janeiro sem tabela do ano: faixa "missing" e tarefa fluxo-missing-table-2027', async () => {
  harborMode = 'ok';
  const s = await w.checkNow({ fetchImpl, now: new Date('2027-01-04T12:00:00Z'), backoffMs: 1 });
  assert.deepEqual(s.banner, { year: 2027, reason: 'missing' });
  assert.ok(harborCalls.some((c) => c.body.dedupeKey === 'fluxo-missing-table-2027'));
});

test('agenda: só de outubro a janeiro e uma vez por dia', async () => {
  assert.equal(w.inSeason(new Date('2026-07-01T00:00:00Z')), false); assert.equal(w.inSeason(new Date('2027-01-10T00:00:00Z')), true);
  assert.equal(await w.scheduledCheck({ fetchImpl, now: new Date('2026-07-01T12:00:00Z') }), null);
  assert.equal(await w.scheduledCheck({ fetchImpl, now: new Date('2027-01-04T18:00:00Z') }), null); // já rodou hoje
  assert.ok(await w.scheduledCheck({ fetchImpl, now: new Date('2027-01-05T09:00:00Z') }));
  assert.equal(w.harborDue(2027, new Date('2026-10-01T00:00:00Z')), '2026-12-15');
});

test('Harbor: 401 não repete; erro de rede nunca lança', async () => {
  const f401 = async () => new Response('{}', { status: 401 });
  let calls = 0; const counting = async (...a) => { calls += 1; return f401(...a); };
  assert.equal(await w.harborAlert({ title: 't', dedupeKey: 'x' }, { fetchImpl: counting, backoffMs: 1 }), 'failed'); assert.equal(calls, 1);
  assert.equal(await w.harborAlert({ title: 't', dedupeKey: 'x' }, { fetchImpl: async () => { throw new Error('boom'); }, backoffMs: 1, retries: 1 }), 'failed');
});
