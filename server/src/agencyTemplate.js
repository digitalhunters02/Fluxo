// Modelo de plano de contas para agência de seguros + contabilidade de custódia (conta fiduciária / "trust").
// O dono liga o modelo por um botão: ele SÓ ACRESCENTA contas (nunca apaga nem renomeia as que já existem).
// Depois disso, um sistema de gestão da agência (o Binder) pode mandar pela API os movimentos do dinheiro de prêmio:
//   prêmio recebido do cliente   → Banco de custódia (débito) / Prêmios a repassar às seguradoras (crédito)
//   repasse à seguradora          → Prêmios a repassar (débito) / Banco de custódia (crédito)
//   comissão retida pela agência  → Prêmios a repassar (débito) / Receita de comissão (crédito)
//                                   + Banco operacional (débito) / Banco de custódia (crédito)  [o dinheiro sai da custódia]
// É um controle interno: as regras de conta fiduciária variam por estado e devem ser validadas com contador e advogado.
import { all, get, run, insert, tx, getSetting, setSetting } from './db.js';
import { HttpError, postEntry, isDate, today, cents } from './accounting.js';

const bad = (m) => new HttpError(400, m);
export const TEMPLATE_ID = 'insurance_agency';
const FLAG = 'template_insurance_agency';

// [código, nomes, tipo, subtipo, conta que o sistema usa para lançar (não pode ser apagada)]
export const INSURANCE_ACCOUNTS = [
  ['1040', { en: 'Premium Trust Account', pt: 'Conta de Custódia de Prêmios', es: 'Cuenta fiduciaria de primas' }, 'asset', 'trust_bank', true],
  ['2400', { en: 'Premiums Payable to Carriers', pt: 'Prêmios a Repassar às Seguradoras', es: 'Primas por pagar a aseguradoras' }, 'liability', 'ins_payable', true],
  ['2410', { en: 'Return Premiums Payable to Clients', pt: 'Estornos de Prêmio a Devolver a Clientes', es: 'Primas devueltas por pagar a clientes' }, 'liability', 'ins_refund_payable', false],
  ['4200', { en: 'Commission Income - New Business', pt: 'Receita de Comissão - Apólices Novas', es: 'Ingresos por comisión - negocio nuevo' }, 'income', 'ins_comm_new', true],
  ['4210', { en: 'Commission Income - Renewals', pt: 'Receita de Comissão - Renovações', es: 'Ingresos por comisión - renovaciones' }, 'income', 'ins_comm_renewal', true],
  ['4220', { en: 'Agency & Policy Fees', pt: 'Taxas de Agência e de Apólice', es: 'Tarifas de agencia y de póliza' }, 'income', 'ins_fees', true],
  ['4230', { en: 'Contingent & Bonus Commission', pt: 'Comissão de Contingência e Bônus', es: 'Comisión contingente y bonos' }, 'income', 'ins_contingent', true],
  ['6120', { en: 'Producer Commissions', pt: 'Comissões de Produtores', es: 'Comisiones de productores' }, 'expense', 'ins_producer_comm', false],
  ['6140', { en: 'Errors & Omissions Insurance', pt: 'Seguro E&O (Erros e Omissões)', es: 'Seguro de errores y omisiones' }, 'expense', '', false],
  ['6150', { en: 'Licensing & Continuing Education', pt: 'Licenças e Educação Continuada', es: 'Licencias y educación continua' }, 'expense', '', false],
];

const COMM_ROLE = { new: 'ins_comm_new', renewal: 'ins_comm_renewal', fee: 'ins_fees', contingent: 'ins_contingent' };
export const KINDS = ['client_payment', 'carrier_remit', 'commission_retained'];

export const templateApplied = () => getSetting(FLAG, '0') === '1';

export function templateStatus() {
  const lang = getSetting('lang', 'en');
  return {
    id: TEMPLATE_ID,
    applied: templateApplied(),
    accounts: INSURANCE_ACCOUNTS.map(([code, names, type, subtype]) => {
      const bySub = subtype ? get('SELECT code FROM accounts WHERE subtype=? AND active=1 ORDER BY code LIMIT 1', subtype) : null;
      const byCode = get('SELECT code,name FROM accounts WHERE code=?', code);
      return { code: bySub?.code || code, name: names[lang] || names.en, type, subtype, exists: !!(bySub || (byCode && !subtype)) };
    }),
    operatingAccountId: Number(getSetting('ins_operating_account', '0')) || null,
  };
}

// Primeiro código livre a partir do sugerido (se o dono já usa o número para outra coisa, não mexemos nela).
function freeCode(code) {
  let n = Number(code);
  for (let i = 0; i < 10; i++, n++) if (!get('SELECT 1 FROM accounts WHERE code=?', String(n))) return String(n);
  throw bad(`No free account code near ${code}. Free one up and try again`);
}

/** Liga o modelo. Idempotente: roda de novo e só cria o que faltar. Devolve o que criou e o que já existia. */
export function applyTemplate({ operatingAccountId } = {}) {
  const lang = getSetting('lang', 'en');
  const created = [], existing = [];
  tx(() => {
    for (const [code, names, type, subtype, system] of INSURANCE_ACCOUNTS) {
      const have = subtype
        ? get('SELECT code FROM accounts WHERE subtype=? ORDER BY code LIMIT 1', subtype)
        : get('SELECT code FROM accounts WHERE code=? AND type=?', code, type);
      if (have) { existing.push(have.code); continue; }
      const use = freeCode(code);
      insert('INSERT INTO accounts(code,name,type,subtype,is_system) VALUES(?,?,?,?,?)', use, names[lang] || names.en, type, subtype, system ? 1 : 0);
      created.push(use);
    }
    if (operatingAccountId !== undefined && operatingAccountId !== null) {
      const a = get("SELECT id FROM accounts WHERE id=? AND type='asset' AND subtype='bank' AND active=1", Number(operatingAccountId));
      if (!a) throw bad('Choose a bank account of the agency (not the trust account) for commission withdrawals');
      setSetting('ins_operating_account', a.id);
    }
    setSetting(FLAG, '1');
  });
  return { created, existing, ...templateStatus() };
}

