// Verificação em dois passos (TOTP, o código de 6 dígitos de aplicativos como Google Authenticator, Authy ou 1Password),
// confirmação de senha para ações sensíveis e a regra "2FA obrigatório" da empresa.
// Sem dependências: o TOTP (RFC 6238) usa só o módulo crypto do Node. O segredo fica cifrado (secure.js).
import crypto from 'node:crypto';
import { get, run, getSetting, setSetting } from './db.js';
import { HttpError } from './accounting.js';
import { encrypt, decrypt } from './secure.js';
import { verifyPassword } from './auth.js';

const bad = (m) => new HttpError(400, m);
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

/* ----------------------------------- TOTP ----------------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const b32encode = (buf) => {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
};
export const b32decode = (str) => {
  let bits = '';
  for (const ch of String(str).toUpperCase().replace(/=+$/, '')) { const v = B32.indexOf(ch); if (v < 0) throw new Error('bad base32'); bits += v.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
export const newSecret = () => b32encode(crypto.randomBytes(20));
/** Código de 6 dígitos do passo `step` (30 s). */
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(msg).digest();
  const o = h[19] & 15;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
/** Devolve o passo aceito (aceita 1 passo para cada lado do relógio) ou 0. Um passo já usado não vale de novo. */
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return 0;
  const cur = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) { const step = cur + d; if (step > lastStep && same(code, totpAt(secret, step))) return step; }
  return 0;
}
export const otpauthUrl = (secret, email, issuer = 'Fluxo') => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ------------------------------ códigos de recuperação ------------------------------ */
const newRecovery = () => Array.from({ length: 8 }, () => { const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`; });
const recoveryLeft = (u) => { try { return JSON.parse(u.recovery_codes || '[]').length; } catch { return 0; } };

/* --------------------------------------- uso --------------------------------------- */
/** Confere o código de 2FA (aplicativo ou recuperação) de um usuário com 2FA ligado; devolve true e consome o que foi usado. */
export function checkCode(u, rawCode) {
  const code = String(rawCode || '').trim().replace(/\s+/g, '').toLowerCase();
  if (!code) return false;
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decrypt(u.totp_secret_enc), code, u.totp_last_step || 0);
    if (!step) return false;
    run('UPDATE users SET totp_last_step=? WHERE id=?', step, u.id);
    return true;
  }
  let list = []; try { list = JSON.parse(u.recovery_codes || '[]'); } catch { /* sem códigos */ }
  const h = sha(code);
  if (!list.includes(h)) return false;
  run('UPDATE users SET recovery_codes=? WHERE id=?', JSON.stringify(list.filter((x) => x !== h)), u.id);
  return true;
}

/** No login: com 2FA ligado, exige o código; sem ele, avisa o cliente de que precisa pedir. */
export function enforceAtLogin(u, code) {
  if (!u.totp_enabled) return;
  if (!String(code || '').trim()) throw new HttpError(401, 'Enter the verification code from your authenticator app', { needs_2fa: true });
  if (!checkCode(u, code)) throw new HttpError(401, 'Incorrect verification code', { needs_2fa: true });
}

export const twofaRequired = () => getSetting('require_2fa', '0') === '1';
export const reauthOn = () => getSetting('reauth_sensitive', '0') === '1';
export const twofaState = (u) => ({ enabled: !!u.totp_enabled, required: twofaRequired(), mustSetup: twofaRequired() && !u.totp_enabled, recoveryLeft: u.totp_enabled ? recoveryLeft(u) : 0 });
const isSsoUser = (u) => !!getSetting(`sso_sub_${u.id}`, ''); // quem entra por login único segue as regras do provedor de identidade

/** Ações sensíveis (pagar conta, aprovar, mexer em acesso e chaves) pedem a senha de novo se a empresa ligou isso. */
export function assertFresh(req) {
  if (!reauthOn() || !req.user || isSsoUser(req.user)) return;
  const ok = req.sessionKey && get("SELECT 1 FROM sessions WHERE token=? AND verified_at > datetime('now','-5 minutes')", req.sessionKey);
  if (!ok) throw new HttpError(403, 'Please confirm your password to continue', { code: 'reauth_required' });
}
export const requireFresh = (req, _res, next) => { try { assertFresh(req); next(); } catch (e) { next(e); } };

/** Com "2FA obrigatório", quem ainda não ativou só alcança as telas de ativação. */
export function setupGate(req, _res, next) {
  if (!req.user || !twofaRequired() || req.user.totp_enabled || isSsoUser(req.user)) return next();
  if (req.path === '/me' || req.path === '/logout' || req.path.startsWith('/me/2fa') || (req.path === '/settings' && req.method === 'GET')) return next();
  next(new HttpError(403, 'Two-step verification is required. Set it up to continue', { code: '2fa_setup_required' }));
}

export function registerTwoFactor(api, { wrap, ok, can, audit, listUsers }) {
  const needPassword = (req) => { if (!verifyPassword(String(req.body?.password || ''), req.user.password_hash)) throw bad('Password is incorrect'); };

  api.get('/me/2fa', wrap((req, res) => ok(res, twofaState(get('SELECT * FROM users WHERE id=?', req.user.id)))));
  // 1) pede a chave (exige a senha); ainda não vale até confirmar com um código
  api.post('/me/2fa/setup', wrap((req, res) => {
    needPassword(req);
    if (req.user.totp_enabled) throw bad('Two-step verification is already on');
    const secret = newSecret();
    run('UPDATE users SET totp_secret_enc=?, totp_enabled=0, totp_last_step=0, recovery_codes=NULL WHERE id=?', encrypt(secret), req.user.id);
    ok(res, { secret, otpauth: otpauthUrl(secret, req.user.email, getSetting('company_name', '') || 'Fluxo') });
  }));
  // 2) confirma com o primeiro código do aplicativo; devolve os códigos de recuperação UMA vez
  api.post('/me/2fa/enable', wrap((req, res) => {
    const u = get('SELECT * FROM users WHERE id=?', req.user.id);
    if (u.totp_enabled) throw bad('Two-step verification is already on');
    if (!u.totp_secret_enc) throw bad('Start the setup first');
    const step = verifyTotp(decrypt(u.totp_secret_enc), String(req.body?.code || '').replace(/\s+/g, ''), 0);
    if (!step) throw bad('That code is not right. Check the time on your phone and try again');
    const codes = newRecovery();
    run('UPDATE users SET totp_enabled=1, totp_last_step=?, recovery_codes=? WHERE id=?', step, JSON.stringify(codes.map(sha)), u.id);
    audit(req, 'enable', '2fa', u.id, u.email);
    ok(res, { recoveryCodes: codes });
  }));
  api.post('/me/2fa/disable', wrap((req, res) => {
    needPassword(req);
    const u = get('SELECT * FROM users WHERE id=?', req.user.id);
    if (!u.totp_enabled) throw bad('Two-step verification is off');
    if (twofaRequired()) throw bad('Your company requires two-step verification, so it cannot be turned off');
    if (!checkCode(u, req.body?.code)) throw bad('Incorrect verification code');
    run('UPDATE users SET totp_secret_enc=NULL, totp_enabled=0, totp_last_step=0, recovery_codes=NULL WHERE id=?', u.id);
    audit(req, 'disable', '2fa', u.id, u.email);
    ok(res, {});
  }));
  api.post('/me/2fa/recovery', wrap((req, res) => {
    needPassword(req);
    const u = get('SELECT * FROM users WHERE id=?', req.user.id);
    if (!u.totp_enabled) throw bad('Two-step verification is off');
    if (!checkCode(u, req.body?.code)) throw bad('Incorrect verification code');
    const codes = newRecovery();
    run('UPDATE users SET recovery_codes=? WHERE id=?', JSON.stringify(codes.map(sha)), u.id);
    audit(req, 'recovery', '2fa', u.id);
    ok(res, { recoveryCodes: codes });
  }));
  // confirma a senha (e o código, se tiver 2FA) para liberar ações sensíveis por 5 minutos
  api.post('/me/reauth', wrap((req, res) => {
    const u = get('SELECT * FROM users WHERE id=?', req.user.id);
    if (!verifyPassword(String(req.body?.password || ''), u.password_hash)) throw bad('Password is incorrect');
    if (u.totp_enabled && !checkCode(u, req.body?.code)) throw bad('Incorrect verification code');
    run("UPDATE sessions SET verified_at=CURRENT_TIMESTAMP WHERE token=?", req.sessionKey);
    ok(res, {});
  }));

  // regras da empresa (dono): 2FA obrigatório e senha de novo em ações sensíveis
  api.get('/security', can('users'), wrap((_req, res) => ok(res, {
    require_2fa: twofaRequired(), reauth_sensitive: reauthOn(),
    users: listUsers().filter((u) => u.active).map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, totp_enabled: !!u.totp_enabled })),
  })));
  api.put('/security', can('users', true), requireFresh, wrap((req, res) => {
    const b = req.body || {};
    if ('require_2fa' in b) {
      if (b.require_2fa && !req.user.totp_enabled) throw bad('Turn on two-step verification for your own account first');
      setSetting('require_2fa', b.require_2fa ? '1' : '0');
    }
    if ('reauth_sensitive' in b) setSetting('reauth_sensitive', b.reauth_sensitive ? '1' : '0');
    audit(req, 'update', 'settings', null, 'security');
    ok(res, { require_2fa: twofaRequired(), reauth_sensitive: reauthOn() });
  }));
  // celular perdido: o dono limpa o 2FA de outra pessoa (ela volta a configurar no próximo acesso)
  api.post('/users/:id/2fa/reset', can('users', true), requireFresh, wrap((req, res) => {
    const uid = Number(req.params.id); const u = get('SELECT * FROM users WHERE id=?', uid);
    if (!u) throw new HttpError(404, 'User not found');
    run('UPDATE users SET totp_secret_enc=NULL, totp_enabled=0, totp_last_step=0, recovery_codes=NULL WHERE id=?', uid);
    run('DELETE FROM sessions WHERE user_id=?', uid);
    audit(req, 'reset', '2fa', uid, u.email);
    ok(res, {});
  }));
}
