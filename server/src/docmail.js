// Envio de fatura/orçamento por e-mail pelo próprio sistema (plano Essentials). O e-mail leva o link público do documento;
// quando a empresa recebe pagamentos online, o mesmo link tem o botão de pagar.
import { get, run, getSetting } from './db.js';
import { HttpError, loadDoc } from './accounting.js';
import { mailConfigured, sendMail } from './mailer.js';

const COPY = {
  en: { invoice: 'Invoice', estimate: 'Estimate', credit: 'Credit memo', hello: 'Hello', body: (kind, n, co) => `Here is ${kind.toLowerCase()} ${n} from ${co}.`, view: 'You can view it here:', pay: 'You can also pay it online from that page.', thanks: 'Thank you!' },
  pt: { invoice: 'Fatura', estimate: 'Orçamento', credit: 'Nota de crédito', hello: 'Olá', body: (kind, n, co) => `Segue ${kind.toLowerCase()} ${n} de ${co}.`, view: 'Você pode ver aqui:', pay: 'Você também pode pagar online por essa página.', thanks: 'Obrigado!' },
  es: { invoice: 'Factura', estimate: 'Presupuesto', credit: 'Nota de crédito', hello: 'Hola', body: (kind, n, co) => `Aquí tiene ${kind.toLowerCase()} ${n} de ${co}.`, view: 'Puede verla aquí:', pay: 'También puede pagarla en línea desde esa página.', thanks: '¡Gracias!' },
};

export const emailReady = () => mailConfigured();

export async function emailDocument(id, { to, message }, link) {
  if (!mailConfigured()) throw new HttpError(503, 'Email is not set up on this server yet');
  const d = loadDoc(id);
  if (!d || !['invoice', 'estimate', 'credit'].includes(d.type)) throw new HttpError(404, 'Document not found');
  if (d.status === 'draft' || d.status === 'void') throw new HttpError(400, 'Issue the document before sending it');
  const addr = String(to || d.contact_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) throw new HttpError(400, 'Enter a valid email address');
  const lang = getSetting('lang', 'en'), c = COPY[lang] || COPY.en, company = getSetting('company_name', '');
  const kind = c[d.type];
  const payNote = d.type === 'invoice' && getSetting('connect_ready', '0') === '1' && d.balance > 0 ? `\n${c.pay}` : '';
  const text = `${c.hello} ${d.contact_name},\n\n${String(message || '').trim() ? `${String(message).trim().slice(0, 1500)}\n\n` : ''}${c.body(kind, d.number, company)}\n${c.view} ${link}${payNote}\n\n${c.thanks}\n${company}`;
  await sendMail({ to: addr, subject: `${kind} ${d.number} — ${company}`, text });
  run('UPDATE docs SET emailed_at=CURRENT_TIMESTAMP, status=CASE WHEN status=\'draft\' THEN \'sent\' ELSE status END WHERE id=?', id);
  return { sentTo: addr, emailed_at: get('SELECT emailed_at FROM docs WHERE id=?', id).emailed_at };
}
