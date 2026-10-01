// Internacionalização: inglês é o idioma-base (as chaves do código são os textos em inglês).
// Sufixos de contexto "Texto§x" desambiguam traduções; o sufixo nunca aparece na tela.
import pt from './locales/pt.js';
import es from './locales/es.js';

export const LANGS = { en: 'English', pt: 'Português', es: 'Español' };
const DICTS = { pt, es };
const KEY = 'fluxo_lang';

const detect = () => {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LANGS[saved]) return saved;
  } catch { /* storage bloqueado */ }
  return 'en'; // padrão do app
};
export let lang = detect();

const strip = (s) => s.replace(/§.*$/, '');
const fill = (s, vars) => {
  if (vars === undefined || vars === null) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
};

/** t('English text {0}', [value]) ou t('Hello {name}', { name }) */
export function t(key, vars) {
  if (typeof key !== 'string') return key;
  let out;
  if (lang === 'en') out = strip(key);
  else {
    const d = DICTS[lang];
    out = d[key];
    if (out === undefined) { // textos com espaços nas pontas
      const m = key.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const core = m ? d[m[2]] : undefined;
      out = core !== undefined ? m[1] + core + m[3] : strip(key);
    }
  }
  return fill(out, vars);
}

export function setLang(next) {
  if (!LANGS[next] || next === lang) return;
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  location.reload(); // constantes de módulo (menus, rótulos) são recalculadas no idioma novo
}

export const localeFor = () => ({ en: 'en-US', pt: 'pt-BR', es: 'es-US' }[lang]);

/** Traduz mensagens de erro do servidor (que chegam em inglês). */
const PATTERNS = [
  [/^Out of balance \(debit (.+) ≠ credit (.+)\)$/, 'Out of balance (debit {0} ≠ credit {1})'],
  [/^Invalid quantity on line (\d+)$/, 'Invalid quantity on line {0}'],
  [/^Invalid date: (.+)$/, 'Invalid date: {0}'],
  [/^The reconciliation does not balance: off by (-?\d+) cents$/, 'The reconciliation does not balance: off by {0} cents'],
  [/^System account "(.+)" not found in the chart of accounts$/, 'System account "{0}" not found in the chart of accounts'],
  [/^Deductions exceed gross pay for (.+)$/, 'Deductions exceed gross pay for {0}'],
  [/^(.+) appears twice in this pay run$/, '{0} appears twice in this pay run'],
];
export function tr(message) {
  if (typeof message !== 'string' || lang === 'en') return message;
  const direct = t(message);
  if (direct !== message) return direct;
  for (const [re, key] of PATTERNS) {
    const m = message.match(re);
    if (m) return t(key, m.slice(1));
  }
  return message;
}
