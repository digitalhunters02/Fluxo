// Criptografia em repouso para segredos (ex.: access_token do Plaid). AES-256-GCM.
// A chave vem de FLUXO_ENCRYPTION_KEY (recomendado em produção); sem ela, uma chave aleatória é gerada e guardada nas configurações.
import crypto from 'node:crypto';
import { getSetting, setSetting } from './db.js';

function key() {
  const env = process.env.FLUXO_ENCRYPTION_KEY;
  if (env) return crypto.scryptSync(env, 'fluxo-secrets-v1', 32);
  let k = getSetting('enc_key', '');
  if (!k) { k = crypto.randomBytes(32).toString('hex'); setSetting('enc_key', k); }
  return Buffer.from(k, 'hex');
}

export function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(':');
  if (v !== 'v1') throw new Error('Unsupported secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
