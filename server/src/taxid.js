// SSN/EIN: nunca em texto puro no banco nem na API.
//  - gravado criptografado (AES-256-GCM, secure.js) com o prefixo "enc1:" na própria coluna tax_id;
//  - a API devolve só "***-**-1234" (mask) + has_tax_id; o número inteiro só sai por rota própria, para o dono, e fica no log de auditoria;
//  - registros antigos em texto puro continuam funcionando e são cifrados na subida (sealLegacyTaxIds).
import { all, run } from './db.js';
import { encrypt, decrypt } from './secure.js';
import { HttpError } from './accounting.js';

const PREFIX = 'enc1:';
const bad = (m) => new HttpError(400, m);

export const isSealed = (v) => String(v ?? '').startsWith(PREFIX);
export const seal = (plain) => (plain ? PREFIX + encrypt(plain) : '');
/** Número completo (aceita registro antigo em texto puro). Só para as rotas de "mostrar" e para o arquivo do contador. */
export function open(v) {
  if (!v) return '';
  if (!isSealed(v)) return String(v);
  try { return decrypt(String(v).slice(PREFIX.length)); } catch { return ''; }
}
const lastFour = (plain) => String(plain).replace(/[^0-9A-Za-z]/g, '').slice(-4);
/** "***-**-1234" para a tela; '' se não há número. */
export function mask(v) {
  const plain = open(v);
  return plain ? `***-**-${lastFour(plain)}` : (v ? '***' : '');
}
/** Troca o tax_id do registro pela versão segura (texto mascarado + marcador) antes de sair pela API. */
export const publicTaxId = (row) => (row && 'tax_id' in row ? { ...row, has_tax_id: !!row.tax_id, tax_id: mask(row.tax_id) } : row);

/**
 * O que gravar a partir do que veio do formulário.
 *  - ausente ou mascarado ("***-**-1234") → mantém o que já está gravado (editar sem mexer no número não o apaga);
 *  - vazio → apaga;
 *  - strict (prestador 1099 e funcionário): 9 números, senão 400;
 *  - não strict (clientes, outros países): texto livre até 40 caracteres.
 */
export function prepareTaxId(raw, current, { strict = false } = {}) {
  if (raw === undefined || raw === null) return current ?? '';
  const s = String(raw).trim();
  if (s.includes('*')) return current ?? '';
  if (!s) return '';
  if (strict) {
    const digits = s.replace(/\D/g, '');
    if (digits.length !== 9 || /^(\d)\1{8}$/.test(digits) || /[A-Za-z]/.test(s)) throw bad('SSN/EIN must have 9 digits');
    return seal(`${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`);
  }
  return seal(s.slice(0, 40));
}

/** Cifra os números que ainda estão em texto puro (rodar com o banco da empresa ativo). */
export function sealLegacyTaxIds() {
  let n = 0;
  for (const table of ['contacts', 'employees']) {
    for (const r of all(`SELECT id, tax_id FROM ${table} WHERE tax_id IS NOT NULL AND tax_id <> '' AND tax_id NOT LIKE '${PREFIX}%'`)) {
      run(`UPDATE ${table} SET tax_id=? WHERE id=?`, seal(r.tax_id), r.id); n += 1;
    }
  }
  return n;
}
