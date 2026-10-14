// Imposto sobre vendas (EUA): alíquotas com nome por estado/cidade, clientes isentos, relatório por jurisdição e alerta de obrigação
// ("nexus": passar do limite de vendas de um estado onde a empresa não mora). É um ORGANIZADOR e um AVISO: as alíquotas e os limites
// abaixo são ponto de partida (de memória, não conferidos numa fonte oficial) e cada estado muda as suas regras; confirme com o
// órgão do estado ou com o contador antes de cobrar ou deixar de cobrar. O Fluxo não declara nem recolhe o imposto.
import { all, get, run, insert, getSetting, setSetting } from './db.js';
import { HttpError, isDate, today, addDays } from './accounting.js';

const bad = (m) => new HttpError(400, m);

export const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };

/** Alíquota estadual de base (sem impostos locais). Ponto de partida: o dono confere e ajusta. Estados sem imposto estadual ficam de fora. */
export const STATE_BASE = { AL: 4, AZ: 5.6, AR: 6.5, CA: 7.25, CO: 2.9, CT: 6.35, DC: 6, FL: 6, GA: 4, HI: 4, ID: 6, IL: 6.25, IN: 7, IA: 6, KS: 6.5, KY: 6, LA: 5, ME: 5.5, MD: 6, MA: 6.25, MI: 6, MN: 6.875, MS: 7, MO: 4.225, NE: 5.5, NV: 6.85, NJ: 6.625, NM: 5.125, NY: 4, NC: 4.75, ND: 5, OH: 5.75, OK: 4.5, PA: 6, RI: 7, SC: 6, SD: 4.2, TN: 7, TX: 6.25, UT: 6.1, VT: 6, VA: 5.3, WA: 6.5, WV: 6, WI: 5, WY: 4 };
const NO_STATE_SALES_TAX = ['AK', 'DE', 'MT', 'NH', 'OR'];

/** Limites de obrigação (vendas em 12 meses e/ou número de vendas). Padrão: US$ 100 mil ou 200 vendas; alguns estados são diferentes. Editáveis. */
export const NEXUS_DEFAULT = { sales: 10_000_000, txns: 200 }; // centavos
const NEXUS_OVERRIDE = { AL: { sales: 25_000_000, txns: 0 }, MS: { sales: 25_000_000, txns: 0 }, CA: { sales: 50_000_000, txns: 0 }, TX: { sales: 50_000_000, txns: 0 }, NY: { sales: 50_000_000, txns: 100, both: true } };

export const isState = (s) => Object.prototype.hasOwnProperty.call(STATES, s);
export const cleanState = (s) => { const v = String(s || '').trim().toUpperCase(); if (!v) return ''; if (!isState(v)) throw bad('Choose a valid US state'); return v; };

/* ------------------------------ alíquotas ------------------------------ */
export const listRates = () => all('SELECT * FROM tax_rates ORDER BY active DESC, state, name');
export function saveRate({ id, name, state = '', rate, notes = '', active = true }) {
  const nm = String(name || '').trim();
  if (!nm) throw bad('Enter a name for this tax rate');
  const r = Number(rate);
  if (!(r >= 0 && r <= 30)) throw bad('The tax rate must be between 0 and 30%');
  const st = cleanState(state);
  const dupe = get('SELECT id FROM tax_rates WHERE lower(name)=lower(?) AND id<>?', nm, id || 0);
  if (dupe) throw bad('A tax rate with this name already exists');
  if (id) {
    if (!get('SELECT 1 FROM tax_rates WHERE id=?', id)) throw new HttpError(404, 'Tax rate not found');
    run('UPDATE tax_rates SET name=?, state=?, rate=?, notes=?, active=? WHERE id=?', nm, st, r, String(notes).slice(0, 200), active ? 1 : 0, id);
    return get('SELECT * FROM tax_rates WHERE id=?', id);
  }
  const nid = insert('INSERT INTO tax_rates(name,state,rate,notes,active) VALUES(?,?,?,?,?)', nm, st, r, String(notes).slice(0, 200), active ? 1 : 0);
  return get('SELECT * FROM tax_rates WHERE id=?', nid);
}
export function deleteRate(id) {
  if (!get('SELECT 1 FROM tax_rates WHERE id=?', id)) throw new HttpError(404, 'Tax rate not found');
  run('UPDATE contacts SET tax_rate_id=NULL WHERE tax_rate_id=?', id);
  run('DELETE FROM tax_rates WHERE id=?', id); // as faturas já emitidas guardam o nome e a alíquota na própria linha
}
/** Cria as alíquotas estaduais de base que ainda não existem (nunca mexe nas que a pessoa já criou ou editou). */
export function addStateBaseRates() {
  let added = 0;
  for (const [st, rate] of Object.entries(STATE_BASE)) {
    const name = `${STATES[st]} state sales tax`;
    if (get('SELECT 1 FROM tax_rates WHERE lower(name)=lower(?) OR (state=? AND lower(name) LIKE ?)', name, st, `${STATES[st].toLowerCase()}%`)) continue;
    insert('INSERT INTO tax_rates(name,state,rate,notes,active) VALUES(?,?,?,?,1)', name, st, rate, 'Starting point: state rate only. Check it and add local rates.');
    added++;
  }
  return { added, noSalesTax: NO_STATE_SALES_TAX };
}

