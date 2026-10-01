// Feed bancário: importação, categorização automática (regras + aprendizado), conciliação.
import crypto from 'node:crypto';
import { all, get, run, insert, tx } from './db.js';
import { HttpError, postEntry, getAccount, cents, isDate, removeEntries } from './accounting.js';

const bad = (m) => new HttpError(400, m);
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\d{2}[/.-]\d{2}([/.-]\d{2,4})?/g, ' ').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
export const isBankAccount = (a) => a.type === 'asset' ? a.subtype === 'bank' : a.subtype === 'credit_card';

function requireBank(id) {
  const a = getAccount(id);
  if (!isBankAccount(a)) throw bad('The selected account is not a bank or card account');
  return a;
}

/** Sugere categoria: 1) regras do usuário 2) histórico de transações parecidas. */
export function suggestCategory(description, amount) {
  const d = norm(description);
  for (const r of all('SELECT * FROM bank_rules ORDER BY id')) {
    if (r.direction === 'in' && amount < 0) continue;
    if (r.direction === 'out' && amount > 0) continue;
    if (d.includes(norm(r.pattern))) return { account_id: r.account_id, source: 'rule' };
  }
  if (d.length >= 3) {
    const hist = all(`SELECT description, suggested_account_id, entry_id, amount FROM bank_txns WHERE status='categorized' AND entry_id IS NOT NULL ORDER BY id DESC LIMIT 800`);
    const counts = new Map();
    for (const h of hist) {
      if ((h.amount < 0) !== (amount < 0)) continue;
      if (norm(h.description) !== d) continue;
      const line = get(`SELECT jl.account_id FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.entry_id=? AND a.subtype NOT IN ('bank','credit_card') LIMIT 1`, h.entry_id);
      if (line) counts.set(line.account_id, (counts.get(line.account_id) || 0) + 1);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best) return { account_id: best[0], source: 'history' };
  }
  return null;
}

/** Procura lançamento já existente (pagamento, despesa…) com mesmo valor e data próxima. */
function findMatch(account_id, date, amount, exclude = []) {
  const from = new Date(Date.parse(date) - 5 * 864e5).toISOString().slice(0, 10), to = new Date(Date.parse(date) + 5 * 864e5).toISOString().slice(0, 10);
  const cands = all(`SELECT jl.id, je.date FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_id=? AND jl.debit-jl.credit=? AND je.date>=? AND je.date<=? AND jl.reconciliation_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM bank_txns b WHERE b.entry_id=je.id)
    AND je.source_type<>'bank'`, account_id, amount, from, to).filter((c) => !exclude.includes(c.id));
  cands.sort((a, b) => Math.abs(Date.parse(a.date) - Date.parse(date)) - Math.abs(Date.parse(b.date) - Date.parse(date)));
  return cands[0]?.id ?? null;
}

export function importTxns(account_id, rows) {
  requireBank(account_id);
  if (!Array.isArray(rows) || !rows.length) throw bad('No rows to import');
  if (rows.length > 5000) throw bad('Maximum of 5000 rows per import');
  let added = 0, duplicates = 0;
  tx(() => {
    const used = [];
    const seen = new Map();
    for (const r of rows) {
      if (!isDate(r.date)) throw bad(`Invalid date: ${r.date}`);
      const amount = cents(r.amount);
      if (amount === 0) continue;
      const description = String(r.description || '').trim().slice(0, 200) || '(no description)';
      const base = `${account_id}|${r.date}|${description}|${amount}`;
      const n = (seen.get(base) || 0) + 1; seen.set(base, n); // transações idênticas no mesmo arquivo são válidas
      const hash = crypto.createHash('sha1').update(`${base}|${n}`).digest('hex');
      if (get('SELECT 1 FROM bank_txns WHERE hash=?', hash)) { duplicates++; continue; }
      const sug = suggestCategory(description, amount);
      const match = findMatch(account_id, r.date, amount, used);
      if (match) used.push(match);
      insert(`INSERT INTO bank_txns(account_id,date,description,amount,hash,suggested_account_id,suggested_line_id,suggestion_source) VALUES(?,?,?,?,?,?,?,?)`,
        account_id, r.date, description, amount, hash, match ? null : sug?.account_id ?? null, match, match ? 'existing' : sug?.source ?? '');
      added++;
    }
  });
  return { added, duplicates };
}