const role = (subtype) => {
  const a = get('SELECT * FROM accounts WHERE subtype=? AND active=1 ORDER BY code LIMIT 1', subtype);
  if (!a) throw new HttpError(409, `The "${subtype}" account is missing. Apply the insurance agency chart of accounts in Fluxo first`, { code: 'template_required' });
  return a;
};
const operatingAccount = (idIn) => {
  const want = Number(idIn) || Number(getSetting('ins_operating_account', '0'));
  const a = (want && get("SELECT * FROM accounts WHERE id=? AND type='asset' AND subtype='bank' AND active=1", want))
    || get("SELECT * FROM accounts WHERE type='asset' AND subtype='bank' AND active=1 ORDER BY code LIMIT 1");
  if (!a) throw bad('No operating bank account found to receive the commission');
  return a;
};
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

function carrierContact(name) {
  const n = clip(name, 120);
  if (!n) return null;
  const ext = `trust-carrier-${n.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80)}`;
  const ex = get('SELECT id FROM contacts WHERE external_id=?', ext) || get("SELECT id FROM contacts WHERE kind IN ('vendor','both') AND lower(name)=lower(?) LIMIT 1", n);
  if (ex) return ex.id;
  return insert("INSERT INTO contacts(kind,name,external_id) VALUES('vendor',?,?)", n, ext);
}

/** Cria o lançamento de custódia a partir do que o sistema da agência mandou. Reenviar o mesmo externalId nunca duplica. */
export function recordTrustEntry(b) {
  if (!templateApplied()) throw new HttpError(409, 'Apply the insurance agency chart of accounts in Fluxo first (Accounting → Chart of accounts)', { code: 'template_required' });
  const externalId = clip(b.externalId, 100);
  if (!externalId) throw bad('externalId is required');
  const found = get('SELECT id FROM journal_entries WHERE external_id=?', externalId);
  if (found) return { id: found.id, duplicate: true };
  if (!KINDS.includes(b.kind)) throw bad(`kind must be one of: ${KINDS.join(', ')}`);
  const amount = cents(b.amountCents);
  if (amount <= 0) throw bad('amountCents must be greater than zero');
  const date = b.date || today();
  if (!isDate(date)) throw bad('date must be YYYY-MM-DD');
  const trust = role('trust_bank'), payable = role('ins_payable');
  const contact = carrierContact(b.carrierName);
  const what = { client_payment: 'Premium received', carrier_remit: 'Premium remitted to carrier', commission_retained: 'Commission retained' }[b.kind];
  const memo = [what, clip(b.policyNumber, 60) && `policy ${clip(b.policyNumber, 60)}`, clip(b.insuredName, 80), clip(b.carrierName, 80)].filter(Boolean).join(' — ');
  let lines;
  if (b.kind === 'client_payment') lines = [{ account_id: trust.id, debit: amount }, { account_id: payable.id, credit: amount, contact_id: contact }];
  else if (b.kind === 'carrier_remit') lines = [{ account_id: payable.id, debit: amount, contact_id: contact }, { account_id: trust.id, credit: amount }];
  else {
    const income = role(COMM_ROLE[b.commissionType] || 'ins_comm_new');
    const op = operatingAccount(b.operatingAccountId);
    lines = [
      { account_id: payable.id, debit: amount, contact_id: contact }, { account_id: income.id, credit: amount },
      { account_id: op.id, debit: amount }, { account_id: trust.id, credit: amount },
    ];
  }
  const id = postEntry({ date, memo, source_type: 'trust_api', lines });
  run('UPDATE journal_entries SET external_id=? WHERE id=?', externalId, id);
  return { id, duplicate: false };
}

/** Anula um lançamento enviado antes: cria o lançamento inverso (nada é apagado). Reenviar não duplica. */
export function voidTrustEntry(externalId, date) {
  const ext = clip(externalId, 100);
  const orig = get('SELECT * FROM journal_entries WHERE external_id=?', ext);
  if (!orig) throw new HttpError(404, 'Entry not found');
  const revExt = `${ext}#void`;
  const done = get('SELECT id FROM journal_entries WHERE external_id=?', revExt);
  if (done) return { id: done.id, duplicate: true };
  const d = date || today();
  if (!isDate(d)) throw bad('date must be YYYY-MM-DD');
  const lines = all('SELECT account_id,debit,credit,contact_id FROM journal_lines WHERE entry_id=? ORDER BY id', orig.id)
    .map((l) => ({ account_id: l.account_id, debit: l.credit, credit: l.debit, contact_id: l.contact_id }));
  const id = postEntry({ date: d, memo: `Void — ${orig.memo}`, source_type: 'trust_api', lines });
  run('UPDATE journal_entries SET external_id=? WHERE id=?', revExt, id);
  return { id, duplicate: false };
}

/** Saldos para conferir com o sistema da agência: o banco de custódia deve bater com os prêmios a repassar. */
export function trustSummary() {
  const net = (subtype) => get(`SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE a.subtype=?`, subtype).v;
  const trustBankCents = net('trust_bank'), payableCents = -net('ins_payable');
  return {
    template: templateApplied(),
    trustBankCents, payableCents, differenceCents: trustBankCents - payableCents,
    entries: get("SELECT COUNT(*) AS n FROM journal_entries WHERE source_type='trust_api' AND external_id NOT LIKE '%#void'").n,
  };
}
