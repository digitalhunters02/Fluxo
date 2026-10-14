import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
delete process.env.ANTHROPIC_API_KEY;
const { app } = await import('../src/index.js');
const { get, all, insert, setSetting } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const bank = await import('../src/banking.js');
const ai = await import('../src/aiAssist.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, method = 'GET', body, tk = '') => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const C = (n) => Math.round(n * 100);
const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;

// cliente de mentira: devolve o que cada teste mandar
let reply = null; const sent = [];
const fake = { messages: { create: async (req) => { sent.push(req); const out = typeof reply === 'function' ? reply(req) : reply; return { content: [{ type: 'tool_use', name: req.tool_choice.name, input: out }], usage: { input_tokens: 100, output_tokens: 40 } }; } } };
ai.setClientForTests(fake);

let owner = '';
test('plano: Free e Starter não têm; Essentials tem franquia; sem chave avisa', async () => {
  owner = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'free', lang: 'en', demo: false })).body.token;
  assert.equal((await call('/ai/categorize', 'POST', {}, owner)).status, 402, 'free não tem o recurso');
  await call('/plan', 'PUT', { plan: 'essentials' }, owner);
  const st = (await call('/ai/status', 'GET', undefined, owner)).body;
  assert.deepEqual({ limit: st.limit, used: st.used, enabled: st.enabled, configured: st.configured }, { limit: 30, used: 0, enabled: true, configured: true });
  ai.setClientForTests(null);
  insert('INSERT INTO bank_txns(account_id,date,description,amount,hash) VALUES(?,?,?,?,?)', A('1010'), '2026-06-01', 'x', -100, 'h0');
  const r = await call('/ai/categorize', 'POST', {}, owner);
  assert.equal(r.status, 503); assert.equal(r.body.code, 'ai_not_configured');
  ai.setClientForTests(fake);
});

test('categorizar: só as sem sugestão, valida a conta e a direção, nunca lança sozinho', async () => {
  bank.importTxns(A('1010'), [
    { date: '2026-06-10', description: 'ADOBE SYSTEMS', amount: C(-54.99) },
    { date: '2026-06-11', description: 'CLIENTE PAGOU', amount: C(500) },
    { date: '2026-06-12', description: 'XYZ MISTERIOSO', amount: C(-20) },
    { date: '2026-06-13', description: 'ALUGUEL', amount: C(-900) },
  ]);
  const t = (d) => get('SELECT * FROM bank_txns WHERE description=?', d);
  const { run } = await import('../src/db.js'); run("UPDATE bank_txns SET suggested_account_id=?, suggestion_source='rule' WHERE description='ALUGUEL'", A('6000'));
  const soft = A('6300'), income = A('4100'), expense = A('6700');
  reply = (req) => {
    const data = JSON.parse(req.messages[0].content[0].text.split('\n').slice(1).join('\n'));
    assert.ok(!data.transactions.some((x) => x.description === 'ALUGUEL'), 'quem já tem sugestão por regra nem é enviado');
    assert.ok(!data.accounts.some((a) => a.subtype === 'bank' || a.subtype === 'ar' || a.subtype === 'ap'), 'contas de banco/A-R/A-P não entram');
    return { suggestions: [
      { id: t('ADOBE SYSTEMS').id, account_id: soft, confidence: 'high' },
      { id: t('CLIENTE PAGOU').id, account_id: expense, confidence: 'high' },   // entrada em conta de despesa: descartada
      { id: t('XYZ MISTERIOSO').id, account_id: income, confidence: 'low' },    // baixa confiança: descartada
      { id: t('ALUGUEL').id, account_id: soft, confidence: 'high' },            // já tinha regra: não sobrescreve
      { id: 99999, account_id: soft, confidence: 'high' },                      // id que não foi enviado
    ] };
  };
  const r = await call('/ai/categorize', 'POST', {}, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.suggested, 1); assert.equal(r.body.considered, 4, 'as 3 novas + a de teste anterior, sem a que já tem regra');
  assert.equal(t('ADOBE SYSTEMS').suggested_account_id, soft); assert.equal(t('ADOBE SYSTEMS').suggestion_source, 'ai');
  assert.equal(t('CLIENTE PAGOU').suggested_account_id, null); assert.equal(t('XYZ MISTERIOSO').suggested_account_id, null);
  assert.equal(t('ALUGUEL').suggested_account_id, A('6000'), 'a regra não foi sobrescrita');
  assert.equal(get("SELECT COUNT(*) n FROM journal_entries WHERE memo LIKE '%ADOBE%'").n, 0, 'nada foi lançado');
  assert.equal(r.body.status.used, 1);
  // "aceitar tudo" comum ignora a IA; o botão da IA aceita só a da IA
  const normal = await call('/banking/accept-all', 'POST', {}, owner);
  assert.equal(normal.body.categorized >= 1, true); assert.equal(t('ADOBE SYSTEMS').status, 'pending', 'sugestão da IA não é aceita sem pedir');
  const aiAll = await call('/banking/accept-all', 'POST', { ai: true }, owner);
  assert.equal(aiAll.body.categorized, 1); assert.equal(t('ADOBE SYSTEMS').status, 'categorized');
  // sem nada pendente e sem sugestão, não chama a IA nem gasta uso
  run("UPDATE bank_txns SET status='ignored' WHERE status='pending'");
  reply = () => { throw new Error('não deveria chamar a IA'); };
  const used = ai.aiStatus().used;
  const none = await call('/ai/categorize', 'POST', {}, owner);
  assert.equal(none.status, 200); assert.equal(none.body.considered, 0); assert.equal(ai.aiStatus().used, used);
});