export function categorize(id, { account_id, contact_id, memo, remember }, user) {
  return tx(() => {
    const t = get('SELECT * FROM bank_txns WHERE id=?', id);
    if (!t) throw new HttpError(404, 'Transaction not found');
    if (t.status !== 'pending') throw bad('Transaction already handled');
    const cat = getAccount(account_id);
    const bank = getAccount(t.account_id);
    const amt = Math.abs(t.amount);
    const lines = t.amount > 0
      ? [{ account_id: bank.id, debit: amt }, { account_id: cat.id, credit: amt, contact_id: contact_id || null }]
      : [{ account_id: cat.id, debit: amt, contact_id: contact_id || null }, { account_id: bank.id, credit: amt }];
    const entry = postEntry({ date: t.date, memo: memo || t.description, source_type: 'bank', source_id: t.id, lines, user_id: user?.id });
    run('UPDATE bank_txns SET status=\'categorized\', entry_id=?, suggested_account_id=? WHERE id=?', entry, cat.id, id);
    if (remember) {
      const pattern = norm(t.description).split(' ').slice(0, 3).join(' ');
      if (pattern.length >= 3 && !get('SELECT 1 FROM bank_rules WHERE pattern=? AND account_id=?', pattern, cat.id)) {
        insert('INSERT INTO bank_rules(pattern,account_id,contact_id,direction) VALUES(?,?,?,?)', pattern, cat.id, contact_id || null, t.amount > 0 ? 'in' : 'out');
      }
    }
    return get('SELECT * FROM bank_txns WHERE id=?', id);
  });
}

export function matchTxn(id, line_id) {
  return tx(() => {
    const t = get('SELECT * FROM bank_txns WHERE id=?', id);
    if (!t) throw new HttpError(404, 'Transaction not found');
    if (t.status !== 'pending') throw bad('Transaction already handled');
    const l = get(`SELECT jl.*, je.id AS eid FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE jl.id=?`, line_id);
    if (!l || l.account_id !== t.account_id) throw bad('Entry does not belong to this account');
    if (l.debit - l.credit !== t.amount) throw bad('Amounts do not match');
    if (get('SELECT 1 FROM bank_txns WHERE entry_id=?', l.eid)) throw bad('Entry already linked to another transaction');
    run('UPDATE bank_txns SET status=\'matched\', entry_id=? WHERE id=?', l.eid, id);
    return get('SELECT * FROM bank_txns WHERE id=?', id);
  });
}

export function undoTxn(id) {
  return tx(() => {
    const t = get('SELECT * FROM bank_txns WHERE id=?', id);
    if (!t) throw new HttpError(404, 'Transaction not found');
    if (t.status === 'categorized') removeEntries('bank', id);
    run('UPDATE bank_txns SET status=\'pending\', entry_id=NULL WHERE id=?', id);
  });
}

export function acceptAllSuggestions(account_id, user) {
  let ok = 0, matched = 0;
  const pend = all(`SELECT * FROM bank_txns WHERE status='pending' ${account_id ? 'AND account_id=?' : ''}`, ...(account_id ? [account_id] : []));
  for (const t of pend) {
    try {
      if (t.suggested_line_id) { matchTxn(t.id, t.suggested_line_id); matched++; }
      else if (t.suggested_account_id) { categorize(t.id, { account_id: t.suggested_account_id }, user); ok++; }
    } catch { /* skip invalid suggestions */ }
  }
  return { categorized: ok, matched };
}

/* ------------------------------- conciliação ------------------------------ */

const sign = (acc) => (acc.type === 'asset' ? 1 : -1);

export function reconcileState(account_id, upTo) {
  const acc = requireBank(account_id);
  const s = sign(acc);
  const lines = all(`SELECT jl.id, je.date, je.memo, jl.debit, jl.credit FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id
    WHERE jl.account_id=? AND jl.reconciliation_id IS NULL AND je.date<=? ORDER BY je.date, jl.id`, account_id, upTo)
    .map((l) => ({ ...l, amount: (l.debit - l.credit) * s }));
  const beginning = get('SELECT COALESCE(SUM(debit-credit),0) AS v FROM journal_lines WHERE account_id=? AND reconciliation_id IS NOT NULL', account_id).v * s;
  const last = get('SELECT * FROM reconciliations WHERE account_id=? ORDER BY id DESC LIMIT 1', account_id) || null;
  return { account: acc, beginning, lines, last };
}

export function finishReconcile(account_id, { statement_date, statement_balance, line_ids }, user) {
  if (!isDate(statement_date)) throw bad('Invalid statement date');
  const st = cents(statement_balance);
  return tx(() => {
    const state = reconcileState(account_id, statement_date);
    const chosen = new Set(line_ids || []);
    const sel = state.lines.filter((l) => chosen.has(l.id));
    if (sel.length !== chosen.size) throw bad('Some selected entries are invalid');
    const diff = st - (state.beginning + sel.reduce((s, l) => s + l.amount, 0));
    if (diff !== 0) throw bad(`The reconciliation does not balance: off by ${diff} cents`);
    const rid = insert('INSERT INTO reconciliations(account_id,statement_date,statement_balance,created_by) VALUES(?,?,?,?)', account_id, statement_date, st, user?.id ?? null);
    for (const l of sel) run('UPDATE journal_lines SET reconciliation_id=? WHERE id=?', rid, l.id);
    return { id: rid, reconciled: sel.length };
  });
}

export function undoLastReconcile(account_id) {
  return tx(() => {
    const last = get('SELECT * FROM reconciliations WHERE account_id=? ORDER BY id DESC LIMIT 1', account_id);
    if (!last) throw bad('No reconciliation to undo');
    run('UPDATE journal_lines SET reconciliation_id=NULL WHERE reconciliation_id=?', last.id);
    run('DELETE FROM reconciliations WHERE id=?', last.id);
    return last;
  });
}
