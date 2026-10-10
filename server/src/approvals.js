// Aprovação de contas a pagar (plano Business). Com um limite ligado, uma conta a pagar de valor igual ou maior só pode ser
// paga depois de aprovada. Se o valor da conta subir depois da aprovação, ela volta a pedir aprovação.
// Separação de funções (opcional): quem lançou a conta não pode aprová-la.
import { all, get, run, setSetting, getSetting } from './db.js';
import { HttpError, loadDoc } from './accounting.js';
import { approvalThreshold, needsApproval } from './guard.js';
import { emit } from './events.js';

const bad = (m) => new HttpError(400, m);

export const approvalSettings = () => ({ threshold: approvalThreshold(), segregation: getSetting('approval_sod', '0') === '1' });

export function saveApprovalSettings({ threshold, segregation }) {
  if (threshold !== undefined) {
    const n = Math.round(Number(threshold));
    if (!Number.isFinite(n) || n < 0) throw bad('Invalid limit');
    setSetting('approval_threshold', n);
  }
  if (segregation !== undefined) setSetting('approval_sod', segregation ? '1' : '0');
  return approvalSettings();
}

/** Contas a pagar emitidas, ainda não quitadas, que precisam de aprovação (ou foram recusadas). */
export function pendingApprovals() {
  const rows = all("SELECT id FROM docs WHERE type='bill' AND status IN ('open','partial') ORDER BY due_date, id");
  return rows.map((r) => loadDoc(r.id)).filter((d) => needsApproval(d))
    .map((d) => ({ id: d.id, number: d.number, vendor: d.contact_name, total: d.total, due_date: d.due_date, status: d.approval_status || 'pending', created_by: d.created_by }));
}

export function decide(id, action, user) {
  const d = loadDoc(id);
  if (!d || d.type !== 'bill') throw new HttpError(404, 'Bill not found');
  if (!approvalThreshold()) throw bad('Approvals are not turned on');
  if (['void', 'draft', 'paid'].includes(d.status)) throw bad('This bill cannot be approved or rejected now');
  if (action === 'approve' && getSetting('approval_sod', '0') === '1' && d.created_by && d.created_by === user.id) {
    throw new HttpError(403, 'You cannot approve a bill you entered yourself');
  }
  if (action === 'approve') {
    run("UPDATE docs SET approval_status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, approved_total=? WHERE id=?", user.name, d.total, id);
    emit('bill.approved', { id, number: d.number, totalCents: d.total, approvedBy: user.name });
  } else {
    run("UPDATE docs SET approval_status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, approved_total=NULL WHERE id=?", user.name, id);
  }
  return loadDoc(id);
}