test('cobrança: o valor vem do sistema; texto com outro valor é trocado pelo modelo pronto', async () => {
  const cid = insert('INSERT INTO contacts(kind,name,email) VALUES(?,?,?)', 'customer', 'Acme Roofing', 'a@acme.test');
  setSetting('company_name', 'Impact Digital');
  const d = acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: '2026-01-01', due_date: '2026-01-15', post: true, lines: [{ description: 'Serviço', qty: 1, unit_price: C(1250) }] }, null);
  assert.equal((await call('/ai/collection', 'POST', { doc_id: 99999 }, owner)).status, 404);
  reply = (req) => { assert.match(JSON.stringify(req.system), /friendly/); return { subject: 'Lembrete: fatura ' + d.number, body: `Oi Acme Roofing, a fatura ${d.number} de $1,250.00 venceu em 2026-01-15. Veja: {link}. Obrigado!` }; };
  let r = await call('/ai/collection', 'POST', { doc_id: d.id, lang: 'pt' }, owner);
  assert.equal(r.status, 200); assert.equal(r.body.source, 'ai'); assert.match(r.body.body, /\{link\}/);
  reply = () => ({ subject: 'Pague!', body: 'Você deve $9,999.00. {link}' });
  r = await call('/ai/collection', 'POST', { doc_id: d.id, lang: 'en', tone: 'firm' }, owner);
  assert.equal(r.body.source, 'template'); assert.match(r.body.body, /\$1,250\.00/); assert.match(r.body.body, /Impact Digital/); assert.doesNotMatch(r.body.body, /9,999/);
  reply = () => ({ subject: 'Oi', body: 'Pague quando puder.' });
  r = await call('/ai/collection', 'POST', { doc_id: d.id }, owner);
  assert.match(r.body.body, /\{link\}/, 'o link sempre vai');
  // fatura paga não gera cobrança e não gasta uso
  const paid = acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: '2026-01-01', due_date: '2026-01-15', post: true, lines: [{ description: 'x', qty: 1, unit_price: C(10) }] }, null);
  acc.addPayment(paid.id, { date: '2026-01-05', amount: C(10), account_id: A('1010') });
  const used = ai.aiStatus().used;
  assert.equal((await call('/ai/collection', 'POST', { doc_id: paid.id }, owner)).status, 400);
  assert.equal(ai.aiStatus().used, used);
});

test('explicar o período: números só os dados; invenção vira resumo pronto', async () => {
  const cid = insert('INSERT INTO contacts(kind,name) VALUES(?,?)', 'customer', 'Cliente P');
  acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: '2026-07-05', due_date: '2026-07-05', post: true, lines: [{ description: 'Venda', qty: 1, unit_price: C(5000) }] }, null);
  acc.saveExpense({ date: '2026-07-10', account_id: A('6300'), paid_from_id: A('1010'), amount: C(1200), description: 'Software' });
  reply = (req) => { const f = JSON.parse(req.messages[0].content[0].text.split('\n').slice(1).join('\n')); return { text: `Em julho você faturou ${f.income} e gastou ${f.expenses}, sobrando ${f.net}. Vale olhar ${f.topExpense.name}.` }; };
  let r = await call('/ai/explain', 'POST', { from: '2026-07-01', to: '2026-07-31', lang: 'pt' }, owner);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.source, 'ai'); assert.match(r.body.text, /\$5,000\.00/);
  reply = () => ({ text: 'Você faturou $7,777.00 e cresceu 300%.' });
  r = await call('/ai/explain', 'POST', { from: '2026-07-01', to: '2026-07-31', lang: 'en' }, owner);
  assert.equal(r.body.source, 'template'); assert.match(r.body.text, /income \$5,000\.00/); assert.doesNotMatch(r.body.text, /7,777/);
  assert.equal((await call('/ai/explain', 'POST', { from: 'x', to: '2026-07-31' }, owner)).status, 400);
  // período sem movimento: sem chamar a IA
  reply = () => { throw new Error('não deveria chamar'); };
  const used = ai.aiStatus().used;
  r = await call('/ai/explain', 'POST', { from: '2020-01-01', to: '2020-01-31', lang: 'en' }, owner);
  assert.equal(r.body.source, 'template'); assert.equal(ai.aiStatus().used, used);
});

test('franquia: ao acabar, para com mensagem clara; erro da IA não gasta uso', async () => {
  const { run } = await import('../src/db.js');
  const cid = get("SELECT id FROM contacts WHERE name='Cliente P'").id;
  const d = acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: '2026-01-01', due_date: '2026-01-15', post: true, lines: [{ description: 'y', qty: 1, unit_price: C(30) }] }, null);
  fake.messages.create = async () => { const e = new Error('boom'); e.status = 500; throw e; };
  const before = ai.aiStatus().used;
  const f = await call('/ai/collection', 'POST', { doc_id: d.id }, owner);
  assert.equal(f.status, 502); assert.equal(f.body.code, 'ai_failed'); assert.equal(ai.aiStatus().used, before);
  const ymNow = new Date().toISOString().slice(0, 7);
  const need = 30 - ai.aiStatus().used;
  for (let i = 0; i < need; i++) run('INSERT INTO ai_usage(ym,kind) VALUES(?,?)', acc.today().slice(0, 7), 'test');
  const r = await call('/ai/collection', 'POST', { doc_id: d.id }, owner);
  assert.equal(r.status, 402); assert.equal(r.body.code, 'ai_limit'); void ymNow;
});
test.after(() => server.close());
