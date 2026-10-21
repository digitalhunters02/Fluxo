// PDFs da folha "Plano B" com pdf-lib.
//
// Os PDFs oficiais preenchíveis do IRS (f941.pdf, f940.pdf, f941sb.pdf, fw2.pdf, f1099nec.pdf) NÃO puderam ser baixados do ambiente onde isto
// foi construído. Por isso o Fluxo gera uma "planilha para transcrever" (worksheet): título claro, número de cada linha do formulário oficial e
// o valor. Ela NÃO imita o formulário oficial. Para trocar pelo PDF oficial preenchido (veja README → "Switching to the official IRS PDFs"):
//   1) baixe o PDF do ano em irs.gov e ponha em FLUXO_IRS_FORMS_DIR (ex.: f941-2026.pdf);
//   2) liste os campos com `node server/src/payrollPdf.js fields <arquivo.pdf>` e preencha o mapa linha → campo em IRS_FIELD_MAPS;
//   3) com arquivo + mapa presentes, fillOfficial() é usado no lugar da planilha (o resto já está pronto e testado com um PDF de formulário).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/** Mapa linha do Fluxo → nome do campo AcroForm do PDF oficial, por formulário e ano. Vazio até alguém conferir os nomes no PDF oficial. */
export const IRS_FIELD_MAPS = {};
export const officialPath = (form, year) => {
  const dir = process.env.FLUXO_IRS_FORMS_DIR;
  if (!dir) return null;
  const f = path.join(dir, `${form}-${year}.pdf`);
  return fs.existsSync(f) ? f : null;
};
export const officialAvailable = (form, year) => !!(officialPath(form, year) && IRS_FIELD_MAPS[`${form}-${year}`]);

/** Preenche um PDF com formulário (AcroForm). values: { campo: texto | true/false }. Campo inexistente é ignorado e devolvido em `missing`. */
export async function fillAcroForm(bytes, values) {
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  const names = new Set(form.getFields().map((f) => f.getName()));
  const missing = [];
  for (const [name, v] of Object.entries(values)) {
    if (!names.has(name)) { missing.push(name); continue; }
    const field = form.getField(name);
    if (typeof v === 'boolean') { if (field.check) (v ? field.check() : field.uncheck()); }
    else if (field.setText) field.setText(String(v));
  }
  return { bytes: await doc.save(), missing };
}
export async function listFields(bytes) {
  const doc = await PDFDocument.load(bytes);
  return doc.getForm().getFields().map((f) => ({ name: f.getName(), type: f.constructor.name }));
}
export async function fillOfficial(form, year, lineValues) {
  const map = IRS_FIELD_MAPS[`${form}-${year}`];
  const values = {};
  for (const [line, field] of Object.entries(map)) if (lineValues[line] !== undefined) values[field] = lineValues[line];
  return (await fillAcroForm(fs.readFileSync(officialPath(form, year)), values)).bytes;
}

