// Verifica que toda chave t('...') do código tenha tradução em pt e es. uso: node tools/i18n-check.mjs [--list]
import fs from 'node:fs'; import path from 'node:path';
import { parse } from '@babel/parser'; import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;
const read = async (f) => (await import(path.resolve(f) + '?' + Date.now())).default;
const pt = await read('client/src/locales/pt.js'), es = await read('client/src/locales/es.js');
const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (/\.jsx?$/.test(f)) files.push(p); } };
walk('client/src');
const keys = new Set();
for (const file of files) {
  const ast = parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, { CallExpression(p) {
    const c = p.node.callee, a = p.node.arguments[0];
    if (c.type === 'Identifier' && c.name === 't' && a?.type === 'StringLiteral') keys.add(a.value);
    if (c.type === 'Identifier' && c.name === 't' && a?.type === 'TemplateLiteral' && a.expressions.length === 0) keys.add(a.quasis[0].value.cooked);
  } });
}
const norm = (k) => k.trim();
const missing = [...keys].filter((k) => !(pt[k] ?? pt[norm(k)]) || !(es[k] ?? es[norm(k)]));
const unused = Object.keys(pt).filter((k) => !keys.has(k) && !keys.has(' ' + k) && ![...keys].some((x) => x.trim() === k));
if (process.argv.includes('--list')) { fs.writeFileSync('/tmp/i18n-missing.txt', missing.join('\n')); }
console.log(`${keys.size} chaves no código; ${missing.length} sem tradução (pt/es); ${unused.length} entradas não usadas`);
if (missing.length) console.log(missing.map((m) => '  ' + m).join('\n'));
process.exit(missing.length ? 1 : 0);
