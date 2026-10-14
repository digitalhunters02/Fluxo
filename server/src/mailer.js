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

const INVITE = {
  en: { subject: (co) => `${co} invited you to view their books in Fluxo`, body: (co, who, link) => `${who ? `${who} at ` : ''}${co} invited you, as their accountant, to view their financial records in Fluxo.\n\nYou will have read-only access: you can look at the numbers and reports but you cannot change anything. The owner can end your access at any time.\n\nOpen this link within 7 days to create your password:\n${link}\n\nIf you were not expecting this, ignore this message.` },
  pt: { subject: (co) => `${co} convidou você para ver a contabilidade no Fluxo`, body: (co, who, link) => `${who ? `${who}, da empresa ` : ''}${co} convidou você, como contador(a), para ver os números da empresa no Fluxo.\n\nO acesso é só de leitura: você vê os números e relatórios, mas não altera nada. O dono pode encerrar o seu acesso a qualquer momento.\n\nAbra este link em até 7 dias para criar a sua senha:\n${link}\n\nSe você não esperava este convite, ignore esta mensagem.` },
  es: { subject: (co) => `${co} le invitó a ver su contabilidad en Fluxo`, body: (co, who, link) => `${who ? `${who}, de ` : ''}${co} le invitó, como contador(a), a ver los números de la empresa en Fluxo.\n\nEl acceso es solo de lectura: puede ver los números y reportes, pero no cambia nada. El dueño puede terminar su acceso en cualquier momento.\n\nAbra este enlace en los próximos 7 días para crear su contraseña:\n${link}\n\nSi no esperaba esta invitación, ignore este mensaje.` },
};
export const accountantInviteEmail = (lang, { company, inviter, link }) => { const c = INVITE[lang] || INVITE.en; return { subject: c.subject(company), text: c.body(company, inviter, link) }; };
