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

/** Envia um e-mail de texto. `attachments`: [{ filename, content: Buffer, contentType }] (ex.: o PDF da fatura). Lança erro se não conseguir: quem chama nunca deve dizer "enviado" sem isso. */
export async function sendMail({ to, subject, text, attachments }) {
  const from = env().MAIL_FROM || 'Fluxo <no-reply@localhost>';
  const files = (attachments || []).filter((a) => a && a.filename && Buffer.isBuffer(a.content));
  if (override) return override({ to, subject, text, from, attachments: files });
  if (env().FLUXO_MAIL_FILE) { // teste local: grava em arquivo em vez de enviar (anexos: só nome e tamanho)
    fs.appendFileSync(env().FLUXO_MAIL_FILE, `${JSON.stringify({ at: new Date().toISOString(), from, to, subject, text, attachments: files.map((a) => ({ filename: a.filename, bytes: a.content.length })) })}\n`, { mode: 0o600 });
    return undefined;
  }
  if (env().RESEND_API_KEY) {
    const body = { from, to: [to], subject, text, ...(files.length ? { attachments: files.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })) } : {}) };
    const r = await fetch(`${env().RESEND_API_BASE || 'https://api.resend.com'}/emails`, { method: 'POST', headers: { Authorization: `Bearer ${env().RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Resend ${r.status}`);
    return undefined;
  }
  if (env().SMTP_HOST) {
    smtp ||= nodemailer.createTransport({ host: env().SMTP_HOST, port: Number(env().SMTP_PORT || 587), secure: env().SMTP_SECURE === '1',
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
      auth: env().SMTP_USER ? { user: env().SMTP_USER, pass: env().SMTP_PASS || '' } : undefined });
    await smtp.sendMail({ from, to, subject, text, attachments: files.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType || 'application/octet-stream' })) });
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

const CONFIRM = {
  en: { subject: 'Confirm your email for Fluxo', body: (name, link) => `Hi ${name},\n\nWelcome to Fluxo! Please confirm that this is your email address:\n${link}\n\nThe link works for 3 days. Until you confirm, a Free account can create up to 3 invoices; after that, everything works as usual.\n\nIf you did not create this account, ignore this message and nothing will happen.` },
  pt: { subject: 'Confirme o seu e-mail no Fluxo', body: (name, link) => `Olá ${name},\n\nBem-vindo ao Fluxo! Confirme que este é o seu e-mail:\n${link}\n\nO link vale por 3 dias. Enquanto você não confirmar, uma conta Free pode criar até 3 faturas; depois disso, tudo funciona normalmente.\n\nSe você não criou esta conta, ignore esta mensagem e nada acontece.` },
  es: { subject: 'Confirme su correo en Fluxo', body: (name, link) => `Hola ${name},\n\n¡Bienvenido a Fluxo! Confirme que este es su correo electrónico:\n${link}\n\nEl enlace vale por 3 días. Mientras no lo confirme, una cuenta Free puede crear hasta 3 facturas; después todo funciona con normalidad.\n\nSi usted no creó esta cuenta, ignore este mensaje y no pasará nada.` },
};
export const confirmEmail = (lang, name, link) => { const c = CONFIRM[lang] || CONFIRM.en; return { subject: c.subject, text: c.body(name, link) }; };

const IDLE = {
  en: { subject: 'Your free Fluxo account will be deleted on {date} unless you sign in', body: (co, last, date, url) => `Hello,\n\nThe free Fluxo account "${co}" has not been used since ${last}. To keep our servers tidy and protect your data, free accounts that stay unused for 12 months are deleted.\n\nYour account will be deleted on ${date}.\n\nTo keep it, just sign in before that date: ${url}\nTo keep a copy of your records, sign in and use Settings → Company → Download all my data (ZIP, with your records in CSV).\n\nPaid plans are never deleted this way. If you no longer need the account, you can ignore this message.` },
  pt: { subject: 'Sua conta gratuita do Fluxo será apagada em {date} se você não entrar', body: (co, last, date, url) => `Olá,\n\nA conta gratuita "${co}" do Fluxo não é usada desde ${last}. Para manter os servidores em ordem e proteger os seus dados, contas gratuitas paradas há 12 meses são apagadas.\n\nSua conta será apagada em ${date}.\n\nPara mantê-la, basta entrar antes dessa data: ${url}\nPara guardar uma cópia dos seus registros, entre e use Configurações → Empresa → Baixar todos os meus dados (ZIP, com os seus registros em CSV).\n\nPlanos pagos nunca são apagados assim. Se você não precisa mais da conta, pode ignorar esta mensagem.` },
  es: { subject: 'Su cuenta gratuita de Fluxo se eliminará el {date} si no inicia sesión', body: (co, last, date, url) => `Hola,\n\nLa cuenta gratuita "${co}" de Fluxo no se usa desde ${last}. Para mantener los servidores en orden y proteger sus datos, las cuentas gratuitas sin uso durante 12 meses se eliminan.\n\nSu cuenta se eliminará el ${date}.\n\nPara conservarla, solo inicie sesión antes de esa fecha: ${url}\nPara guardar una copia de sus registros, inicie sesión y use Configuración → Empresa → Descargar todos mis datos (ZIP, con sus registros en CSV).\n\nLos planes de pago nunca se eliminan así. Si ya no necesita la cuenta, puede ignorar este mensaje.` },
};
export const idleWarningEmail = (lang, { company, lastUse, deleteOn, url }) => { const c = IDLE[lang] || IDLE.en; return { subject: c.subject.replace('{date}', deleteOn), text: c.body(company, lastUse, deleteOn, url) }; };
