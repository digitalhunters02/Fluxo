// Enviar fatura por e-mail pelo Fluxo: texto editável, PDF anexo, histórico, regra de plano e aviso de "e-mail não configurado".
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

process.env.FLUXO_DB = ':memory:'; process.env.APP_URL = 'https://app.fluxo.test';
const { get, insert, run: runSql } = await import('../src/db.js');
const acc = await import('../src/accounting.js');
const mailer = await import('../src/mailer.js');
const pdf = await import('../src/pdf.js');
const { app } = await import('../src/index.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
let token = '';
const call = async (p, method = 'GET', body, tk = token) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = {}; try { json = JSON.parse(buf.toString()); } catch { /* pdf */ }
  return { status: r.status, body: json, buf, headers: r.headers };
};
const t = acc.today();
const cid = insert("INSERT INTO contacts(kind,name,email,address) VALUES('customer','Padaria São João','joao@padaria.test','Rua das Flores 10')");
const mkInvoice = (n = 12345, post = true) => acc.saveDoc({ type: 'invoice', contact_id: cid, issue_date: t, due_date: acc.addDays(t, 15), post, lines: [{ description: 'Consultoria — ação mensal', qty: 2, unit_price: n }] }, null);
const sent = [];
// texto desenhado em todas as páginas do PDF (descomprime os fluxos)
const pdfText = (buf) => [...buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')).join('\n');
let inv;

test('preparo', async () => {
  token = (await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'essentials', lang: 'pt', company_name: 'Impact Digital' }, '')).body.token;
  assert.ok(token); inv = mkInvoice();
});

test('sem provedor de e-mail: avisa e nunca finge que enviou nem grava histórico', async () => {
  const d = await call(`/doc/${inv.id}/emails`);
  assert.equal(d.body.ready, false); assert.equal(d.body.allowed, true);
  const r = await call(`/doc/${inv.id}/email`, 'POST', { to: 'a@b.com' });
  assert.equal(r.status, 503); assert.match(r.body.error, /not set up/);
  assert.equal(get('SELECT COUNT(*) n FROM doc_emails').n, 0); assert.equal(get('SELECT emailed_at e FROM docs WHERE id=?', inv.id).e, null);
});

test('rascunho no idioma da empresa, editável; envio com PDF anexo e histórico', async () => {
  mailer.setTransport(async (m) => { sent.push(m); });
  const d = await call(`/doc/${inv.id}/emails`);
  assert.equal(d.body.ready, true); assert.equal(d.body.draft.to, 'joao@padaria.test');
  assert.match(d.body.draft.subject, /^Fatura FAT-\d+ — Impact Digital$/); assert.match(d.body.draft.message, /^Olá Padaria São João,/);
  const r = await call(`/doc/${inv.id}/email`, 'POST', { to: ' joao@padaria.test ', subject: 'Sua fatura\r\nBcc: x@y.com', message: 'Oi João, segue a fatura do mês. Abraço!' });
  assert.equal(r.status, 200); assert.equal(r.body.sentTo, 'joao@padaria.test'); assert.equal(r.body.withPdf, true);
  const m = sent.at(-1);
  assert.equal(m.to, 'joao@padaria.test'); assert.equal(m.subject, 'Sua fatura Bcc: x@y.com');                // quebra de linha no assunto não vira cabeçalho novo
  assert.match(m.text, /^Oi João, segue a fatura do mês\. Abraço!/); assert.doesNotMatch(m.text, /Olá Padaria/);   // o texto editado substitui o padrão
  assert.match(m.text, /O PDF segue em anexo\./); assert.match(m.text, /https:\/\/app\.fluxo\.test\/p\/[0-9a-f]+/);
  assert.equal(m.attachments.length, 1); assert.equal(m.attachments[0].contentType, 'application/pdf'); assert.match(m.attachments[0].filename, /^Fatura-FAT-\d+\.pdf$/);
  const b = m.attachments[0].content;
  assert.equal(b.subarray(0, 5).toString(), '%PDF-'); assert.match(b.subarray(-6).toString(), /%%EOF/);
  const txt = pdfText(b);
  assert.match(txt, /\(FAT-\d+\) Tj/); assert.match(txt, /Impact Digital/); assert.match(txt, /Padaria S\xe3o Jo\xe3o/); assert.match(txt, /US\$ 246,90/);   // 2 x US$ 123,45
  const h = await call(`/doc/${inv.id}/emails`);
  assert.equal(h.body.history.length, 1); assert.deepEqual([h.body.history[0].status, h.body.history[0].to_addr, h.body.history[0].with_pdf, h.body.history[0].user_name], ['sent', 'joao@padaria.test', true, 'Dono']);
  assert.ok(get('SELECT emailed_at e FROM docs WHERE id=?', inv.id).e);
});

