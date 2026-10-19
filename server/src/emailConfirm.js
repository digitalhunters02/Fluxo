// Confirmação de e-mail do cadastro (hospedado, plano Free). Evita contas falsas sem prender ninguém:
//  - só vale quando o servidor CONSEGUE mandar e-mail (provedor + APP_URL); sem isso nada é limitado e o aviso diz o porquê;
//  - quem paga, quem já existia antes desta função e quem foi criado pelo dono nunca fica "não confirmado";
//  - enquanto o dono de uma conta Free não confirma, a conta pode criar até UNCONFIRMED_INVOICE_CAP faturas; o resto funciona normalmente.
import crypto from 'node:crypto';
import { get, run } from './db.js';
import { HttpError } from './accounting.js';
import * as mailer from './mailer.js';
import { currentPlan } from './plans.js';

export const UNCONFIRMED_INVOICE_CAP = 3;
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/** O servidor sabe mandar e-mail com link? Sem isso a confirmação fica desligada (modo teste/demonstração). */
export const confirmationAvailable = () => mailer.recoveryReady();
const owner = () => get("SELECT id,name,email,email_verified_at FROM users WHERE role='owner' AND active=1 ORDER BY id LIMIT 1");

/** {invoiceCap} quando a conta está limitada por falta de confirmação; null quando não há limite. */
export function restriction() {
  if (!confirmationAvailable() || currentPlan() !== 'free') return null;
  const o = owner();
  return o && !o.email_verified_at ? { invoiceCap: UNCONFIRMED_INVOICE_CAP } : null;
}
/** Estado para a tela (cada pessoa vê o seu próprio e-mail; o limite é da conta). */
export function stateFor(user) {
  const last = get('SELECT created_at FROM email_verifications WHERE user_id=? ORDER BY created_at DESC LIMIT 1', user.id);
  const r = restriction();
  return { confirmed: !!user.email_verified_at, available: confirmationAvailable(), limited: !!r && user.role === 'owner', invoiceCap: r ? r.invoiceCap : null, lastSentAt: last?.created_at || null };
}
/** Barra a criação de faturas além do limite de uma conta não confirmada (conta as não anuladas, de todos os meses). */
export function assertInvoiceAllowed(adding = 1) {
  const r = restriction();
  if (!r) return;
  const n = get("SELECT COUNT(*) n FROM docs WHERE type='invoice' AND status!='void'").n;
  if (n + adding > r.invoiceCap) throw new HttpError(403, 'Confirm your email to keep creating invoices. We sent you a link; you can ask for a new one at the top of the page.', { code: 'email_unconfirmed', cap: r.invoiceCap });
}

/** Cria o link e manda o e-mail. `slug` é a empresa (modo multi). Lança erro se o envio falhar. */
export async function sendConfirmation(user, { slug = '', lang = 'en' } = {}) {
  if (!confirmationAvailable()) throw new HttpError(503, 'Email is not set up on this server yet');
  const recent = get("SELECT COUNT(*) n FROM email_verifications WHERE user_id=? AND created_at > datetime('now','-1 minute')", user.id).n;
  if (recent) throw new HttpError(429, 'We just sent you an email. Wait a minute before asking for another one.');
  const today = get("SELECT COUNT(*) n FROM email_verifications WHERE user_id=? AND created_at > datetime('now','-1 day')", user.id).n;
  if (today >= 5) throw new HttpError(429, 'Too many emails requested today. Check your spam folder or try again tomorrow.');
  const raw = crypto.randomBytes(32).toString('hex');
  run("DELETE FROM email_verifications WHERE user_id=? AND used_at IS NULL", user.id);
  run("INSERT INTO email_verifications(token_hash,user_id,email,expires_at) VALUES(?,?,?,datetime('now','+3 days'))", sha(raw), user.id, user.email);
  const link = `${mailer.appUrl()}/confirm-email?token=${encodeURIComponent(slug ? `${slug}.${raw}` : raw)}`;
  const mail = mailer.confirmEmail(lang, user.name || '', link);
  try { await mailer.sendMail({ to: user.email, ...mail }); }
  catch (e) { run('DELETE FROM email_verifications WHERE token_hash=?', sha(raw)); console.error('confirmation email failed:', e.message); throw new HttpError(502, 'We could not send the email right now. Please try again in a few minutes.'); }
}

/** Usa o link. Devolve {email, already}. Clicar duas vezes (ou um antivírus abrir o link antes) não dá erro. */
export function confirmToken(raw) {
  const r = get("SELECT * FROM email_verifications WHERE token_hash=? AND expires_at > datetime('now')", sha(raw));
  const u = r && get('SELECT * FROM users WHERE id=? AND active=1', r.user_id);
  if (!u || u.email !== r.email) throw new HttpError(400, 'This link is invalid or has expired. Sign in and ask for a new one.');
  if (u.email_verified_at) return { email: u.email, already: true };
  run("UPDATE users SET email_verified_at=datetime('now') WHERE id=?", u.id);
  run("UPDATE email_verifications SET used_at=datetime('now') WHERE token_hash=?", r.token_hash);
  run('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', u.id, u.name, 'confirm', 'user', u.id, 'email confirmed by link');
  return { email: u.email, already: false };
}
