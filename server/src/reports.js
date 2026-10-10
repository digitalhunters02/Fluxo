import { all, get } from './db.js';
import { today, addDays, addMonths, advance, computeLines } from './accounting.js';

/** Saldo na natureza da conta (positivo = normal). */
const natural = (r) => (['asset', 'expense'].includes(r.type) ? r.debit - r.credit : r.credit - r.debit);

function periodRows(from, to) {
  return all(`
    SELECT a.id, a.code, a.name, a.type, a.subtype,
      COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date>=? AND je.date<=?),0) AS debit,
      COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date>=? AND je.date<=?),0) AS credit
    FROM accounts a WHERE a.type IN ('income','expense') ORDER BY a.code`, from, to, from, to).map((r) => ({ ...r, balance: natural(r) }));
}

export function profitAndLoss(from, to) {
  const build = (f, t) => {
    const rows = periodRows(f, t).filter((r) => r.balance !== 0 || r.debit || r.credit);
    const income = rows.filter((r) => r.type === 'income');
    const cogs = rows.filter((r) => r.type === 'expense' && r.subtype === 'cogs');
    const opex = rows.filter((r) => r.type === 'expense' && r.subtype !== 'cogs');
    const sum = (a) => a.reduce((s, r) => s + r.balance, 0);
    const totalIncome = sum(income), totalCogs = sum(cogs), totalOpex = sum(opex);
    return { income, cogs, opex, totalIncome, totalCogs, grossProfit: totalIncome - totalCogs, totalOpex, netIncome: totalIncome - totalCogs - totalOpex };
  };
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  const prevTo = addDays(from, -1), prevFrom = addDays(prevTo, -(days - 1));
  const cur = build(from, to), prev = build(prevFrom, prevTo);
  return { from, to, prevFrom, prevTo, ...cur, previous: { totalIncome: prev.totalIncome, totalCogs: prev.totalCogs, grossProfit: prev.grossProfit, totalOpex: prev.totalOpex, netIncome: prev.netIncome } };
}

export function balanceSheet(asof) {
  const rows = all(`
    SELECT a.id, a.code, a.name, a.type, a.subtype,
      COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date<=?),0) AS debit,
      COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date<=?),0) AS credit
    FROM accounts a ORDER BY a.code`, asof, asof).map((r) => ({ ...r, balance: natural(r) }));
  const pick = (t) => rows.filter((r) => r.type === t && (r.balance !== 0));
  const assets = pick('asset'), liabilities = pick('liability'), equity = pick('equity');
  const earnings = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.balance, 0) - rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
  const sum = (a) => a.reduce((s, r) => s + r.balance, 0);
  const totalAssets = sum(assets), totalLiabilities = sum(liabilities), totalEquity = sum(equity) + earnings;
  return { asof, assets, liabilities, equity, currentEarnings: earnings, totalAssets, totalLiabilities, totalEquity, balanced: totalAssets === totalLiabilities + totalEquity };
}

export function trialBalance(asof) {
  const rows = all(`
    SELECT a.id, a.code, a.name, a.type,
      COALESCE((SELECT SUM(jl.debit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date<=?),0) AS debit,
      COALESCE((SELECT SUM(jl.credit) FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=a.id AND je.date<=?),0) AS credit
    FROM accounts a ORDER BY a.code`, asof, asof).filter((r) => r.debit || r.credit)
    .map((r) => { const net = r.debit - r.credit; return { ...r, debitBalance: net > 0 ? net : 0, creditBalance: net < 0 ? -net : 0 }; });
  return { asof, rows, totalDebit: rows.reduce((s, r) => s + r.debitBalance, 0), totalCredit: rows.reduce((s, r) => s + r.creditBalance, 0) };
}

