// Contador convidado pelo dono: link por e-mail (7 dias), o contador cria a própria senha e entra só para ler.
// O acesso é conferido a cada pedido (usuário ativo + papel "cpa" só de leitura), então encerrar vale na hora.
import crypto from 'node:crypto';
import { get, run, insert, all, tx, getSetting } from './db.js';
import { HttpError } from './accounting.js';
import { CPA_ROLE, hashPassword, createSession, publicUser, rateLimitLogin, audit, can } from './auth.js';
import { limitFor, assertFeature } from './plans.js';
import * as mailer from './mailer.js';
import * as tenants from './tenants.js';

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const bad = (m) => new HttpError(400, m);
const GONE = 'This invitation is invalid or has expired. Ask the owner for a new one.';

const statusOf = (r) => {
  if (r.revoked_at) return 'ended';
  if (r.accepted_at) return get('SELECT active FROM users WHERE id=?', r.user_id)?.active ? 'active' : 'ended';
  return r.expires_at > new Date().toISOString().slice(0, 19).replace('T', ' ') ? 'pending' : 'expired';
};
/** Vagas em uso: convites ainda válidos + contadores ativos. */
export const seatsUsed = () => all('SELECT * FROM accountant_invites WHERE revoked_at IS NULL').filter((r) => ['pending', 'active'].includes(statusOf(r))).length;
/** Uma linha por e-mail (o convite mais novo); convites cancelados antes de serem aceitos somem da lista. */
export const list = () => all('SELECT * FROM accountant_invites WHERE id IN (SELECT MAX(id) FROM accountant_invites GROUP BY email) AND NOT (revoked_at IS NOT NULL AND accepted_at IS NULL) ORDER BY id DESC').map((r) => ({
  id: r.id, email: r.email, name: r.name, status: statusOf(r), expires_at: r.expires_at, accepted_at: r.accepted_at, created_at: r.created_at,
}));

/** Cria (ou renova) o convite e devolve o código bruto, que só existe agora. */
export function invite({ email, name }, by) {
  const e = String(email || '').trim().toLowerCase();
  if (!EMAIL.test(e)) throw bad('Enter a valid email');
  assertFeature('accountant_access');
  const u = get('SELECT * FROM users WHERE email=?', e);
  if (u && u.role !== CPA_ROLE) throw bad('This email already belongs to a user of this company.');
  const prev = all('SELECT * FROM accountant_invites WHERE email=? AND revoked_at IS NULL', e);
  if (prev.some((r) => statusOf(r) === 'active')) throw bad('This accountant already has access.');
  const cap = limitFor('accountants');
  const renewing = prev.some((r) => statusOf(r) === 'pending'); // renovar um convite pendente não ocupa vaga nova
  if (cap !== null && !renewing && seatsUsed() >= cap) throw new HttpError(402, 'You have used all the accountant seats in your plan. Upgrade to add more.', { feature: 'accountants', required: 'advanced' });
  const raw = crypto.randomBytes(32).toString('hex');
  tx(() => {
    run("UPDATE accountant_invites SET revoked_at=datetime('now') WHERE email=? AND revoked_at IS NULL", e);
    insert("INSERT INTO accountant_invites(email,name,token_hash,expires_at,invited_by) VALUES(?,?,?,datetime('now','+7 days'),?)", e, String(name || '').trim().slice(0, 100), sha(raw), by?.id ?? null);
  });
  return { email: e, raw };
}

/** Encerra o acesso: o usuário fica inativo e as sessões caem; o próximo pedido dele já recebe 401. */
export function end(inviteId) {
  const r = get('SELECT * FROM accountant_invites WHERE id=?', inviteId);
  if (!r) throw new HttpError(404, 'Accountant not found');
  tx(() => {
    run("UPDATE accountant_invites SET revoked_at=COALESCE(revoked_at,datetime('now')) WHERE id=?", r.id);
    if (r.user_id) {
      const u = get('SELECT role FROM users WHERE id=?', r.user_id);
      if (u?.role === CPA_ROLE) { run('UPDATE users SET active=0 WHERE id=?', r.user_id); run('DELETE FROM sessions WHERE user_id=?', r.user_id); }
    }
  });
  return r;
}

