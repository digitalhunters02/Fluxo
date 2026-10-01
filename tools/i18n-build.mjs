// Gera map.json (PT→EN, usado uma vez pelo codemod) e os dicionários locales/pt.js e es.js (chave em inglês).
import fs from 'node:fs';
const legacy = fs.readFileSync('tools/i18n-legacy.txt', 'utf8').split('\n').filter((l) => l.includes(' || '));
const extra = fs.existsSync('tools/i18n-extra.txt') ? fs.readFileSync('tools/i18n-extra.txt', 'utf8').split('\n').filter((l) => l.includes(' || ')) : [];
const map = {}, pt = {}, es = {}, seen = {};
const conflicts = [];
const put = (en, p, e) => {
  if (seen[en] && (seen[en][0] !== p || seen[en][1] !== e)) conflicts.push(`${en}\n   PT: ${seen[en][0]} | ${p}\n   ES: ${seen[en][1]} | ${e}`);
  seen[en] = [p, e]; pt[en] = p; es[en] = e;
};
for (const line of legacy) {
  const [p, en, e] = line.split(' || ').map((x) => x.trim());
  map[p] = en; put(en, p, e);
}
// extra: EN || PT || ES  (textos novos escritos direto em inglês)
for (const line of extra) { const [en, p, e] = line.split(' || ').map((x) => x.trim()); put(en, p, e); }
const dump = (o) => '// Gerado por tools/i18n-build.mjs — edite tools/i18n-legacy.txt / i18n-extra.txt\nexport default ' + JSON.stringify(o, null, 1) + ';\n';
fs.mkdirSync('client/src/locales', { recursive: true });
fs.writeFileSync('client/src/locales/pt.js', dump(pt));
fs.writeFileSync('client/src/locales/es.js', dump(es));
fs.writeFileSync('/tmp/i18n-map.json', JSON.stringify(map));
console.log(`${Object.keys(map).length} traduções legadas, ${extra.length} extras, ${Object.keys(pt).length} chaves`);
if (conflicts.length) console.log('CONFLITOS (mesma chave EN, traduções diferentes):\n' + conflicts.join('\n'));
