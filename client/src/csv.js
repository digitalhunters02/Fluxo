/** CSV no padrão dos EUA (vírgula): o Excel americano abre direto em colunas. Textos que começam com = + @ viram texto puro, para não executarem como fórmula. */
export function toCsv(rows) {
  const esc = (v) => {
    let s = v == null ? '' : String(v);
    if (typeof v === 'string' && /^([=+@\t\r]|-(?![\d.]))/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\ufeff' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
export function download(name, rows) {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
/** Lê CSV com delimitador , ou ; e aspas. */
export function parseCsv(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
/** MM/DD/YYYY (padrão EUA), YYYY-MM-DD; se o 1º número passar de 12 trata como DD/MM. */
export function parseDate(s) {
  const v = String(s || '').trim();
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) { const iso = `${m[1]}-${m[2]}-${m[3]}`; const real = new Date(`${iso}T00:00:00Z`); return Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== iso ? null : iso; }
  m = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    let mo = Number(m[1]), d = Number(m[2]);
    if (mo > 12 && d <= 12) [mo, d] = [d, mo];
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const real = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== iso ? null : iso; // recusa 02/31 e afins
  }
  return null;
}
