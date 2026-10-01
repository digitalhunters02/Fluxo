// Percorre o frontend e lista (ou troca) textos de interface.  uso: node tools/i18n-scan.mjs [--apply map.json]
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;

const SKIP_ATTRS = new Set(['className', 'style', 'type', 'inputMode', 'autoComplete', 'accept', 'key', 'id', 'name', 'href', 'to', 'target', 'rel', 'viewBox', 'fill', 'stroke', 'd', 'role', 'htmlFor', 'for', 'src', 'width', 'height', 'minLength', 'min', 'max', 'step', 'colSpan', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin', 'x', 'y', 'rx', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'textAnchor', 'fontSize', 'end', 'value', 'format']);
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (/\.(jsx?|mjs)$/.test(f) && !/^i18n/.test(f)) files.push(p); } };
walk('client/src');

const codeish = (s) => /^[a-z][a-z0-9_\-]*$/.test(s) || /^[/#.]/.test(s) || /^https?:/.test(s) || /^[\d\s.,:%\-+/()$€]*$/.test(s)
  || (/\s/.test(s) && s.split(/\s+/).every((w) => /^[a-z0-9\[\]\/:.\-!%#_@]+$/.test(w) && /[-:\[\]\/]|^(flex|grid|block|hidden|text-\w+|font-\w+|border|rounded|px-\d|py-\d)$/.test(w)));
const hasLetter = (s) => /\p{L}/u.test(s);

const collapse = (raw) => raw.replace(/\s+/g, ' ');

function scan(file) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  const found = [];
  traverse(ast, {
    JSXText(p) {
      const norm = collapse(p.node.value);
      const text = norm.trim();
      if (!text || !hasLetter(text)) return;
      found.push({ kind: 'jsxtext', start: p.node.start, end: p.node.end, text, lead: /^\s/.test(norm), trail: /\s$/.test(norm), raw: p.node.value });
    },
    StringLiteral(p) {
      const n = p.node, parent = p.parent;
      if (/Import|Export/.test(parent.type)) return;
      if ((parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && parent.key === n && !parent.computed) return;
      if (parent.type === 'MemberExpression' && parent.property === n) return;
      if (parent.type === 'JSXAttribute') { if (SKIP_ATTRS.has(parent.name.name)) return; }
      // dentro de atributos ignorados (className={cond ? 'a' : 'b'})
      let a = p.parentPath;
      while (a) { if (a.node.type === 'JSXAttribute' && SKIP_ATTRS.has(a.node.name.name)) return; if (a.node.type === 'CallExpression' && a.node.callee.name === 't') return; a = a.parentPath; }
      if (parent.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(parent.operator)) return;
      if (parent.type === 'SwitchCase') return;
      if (parent.type === 'ArrayExpression' && p.parentPath.parent.type === 'CallExpression' && p.parentPath.parent.callee.property?.name === 'includes') return;
      const s = n.value;
      if (!s || !hasLetter(s) || codeish(s)) return;
      found.push({ kind: 'str', start: n.start, end: n.end, text: s, jsxAttr: parent.type === 'JSXAttribute' });
    },
    TemplateLiteral(p) {
      let a = p.parentPath;
      while (a) { if (a.node.type === 'JSXAttribute' && SKIP_ATTRS.has(a.node.name.name)) return; if (a.node.type === 'TaggedTemplateExpression') return; a = a.parentPath; }
      const q = p.node.quasis.map((x) => x.value.cooked);
      if (!q.some((s) => /\p{L}{3,}/u.test(s.replace(/\$\{[^}]*\}/g, '')))) return;
      let key = q[0];
      for (let i = 1; i < q.length; i++) key += `{${i - 1}}` + q[i];
      if (p.node.expressions.length === 0 && codeish(key)) return;
      if (/^[\s\S]*\bbg-|text-\w+-\d{2,3}|hover:|rounded|px-\d/.test(key)) return;
      found.push({ kind: 'tpl', start: p.node.start, end: p.node.end, text: key, exprs: p.node.expressions.map((e) => ({ s: e.start, e: e.end })) });
    },
  });
  return { code, found };
}

const mode = process.argv[2];
if (mode === '--apply') {
  const map = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); // { "<pt>": "<en>" }
  let changed = 0, skipped = new Set();
  for (const file of files) {
    const { code, found } = scan(file);
    const edits = [];
    for (const f of found) {
      let en = map[f.text];
      if (en === undefined && f.text !== f.text.trim() && map[f.text.trim()] !== undefined) {
        const m = f.text.match(/^(\s*)([\s\S]*?)(\s*)$/); en = m[1] + map[m[2]] + m[3];
      }
      if (en === undefined) { skipped.add(f.text); continue; }
      const q = JSON.stringify(en).replace(/^"|"$/g, '').replace(/'/g, "\\'").replace(/\\"/g, '"');
      const lit = `'${q}'`;
      if (f.kind === 'jsxtext') {
        const parts = [];
        if (f.lead) parts.push("{' '}");
        parts.push(`{t(${lit})}`);
        if (f.trail) parts.push("{' '}");
        // preserva quebras de linha originais ao redor para legibilidade
        const lead = /^\s*\n\s*/.test(f.raw) ? '' : '';
        edits.push({ s: f.start, e: f.end, r: lead + parts.join('') });
      } else if (f.kind === 'str') {
        edits.push({ s: f.start, e: f.end, r: f.jsxAttr ? `{t(${lit})}` : `t(${lit})` });
      } else {
        const args = f.exprs.map((x) => code.slice(x.s, x.e));
        edits.push({ s: f.start, e: f.end, r: args.length ? `t(${lit}, [${args.join(', ')}])` : `t(${lit})` });
      }
    }
    if (!edits.length) continue;
    // remove edições aninhadas (um template dentro de outro, etc.)
    edits.sort((a, b) => a.s - b.s);
    const flat = []; for (const e of edits) { if (flat.length && e.s < flat[flat.length - 1].e) continue; flat.push(e); }
    let out = code;
    for (const e of flat.reverse()) out = out.slice(0, e.s) + e.r + out.slice(e.e);
    if (!/from '\.\.?\/(?:\.\.\/)?i18n\.jsx'|from '\.\/i18n\.jsx'/.test(out)) {
      const rel = path.relative(path.dirname(file), 'client/src/i18n.jsx').replace(/\\/g, '/');
      const imp = `import { t } from '${rel.startsWith('.') ? rel : './' + rel}';\n`;
      const idx = out.search(/^import /m);
      out = idx === -1 ? imp + out : out.slice(0, idx) + imp + out.slice(idx);
    }
    fs.writeFileSync(file, out); changed++;
  }
  console.log(`arquivos alterados: ${changed}; textos sem tradução ficam como estão: ${skipped.size}`);
  fs.writeFileSync('/tmp/i18n-skipped.json', JSON.stringify([...skipped], null, 1));
} else {
  const all = new Map();
  for (const file of files) for (const f of scan(file).found) { const k = f.text; if (!all.has(k)) all.set(k, []); all.get(k).push(path.basename(file)); }
  const list = [...all.keys()];
  fs.writeFileSync('/tmp/i18n-candidates.json', JSON.stringify(list, null, 1));
  console.log(list.length + ' candidatos');
}
