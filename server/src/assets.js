// Ativos fixos e depreciação linear (plano Business). Cada mês depreciado vira um lançamento: débito na despesa de depreciação,
// crédito na depreciação acumulada. Começa no mês da compra; o último mês fecha o valor exato (sem sobra de centavos).
import { all, get, run, insert, tx } from './db.js';
import { HttpError, postEntry, isDate, cents, getAccount, today, assertOpenPeriod } from './accounting.js';
import { emit } from './events.js';

const bad = (m) => new HttpError(400, m);
const ym = (iso) => iso.slice(0, 7);
const lastDay = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const nextPeriod = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

/** Contas de depreciação: criadas na primeira vez que são precisas. */
export function ensureAssetAccounts() {
  const mk = (code, name, type, subtype) => {
    const ex = get('SELECT id FROM accounts WHERE subtype=? AND active=1', subtype) || get('SELECT id FROM accounts WHERE code=?', code);
    if (ex) return ex.id;
    return insert('INSERT INTO accounts(code,name,type,subtype,is_system) VALUES(?,?,?,?,1)', code, name, type, subtype);
  };
  return {
    accum: mk('1590', 'Accumulated Depreciation', 'asset', 'accum_depr'),
    expense: mk('6950', 'Depreciation Expense', 'expense', 'depr_exp'),
    asset: get("SELECT id FROM accounts WHERE subtype='fixed_asset' AND active=1 ORDER BY code")?.id,
  };
}

const perMonth = (a) => Math.floor((a.cost - a.salvage) / a.life_months);
/** Quanto se deprecia no mês de índice idx (0 = mês da compra). */
const amountFor = (a, idx) => (idx === a.life_months - 1 ? (a.cost - a.salvage) - perMonth(a) * (a.life_months - 1) : perMonth(a));
const periodIndex = (a, period) => {
  const [y0, m0] = ym(a.acquired_date).split('-').map(Number), [y, m] = period.split('-').map(Number);
  return (y - y0) * 12 + (m - m0);
};

export function createAsset(input) {
  const name = String(input.name || '').trim().slice(0, 120);
  if (!name) throw bad('Enter a name');
  if (!isDate(input.acquired_date)) throw bad('Invalid purchase date');
  const cost = cents(input.cost), salvage = cents(input.salvage || 0), life = Math.round(Number(input.life_months));
  if (cost <= 0) throw bad('The cost must be greater than zero');
  if (salvage < 0 || salvage >= cost) throw bad('The salvage value must be less than the cost');
  if (!Number.isInteger(life) || life < 1 || life > 600) throw bad('The useful life must be between 1 and 600 months');
  const base = ensureAssetAccounts();
  const asset_account_id = input.asset_account_id ? getAccount(Number(input.asset_account_id)).id : base.asset;
  if (!asset_account_id) throw bad('No fixed asset account found. Add one to the chart of accounts');
  const id = insert('INSERT INTO fixed_assets(name,acquired_date,cost,salvage,life_months,asset_account_id,accum_account_id,expense_account_id,notes) VALUES(?,?,?,?,?,?,?,?,?)',
    name, input.acquired_date, cost, salvage, life, asset_account_id, base.accum, base.expense, String(input.notes || '').slice(0, 300));
  return loadAsset(id);
}

export function loadAsset(id) {
  const a = get('SELECT * FROM fixed_assets WHERE id=?', id);
  if (!a) return null;
  const done = get('SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total, MAX(period) AS last FROM asset_depr WHERE asset_id=?', id);
  return { ...a, depreciated: done.total, months_done: done.n, last_period: done.last, book_value: a.cost - done.total, fully_depreciated: done.n >= a.life_months };
}
export const listAssets = () => all('SELECT id FROM fixed_assets ORDER BY acquired_date DESC, id DESC').map((r) => loadAsset(r.id));

