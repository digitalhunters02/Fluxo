// Regras que o motor contábil consulta sem depender dos módulos de cima (evita importação circular).
import { getSetting } from './db.js';

/** Limite de aprovação de contas a pagar, em centavos (0 = sem aprovação). */
export const approvalThreshold = () => Math.max(0, Number(getSetting('approval_threshold', '0')) || 0);

/** Uma conta a pagar exige aprovação quando o limite está ligado, o total chega nele e ainda não há aprovação deste valor. */
export function needsApproval(doc) {
  const th = approvalThreshold();
  if (!th || doc.type !== 'bill' || doc.total < th) return false;
  return !(doc.approval_status === 'approved' && Number(doc.approved_total) >= doc.total);
}

/** Texto do bloqueio, ou null se o pagamento pode seguir. */
export function approvalBlocksPayment(doc) {
  if (!needsApproval(doc)) return null;
  return doc.approval_status === 'rejected' ? 'This bill was rejected and cannot be paid' : 'This bill needs approval before it can be paid';
}
