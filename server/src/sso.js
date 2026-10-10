// Login único (SSO) por empresa, com qualquer provedor OpenID Connect (Google Workspace, Microsoft Entra ID, Okta...). Plano Enterprise.
// O dono da empresa cadastra emissor, client id e client secret em Configurações. O segredo fica criptografado (AES-256-GCM).
// A pessoa precisa já ter usuário ativo no Fluxo (o SSO prova quem ela é; quem pode entrar continua sendo decisão do dono).
// A autenticação em dois fatores do provedor vale; o Fluxo não pede outra senha. A volta traz o token em #sso_token=<empresa.token>.
import crypto from 'node:crypto';
import { get, run, getSetting, setSetting } from './db.js';
import * as tenants from './tenants.js';
import { HttpError } from './accounting.js';
import { hasFeature } from './plans.js';
import { encrypt, decrypt } from './secure.js';
import { createSession, rateLimitLogin } from './auth.js';

const bad = (m) => new HttpError(400, m);
const STATE_KEY = crypto.createHash('sha256').update(process.env.SSO_STATE_SECRET || process.env.FLUXO_ENCRYPTION_KEY || crypto.randomBytes(32)).digest();
const sign = (obj) => { const b = Buffer.from(JSON.stringify(obj)).toString('base64url'); return `${b}.${crypto.createHmac('sha256', STATE_KEY).update(b).digest('base64url')}`; };
function unsign(s) {
  const [b, sig] = String(s || '').split('.');
  if (!b || !sig) return null;
  const good = crypto.createHmac('sha256', STATE_KEY).update(b).digest('base64url');
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}

export const ssoSettings = () => ({ enabled: getSetting('sso_enabled', '0') === '1', issuer: getSetting('sso_issuer', ''), client_id: getSetting('sso_client_id', ''), has_secret: !!getSetting('sso_client_secret', ''), domains: getSetting('sso_domains', '') });
export function saveSsoSettings(b) {
  const issuer = String(b.issuer ?? getSetting('sso_issuer', '')).trim().replace(/\/+$/, '');
  if (issuer && !/^https?:\/\/[^\s]+$/.test(issuer)) throw bad('Enter the provider address (for example https://accounts.google.com)');
  setSetting('sso_issuer', issuer);
  if (b.client_id !== undefined) setSetting('sso_client_id', String(b.client_id).trim().slice(0, 300));
  if (b.client_secret) setSetting('sso_client_secret', encrypt(String(b.client_secret).slice(0, 500)));
  if (b.domains !== undefined) setSetting('sso_domains', String(b.domains).toLowerCase().split(/[\s,;]+/).filter(Boolean).join(','));
  if (b.enabled !== undefined) {
    if (b.enabled && !(getSetting('sso_issuer', '') && getSetting('sso_client_id', '') && getSetting('sso_client_secret', ''))) throw bad('Fill in the provider address, client id and client secret first');
    setSetting('sso_enabled', b.enabled ? '1' : '0');
  }
  return ssoSettings();
}

const disco = new Map();
async function discovery(issuer) {
  const c = disco.get(issuer);
  if (c && c.at > Date.now() - 3600_000) return c.doc;
  const r = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!r.ok) throw new HttpError(502, 'Could not read the sign-in provider configuration');
  const doc = await r.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.userinfo_endpoint) throw new HttpError(502, 'The sign-in provider configuration is incomplete');
  disco.set(issuer, { at: Date.now(), doc });
  return doc;
}
const origin = (req) => (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

/** Rotas públicas (sem sessão). */
export function registerSsoPublic(api, { wrap }) {
  const back = (req, res, msg) => res.redirect(302, `${origin(req)}/#sso_error=${encodeURIComponent(msg)}`);
  api.get('/sso/start', wrap(async (req, res) => {
    rateLimitLogin(`sso|${req.ip}`);
    const email = String(req.query.email || '').trim().toLowerCase();
    const generic = 'Single sign-on is not set up for this account';
    const slug = tenants.multiEnabled() ? tenants.slugForEmail(email) : '';
    if (tenants.multiEnabled() && !slug) return back(req, res, generic);
    const go = async () => {
      if (!hasFeature('sso') || getSetting('sso_enabled', '0') !== '1' || !get('SELECT 1 FROM users WHERE email=? AND active=1', email)) return back(req, res, generic);
      const s = ssoSettings();
      const d = await discovery(s.issuer);
      const state = sign({ slug: slug || '', email, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60_000 });
      const q = new URLSearchParams({ response_type: 'code', client_id: s.client_id, redirect_uri: `${origin(req)}/api/sso/callback`, scope: 'openid email profile', state, login_hint: email });
      res.redirect(302, `${d.authorization_endpoint}?${q}`);
    };
    return slug ? tenants.inTenant(slug, go) : go();
  }));

  api.get('/sso/callback', wrap(async (req, res) => {
    const st = unsign(req.query.state);
    if (!st) return back(req, res, 'Sign-in expired. Try again');
    if (!req.query.code) return back(req, res, 'The provider did not return a sign-in code');
    const finish = async () => {
      if (!hasFeature('sso') || getSetting('sso_enabled', '0') !== '1') return back(req, res, 'Single sign-on is not enabled');
      const s = ssoSettings();
      const d = await discovery(s.issuer);
      const tr = await fetch(d.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(req.query.code), redirect_uri: `${origin(req)}/api/sso/callback`, client_id: s.client_id, client_secret: decrypt(getSetting('sso_client_secret', '')) }) });
      const tok = await tr.json().catch(() => ({}));
      if (!tr.ok || !tok.access_token) return back(req, res, 'The provider refused the sign-in');
      const ur = await fetch(d.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const info = await ur.json().catch(() => ({}));
      const email = String(info.email || '').toLowerCase();
      if (!ur.ok || !email || !info.sub) return back(req, res, 'The provider did not share an email address');
      if (email !== st.email) return back(req, res, 'The provider signed in a different email address');
      if (info.email_verified === false) return back(req, res, 'Your email address is not verified with the provider');
      const allowed = s.domains.split(',').filter(Boolean);
      if (allowed.length && !allowed.includes(email.split('@')[1])) return back(req, res, 'This email domain may not sign in here');
      const u = get('SELECT * FROM users WHERE email=? AND active=1', email);
      if (!u) return back(req, res, 'There is no active Fluxo user for this email. Ask the owner to add you');
      const linked = getSetting(`sso_sub_${u.id}`, '');
      if (linked && linked !== String(info.sub)) return back(req, res, 'This user is linked to a different identity');
      if (!linked) setSetting(`sso_sub_${u.id}`, String(info.sub));
      run('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', u.id, u.name, 'login', 'user', u.id, 'single sign-on');
      const token = createSession(u.id);
      res.redirect(302, `${origin(req)}/#sso_token=${st.slug ? `${st.slug}.` : ''}${token}`);
    };
    return st.slug ? tenants.inTenant(st.slug, finish) : finish();
  }));
}