/** Fluxo de caixa (método direto): movimentos em contas bancárias atribuídos às contrapartidas. */
export function cashFlow(from, to) {
  const cashIds = new Set(all('SELECT id FROM accounts WHERE subtype IN (\'bank\')').map((r) => r.id));
  const entries = all('SELECT id, date FROM journal_entries WHERE date>=? AND date<=?', from, to);
  const bucket = { operating: new Map(), investing: new Map(), financing: new Map() };
  let net = 0;
  const lineStmt = (id) => all('SELECT jl.*, a.name, a.type, a.subtype FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE entry_id=?', id);
  for (const e of entries) {
    const ls = lineStmt(e.id);
    const cash = ls.filter((l) => cashIds.has(l.account_id));
    if (!cash.length) continue;
    const others = ls.filter((l) => !cashIds.has(l.account_id));
    const cashDelta = cash.reduce((s, l) => s + l.debit - l.credit, 0);
    if (!others.length) continue; // transferência entre contas bancárias
    net += cashDelta;
    const otherTotal = others.reduce((s, l) => s + Math.abs(l.credit - l.debit), 0) || 1;
    let assigned = 0;
    others.forEach((l, i) => {
      const share = i === others.length - 1 ? cashDelta - assigned : Math.round((cashDelta * Math.abs(l.credit - l.debit)) / otherTotal);
      assigned += share;
      const sec = l.subtype === 'fixed_asset' ? 'investing' : (l.type === 'equity' || l.subtype === 'loan') ? 'financing' : 'operating';
      const key = l.name;
      bucket[sec].set(key, (bucket[sec].get(key) || 0) + share);
    });
  }
  const section = (m) => { const items = [...m].map(([name, amount]) => ({ name, amount })).filter((x) => x.amount !== 0).sort((a, b) => b.amount - a.amount); return { items, total: items.reduce((s, x) => s + x.amount, 0) }; };
  const cashBal = (d) => get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    JOIN accounts a ON a.id=jl.account_id WHERE a.subtype='bank' AND je.date<=?`, d).v;
  const opening = cashBal(addDays(from, -1)), closing = cashBal(to);
  return { from, to, operating: section(bucket.operating), investing: section(bucket.investing), financing: section(bucket.financing), netChange: net, opening, closing };
}

export function aging(kind, asof = today()) {
  const type = kind === 'receivable' ? 'invoice' : 'bill';
  const rows = all(`SELECT d.id, d.number, d.due_date, d.total - d.paid AS balance, d.contact_id, c.name AS contact_name FROM docs d JOIN contacts c ON c.id=d.contact_id
    WHERE d.type=? AND d.status IN ('sent','open','partial') AND d.total-d.paid>0 ORDER BY d.due_date`, type);
  if (kind === 'receivable') {
    // notas de crédito ainda não usadas reduzem o saldo a receber do cliente
    for (const c of all(`SELECT d.id, d.number, d.issue_date AS due_date, -(d.total - d.paid) AS balance, d.contact_id, c.name AS contact_name FROM docs d JOIN contacts c ON c.id=d.contact_id
      WHERE d.type='credit' AND d.status IN ('open','partial') AND d.total-d.paid>0`)) rows.push(c);
  }
  const buckets = ['current', 'd1_30', 'd31_60', 'd61_90', 'd90p'];
  const byContact = new Map();
  for (const r of rows) {
    const late = Math.floor((Date.parse(asof) - Date.parse(r.due_date)) / 86400000);
    const b = late <= 0 ? 'current' : late <= 30 ? 'd1_30' : late <= 60 ? 'd31_60' : late <= 90 ? 'd61_90' : 'd90p';
    const c = byContact.get(r.contact_id) || { contact_id: r.contact_id, contact_name: r.contact_name, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90p: 0, total: 0, docs: [] };
    c[b] += r.balance; c.total += r.balance; c.docs.push({ ...r, daysLate: Math.max(late, 0), bucket: b });
    byContact.set(r.contact_id, c);
  }
  const list = [...byContact.values()].sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries([...buckets, 'total'].map((k) => [k, list.reduce((s, c) => s + c[k], 0)]));
  return { asof, kind, rows: list, totals };
}

export function salesByCustomer(from, to) {
  return all(`SELECT c.id, c.name, COUNT(*) AS count, SUM(d.subtotal) AS subtotal, SUM(d.tax) AS tax, SUM(d.total) AS total
    FROM docs d JOIN contacts c ON c.id=d.contact_id WHERE d.type='invoice' AND d.status IN ('sent','partial','paid') AND d.issue_date>=? AND d.issue_date<=?
    GROUP BY c.id ORDER BY total DESC`, from, to);
}

export function expensesByCategory(from, to) {
  return all(`SELECT a.id, a.code, a.name, SUM(jl.debit-jl.credit) AS total FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    JOIN accounts a ON a.id=jl.account_id WHERE a.type='expense' AND je.date>=? AND je.date<=? GROUP BY a.id HAVING total<>0 ORDER BY total DESC`, from, to);
}

export function expensesByVendor(from, to) {
  return all(`SELECT c.id, c.name, SUM(jl.debit) AS total FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    JOIN accounts a ON a.id=jl.account_id JOIN contacts c ON c.id=jl.contact_id WHERE a.type='expense' AND je.date>=? AND je.date<=? GROUP BY c.id ORDER BY total DESC`, from, to);
}

export function taxSummary(from, to) {
  const collected = get(`SELECT COALESCE(SUM(jl.credit-jl.debit),0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    JOIN accounts a ON a.id=jl.account_id WHERE a.subtype='tax' AND je.date>=? AND je.date<=?`, from, to).v;
  const taxable = get(`SELECT COALESCE(SUM(subtotal),0) AS v FROM docs WHERE type='invoice' AND status IN ('sent','partial','paid') AND issue_date>=? AND issue_date<=?`, from, to).v;
  const byRate = all(`SELECT l.tax_rate AS rate, SUM(l.amount) AS base, SUM(l.tax_amount) AS tax FROM doc_lines l JOIN docs d ON d.id=l.doc_id
    WHERE d.type='invoice' AND d.status IN ('sent','partial','paid') AND d.issue_date>=? AND d.issue_date<=? GROUP BY l.tax_rate ORDER BY rate`, from, to);
  return { from, to, collected, taxable, byRate };
}

export function inventoryValuation() {
  const rows = all('SELECT id, name, sku, qty_on_hand, cost, price, reorder_point, qty_on_hand*cost AS value FROM items WHERE track_inventory=1 AND active=1 ORDER BY name')
    .map((r) => ({ ...r, value: Math.round(r.value), low: r.qty_on_hand <= r.reorder_point }));
  return { rows, total: rows.reduce((s, r) => s + r.value, 0) };
}

export function generalLedger(account_id, from, to) {
  const acc = get('SELECT * FROM accounts WHERE id=?', account_id);
  if (!acc) return null;
  const sign = ['asset', 'expense'].includes(acc.type) ? 1 : -1;
  const open = get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=? AND je.date<?`, account_id, from).v * sign;
  const lines = all(`SELECT jl.id, je.id AS entry_id, je.date, je.memo, je.source_type, jl.debit, jl.credit, jl.reconciliation_id FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_id=? AND je.date>=? AND je.date<=? ORDER BY je.date, je.id, jl.id`, account_id, from, to);
  let run = open;
  for (const l of lines) { run += (l.debit - l.credit) * sign; l.balance = run; }
  return { account: acc, from, to, opening: open, lines, closing: run };
}