/** Lança a depreciação de todos os meses pendentes até `through` (AAAA-MM). Meses em período fechado ficam de fora e são avisados. */
export function depreciate(through = ym(today()), user = null) {
  if (!/^\d{4}-\d{2}$/.test(through)) throw bad('Invalid month');
  const posted = [], skipped = [];
  tx(() => {
    for (const a of all("SELECT * FROM fixed_assets WHERE status='active' ORDER BY id")) {
      let p = ym(a.acquired_date);
      for (; p <= through; p = nextPeriod(p)) {
        const idx = periodIndex(a, p);
        if (idx >= a.life_months) break;
        if (get('SELECT 1 FROM asset_depr WHERE asset_id=? AND period=?', a.id, p)) continue;
        const amount = amountFor(a, idx);
        if (amount <= 0) continue;
        try { assertOpenPeriod(lastDay(p)); } catch { skipped.push({ asset: a.name, period: p, reason: 'period_closed' }); continue; }
        const did = insert('INSERT INTO asset_depr(asset_id,period,amount) VALUES(?,?,?)', a.id, p, amount);
        const eid = postEntry({ date: lastDay(p), memo: `Depreciation — ${a.name} (${p})`, source_type: 'depreciation', source_id: did, user_id: user?.id,
          lines: [{ account_id: a.expense_account_id, debit: amount }, { account_id: a.accum_account_id, credit: amount }] });
        run('UPDATE asset_depr SET entry_id=? WHERE id=?', eid, did);
        posted.push({ asset: a.name, period: p, amount });
      }
    }
  });
  if (posted.length) emit('asset.depreciated', { count: posted.length, through, totalCents: posted.reduce((s, x) => s + x.amount, 0) });
  return { posted, skipped, total: posted.reduce((s, x) => s + x.amount, 0) };
}

/** Baixa do ativo: deprecia até o mês da venda, tira o custo e a depreciação acumulada e lança o ganho ou a perda. */
export function disposeAsset(id, { date, proceeds = 0, deposit_account_id }, user = null) {
  const a = get('SELECT * FROM fixed_assets WHERE id=?', id);
  if (!a) throw new HttpError(404, 'Asset not found');
  if (a.status === 'disposed') throw bad('This asset was already disposed');
  if (!isDate(date) || date < a.acquired_date) throw bad('Invalid date');
  const proceedsC = cents(proceeds);
  if (proceedsC < 0) throw bad('Invalid amount');
  if (proceedsC > 0) { const acc = getAccount(Number(deposit_account_id)); if (acc.type !== 'asset') throw bad('Choose the account that received the money'); }
  return tx(() => {
    depreciate(ym(date), user);
    const accum = get('SELECT COALESCE(SUM(amount),0) AS v FROM asset_depr WHERE asset_id=?', id).v;
    const gain = Math.max(0, proceedsC + accum - a.cost), loss = Math.max(0, a.cost - accum - proceedsC);
    const gainAcc = get("SELECT id FROM accounts WHERE code='4900'")?.id, lossAcc = get("SELECT id FROM accounts WHERE code='6990'")?.id;
    const lines = [{ account_id: a.asset_account_id, credit: a.cost }];
    if (accum) lines.push({ account_id: a.accum_account_id, debit: accum });
    if (proceedsC) lines.push({ account_id: Number(deposit_account_id), debit: proceedsC });
    if (loss) { if (!lossAcc) throw bad('Miscellaneous expense account not found'); lines.push({ account_id: lossAcc, debit: loss }); }
    if (gain) { if (!gainAcc) throw bad('Other income account not found'); lines.push({ account_id: gainAcc, credit: gain }); }
    postEntry({ date, memo: `Disposal — ${a.name}`, source_type: 'asset_disposal', source_id: id, lines, user_id: user?.id });
    run("UPDATE fixed_assets SET status='disposed', disposed_date=?, disposal_proceeds=? WHERE id=?", date, proceedsC, id);
    return { ...loadAsset(id), gain, loss };
  });
}
