// PDF de fatura/orçamento sem dependências: PDF 1.4 com as fontes padrão Helvetica (não precisam ser embutidas).
// Cobre o que a fatura precisa: cabeçalho da empresa, cliente, tabela de linhas com quebra de linha e de página, totais, notas e rodapé.
// Texto em WinAnsi (acentos do inglês, português e espanhol, €, aspas e travessões); outros símbolos viram "?".
import zlib from 'node:zlib';

/* ------------------------------ métricas das fontes (AFM, 1/1000 do corpo) ------------------------------ */
const ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';
const REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975,
  722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333,
  556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
const W = { reg: Object.fromEntries([...ASCII].map((c, i) => [c, REG[i]])), bold: Object.fromEntries([...ASCII].map((c, i) => [c, BOLD[i]])) };
const charWidth = (ch, bold) => {
  const t = bold ? W.bold : W.reg;
  if (t[ch] !== undefined) return t[ch];
  const base = ch.normalize('NFD')[0];                       // á -> a (mesma largura na Helvetica)
  if (t[base] !== undefined) return t[base];
  return { '€': 556, '£': 556, '¥': 556, '–': 556, '—': 1000, '•': 350, '“': 333, '”': 333, '‘': 222, '’': 222, '…': 1000, '°': 400, '©': 737, '®': 737, ' ': 278, ' ': 278 }[ch] ?? 556;
};
export const textWidth = (s, size, bold = false) => [...String(s)].reduce((w, ch) => w + charWidth(ch, bold), 0) * size / 1000;

/** Texto -> bytes WinAnsi (como string latin1) já escapado para dentro de ( ). */
const WIN = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99, ' ': 0x20 };
export function encode(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    const b = WIN[ch] ?? (c === 0x09 || c === 0x0a || c === 0x0d ? 0x20 : c < 0x20 ? 0x3f : c <= 0xff && !(c >= 0x80 && c <= 0x9f) ? c : 0x3f);
    const x = String.fromCharCode(b);
    out += x === '(' || x === ')' || x === '\\' ? `\\${x}` : x;
  }
  return out;
}

/** Quebra o texto em linhas que cabem em `maxW` pontos (respeita \n; palavras gigantes são partidas). */
export function wrap(text, size, maxW, bold = false) {
  const lines = [];
  for (const para of String(text ?? '').split(/\r?\n/)) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (textWidth(w, size, bold) > maxW) { // palavra maior que a linha
        let k = w.length; while (k > 1 && textWidth(w.slice(0, k), size, bold) > maxW) k--;
        if (cur) { lines.push(cur); cur = ''; }
        lines.push(w.slice(0, k)); w = w.slice(k);
      }
      const next = cur ? `${cur} ${w}` : w;
      if (textWidth(next, size, bold) <= maxW) cur = next; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  return lines;
}

/* ------------------------------------------- escritor de PDF ------------------------------------------- */
const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); const h = m ? m[1] : '4338ca'; return [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(3)).join(' '); };
export class Pdf {
  constructor({ width = 612, height = 792 } = {}) { this.w = width; this.h = height; this.pages = []; this.addPage(); }
  addPage() { this.cur = []; this.pages.push(this.cur); return this.pages.length; }
  /** y é contado do topo da página. align: left | right | center (x é a âncora). */
  text(x, y, s, { size = 10, bold = false, color = '#111827', align = 'left' } = {}) {
    const wd = textWidth(s, size, bold), px = align === 'right' ? x - wd : align === 'center' ? x - wd / 2 : x;
    this.cur.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${hex(color)} rg ${px.toFixed(2)} ${(this.h - y).toFixed(2)} Td (${encode(s)}) Tj ET`);
  }
  rect(x, y, w, h, { fill, stroke, lineWidth = 0.5 } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.cur.push(`${fill ? `${hex(fill)} rg ` : ''}${stroke ? `${hex(stroke)} RG ${lineWidth} w ` : ''}${x.toFixed(2)} ${(this.h - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
  }
  line(x1, y1, x2, y2, { color = '#d1d5db', width = 0.5 } = {}) { this.cur.push(`${hex(color)} RG ${width} w ${x1.toFixed(2)} ${(this.h - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.h - y2).toFixed(2)} l S`); }
  /** Chamado depois de escrever tudo: percorre as páginas já feitas (ex.: "Página 1 de 3"). */
  forEachPage(fn) { const keep = this.cur; this.pages.forEach((p, i) => { this.cur = p; fn(i + 1, this.pages.length); }); this.cur = keep; }
  toBuffer({ title = '', author = '' } = {}) {
    const objs = []; // objs[i] = Buffer do objeto i+1
    const add = (body) => { objs.push(Buffer.from(body, 'latin1')); return objs.length; };
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // Pages: preenchido abaixo
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids = [];
    for (const ops of this.pages) {
      const data = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
      const streamId = objs.length + 2;
      const pageId = add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.w} ${this.h}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`);
      objs.push(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
      kids.push(`${pageId} 0 R`);
    }
    objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${kids.length} >>`, 'latin1');
    const info = add(`<< /Title (${encode(title)}) /Author (${encode(author)}) /Producer (Fluxo) >>`);
    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')], offsets = [];
    let pos = parts[0].length;
    objs.forEach((o, i) => { offsets.push(pos); const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), o, Buffer.from('\nendobj\n', 'latin1')]); parts.push(b); pos += b.length; });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${pos}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