test('sem PDF, texto padrão e outro destinatário; falha do provedor fica no histórico e não marca como enviada', async () => {
  const second = mkInvoice(5000);
  const ok = await call(`/doc/${second.id}/email`, 'POST', { to: 'outro@x.com', attach_pdf: false });
  assert.equal(ok.status, 200); assert.equal(ok.body.withPdf, false);
  const m = sent.at(-1); assert.equal(m.attachments.length, 0); assert.match(m.text, /^Olá Padaria São João,/); assert.doesNotMatch(m.text, /anexo/);
  const third = mkInvoice(7000);
  mailer.setTransport(async () => { throw new Error('550 mailbox unavailable'); });
  const bad = await call(`/doc/${third.id}/email`, 'POST', { to: 'x@y.com' });
  assert.equal(bad.status, 502); assert.match(bad.body.error, /could not be sent/); assert.doesNotMatch(JSON.stringify(bad.body), /550/);   // erro técnico não vaza para a tela
  assert.equal(get('SELECT emailed_at e FROM docs WHERE id=?', third.id).e, null);
  const h = (await call(`/doc/${third.id}/emails`)).body.history;
  assert.equal(h.length, 1); assert.equal(h[0].status, 'failed'); assert.match(h[0].error, /550/);
  mailer.setTransport(async (mm) => { sent.push(mm); });
});

test('validações: e-mail inválido, rascunho, anulada', async () => {
  assert.equal((await call(`/doc/${inv.id}/email`, 'POST', { to: 'sem-arroba' })).status, 400);
  const draft = mkInvoice(100, false);
  assert.equal((await call(`/doc/${draft.id}/email`, 'POST', { to: 'a@b.com' })).status, 400);
  assert.equal((await call('/doc/99999/email', 'POST', { to: 'a@b.com' })).status, 404);
  assert.equal((await call('/doc/99999/emails')).status, 404);
});

test('regra de plano: Free e Starter recebem uma mensagem amigável com o plano necessário', async () => {
  for (const plan of ['free', 'starter']) {
    runSql("UPDATE settings SET value=? WHERE key='plan'", plan);
    const r = await call(`/doc/${inv.id}/email`, 'POST', { to: 'a@b.com' });
    assert.equal(r.status, 402); assert.match(r.body.error, /Essentials plan/); assert.equal(r.body.required, 'essentials');
    assert.equal((await call(`/doc/${inv.id}/emails`)).body.allowed, false);
  }
  runSql("UPDATE settings SET value='essentials' WHERE key='plan'");
  assert.equal((await call(`/doc/${inv.id}/email`, 'POST', { to: 'a@b.com' })).status, 200);
});

test('baixar o PDF funciona em qualquer plano e é o mesmo documento', async () => {
  runSql("UPDATE settings SET value='free' WHERE key='plan'");
  const r = await call(`/doc/${inv.id}/pdf`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/pdf'); assert.match(r.headers.get('content-disposition'), /filename="FAT-\d+\.pdf"/);
  assert.equal(r.buf.subarray(0, 5).toString(), '%PDF-');
  assert.equal((await call(`/doc/${inv.id}/pdf`, 'GET', undefined, '')).status, 401);
  runSql("UPDATE settings SET value='essentials' WHERE key='plan'");
});

test('PDF: várias páginas, acentos e quebra de linha', () => {
  const lines = Array.from({ length: 60 }, (_, i) => ({ description: `Item ${i + 1} ação coração €`, qty: 1, unit_price: 1000, amount: 1000, tax_rate: 0 }));
  const b = pdf.buildDocPdf({ type: 'estimate', number: 'EST-1', contact_name: 'C', issue_date: '2026-01-01', due_date: '2026-02-01', subtotal: 60000, tax: 0, total: 60000, paid: 0, balance: 60000, lines, notes: 'x' }, { lang: 'es', company: { name: 'Co' } });
  assert.match(b.toString('latin1'), /\/Count [2-9]/);                                  // passou de uma página
  assert.match(pdfText(b), /P\xe1gina 1 de \d/);
  assert.deepEqual(pdf.wrap('uma frase curta para quebrar em linhas pequenas', 10, 80).every((l) => pdf.textWidth(l, 10) <= 80), true);
  assert.equal(pdf.encode('a(b)\\c'), 'a\\(b\\)\\\\c'); assert.equal(pdf.encode('€'), '\x80'); assert.equal(pdf.encode('日'), '?');
});
test.after(() => server.close());
