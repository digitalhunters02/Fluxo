// Grupo de empresas e relatórios consolidados (plano Business: até 5 empresas; Enterprise: sem limite).
// Cada empresa continua com a sua contabilidade separada; o grupo só soma os números na hora de ver. Contas cujo nome tem
// "Intercompany" (a receber/pagar entre as empresas, receita/despesa entre elas) saem da soma e o relatório mostra se fecham em zero.
import * as tenants from './tenants.js';
import * as rep from './reports.js';
import * as billing from './billing.js';
import { HttpError } from './accounting.js';
import { limitFor, hasFeature, currentPlan, enterpriseMonthly, ENTERPRISE_INCLUDED_COMPANIES, ENTERPRISE_EXTRA_COMPANY } from './plans.js';

const bad = (m) => new HttpError(400, m);
const isInter = (name) => /inter-?company/i.test(name || '');
const ownerLimit = (ownerSlug) => tenants.inTenant(ownerSlug, () => (hasFeature('multi_company') ? limitFor('group_companies') : 0));

export function info() {
  const slug = tenants.currentSlug();
  const g = tenants.groupOf(slug);
  if (!g) return { group: null };
  const members = tenants.groupMembers(g.id).map((m) => ({ ...m, owner: m.slug === g.owner_slug }));
  // Enterprise: o preço acompanha o número de empresas do grupo (5 incluídas, depois US$ 100 por empresa).
  const enterprise = tenants.inTenant(g.owner_slug, () => currentPlan() === 'enterprise');
  const cost = enterprise ? { included: ENTERPRISE_INCLUDED_COMPANIES, extra: Math.max(0, members.length - ENTERPRISE_INCLUDED_COMPANIES), perCompany: ENTERPRISE_EXTRA_COMPANY, monthly: enterpriseMonthly(members.length) } : null;
  return { group: { id: g.id, name: g.name, isOwner: g.owner_slug === slug, members, limit: ownerLimit(g.owner_slug), billing: cost } };
}
export function create(name) {
  if (!String(name || '').trim()) throw bad('Name the group');
  if (!tenants.createGroup(name, tenants.currentSlug())) throw new HttpError(409, 'This company already belongs to a group');
  return info();
}
export function invite() {
  const g = tenants.groupOf(tenants.currentSlug());
  if (!g || g.owner_slug !== tenants.currentSlug()) throw new HttpError(403, 'Only the company that created the group can invite others');
  const lim = ownerLimit(g.owner_slug);
  if (lim != null && tenants.groupMembers(g.id).length >= lim) throw new HttpError(402, 'Your plan allows up to ' + lim + ' companies in a group', { feature: 'multi_company', limit: lim });
  return { code: tenants.createInvite(g.id), expiresInDays: 7 };
}
/** Atualiza no Stripe as empresas extras cobradas do dono do grupo Enterprise. Falha do Stripe não impede entrar/sair; fica no registro. */
const syncOwnerBilling = (ownerSlug) => {
  try { Promise.resolve(tenants.inTenant(ownerSlug, () => billing.syncEnterpriseExtras())).catch((e) => console.error('enterprise extras sync:', e.message)); } catch (e) { console.error('enterprise extras sync:', e.message); }
};
export function join(code) {
  const slug = tenants.currentSlug();
  if (!String(code || '').trim()) throw bad('Enter the invitation code');
  const inv = tenants.peekInvite(code);
  if (!inv) throw bad('This code is invalid or has expired');
  const lim = ownerLimit(inv.owner_slug); // o limite é o do plano de quem criou o grupo
  const r = tenants.joinWithCode(code, slug, lim);
  if (r.error) throw new HttpError(/limit/.test(r.error) ? 402 : 400, r.error);
  syncOwnerBilling(inv.owner_slug);
  return info();
}
export function leave() {
  const g = tenants.groupOf(tenants.currentSlug());
  tenants.leaveGroup(tenants.currentSlug());
  if (g) syncOwnerBilling(g.owner_slug); // se o dono saiu o grupo acabou: as extras voltam a zero
  return info();
}

function members() {
  const g = tenants.groupOf(tenants.currentSlug());
  if (!g) throw new HttpError(404, 'This company is not in a group yet');
  return { g, list: tenants.groupMembers(g.id) };
}

/** Soma linhas de várias empresas pela "chave" (tipo + nome da conta). */
function merge(perCompany, pick, keyFn) {
  const map = new Map();
  for (const { slug, data } of perCompany) {
    for (const r of pick(data)) {
      const key = keyFn(r);
      const m = map.get(key) || { name: r.name, type: r.type, subtype: r.subtype, total: 0, byCompany: {} };
      m.total += r.balance; m.byCompany[slug] = (m.byCompany[slug] || 0) + r.balance;
      map.set(key, m);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const sum = (rows) => rows.reduce((s, r) => s + r.total, 0);
const split = (rows) => ({ rows: rows.filter((r) => !isInter(r.name)), inter: rows.filter((r) => isInter(r.name)) });

export function consolidatedPnl(from, to) {
  const { list } = members();
  const per = list.map((m) => ({ slug: m.slug, name: m.name, data: tenants.inTenant(m.slug, () => rep.profitAndLoss(from, to)) }));
  const key = (r) => `${r.type}|${r.subtype === 'cogs' ? 'cogs' : ''}|${r.name.toLowerCase()}`;
  const inc = split(merge(per, (d) => d.income, key)), cogs = split(merge(per, (d) => d.cogs, key)), opex = split(merge(per, (d) => d.opex, key));
  const totalIncome = sum(inc.rows), totalCogs = sum(cogs.rows), totalOpex = sum(opex.rows);
  const eliminated = { income: sum(inc.inter), expense: sum(cogs.inter) + sum(opex.inter) };
  return {
    from, to, companies: per.map((p) => ({ slug: p.slug, name: p.name, netIncome: p.data.netIncome })),
    income: inc.rows, cogs: cogs.rows, opex: opex.rows, totalIncome, totalCogs, grossProfit: totalIncome - totalCogs, totalOpex, netIncome: totalIncome - totalCogs - totalOpex,
    eliminated: { ...eliminated, difference: eliminated.income - eliminated.expense },
  };
}

export function consolidatedBalanceSheet(asof) {
  const { list } = members();
  const per = list.map((m) => ({ slug: m.slug, name: m.name, data: tenants.inTenant(m.slug, () => rep.balanceSheet(asof)) }));
  const key = (r) => `${r.type}|${r.name.toLowerCase()}`;
  const assets = split(merge(per, (d) => d.assets, key)), liabilities = split(merge(per, (d) => d.liabilities, key)), equity = merge(per, (d) => d.equity, key);
  const earnings = per.reduce((s, p) => s + p.data.currentEarnings, 0);
  const totalAssets = sum(assets.rows), totalLiabilities = sum(liabilities.rows), totalEquity = sum(equity) + earnings;
  const eliminated = { assets: sum(assets.inter), liabilities: sum(liabilities.inter) };
  return {
    asof, companies: per.map((p) => ({ slug: p.slug, name: p.name, totalAssets: p.data.totalAssets })),
    assets: assets.rows, liabilities: liabilities.rows, equity, currentEarnings: earnings, totalAssets, totalLiabilities, totalEquity,
    eliminated: { ...eliminated, difference: eliminated.assets - eliminated.liabilities }, balanced: totalAssets === totalLiabilities + totalEquity,
  };
}
