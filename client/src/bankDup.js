import { t } from './i18n.jsx';
import { date, money } from './format.js';

/**
 * Grava um lançamento digitado à mão. Se o banco já trouxe a mesma transação (mesmo valor, data próxima), o servidor avisa
 * e a pessoa decide: OK = é a mesma (liga as duas, conta uma vez só); Cancelar = é outra (grava separado).
 */
export async function withBankDup(send) {
  try { return await send({}); } catch (e) {
    if (e.data?.code !== 'possible_duplicate_bank') throw e;
    const x = e.data.txn || {};
    const same = confirm(`${e.message}\n\n${x.description || ''} · ${date(x.date)} · ${money(x.amount)}\n\n${t('OK = it is the same one (link them). Cancel = it is a different one (save separately).')}`);
    return send(same ? { matchBankTxn: x.id } : { allowDuplicate: true });
  }
}
