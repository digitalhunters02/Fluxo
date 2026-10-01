// Envio de e-mail do sistema (hoje: recuperação de senha). Escolhe o provedor pelo ambiente:
//   SMTP_HOST (+ SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE=1)  ou  RESEND_API_KEY.  Remetente: MAIL_FROM.
// Sem nenhum dos dois, o recurso fica desligado e a tela avisa como proceder.
import fs from 'node:fs';
import nodemailer from 'nodemailer';

let override = null;
let smtp = null;
/** Para testes: troca o envio real por uma função. */
export const setTransport = (fn) => { override = fn; };
const env = () => process.env;
export const mailConfigured = () => !!(override || env().SMTP_HOST || env().RESEND_API_KEY || env().FLUXO_MAIL_FILE);
/** O link do e-mail usa APP_URL (e não o cabeçalho Host, que um atacante poderia forjar para desviar o link). */
export const appUrl = () => String(env().APP_URL || '').replace(/\/+$/, '');
export const recoveryReady = () => mailConfigured() && /^https?:\/\//.test(appUrl());

export async function sendMail({ to, subject, text }) {
  const from = env().MAIL_FROM || 'Fluxo <no-reply@localhost>';
  if (override) return override({ to, subject, text, from });
  if (env().FLUXO_MAIL_FILE) { fs.appendFileSync(env().FLUXO_MAIL_FILE, `${JSON.stringify({ at: new Date().toISOString(), from, to, subject, text })}\n`, { mode: 0o600 }); return undefined; } // teste local: grava em arquivo em vez de enviar
  if (env().RESEND_API_KEY) {
    const r = await fetch(`${env().RESEND_API_BASE || 'https://api.resend.com'}/emails`, { method: 'POST', headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to: [to], subject, text }) });
    if (!r.ok) throw new Error(`Resend ${r.status}`);
    return undefined;
  }
  if (env().SMTP_HOST) {
    smtp ||= nodemailer.createTransport({ host: env().SMTP_HOST, port: Number(env().SMTP_PORT || 587), secure: env().SMTP_SECURE === '1',
      auth: env().SMTP_USER ? { user: env().SMTP_USER, pass: env().SMTP_PASS || '' } : undefined });
    await smtp.sendMail({ from, to, subject, text });
    return undefined;
  }
  throw new Error('No mail provider configured');
}

const COPY = {
  en: { subject: 'Reset your Fluxo password', body: (link) => `Someone asked to reset the password for your Fluxo account.\n\nOpen this link within 1 hour to choose a new password:\n${link}\n\nIf it was not you, ignore this message. Your password stays the same.` },
  pt: { subject: 'Redefina a sua senha do Fluxo', body: (link) => `Alguém pediu para redefinir a senha da sua conta do Fluxo.\n\nAbra este link em até 1 hora para escolher uma nova senha:\n${link}\n\nSe não foi você, ignore esta mensagem. A sua senha continua a mesma.` },
  es: { subject: 'Restablezca su contraseña de Fluxo', body: (link) => `Alguien pidió restablecer la contraseña de su cuenta de Fluxo.\n\nAbra este enlace en la próxima hora para elegir una contraseña nueva:\n${link}\n\nSi no fue usted, ignore este mensaje. Su contraseña no cambia.` },
};
export const resetEmail = (lang, link) => { const c = COPY[lang] || COPY.en; return { subject: c.subject, text: c.body(link) }; };