/* --------------------------------------- a fatura / orçamento --------------------------------------- */
const L = {
  en: { invoice: 'INVOICE', estimate: 'ESTIMATE', credit: 'CREDIT MEMO', billTo: 'Bill to', issued: 'Issued', due: 'Due', valid: 'Valid until', desc: 'Description', qty: 'Qty', price: 'Price', tax: 'Tax', total: 'Total', subtotal: 'Subtotal', taxes: 'Taxes', paid: 'Paid', balance: 'Balance due', notes: 'Notes', page: (a, b) => `Page ${a} of ${b}`, view: 'View online' },
  pt: { invoice: 'FATURA', estimate: 'ORÇAMENTO', credit: 'NOTA DE CRÉDITO', billTo: 'Cobrar de', issued: 'Emissão', due: 'Vencimento', valid: 'Válido até', desc: 'Descrição', qty: 'Qtd', price: 'Preço', tax: 'Imposto', total: 'Total', subtotal: 'Subtotal', taxes: 'Impostos', paid: 'Pago', balance: 'Saldo a pagar', notes: 'Observações', page: (a, b) => `Página ${a} de ${b}`, view: 'Ver online' },
  es: { invoice: 'FACTURA', estimate: 'PRESUPUESTO', credit: 'NOTA DE CRÉDITO', billTo: 'Facturar a', issued: 'Emisión', due: 'Vencimiento', valid: 'Válido hasta', desc: 'Descripción', qty: 'Cant.', price: 'Precio', tax: 'Impuesto', total: 'Total', subtotal: 'Subtotal', taxes: 'Impuestos', paid: 'Pagado', balance: 'Saldo a pagar', notes: 'Notas', page: (a, b) => `Página ${a} de ${b}`, view: 'Ver en línea' },
};
const LOCALE = { en: 'en-US', pt: 'pt-BR', es: 'es-US' };

/**
 * @param d documento carregado (loadDoc)  @param o {lang, currency, company:{name,tax_id,address,email,phone}, customer:{address}, brand, footer, link}
 */