/* ------------------------------ estado de origem e limites ------------------------------ */
export const homeState = () => getSetting('tax_home_state', '');
export const setHomeState = (s) => { setSetting('tax_home_state', cleanState(s)); return homeState(); };
function thresholds() {
  let saved = {}; try { saved = JSON.parse(getSetting('nexus_thresholds', '{}')); } catch { saved = {}; }
  return (st) => ({ ...NEXUS_DEFAULT, ...(NEXUS_OVERRIDE[st] || {}), ...(saved[st] || {}) });
}
export function saveThreshold(state, { sales, txns }) {
  const st = cleanState(state); if (!st) throw bad('Choose a state');
  const s = Math.round(Number(sales)), n = Math.round(Number(txns));
  if (!(s >= 0) || !(n >= 0)) throw bad('Limits must be zero or more');
  let saved = {}; try { saved = JSON.parse(getSetting('nexus_thresholds', '{}')); } catch { saved = {}; }
  saved[st] = { sales: s, txns: n };
  setSetting('nexus_thresholds', JSON.stringify(saved));
}

/* ------------------------------ relatórios ------------------------------ */
const POSTED_INV = "d.type='invoice' AND d.status IN ('sent','partial','paid')";
const POSTED_CRE = "d.type='credit' AND d.status IN ('open','used')";

/** Imposto cobrado por jurisdição (nome da alíquota), vendas isentas e vendas por estado do cliente, no período. Notas de crédito subtraem. */
export function jurisdictionReport(from, to) {
  if (!isDate(from) || !isDate(to)) throw bad('Invalid dates');
  const lines = all(`SELECT COALESCE(NULLIF(l.tax_name,''), CASE WHEN l.tax_rate>0 THEN 'Unnamed rate' ELSE '' END) AS name, l.tax_rate AS rate,
      CASE WHEN d.type='credit' THEN -1 ELSE 1 END AS sign, l.amount, l.tax_amount, c.tax_exempt, c.tax_state
    FROM doc_lines l JOIN docs d ON d.id=l.doc_id JOIN contacts c ON c.id=d.contact_id
    WHERE ((${POSTED_INV}) OR (${POSTED_CRE})) AND d.issue_date>=? AND d.issue_date<=?`, from, to);
  const byRate = new Map(), byState = new Map();
  let exempt = 0, zeroRated = 0, collected = 0, taxable = 0;
  for (const l of lines) {
    const base = l.sign * l.amount, tax = l.sign * l.tax_amount;
    if (l.rate > 0) {
      const k = `${l.name}|${l.rate}`; const r = byRate.get(k) || { name: l.name, rate: l.rate, base: 0, tax: 0 };
      r.base += base; r.tax += tax; byRate.set(k, r); collected += tax; taxable += base;
    } else if (l.tax_exempt) exempt += base; else zeroRated += base;
    const st = l.tax_state || '';
    const s = byState.get(st) || { state: st, sales: 0, tax: 0 }; s.sales += base; s.tax += tax; byState.set(st, s);
  }
  const rows = [...byRate.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, rows, taxable, collected, exempt, zeroRated, byState: [...byState.values()].sort((a, b) => b.sales - a.sales) };
}

/** Quanto foi vendido a clientes de cada estado nos últimos 12 meses, contra o limite de obrigação do estado. */
export function nexusStatus(asof = today()) {
  const since = addDays(asof, -365);
  const home = homeState();
  const th = thresholds();
  const rows = all(`SELECT c.tax_state AS state,
      COALESCE(SUM(CASE WHEN d.type='credit' THEN -d.subtotal ELSE d.subtotal END),0) AS sales,
      COALESCE(SUM(CASE WHEN d.type='credit' THEN 0 ELSE 1 END),0) AS txns
    FROM docs d JOIN contacts c ON c.id=d.contact_id
    WHERE ((${POSTED_INV}) OR (${POSTED_CRE})) AND d.issue_date>? AND d.issue_date<=? GROUP BY c.tax_state`, since, asof);
  const out = []; let unassigned = { sales: 0, txns: 0 };
  for (const r of rows) {
    if (!r.state) { unassigned = { sales: r.sales, txns: r.txns }; continue; }
    const lim = th(r.state);
    const noTax = NO_STATE_SALES_TAX.includes(r.state);
    const pctSales = lim.sales > 0 ? r.sales / lim.sales : 0, pctTx = lim.txns > 0 ? r.txns / lim.txns : 0;
    const both = NEXUS_OVERRIDE[r.state]?.both;
    const pct = both ? Math.min(pctSales, pctTx) : Math.max(pctSales, pctTx);
    const status = r.state === home ? 'home' : noTax ? 'no_tax' : pct >= 1 ? 'over' : pct >= 0.8 ? 'near' : 'ok';
    out.push({ state: r.state, name: STATES[r.state], sales: r.sales, txns: r.txns, limitSales: lim.sales, limitTxns: lim.txns, both: !!both, pct: Math.round(pct * 100), status });
  }
  out.sort((a, b) => b.pct - a.pct);
  const noState = get(`SELECT COUNT(*) AS n FROM contacts WHERE active=1 AND kind IN ('customer','both') AND (tax_state IS NULL OR tax_state='')`).n;
  return { asof, since, homeState: home, rows: out, unassigned, customersWithoutState: noState, alerts: out.filter((r) => r.status === 'over' || r.status === 'near') };
}
