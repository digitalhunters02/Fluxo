// Detecta chamadas t('...') cujo "t" não é o importado do i18n (variável local com o mesmo nome).
import fs from 'node:fs'; import path from 'node:path';
import { parse } from '@babel/parser'; import _traverse from '@babel/traverse';
const traverse = _traverse.default || _traverse;
const files = []; const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) { if (f !== 'locales') walk(p); } else if (/\.jsx?$/.test(f)) files.push(p); } };
walk('client/src');
let bad = 0;
for (const file of files) {
  const code = fs.readFileSync(file, 'utf8');
  const ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
  traverse(ast, { CallExpression(p) {
    if (p.node.callee.type !== 'Identifier' || p.node.callee.name !== 't') return;
    const b = p.scope.getBinding('t');
    if (!b || b.path.type !== 'ImportSpecifier') { bad++; console.log(`${file}:${p.node.loc.start.line}  t(${code.slice(p.node.arguments[0]?.start, p.node.arguments[0]?.end).slice(0, 40)}) usa binding ${b ? b.path.type : 'inexistente'}`); }
  } });
}
console.log(bad ? `${bad} problema(s)` : 'ok: nenhum t() sombreado');
process.exit(bad ? 1 : 0);