export function buildDocPdf(d, o = {}) {
  const lang = L[o.lang] ? o.lang : 'en', c = L[lang], locale = o.locale || LOCALE[lang];
  const money = (cents) => new Intl.NumberFormat(locale, { style: 'currency', currency: o.currency || 'USD' }).format((cents || 0) / 100).replace(/[  ]/g, ' ');
  const dateStr = (s) => (s ? new Date(`${s}T00:00:00Z`).toLocaleDateString(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }) : '');
  const num = (n) => new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(Number(n) || 0);
  const co = o.company || {}, M = 48, R = 612 - M, CW = R - M, BOTTOM = 792 - 60;
  const pdf = new Pdf();
  const GREY = '#6b7280', INK = '#111827', brand = o.brand || '#4338ca';
  pdf.rect(0, 0, 612, 10, { fill: brand });
  let y = 48;
  pdf.text(M, y, co.name || '', { size: 18, bold: true });
  pdf.text(R, y, c[d.type === 'estimate' ? 'estimate' : d.type === 'credit' ? 'credit' : 'invoice'], { size: 20, bold: true, align: 'right', color: brand });
  y += 18; pdf.text(R, y, d.number, { size: 11, align: 'right', bold: true });
  let ly = y;
  for (const t of [...wrap(co.address, 9, 280), co.tax_id, co.email, co.phone].filter(Boolean)) { pdf.text(M, ly, t, { size: 9, color: GREY }); ly += 12; }
  y = Math.max(ly, y + 14) + 14;
  // cliente e datas
  pdf.line(M, y - 6, R, y - 6);
  pdf.text(M, y + 6, c.billTo.toUpperCase(), { size: 8, bold: true, color: GREY });
  let cy = y + 20; pdf.text(M, cy, d.contact_name || '', { size: 11, bold: true });
  for (const t of [...wrap(o.customer?.address, 9, 260), d.contact_email].filter(Boolean)) { cy += 12; pdf.text(M, cy, t, { size: 9, color: GREY }); }
  const meta = [[c.issued, dateStr(d.issue_date)], [d.type === 'estimate' ? c.valid : c.due, dateStr(d.due_date)]];
  meta.forEach(([k, v], i) => { pdf.text(R - 190, y + 6 + i * 16, k.toUpperCase(), { size: 8, bold: true, color: GREY }); pdf.text(R, y + 6 + i * 16, v, { size: 10, align: 'right' }); });
  y = Math.max(cy, y + 40) + 22;
  // tabela
  const X = { qty: M + 302, price: M + 384, tax: M + 428, total: R }, DESC_W = 262;
  const head = () => {
    pdf.rect(M, y - 12, CW, 20, { fill: '#f3f4f6' });
    pdf.text(M + 6, y + 2, c.desc, { size: 9, bold: true });
    pdf.text(X.qty, y + 2, c.qty, { size: 9, bold: true, align: 'right' }); pdf.text(X.price, y + 2, c.price, { size: 9, bold: true, align: 'right' });
    pdf.text(X.tax, y + 2, c.tax, { size: 9, bold: true, align: 'right' }); pdf.text(X.total - 6, y + 2, c.total, { size: 9, bold: true, align: 'right' });
    y += 22;
  };
  head();
  for (const l of d.lines || []) {
    const lines = wrap(l.description || l.item_name || '', 9.5, DESC_W);
    const need = Math.max(1, lines.length) * 12 + 8;
    if (y + need > BOTTOM) { pdf.addPage(); pdf.rect(0, 0, 612, 10, { fill: brand }); y = 48; head(); }
    lines.forEach((t, i) => pdf.text(M + 6, y + i * 12, t, { size: 9.5 }));
    pdf.text(X.qty, y, num(l.qty), { size: 9.5, align: 'right' }); pdf.text(X.price, y, money(l.unit_price), { size: 9.5, align: 'right' });
    pdf.text(X.tax, y, l.tax_rate ? `${num(l.tax_rate)}%` : '', { size: 9.5, align: 'right' }); pdf.text(X.total - 6, y, money(l.amount), { size: 9.5, align: 'right' });
    y += need - 2; pdf.line(M, y - 6, R, y - 6, { color: '#e5e7eb' });
  }
  // totais
  const rows = [[c.subtotal, money(d.subtotal)], [c.taxes, money(d.tax)]];
  if (d.type === 'invoice' && d.paid > 0) rows.push([c.paid, money(-d.paid)]);
  const totalsH = rows.length * 16 + 34 + (d.type === 'invoice' ? 22 : 0);
  if (y + totalsH > BOTTOM) { pdf.addPage(); pdf.rect(0, 0, 612, 10, { fill: brand }); y = 60; }
  y += 8;
  rows.forEach(([k, v]) => { pdf.text(R - 190, y, k, { size: 10, color: GREY }); pdf.text(R - 6, y, v, { size: 10, align: 'right' }); y += 16; });
  pdf.line(R - 200, y - 8, R, y - 8, { color: '#9ca3af' });
  y += 6; pdf.text(R - 190, y, c.total, { size: 12, bold: true }); pdf.text(R - 6, y, money(d.total), { size: 12, bold: true, align: 'right' });
  if (d.type === 'invoice') { y += 20; pdf.text(R - 190, y, c.balance, { size: 11, bold: true, color: brand }); pdf.text(R - 6, y, money(d.balance), { size: 11, bold: true, color: brand, align: 'right' }); }
  // notas e rodapé
  y += 34;
  const note = (t, title) => {
    const ls = wrap(t, 9, CW); if (!ls.length || !ls[0]) return;
    if (y + 16 + ls.length * 12 > BOTTOM) { pdf.addPage(); pdf.rect(0, 0, 612, 10, { fill: brand }); y = 60; }
    if (title) { pdf.text(M, y, title.toUpperCase(), { size: 8, bold: true, color: GREY }); y += 13; }
    ls.forEach((x) => { pdf.text(M, y, x, { size: 9, color: INK }); y += 12; }); y += 8;
  };
  note(d.notes, c.notes); note(o.footer);
  if (o.link) note(`${c.view}: ${o.link}`);
  pdf.forEachPage((n, total) => { pdf.text(R, 792 - 30, c.page(n, total), { size: 8, color: GREY, align: 'right' }); pdf.text(M, 792 - 30, `${co.name || ''} · ${d.number}`, { size: 8, color: GREY }); });
  return pdf.toBuffer({ title: `${c[d.type === 'estimate' ? 'estimate' : d.type === 'credit' ? 'credit' : 'invoice']} ${d.number}`, author: co.name || 'Fluxo' });
}