export function projectProfitability() {
  return all(`SELECT p.id, p.name, p.status, p.budget, c.name AS contact_name,
      COALESCE((SELECT SUM(subtotal) FROM docs WHERE project_id=p.id AND type='invoice' AND status IN ('sent','partial','paid')),0) AS invoiced,
      COALESCE((SELECT SUM(amount) FROM expenses WHERE project_id=p.id),0)
        + COALESCE((SELECT SUM(subtotal) FROM docs WHERE project_id=p.id AND type='bill' AND status IN ('open','partial','paid')),0) AS costs,
      COALESCE((SELECT SUM(hours) FROM time_entries WHERE project_id=p.id),0) AS hours,
      COALESCE((SELECT SUM(ROUND(hours*p.hourly_rate)) FROM time_entries WHERE project_id=p.id AND billable=1 AND invoice_id IS NULL),0) AS unbilled
    FROM projects p LEFT JOIN contacts c ON c.id=p.contact_id ORDER BY p.status, p.name`).map((r) => ({ ...r, profit: r.invoiced - r.costs }));
}

export function monthlySeries(months = 6, end = today()) {
  const out = [];
  const endMonth = end.slice(0, 7) + '-01';
  for (let i = months - 1; i >= 0; i--) {
    const start = addMonths(endMonth, -i);
    const last = addDays(addMonths(start, 1), -1);
    const rows = periodRows(start, last);
    const income = rows.filter((r) => r.type === 'income').reduce((s, r) => s + r.balance, 0);
    const expense = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balance, 0);
    out.push({ month: start.slice(0, 7), income, expense, profit: income - expense });
  }
  return out;
}

