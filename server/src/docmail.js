// Envio de fatura/orçamento por e-mail pelo próprio sistema (plano Essentials em diante). O e-mail leva o texto escrito pela pessoa,
// o PDF anexo e o link público do documento (quando a empresa recebe pagamentos online, o mesmo link tem o botão de pagar).
// Cada tentativa fica no histórico do documento (enviada ou com falha). Sem provedor de e-mail, NADA é enviado e o aviso diz isso.
import { get, all, run, insert, getSetting } from './db.js';
import { HttpError, loadDoc } from './accounting.js';
import { mailConfigured, sendMail } from './mailer.js';
import { buildDocPdf } from './pdf.js';

const COPY = {
  en: { invoice: 'Invoice', estimate: 'Estimate', credit: 'Credit memo', hello: 'Hello', body: (kind, n, co) => `Here is ${kind.toLowerCase()} ${n} from ${co}.`, view: 'You can view it here:', pay: 'You can also pay it online from that page.', thanks: 'Thank you!', attached: 'The PDF is attached.' },
  pt: { invoice: 'Fatura', estimate: 'Orçamento', credit: 'Nota de crédito', hello: 'Olá', body: (kind, n, co) => `Segue ${kind.toLowerCase()} ${n} de ${co}.`, view: 'Você pode ver aqui:', pay: 'Você também pode pagar online por essa página.', thanks: 'Obrigado!', attached: 'O PDF segue em anexo.' },
  es: { invoice: 'Factura', estimate: 'Presupuesto', credit: 'Nota de crédito', hello: 'Hola', body: (kind, n, co) => `Aquí tiene ${kind.toLowerCase()} ${n} de ${co}.`, view: 'Puede verla aquí:', pay: 'También puede pagarla en línea desde esa página.', thanks: '¡Gracias!', attached: 'El PDF va adjunto.' },
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const HOURLY_CAP = 60; // e-mails de documentos por empresa por hora (trava contra abuso/erro)

export const emailReady = () => mailConfigured();
const copy = () => COPY[getSetting('lang', 'en')] || COPY.en;
const kindOf = (d) => copy()[d.type];

function loadSendable(id) {
  const d = loadDoc(id);
  if (!d || !['invoice', 'estimate', 'credit'].includes(d.type)) throw new HttpError(404, 'Document not found');
  return d;
}
/** Rascunho do e-mail (o que a tela mostra para a pessoa editar). */
export function draftFor(id) {
  const d = loadSendable(id), c = copy(), company = getSetting('company_name', '');
  return {
    to: d.contact_email || '', subject: `${kindOf(d)} ${d.number} — ${company}`,
    message: `${c.hello} ${d.contact_name},\n\n${c.body(kindOf(d), d.number, company)}\n\n${c.thanks}\n${company}`,
    sendable: !['draft', 'void'].includes(d.status),
  };
}
export const history = (id) => all('SELECT id, to_addr, subject, with_pdf, status, error, user_name, created_at FROM doc_emails WHERE doc_id=? ORDER BY id DESC LIMIT 50', id)
  .map((r) => ({ ...r, with_pdf: !!r.with_pdf }));

/** PDF do documento com os dados da empresa (o mesmo anexo do e-mail e do botão "baixar PDF"). */
export function pdfFor(id, link = '') {
  const d = loadSendable(id), lang = getSetting('lang', 'en');
  const s = (k) => getSetting(k, '');
  const cust = get('SELECT address FROM contacts WHERE id=?', d.contact_id);
  return { d, buffer: buildDocPdf(d, { lang, locale: s('locale') || undefined, currency: s('currency') || 'USD', brand: s('brand_color'), footer: s('invoice_footer'), link,
    company: { name: s('company_name'), tax_id: s('company_tax_id'), address: s('company_address'), email: s('company_email'), phone: s('company_phone') }, customer: { address: cust?.address || '' } }) };
}
const safeName = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

/**
 * Envia e registra no histórico. `body.message` é o texto inteiro escrito/editado pela pessoa (vazio = texto padrão);
 * o link do documento (e o aviso de pagamento online) é sempre acrescentado no fim.
 */
export async function emailDocument(id, { to, subject, message, attach_pdf = true }, link, user = {}) {
  if (!mailConfigured()) throw new HttpError(503, 'Email is not set up on this server yet');
  const d = loadSendable(id);
  if (d.status === 'draft' || d.status === 'void') throw new HttpError(400, 'Issue the document before sending it');
  const addr = String(to || d.contact_email || '').trim();
  if (!EMAIL.test(addr)) throw new HttpError(400, 'Enter a valid email address');
  if (get("SELECT COUNT(*) n FROM doc_emails WHERE created_at > datetime('now','-1 hour')").n >= HOURLY_CAP) throw new HttpError(429, 'Too many emails sent in the last hour. Please wait a little and try again.');
  const c = copy(), dflt = draftFor(id);
  const subj = String(subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || dflt.subject;
  const msg = String(message || '').trim().slice(0, 4000) || dflt.message;
  const withPdf = attach_pdf !== false;
  const payNote = d.type === 'invoice' && getSetting('connect_ready', '0') === '1' && d.balance > 0 ? `\n${c.pay}` : '';
  const text = `${msg}\n\n${withPdf ? `${c.attached}\n` : ''}${c.view} ${link}${payNote}`;
  const attachments = withPdf ? [{ filename: `${safeName(`${kindOf(d)}-${d.number}`)}.pdf`, content: pdfFor(id, link).buffer, contentType: 'application/pdf' }] : [];
  const rec = (status, error = '') => insert('INSERT INTO doc_emails(doc_id,to_addr,subject,with_pdf,status,error,user_id,user_name) VALUES(?,?,?,?,?,?,?,?)', id, addr, subj, withPdf ? 1 : 0, status, String(error).slice(0, 300), user.id ?? null, user.name || '');
  try { await sendMail({ to: addr, subject: subj, text, attachments }); }
  catch (e) {
    rec('failed', e.message); console.error('invoice email failed:', e.message);
    throw new HttpError(502, 'The email could not be sent. Check the address and try again. If it keeps failing, ask the administrator to check the email settings.');
  }
  const eid = rec('sent');
  run('UPDATE docs SET emailed_at=CURRENT_TIMESTAMP, status=CASE WHEN status=\'draft\' THEN \'sent\' ELSE status END WHERE id=?', id);
  return { id: eid, sentTo: addr, withPdf, emailed_at: get('SELECT emailed_at FROM docs WHERE id=?', id).emailed_at };
}
