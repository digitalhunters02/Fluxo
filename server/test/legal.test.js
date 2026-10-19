// Termos e Privacidade: rascunho nos 3 idiomas, com o mesmo conjunto de seções e o aviso "revisar com advogado" bem visível.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { LEGAL, LEGAL_VERSION } = await import('../../client/src/pages/legalText.js');

test('Termos e Privacidade existem em en/pt/es, com as mesmas seções e aviso de rascunho', () => {
  assert.deepEqual(Object.keys(LEGAL).sort(), ['en', 'es', 'pt']);
  for (const kind of ['terms', 'privacy']) {
    const n = LEGAL.en[kind].sections.length;
    assert.ok(n >= 10, `${kind} tem seções suficientes`);
    for (const lang of ['pt', 'es']) {
      assert.equal(LEGAL[lang][kind].sections.length, n, `${kind} ${lang}: mesmo número de seções`);
      LEGAL[lang][kind].sections.forEach((s, i) => assert.equal(s.p.length, LEGAL.en[kind].sections[i].p.length, `${kind} ${lang} seção ${i + 1}: mesmos parágrafos`));
    }
  }
  assert.match(LEGAL.en.banner, /DRAFT/); assert.match(LEGAL.pt.banner, /RASCUNHO — revisar com advogado/); assert.match(LEGAL.es.banner, /BORRADOR/);
  assert.match(LEGAL_VERSION, /^draft-/);
});

test('o rascunho diz o que o produto realmente faz (planos, apagar contas paradas, serviços de terceiros, exportar tudo)', () => {
  for (const lang of ['en', 'pt', 'es']) {
    const all = JSON.stringify(LEGAL[lang]);
    for (const word of ['Stripe', 'Plaid', '12', '30']) assert.ok(all.includes(word), `${lang}: menciona ${word}`);
    assert.ok(/\[[^\]]+\]/.test(all), `${lang}: deixa colchetes para o advogado/Jadson preencherem`);
  }
});

test('o servidor guarda a mesma versão dos textos que o cliente mostra', () => {
  assert.ok(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').includes(`LEGAL_VERSION = '${LEGAL_VERSION}'`));
});