/* -------------------------------------------- planilhas -------------------------------------------- */
const money = (c) => { const n = Math.round(Number(c) || 0); const s = (Math.abs(n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return n < 0 ? `-$${s}` : `$${s}`; };
export { money as usd };
/** pdf-lib só escreve WinAnsi com as fontes padrão: troca o resto por equivalentes. */
const safe = (s) => String(s ?? '').replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

class Sheet {
  async init() {
    this.doc = await PDFDocument.create();
    this.font = await this.doc.embedFont(StandardFonts.Helvetica);
    this.bold = await this.doc.embedFont(StandardFonts.HelveticaBold);
    this.page = null; this.y = 0;
    return this;
  }
  newPage() { this.page = this.doc.addPage([612, 792]); this.y = 750; }
  ensure(h) { if (!this.page || this.y - h < 60) { this.newPage(); this.footer(); } }
  footer() { this.text('Prepared by Fluxo from your payroll records. Fluxo does not file, deposit or pay anything for you.', 40, 30, { size: 7, color: rgb(0.45, 0.45, 0.45) }); }
  text(s, x, y, { size = 10, bold = false, color = rgb(0.1, 0.1, 0.1) } = {}) { this.page.drawText(safe(s), { x, y, size, font: bold ? this.bold : this.font, color }); }
  width(s, size = 10, bold = false) { return (bold ? this.bold : this.font).widthOfTextAtSize(safe(s), size); }
  wrapLines(s, size, maxW, bold = false) {
    const out = []; let cur = '';
    for (const w of safe(s).split(/\s+/)) { const n = cur ? `${cur} ${w}` : w; if (this.width(n, size, bold) > maxW && cur) { out.push(cur); cur = w; } else cur = n; }
    if (cur) out.push(cur); return out;
  }
  title(t, sub) {
    this.ensure(80);
    this.text(t, 40, this.y, { size: 15, bold: true }); this.y -= 18;
    for (const l of this.wrapLines(sub || '', 9, 530)) { this.text(l, 40, this.y, { size: 9, color: rgb(0.35, 0.35, 0.35) }); this.y -= 12; }
    this.y -= 4;
  }
  notice(t) {
    const ls = this.wrapLines(t, 9, 515, true); const h = ls.length * 12 + 10;
    this.ensure(h + 6);
    this.page.drawRectangle({ x: 36, y: this.y - h + 10, width: 540, height: h, color: rgb(1, 0.96, 0.85), borderColor: rgb(0.85, 0.6, 0.1), borderWidth: 0.8 });
    let y = this.y; for (const l of ls) { this.text(l, 44, y, { size: 9, bold: true, color: rgb(0.45, 0.3, 0) }); y -= 12; }
    this.y -= h + 8;
  }
  heading(t) { this.ensure(30); this.y -= 6; this.text(t, 40, this.y, { size: 11, bold: true }); this.y -= 6; this.page.drawLine({ start: { x: 40, y: this.y }, end: { x: 572, y: this.y }, thickness: 0.6, color: rgb(0.7, 0.7, 0.7) }); this.y -= 14; }
  row(line, label, value, { bold = false } = {}) {
    const ls = this.wrapLines(label, 9, 360, bold); const h = Math.max(1, ls.length) * 11 + 3;
    this.ensure(h);
    this.text(line, 40, this.y, { size: 9, bold: true });
    let y = this.y; for (const l of ls) { this.text(l, 92, y, { size: 9, bold }); y -= 11; }
    const v = typeof value === 'number' ? money(value) : String(value ?? '');
    this.text(v, 572 - this.width(v, 9.5, true), this.y, { size: 9.5, bold: true });
    this.y -= h;
  }
  kv(label, value) { this.ensure(13); this.text(label, 40, this.y, { size: 9, color: rgb(0.35, 0.35, 0.35) }); this.text(value, 200, this.y, { size: 9 }); this.y -= 12; }
  async bytes() { return Buffer.from(await this.doc.save()); }
}
const header = (s, title, subtitle, er) => {
  s.title(title, subtitle);
  s.kv('Employer', `${er.employer_name || '-'}   EIN ${er.employer_ein ? `${er.employer_ein.slice(0, 2)}-${er.employer_ein.slice(2)}` : '(missing)'}`);
  s.kv('Address', [er.employer_address, er.employer_city, er.employer_state, er.employer_zip].filter(Boolean).join(', ') || '(missing)');
};
const REVIEW = 'Worksheet only - this is NOT the official IRS form. Transcribe these amounts to the official form (irs.gov). Review, sign and file it yourself (paper or your e-file provider). Fluxo does not file or pay anything.';

export async function form941Pdf(f, er) {
  const s = await (new Sheet()).init(); s.newPage(); s.footer();
  const L = f.lines;
  header(s, 'Form 941 worksheet (transcribe to the official form)', `Employer's Quarterly Federal Tax Return - ${f.year}, quarter ${f.quarter} (${f.from} to ${f.to})`, er);
  s.notice(REVIEW);
  s.heading('Part 1 - Answer these questions for this quarter');
  s.row('1', 'Number of employees who received wages, tips, or other compensation for the pay period including the 12th of the last month of the quarter', String(L[1]));
  s.row('2', 'Wages, tips, and other compensation', L[2]);
  s.row('3', 'Federal income tax withheld from wages, tips, and other compensation', L[3]);
  s.row('4', 'If no wages, tips, and other compensation are subject to social security or Medicare tax, check here', L[4] ? 'Check' : 'Leave blank');
  s.row('5a', `Taxable social security wages: column 1 ${money(L['5a1'])} x 0.124 =`, L['5a2']);
  s.row('5b', `Taxable social security tips: column 1 ${money(L['5b1'])} x 0.124 =`, L['5b2']);
  s.row('5c', `Taxable Medicare wages & tips: column 1 ${money(L['5c1'])} x 0.029 =`, L['5c2']);
  s.row('5d', `Taxable wages & tips subject to Additional Medicare Tax withholding: column 1 ${money(L['5d1'])} x 0.009 =`, L['5d2']);
  s.row('5e', 'Total social security and Medicare taxes (5a + 5b + 5c + 5d, column 2)', L['5e']);
  s.row('5f', 'Section 3121(q) Notice and Demand - tax due on unreported tips', L['5f']);
  s.row('6', 'Total taxes before adjustments (lines 3 + 5e + 5f)', L[6], { bold: true });
  s.row('7', 'Current quarter\'s adjustment for fractions of cents', L[7]);
  s.row('8', 'Current quarter\'s adjustment for sick pay', L[8]);
  s.row('9', 'Current quarter\'s adjustments for tips and group-term life insurance', L[9]);
  s.row('10', 'Total taxes after adjustments (lines 6 through 9)', L[10], { bold: true });
  s.row('11', 'Qualified small business payroll tax credit for increasing research activities (Form 8974)', L[11]);
  s.row('12', 'Total taxes after adjustments and nonrefundable credits (line 10 - line 11)', L[12], { bold: true });
  s.row('13', 'Total deposits for this quarter, including overpayment applied from a prior quarter (deposits recorded in Fluxo)', L[13]);
  s.row('14', 'Balance due (if line 12 is more than line 13)', L[14], { bold: true });
  s.row('15', 'Overpayment (if line 13 is more than line 12) - choose apply to next return or send a refund on the form', L[15]);
  s.heading('Part 2 - Tell us about your deposit schedule and tax liability for this quarter');
  if (L[16] === 'small') s.row('16', 'Check box 1: line 12 is less than $2,500 (and no $100,000 next-day obligation). Do not fill the monthly liability.', 'Box 1');
  else if (L[16] === 'monthly') {
    s.row('16', 'Check box 2: monthly schedule depositor for the entire quarter. Tax liability:', 'Box 2');
    s.row('', 'Month 1', L['16m1']); s.row('', 'Month 2', L['16m2']); s.row('', 'Month 3', L['16m3']); s.row('', 'Total liability for quarter (must equal line 12)', L['16total'], { bold: true });
  } else s.row('16', 'Check box 3: semiweekly schedule depositor for any part of this quarter. Complete Schedule B (Form 941) and attach it.', 'Box 3');
  s.heading('Part 3, Part 4 and Part 5');
  s.row('17-18', 'Business closed or seasonal employer: answer on the official form if it applies', '');
  s.row('', 'Third-party designee, signature, date, name, title and phone: complete and sign on the official form', '');
  if (f.scheduleB) {
    s.newPage(); s.footer();
    header(s, 'Schedule B (Form 941) worksheet (transcribe to the official form)', `Report of Tax Liability for Semiweekly Schedule Depositors - ${f.year}, quarter ${f.quarter}`, er);
    s.notice(REVIEW);
    const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    f.scheduleB.forEach((m, i) => {
      s.heading(`Month ${i + 1} - ${MONTHS[m.month - 1]}`);
      const days = m.daily.map((v, d) => [d + 1, v]).filter(([, v]) => v);
      if (!days.length) s.row('', 'No tax liability this month', 0);
      for (const [d, v] of days) s.row(String(d), `Tax liability for day ${d}`, v);
      s.row('', `Tax liability for Month ${i + 1}`, m.total, { bold: true });
    });
    s.row('', 'Total liability for the quarter (Month 1 + Month 2 + Month 3) - must equal Form 941 line 12', f.scheduleB.reduce((a, m) => a + m.total, 0), { bold: true });
  }
  return s.bytes();
}

export async function form940Pdf(f, er) {
  const s = await (new Sheet()).init(); s.newPage(); s.footer();
  const L = f.lines;
  header(s, 'Form 940 worksheet (transcribe to the official form)', `Employer's Annual Federal Unemployment (FUTA) Tax Return - ${f.year}`, er);
  s.notice(REVIEW);
  s.heading('Part 1 - Tell us about your return');
  s.row('1a', 'If you had to pay state unemployment tax in one state only, enter the state abbreviation', L['1a'] || '(set your state in Settings > Payroll)');
  s.row('1b', 'If you had to pay state unemployment tax in more than one state, you are a multi-state employer', 'No');
  s.row('2', 'If you paid wages in a state that is subject to CREDIT REDUCTION (not modeled by Fluxo - check Schedule A)', 'Check the official list');
  s.heading('Part 2 - Determine your FUTA tax before adjustments');
  s.row('3', 'Total payments to all employees', L[3]);
  s.row('4', 'Payments exempt from FUTA tax', L[4]);
  s.row('5', 'Total of payments made to each employee in excess of $7,000', L[5]);
  s.row('6', 'Subtotal (line 4 + line 5)', L[6]);
  s.row('7', 'Total taxable FUTA wages (line 3 - line 6)', L[7], { bold: true });
  s.row('8', 'FUTA tax before adjustments (line 7 x 0.006)', L[8], { bold: true });
  s.heading('Part 3 - Determine your adjustments');
  s.row('9', 'If ALL of the taxable FUTA wages you paid were excluded from state unemployment tax (line 7 x 0.054)', L[9]);
  s.row('10', 'If SOME of the taxable FUTA wages were excluded from state unemployment tax, or you paid state tax late', L[10]);
  s.row('11', 'If credit reduction applies, enter the total from Schedule A (Form 940)', L[11]);
  s.heading('Part 4 - Determine your FUTA tax and balance due or overpayment');
  s.row('12', 'Total FUTA tax after adjustments (lines 8 + 9 + 10 + 11)', L[12], { bold: true });
  s.row('13', 'FUTA tax deposited for the year, including any overpayment applied from a prior year (deposits recorded in Fluxo)', L[13]);
  s.row('14', 'Balance due (if line 12 is more than line 13)', L[14], { bold: true });
  s.row('15', 'Overpayment (if line 13 is more than line 12)', L[15]);
  s.heading(`Part 5 - Report your FUTA tax liability by quarter${L.part5Required ? '' : ' (only required if line 12 is more than $500)'}`);
  s.row('16a', '1st quarter (January 1 - March 31)', L['16a']); s.row('16b', '2nd quarter (April 1 - June 30)', L['16b']);
  s.row('16c', '3rd quarter (July 1 - September 30)', L['16c']); s.row('16d', '4th quarter (October 1 - December 31)', L['16d']);
  s.row('17', 'Total tax liability for the year (16a + 16b + 16c + 16d = line 17) - must equal line 12', L[17], { bold: true });
  s.row('', 'Parts 6 and 7 (third-party designee and signature): complete and sign on the official form', '');
  return s.bytes();
}

export async function w2Pdf(data) {
  const s = await (new Sheet()).init();
  const er = data.employer;
  for (const r of data.rows) {
    s.newPage(); s.footer();
    s.title(`Form W-2 worksheet - ${data.year} - employee copy`, 'Wage and Tax Statement amounts from your payroll records. Not the official IRS form: the employer must issue the official W-2 (Copies B, C and 2) or an approved substitute.');
    s.notice('Worksheet only - this is NOT the official Form W-2. Your employer files Copy A with the SSA. Review the amounts and keep this for your records.');
    s.kv('a  Employee\'s SSN', r.ssn_masked || '(missing)');
    s.kv('b  Employer EIN', er.employer_ein ? `${er.employer_ein.slice(0, 2)}-${er.employer_ein.slice(2)}` : '(missing)');
    s.kv('c  Employer', [er.employer_name, er.employer_address, er.employer_city, er.employer_state, er.employer_zip].filter(Boolean).join(', '));
    s.kv('e/f  Employee', [r.name, r.address, r.city, r.state, r.zip].filter(Boolean).join(', '));
    s.y -= 6;
    s.heading('Boxes');
    s.row('1', 'Wages, tips, other compensation', r.box1); s.row('2', 'Federal income tax withheld', r.box2);
    s.row('3', 'Social security wages', r.box3); s.row('4', 'Social security tax withheld', r.box4);
    s.row('5', 'Medicare wages and tips', r.box5); s.row('6', 'Medicare tax withheld', r.box6);
    if (r.box12.length) for (const x of r.box12) s.row('12', `Code ${x.code}`, x.amount); else s.row('12', 'Codes', 'None');
    s.row('13', 'Retirement plan', r.box13_retirement ? 'Checked' : 'Not checked');
    s.row('15', 'State / Employer\'s state ID number', [r.box15_state, r.box15_id].filter(Boolean).join(' ') || '-');
    s.row('16', 'State wages, tips, etc.', r.box16); s.row('17', 'State income tax', r.box17);
  }
  s.newPage(); s.footer();
  s.title(`Form W-3 worksheet - ${data.year} (transcribe to the official form)`, 'Transmittal of Wage and Tax Statements: totals of all W-2s above. When you upload the EFW2 file to SSA Business Services Online, the W-3 is created there.');
  s.notice(REVIEW);
  const w = data.w3;
  s.row('c', 'Total number of Forms W-2', String(w.count));
  s.row('1', 'Wages, tips, other compensation', w.box1); s.row('2', 'Federal income tax withheld', w.box2);
  s.row('3', 'Social security wages', w.box3); s.row('4', 'Social security tax withheld', w.box4);
  s.row('5', 'Medicare wages and tips', w.box5); s.row('6', 'Medicare tax withheld', w.box6);
  for (const [c, v] of Object.entries(w.box12)) if (v) s.row('12a', `Deferred compensation (code ${c})`, v);
  s.row('16', 'State wages, tips, etc.', w.box16); s.row('17', 'State income tax', w.box17);
  return s.bytes();
}

export async function nec1099Pdf(d) {
  const s = await (new Sheet()).init();
  const p = d.payer;
  for (const r of d.rows) {
    s.newPage(); s.footer();
    s.title(`Form 1099-NEC worksheet - ${d.year} - recipient copy`, 'Nonemployee Compensation. Not the official IRS form: file the official 1099-NEC (IRIS or paper Copy A) and give the recipient Copy B.');
    s.notice('Worksheet only - this is NOT the official Form 1099-NEC. Review, file and furnish the official form yourself. Fluxo does not file anything.');
    s.kv('Payer', [p.employer_name, p.employer_address, p.employer_city, p.employer_state, p.employer_zip].filter(Boolean).join(', '));
    s.kv('Payer TIN', p.employer_ein ? `${p.employer_ein.slice(0, 2)}-${p.employer_ein.slice(2)}` : '(missing)');
    s.kv('Recipient', [r.name, r.address.street, r.address.city, r.address.state, r.address.zip].filter(Boolean).join(', '));
    s.kv('Recipient TIN', r.tin_masked || '(missing)');
    s.kv('Account number', `C${r.id}`);
    s.y -= 6; s.heading('Boxes');
    s.row('1', 'Nonemployee compensation', r.box1);
    s.row('2', 'Payer made direct sales totaling $5,000 or more of consumer products to recipient for resale', 'Not checked');
    s.row('4', 'Federal income tax withheld', 0);
    s.row('5-7', 'State tax withheld / State, payer\'s state no. / State income', 'Not reported by Fluxo');
  }
  return s.bytes();
}

/* CLI: node server/src/payrollPdf.js fields <arquivo.pdf>  → lista os campos do formulário (para montar IRS_FIELD_MAPS) */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv[2] === 'fields') {
  listFields(fs.readFileSync(process.argv[3])).then((f) => { for (const x of f) console.log(`${x.type}\t${x.name}`); });
}
