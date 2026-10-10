// Verificação em dois passos (TOTP), códigos de recuperação, senha de novo em ações sensíveis,
// "2FA obrigatório" e sessões guardadas só como resumo.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
const { get, all, run } = await import('../src/db.js');
const { app } = await import('../src/index.js');
const tf = await import('../src/twofa.js');
const { hashToken } = await import('../src/auth.js');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (path, method = 'GET', body, tk) => {
  const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const codeNow = (secret, shift = 0) => tf.totpAt(secret, Math.floor(Date.now() / 30000) + shift);
// o relógio do teste não anda: para gerar outro código válido, liberamos o passo já usado
const next = (secret) => { run('UPDATE users SET totp_last_step=0 WHERE id=1'); return codeNow(secret); };
let owner = '';

test('TOTP confere com o vetor oficial da RFC 6238 e rejeita código errado ou repetido', () => {
  const secret = tf.b32encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(tf.totpAt(secret, Math.floor(59 / 30)), '287082'); // 94287082 nos 8 dígitos da RFC
  assert.equal(tf.totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  const now = 1111111109 * 1000;
  assert.equal(tf.verifyTotp(secret, '081804', 0, now), Math.floor(1111111109 / 30));
  assert.equal(tf.verifyTotp(secret, '000000', 0, now), 0);
  assert.equal(tf.verifyTotp(secret, '081804', Math.floor(1111111109 / 30), now), 0, 'o mesmo código não vale duas vezes');
  assert.equal(tf.verifyTotp(secret, 'abc123', 0, now), 0);
});

test('a sessão fica guardada só como resumo (e a sessão antiga ainda funciona uma vez)', async () => {
  const s = await call('/setup', 'POST', { name: 'Dono', email: 'o@x.com', password: 'senha1234', plan: 'advanced', lang: 'en' });
  owner = s.body.token;
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token=?', owner).n, 0, 'o código bruto não está no banco');
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token=?', hashToken(owner)).n, 1);
  // sessão antiga (código guardado sem resumo) continua valendo e é convertida
  run('INSERT INTO sessions(token,user_id,verified_at) VALUES(?,1,CURRENT_TIMESTAMP)', 'legacytoken123');
  assert.equal((await call('/me', 'GET', undefined, 'legacytoken123')).status, 200);
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token=?', 'legacytoken123').n, 0);
  assert.equal(get('SELECT COUNT(*) AS n FROM sessions WHERE token=?', hashToken('legacytoken123')).n, 1);
  assert.equal((await call('/logout', 'POST', {}, 'legacytoken123')).status, 200);
  assert.equal((await call('/me', 'GET', undefined, 'legacytoken123')).status, 401);
});

test('ativar o 2FA: senha, código do aplicativo e códigos de recuperação', async () => {
  assert.equal((await call('/me/2fa/setup', 'POST', { password: 'errada' }, owner)).status, 400);
  const st = await call('/me/2fa/setup', 'POST', { password: 'senha1234' }, owner);
  assert.equal(st.status, 200);
  assert.match(st.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(st.body.otpauth, /^otpauth:\/\/totp\//);
  assert.ok(!get('SELECT totp_secret_enc FROM users WHERE id=1').totp_secret_enc.includes(st.body.secret), 'segredo cifrado no banco');
  assert.equal((await call('/me/2fa/enable', 'POST', { code: '000000' }, owner)).status, 400);
  const en = await call('/me/2fa/enable', 'POST', { code: codeNow(st.body.secret) }, owner);
  assert.equal(en.status, 200);
  assert.equal(en.body.recoveryCodes.length, 8);
  assert.match(en.body.recoveryCodes[0], /^[0-9a-f]{5}-[0-9a-f]{5}$/);
  const me = await call('/me', 'GET', undefined, owner);
  assert.equal(me.body.twofa.enabled, true); assert.equal(me.body.twofa.recoveryLeft, 8);
  globalThis.__secret = st.body.secret; globalThis.__rec = en.body.recoveryCodes;
});

test('login com 2FA: pede o código, recusa o errado e o repetido, aceita o certo e o de recuperação (uma vez)', async () => {
  const secret = globalThis.__secret, rec = globalThis.__rec;
  const noCode = await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234' });
  assert.equal(noCode.status, 401); assert.equal(noCode.body.needs_2fa, true);
  assert.equal((await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234', code: '123456' })).status, 401);
  assert.equal((await call('/login', 'POST', { email: 'o@x.com', password: 'errada', code: codeNow(secret) })).status, 401);
  // o código usado na ativação já foi consumido: o do passo seguinte vale
  const good = await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234', code: codeNow(secret, 1) });
  assert.equal(good.status, 200); assert.ok(good.body.token);
  assert.equal((await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234', code: codeNow(secret, 1) })).status, 401, 'código repetido');
  const viaRec = await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234', code: rec[0] });
  assert.equal(viaRec.status, 200);
  assert.equal((await call('/login', 'POST', { email: 'o@x.com', password: 'senha1234', code: rec[0] })).status, 401, 'código de recuperação só vale uma vez');
  assert.equal((await call('/me', 'GET', undefined, viaRec.body.token)).body.twofa.recoveryLeft, 7);
  globalThis.__tok = viaRec.body.token;
});

test('senha de novo em ações sensíveis (ligada pelo dono)', async () => {
  const secret = globalThis.__secret;
  const sec = await call('/security', 'GET', undefined, owner);
  assert.equal(sec.body.reauth_sensitive, false);
  // desligado: nada muda
  assert.equal((await call('/users', 'POST', { name: 'A', email: 'a@x.com', password: 'abcd1234', role: 'viewer' }, owner)).status, 200);
  assert.equal((await call('/security', 'PUT', { reauth_sensitive: true }, owner)).status, 200);
  // ligado: a sessão recém-aberta ainda vale por 5 minutos
  assert.equal((await call('/users', 'POST', { name: 'B', email: 'b@x.com', password: 'abcd1234', role: 'viewer' }, owner)).status, 200);
  // sessão "velha": pede a senha
  run("UPDATE sessions SET verified_at=datetime('now','-10 minutes')");
  const blocked = await call('/users', 'POST', { name: 'C', email: 'c@x.com', password: 'abcd1234', role: 'viewer' }, owner);
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, 'reauth_required');
  assert.equal((await call('/me/reauth', 'POST', { password: 'errada' }, owner)).status, 400);
  assert.equal((await call('/me/reauth', 'POST', { password: 'senha1234' }, owner)).status, 400, 'com 2FA ligado também pede o código');
  assert.equal((await call('/me/reauth', 'POST', { password: 'senha1234', code: next(secret) }, owner)).status, 200);
  assert.equal((await call('/users', 'POST', { name: 'C', email: 'c@x.com', password: 'abcd1234', role: 'viewer' }, owner)).status, 200);
  // pagar conta também exige (aprovar, chaves de API e papéis usam a mesma regra)
  run("UPDATE sessions SET verified_at=datetime('now','-10 minutes')");
  const k = await call('/integrations/keys', 'POST', { name: 'x' }, owner);
  assert.equal(k.status, 403); assert.equal(k.body.code, 'reauth_required');
  // leitura continua livre
  assert.equal((await call('/users', 'GET', undefined, owner)).status, 200);
});

test('2FA obrigatório: quem não ativou só alcança a tela de ativação; o dono limpa o 2FA de quem perdeu o celular', async () => {
  const secret = globalThis.__secret;
  run("UPDATE sessions SET verified_at=CURRENT_TIMESTAMP");
  const emp = await call('/login', 'POST', { email: 'a@x.com', password: 'abcd1234' });
  assert.equal(emp.status, 200); const e = emp.body.token;
  assert.equal((await call('/security', 'PUT', { require_2fa: true }, e)).status, 403, 'só o dono');
  assert.equal((await call('/security', 'PUT', { require_2fa: true }, owner)).status, 200);
  assert.equal((await call('/users', 'GET', undefined, e)).status, 403);
  assert.equal((await call('/users', 'GET', undefined, e)).body.code, '2fa_setup_required');
  const me = await call('/me', 'GET', undefined, e);
  assert.equal(me.status, 200); assert.equal(me.body.twofa.mustSetup, true);
  // ele ativa o próprio 2FA e volta a usar tudo
  const st = await call('/me/2fa/setup', 'POST', { password: 'abcd1234' }, e);
  assert.equal((await call('/me/2fa/enable', 'POST', { code: codeNow(st.body.secret) }, e)).status, 200);
  assert.equal((await call('/me/2fa/disable', 'POST', { password: 'abcd1234', code: codeNow(st.body.secret, 1) }, e)).status, 400, 'obrigatório: não dá para desligar');
  assert.equal((await call('/users', 'GET', undefined, e)).status, 403, 'sem permissão de usuários, mas já passou do bloqueio do 2FA');
  assert.notEqual((await call('/users', 'GET', undefined, e)).body.code, '2fa_setup_required');
  // celular perdido: o dono limpa o 2FA dele e derruba as sessões
  const emp2 = get("SELECT id FROM users WHERE email='a@x.com'").id;
  run("UPDATE sessions SET verified_at=CURRENT_TIMESTAMP");
  assert.equal((await call(`/users/${emp2}/2fa/reset`, 'POST', {}, owner)).status, 200);
  assert.equal(get('SELECT totp_enabled FROM users WHERE id=?', emp2).totp_enabled, 0);
  assert.equal((await call('/me', 'GET', undefined, e)).status, 401);
  // o dono desligar a exigência
  assert.equal((await call('/security', 'PUT', { require_2fa: false }, owner)).status, 200);
});

test('o dono não consegue exigir 2FA sem ter o seu; desligar o próprio exige senha e código', async () => {
  const secret = globalThis.__secret;
  run("UPDATE sessions SET verified_at=CURRENT_TIMESTAMP");
  const r = await call('/me/2fa/disable', 'POST', { password: 'senha1234', code: next(secret) }, owner);
  assert.equal(r.status, 200);
  const me = await call('/me', 'GET', undefined, owner);
  assert.equal(me.body.twofa.enabled, false);
  assert.equal((await call('/security', 'PUT', { require_2fa: true }, owner)).status, 400, 'ative o seu primeiro');
  assert.equal(all('SELECT id FROM audit_log WHERE action IN (\'enable\',\'disable\',\'reset\') AND entity=\'2fa\'').length >= 3, true, 'tudo fica no registro de ações');
  server.close();
});