const openInvite = (raw) => get("SELECT * FROM accountant_invites WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > datetime('now')", sha(String(raw || '')));

/** O contador aceita: cria (ou reativa) o usuário de leitura e já entra. */
export function accept(raw, { name, password }) {
  const inv = openInvite(raw);
  if (!inv) throw bad(GONE);
  if (!password || String(password).length < 8) throw bad('The password must be at least 8 characters');
  let uid;
  tx(() => {
    const u = get('SELECT * FROM users WHERE email=?', inv.email);
    if (u && u.role !== CPA_ROLE) throw bad('This email already belongs to a user of this company.');
    if (u) { run('UPDATE users SET password_hash=?, active=1, name=? WHERE id=?', hashPassword(password), (name || inv.name || u.name).trim().slice(0, 100), u.id); run('DELETE FROM sessions WHERE user_id=?', u.id); uid = u.id; }
    else {
      if (tenants.multiEnabled() && !tenants.registerEmail(inv.email, tenants.currentSlug())) throw new HttpError(409, 'This email already has a Fluxo login for another company. Ask the owner to invite a different email address.');
      uid = insert('INSERT INTO users(name,email,password_hash,role,email_verified_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)', (name || inv.name || inv.email.split('@')[0]).trim().slice(0, 100), inv.email, hashPassword(password), CPA_ROLE);
    }
    run("UPDATE accountant_invites SET accepted_at=datetime('now'), user_id=? WHERE id=?", uid, inv.id);
    run('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', uid, inv.email, 'accept', 'accountant', inv.id, 'accountant accepted the invitation (read-only)');
  });
  return { uid, session: createSession(uid), user: publicUser(get('SELECT * FROM users WHERE id=?', uid)) };
}

export function registerAccountantsPublic(api, { wrap, ok, publicTenant, withSlug }) {
  api.get('/public/accountant/:token', publicTenant, wrap((req, res) => {
    rateLimitLogin(`acc-view|${req.ip}`);
    const inv = openInvite(req.params.token);
    if (!inv) throw new HttpError(404, GONE);
    ok(res, { company: getSetting('company_name', ''), email: inv.email, name: inv.name, lang: getSetting('lang', 'en'), expires_at: inv.expires_at });
  }));
  api.post('/public/accountant/:token/accept', publicTenant, wrap((req, res) => {
    rateLimitLogin(`acc-accept|${req.ip}`);
    const out = accept(req.params.token, req.body || {});
    ok(res, { token: withSlug(out.session), user: out.user });
  }));
}

export function registerAccountants(api, { wrap, ok, twofa, id, multi }) {
  api.get('/accountants', can('users'), wrap((_req, res) => ok(res, { accountants: list(), seats: { used: seatsUsed(), limit: limitFor('accountants') }, mailReady: mailer.recoveryReady() })));
  api.post('/accountants', can('users', true), twofa.requireFresh, wrap(async (req, res) => {
    const { email, raw } = invite(req.body || {}, req.user);
    const slug = multi() ? tenants.currentSlug() : '';
    const base = mailer.appUrl() || `${req.protocol}://${req.get('host')}`;
    const link = `${base}/accountant/${encodeURIComponent(slug ? `${slug}.${raw}` : raw)}`;
    let emailed = false;
    if (mailer.recoveryReady()) {
      try { await mailer.sendMail({ to: email, ...mailer.accountantInviteEmail(getSetting('lang', 'en'), { company: getSetting('company_name', 'Fluxo'), inviter: req.user.name, link }) }); emailed = true; } catch (e) { console.error('accountant invite email failed:', e.message); }
    }
    audit(req, 'invite', 'accountant', null, email);
    ok(res, { email, link, emailed });
  }));
  api.delete('/accountants/:id', can('users', true), wrap((req, res) => {
    const r = end(id(req));
    audit(req, 'revoke', 'accountant', r.id, r.email);
    ok(res, {});
  }));
}
