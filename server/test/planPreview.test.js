// Selo de plano + "ver como plano" do dono: o servidor diz qual o plano mínimo de cada recurso e se o plano EM VIGOR libera;
// o dono (OWNER_EMAILS) pode ver o produto como qualquer plano pelo cabeçalho X-Preview-Plan sem mudar a conta e sem cobrar.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
process.env.OWNER_EMAILS = 'Dono@Example.test, outro@example.test';
const plans = await import('../src/plans.js');
const { isPlatformOwner } = await import('../src/owner.js');
const { app } = await import('../src/index.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(() => server.close());
const call = async (path, { method = 'GET', body, token = '', preview = '' } = {}) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(preview ? { 'x-preview-plan': preview } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const ORDER = ['free', 'starter', 'essentials', 'plus', 'advanced', 'business', 'enterprise'];

test('mapa recurso -> plano mínimo vem de FEATURES e cada recurso entra em exatamente um plano', () => {
  const g = plans.publicGates();
  for (const [f, min] of Object.entries(plans.FEATURES)) assert.equal(g[f].minPlan, min, f);
  assert.equal(g.unlimited_invoices.minPlan, 'starter');
  assert.equal(g.photo_import.minPlan, 'essentials');
  assert.equal(g.payroll.minPlan, null);          // folha é complemento, não plano
  assert.equal(g.payroll.addon, 'payroll');
  const cat = plans.publicCatalog();
  assert.deepEqual(cat.map((p) => p.key), ORDER);
  assert.deepEqual(cat[0].adds, []);
  const all = cat.flatMap((p) => p.adds).sort();
  assert.deepEqual(all, Object.keys({ ...plans.FEATURES, ...plans.EXTRA_GATES }).sort(), 'todo recurso com selo entra em um plano');
  for (const p of cat) for (const gate of p.adds) assert.equal(g[gate].minPlan, p.key, `${gate} entra em ${p.key}`);
  assert.deepEqual(cat.map((p) => p.price.month), [0, 29, 65, 109, 269, 599, 900]);
});

test('nenhum recurso de plano fica bloqueado no plano mais alto e o número de bloqueios cresce ao descer', () => {
  const lockedAt = (plan) => Object.entries(plans.publicGates(plan)).filter(([k, v]) => v.locked && !v.addon).map(([k]) => k);
  assert.deepEqual(lockedAt('enterprise'), []);
  let last = -1;
  for (const p of [...ORDER].reverse()) { const n = lockedAt(p).length; assert.ok(n >= last, p); last = n; }
  assert.ok(lockedAt('free').includes('bills'));
  assert.ok(!lockedAt('essentials').includes('bills'));
});

test('só dono de verdade: e-mail da lista + confirmado + papel de dono', () => {
  assert.equal(isPlatformOwner({ role: 'owner', email: 'dono@example.test', email_verified_at: '2026-01-01' }), true);
  assert.equal(isPlatformOwner({ role: 'owner', email: 'dono@example.test', email_verified_at: null }), false, 'cadastro sem confirmar o e-mail');
  assert.equal(isPlatformOwner({ role: 'accountant', email: 'dono@example.test', email_verified_at: '2026-01-01' }), false);
  assert.equal(isPlatformOwner({ role: 'owner', email: 'outra@example.test', email_verified_at: '2026-01-01' }), false);
});

test('/public/plans traz catálogo, mapa e complemento para a página de preços', async () => {
  const r = await call('/public/plans');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.catalog.map((p) => p.key), ORDER);
  assert.equal(r.body.gates.bills.minPlan, 'essentials');
  assert.equal(r.body.gates.bills.locked, undefined, 'a página pública não sabe o plano de ninguém');
  assert.equal(r.body.addons.payroll.price.month, 35);
});

let owner = '', common = '', cpa = '';
test('dono vê o produto como cada plano sem mudar a conta', async () => {
  const s = await call('/setup', { method: 'POST', body: { name: 'Dono', email: 'dono@example.test', password: 'senha1234', plan: 'enterprise', lang: 'en' } });
  assert.equal(s.status, 200); owner = s.body.token;
  const mine = await call('/me', { token: owner });
  assert.equal(mine.body.owner, true); assert.equal(mine.body.previewPlan, null);
  assert.equal(mine.body.planInfo.plan, 'enterprise');
  assert.ok(Object.entries(mine.body.gates).every(([, v]) => !v.locked), 'plano mais alto + folha ligada: nenhum selo');

  for (const plan of ORDER) {
    const v = await call('/me', { token: owner, preview: plan });
    assert.equal(v.body.previewPlan, plan, plan);
    assert.equal(v.body.planInfo.plan, plan);
    for (const [gate, info] of Object.entries(v.body.gates)) {
      if (info.addon) assert.equal(info.locked, true, 'sem complemento na prévia'); // o cliente do plano visto não tem a folha
      else assert.equal(info.locked, ORDER.indexOf(plan) < ORDER.indexOf(info.minPlan), `${plan}/${gate}`);
    }
    assert.equal(v.body.planInfo.features.bills, ORDER.indexOf(plan) >= ORDER.indexOf('essentials'));
  }
  // limites seguem o plano visto
  const free = await call('/me', { token: owner, preview: 'free' });
  assert.equal(free.body.planInfo.limits.invoices_per_month, 5);
  assert.equal(free.body.planInfo.limits.users, 1);
  // a conta de verdade não mudou
  const after = await call('/plan', { token: owner });
  assert.equal(after.body.plan, 'enterprise'); assert.equal(after.body.payroll, true);
});

test('na prévia, as rotas travadas respondem como para o cliente do plano e a conta fica intacta', async () => {
  assert.equal((await call('/docs/bill', { token: owner })).status, 200);
  const r = await call('/docs/bill', { token: owner, preview: 'free' });
  assert.equal(r.status, 402); assert.equal(r.body.feature, 'bills'); assert.equal(r.body.required, 'essentials');
  assert.equal((await call('/docs/bill', { token: owner, preview: 'essentials' })).status, 200);
  assert.equal((await call('/payroll/employees', { token: owner })).status, 200);
  assert.equal((await call('/payroll/employees', { token: owner, preview: 'enterprise' })).status, 402, 'folha é complemento: o cliente de Enterprise sem complemento não tem');
  assert.equal((await call('/docs/bill', { token: owner })).status, 200, 'sem o cabeçalho, volta ao normal');
});

test('na prévia, plano e cobrança não mudam (409) e nada é gravado', async () => {
  for (const [path, method, body] of [['/plan', 'PUT', { plan: 'free' }], ['/billing/checkout', 'POST', { plan: 'plus' }], ['/billing/change', 'POST', { plan: 'plus' }], ['/billing/portal', 'POST', {}]]) {
    const r = await call(path, { method, body, token: owner, preview: 'starter' });
    assert.equal(r.status, 409, path); assert.equal(r.body.code, 'preview_readonly');
  }
  assert.equal((await call('/plan', { token: owner })).body.plan, 'enterprise');
});

test('quem não é dono: o cabeçalho é ignorado (comum e contador, mesmo com e-mail da lista)', async () => {
  const mk = async (email, role) => (await call('/users', { method: 'POST', token: owner, body: { name: 'U', email, password: 'senha1234', role } }));
  assert.equal((await mk('comum@example.test', 'sales')).status, 200);
  assert.equal((await mk('outro@example.test', 'accountant')).status, 200);   // e-mail da lista, mas não é dono da empresa
  common = (await call('/login', { method: 'POST', body: { email: 'comum@example.test', password: 'senha1234' } })).body.token;
  cpa = (await call('/login', { method: 'POST', body: { email: 'outro@example.test', password: 'senha1234' } })).body.token;
  for (const tk of [common, cpa]) {
    const me = await call('/me', { token: tk, preview: 'free' });
    assert.equal(me.body.owner, false); assert.equal(me.body.previewPlan, null);
    assert.equal(me.body.planInfo.plan, 'enterprise', 'ignorou o cabeçalho');
    assert.ok(Object.entries(me.body.gates).filter(([, v]) => !v.addon).every(([, v]) => !v.locked));
  }
  // cabeçalho inválido do dono também é ignorado
  const bad = await call('/me', { token: owner, preview: 'ouro' });
  assert.equal(bad.body.previewPlan, null); assert.equal(bad.body.planInfo.plan, 'enterprise');
});