export function dashboard() {
  const t = today();
  const monthStart = t.slice(0, 7) + '-01';
  const cash = get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.subtype='bank'`).v;
  const ar = get(`SELECT COALESCE(SUM(total-paid),0) AS v, COUNT(*) AS n FROM docs WHERE type='invoice' AND status IN ('sent','partial')`);
  const arOver = get(`SELECT COALESCE(SUM(total-paid),0) AS v, COUNT(*) AS n FROM docs WHERE type='invoice' AND status IN ('sent','partial') AND due_date<?`, t);
  const ap = get(`SELECT COALESCE(SUM(total-paid),0) AS v, COUNT(*) AS n FROM docs WHERE type='bill' AND status IN ('open','partial')`);
  const apOver = get(`SELECT COALESCE(SUM(total-paid),0) AS v, COUNT(*) AS n FROM docs WHERE type='bill' AND status IN ('open','partial') AND due_date<?`, t);
  const month = profitAndLoss(monthStart, t);
  const horizon = addDays(t, 30);
  const arSoon = get(`SELECT COALESCE(SUM(total-paid),0) AS v FROM docs WHERE type='invoice' AND status IN ('sent','partial') AND due_date<=?`, horizon).v;
  const apSoon = get(`SELECT COALESCE(SUM(total-paid),0) AS v FROM docs WHERE type='bill' AND status IN ('open','partial') AND due_date<=?`, horizon).v;
  const pendingBank = get(`SELECT COUNT(*) AS n FROM bank_txns WHERE status='pending'`).n;
  const lowStock = get(`SELECT COUNT(*) AS n FROM items WHERE track_inventory=1 AND active=1 AND qty_on_hand<=reorder_point`).n;
  const upcoming = all(`SELECT d.id, d.type, d.number, d.due_date, d.total-d.paid AS balance, c.name AS contact_name FROM docs d JOIN contacts c ON c.id=d.contact_id
    WHERE d.status IN ('sent','open','partial') AND d.total-d.paid>0 ORDER BY d.due_date LIMIT 8`);
  return {
    cash, receivable: ar, receivableOverdue: arOver, payable: ap, payableOverdue: apOver, month: { income: month.totalIncome, expense: month.totalCogs + month.totalOpex, profit: month.netIncome },
    forecast30: cash + arSoon - apSoon, series: monthlySeries(6), topExpenses: expensesByCategory(monthStart, t).slice(0, 5), pendingBank, lowStock, upcoming,
  };
}

/** Orçamento x realizado no período (meses inteiros entre from e to). */
export function budgetVsActual(from, to) {
  const months = [];
  for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = addMonths(m + '-01', 1).slice(0, 7)) months.push(m);
  const budgets = Object.fromEntries(all(`SELECT account_id, SUM(amount) AS v FROM budgets WHERE month>=? AND month<=? GROUP BY account_id`, months[0], months[months.length - 1]).map((r) => [r.account_id, r.v]));
  const actual = periodRows(from, to);
  const rows = actual.filter((r) => budgets[r.id] || r.balance).map((r) => {
    const budget = budgets[r.id] || 0;
    return { id: r.id, code: r.code, name: r.name, type: r.type, budget, actual: r.balance, variance: r.type === 'income' ? r.balance - budget : budget - r.balance };
  });
  const sum = (type, k) => rows.filter((r) => r.type === type).reduce((s, r) => s + r[k], 0);
  return { from, to, income: rows.filter((r) => r.type === 'income'), expense: rows.filter((r) => r.type === 'expense'),
    totals: { incomeBudget: sum('income', 'budget'), incomeActual: sum('income', 'actual'), expenseBudget: sum('expense', 'budget'), expenseActual: sum('expense', 'actual') } };
}

/** DRE por classe: uma coluna por classe (mais "sem classe"). */
export function plByClass(from, to) {
  const classes = [...all('SELECT id, name FROM classes WHERE active=1 ORDER BY name'), { id: null, name: null }];
  const lines = all(`SELECT a.id, a.code, a.name, a.type, jl.class_id, SUM(jl.debit) AS debit, SUM(jl.credit) AS credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    JOIN accounts a ON a.id=jl.account_id WHERE a.type IN ('income','expense') AND je.date>=? AND je.date<=? GROUP BY a.id, jl.class_id`, from, to);
  const accounts = new Map();
  for (const l of lines) {
    const a = accounts.get(l.id) || { id: l.id, code: l.code, name: l.name, type: l.type, byClass: {}, total: 0 };
    const v = l.type === 'income' ? l.credit - l.debit : l.debit - l.credit;
    const key = l.class_id ?? 'none';
    a.byClass[key] = (a.byClass[key] || 0) + v; a.total += v; accounts.set(l.id, a);
  }
  const rows = [...accounts.values()].sort((x, y) => x.code.localeCompare(y.code));
  const net = {};
  for (const c of classes) { const k = c.id ?? 'none'; net[k] = rows.reduce((s, r) => s + (r.type === 'income' ? 1 : -1) * (r.byClass[k] || 0), 0); }
  return { from, to, classes: classes.map((c) => ({ id: c.id ?? 'none', name: c.name })), income: rows.filter((r) => r.type === 'income'), expense: rows.filter((r) => r.type === 'expense'), net };
}

/** Previsão de caixa semanal: saldo dos bancos hoje + contas a receber e a pagar abertas (por vencimento) + recorrências ativas. */
export function cashForecast(weeks = 13, from = today()) {
  const w = Math.min(Math.max(Math.round(Number(weeks)) || 13, 1), 52);
  const horizon = addDays(from, w * 7 - 1);
  const buckets = Array.from({ length: w }, (_, i) => ({ from: addDays(from, i * 7), to: addDays(from, i * 7 + 6), inflow: 0, outflow: 0, recurringIn: 0, recurringOut: 0 }));
  const place = (date, key, amt) => {
    const d = date < from ? from : date; // vencido: entra na primeira semana
    const b = buckets.find((x) => d >= x.from && d <= x.to);
    if (b) b[key] += amt;
  };
  const start = all("SELECT a.id FROM accounts a WHERE a.type='asset' AND a.subtype='bank' AND a.active=1").reduce((s, a) =>
    s + get('SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=? AND je.date<=?', a.id, from).v, 0);
  for (const d of all("SELECT type,due_date,total-paid AS open FROM docs WHERE type IN ('invoice','bill') AND status IN ('sent','open','partial') AND total-paid>0")) {
    place(d.due_date, d.type === 'invoice' ? 'inflow' : 'outflow', d.open);
  }
  for (const r of all('SELECT * FROM recurring WHERE active=1')) {
    let t; try { t = JSON.parse(r.template); } catch { continue; }
    let total = 0; try { total = computeLines(t.type === 'bill' ? 'bill' : 'invoice', t.lines || []).total; } catch { continue; }
    for (let date = r.next_date, n = 0; date <= horizon && (!r.end_date || date <= r.end_date) && n < 60; date = advance(date, r.frequency, r.anchor_day), n++) {
      place(date, t.type === 'bill' ? 'recurringOut' : 'recurringIn', total);
    }
  }
  let balance = start, lowest = { balance: start, week: 0 };
  const rows = buckets.map((b, i) => {
    const inflow = b.inflow + b.recurringIn, outflow = b.outflow + b.recurringOut;
    balance += inflow - outflow;
    if (balance < lowest.balance) lowest = { balance, week: i + 1 };
    return { ...b, inflowTotal: inflow, outflowTotal: outflow, net: inflow - outflow, ending: balance };
  });
  return { from, to: horizon, weeks: w, startingCash: start, endingCash: balance, lowest, rows };
}
