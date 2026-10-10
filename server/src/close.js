// Fechamento do mês (plano Business): lista de verificação com o que o sistema consegue conferir sozinho e o que a pessoa marca.
// Ao terminar, "Fechar o mês" trava os lançamentos até o último dia (mesma trava de período do plano Plus).
import { all, get, run, getSetting, setSetting } from './db.js';
import { HttpError, isDate } from './accounting.js';
import { needsApproval } from './guard.js';
import { loadDoc } from './accounting.js';

const bad = (m) => new HttpError(400, m);
export const lastDayOf = (period) => { const [y, m] = period.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const MANUAL = ['review_ar', 'review_ap', 'review_reports'];

export function checklist(period) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw bad('Invalid month');
  const end = lastDayOf(period);
  const manual = Object.fromEntries(all('SELECT key,done_by,done_at FROM close_tasks WHERE period=?', period).map((r) => [r.key, r]));
  // só entram na conferência as contas de banco/cartão que já tinham movimento até o fim do mês
  const banks = all("SELECT id FROM accounts WHERE active=1 AND ((type='asset' AND subtype='bank') OR subtype='credit_card')")
    .filter((b) => get('SELECT 1 FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.account_id=? AND je.date<=? LIMIT 1', b.id, end));
  const reconciled = banks.every((b) => get('SELECT 1 FROM reconciliations WHERE account_id=? AND statement_date>=?', b.id, end));
  const periodIndex = (a) => { const [y0, m0] = a.acquired_date.slice(0, 7).split('-').map(Number), [y, m] = period.split('-').map(Number); return (y - y0) * 12 + (m - m0); };
  const assets = all("SELECT id,acquired_date,life_months FROM fixed_assets WHERE status='active'").filter((a) => periodIndex(a) >= 0 && periodIndex(a) < a.life_months);
  const depreciated = assets.every((a) => !!get('SELECT 1 FROM asset_depr WHERE asset_id=? AND period=?', a.id, period));
  const pendingBills = all("SELECT id FROM docs WHERE type='bill' AND status IN ('open','partial') AND issue_date<=?", end).map((r) => loadDoc(r.id)).filter(needsApproval).length;
  const draftRuns = get("SELECT COUNT(*) AS n FROM pay_runs WHERE status='draft' AND pay_date<=?", end).n;
  const lock = getSetting('lock_date', '');
  const items = [
    { key: 'bank_rec', auto: true, done: banks.length === 0 || reconciled },
    { key: 'depreciation', auto: true, done: depreciated },
    { key: 'approvals', auto: true, done: pendingBills === 0, detail: pendingBills },
    { key: 'payroll', auto: true, done: draftRuns === 0, detail: draftRuns },
    ...MANUAL.map((key) => ({ key, auto: false, done: !!manual[key], by: manual[key]?.done_by || null, at: manual[key]?.done_at || null })),
  ];
  const ready = items.every((i) => i.done);
  return { period, end, items, ready, locked: !!lock && lock >= end, lock_date: lock };
}

export function toggleTask(period, key, done, user) {
  if (!MANUAL.includes(key)) throw bad('This item is checked by the system');
  checklist(period);
  if (done) run('INSERT INTO close_tasks(period,key,done_by,done_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(period,key) DO UPDATE SET done_by=excluded.done_by, done_at=excluded.done_at', period, key, user.name);
  else run('DELETE FROM close_tasks WHERE period=? AND key=?', period, key);
  return checklist(period);
}

export function closeMonth(period) {
  const c = checklist(period);
  if (!c.ready) throw new HttpError(409, 'Finish every item before closing the month', { code: 'not_ready' });
  const lock = getSetting('lock_date', '');
  if (!lock || lock < c.end) setSetting('lock_date', c.end);
  return checklist(period);
}
