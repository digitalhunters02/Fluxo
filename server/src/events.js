// Webhooks de saída: cada evento é um POST em JSON assinado com HMAC-SHA256 no cabeçalho
// X-Fluxo-Signature (t=<unix>,v1=<hex> sobre "<t>.<corpo>"), para o outro lado conferir que veio do Fluxo.
// Falhas nunca derrubam a operação que gerou o evento: ficam registradas e, depois de 10 seguidas, o aviso é desligado.
// Segurança: só https (http só com WEBHOOK_ALLOW_INSECURE=1, para testes) e nunca endereços internos (SSRF).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { all, get, run, als } from './db.js';

export const EVENTS = ['invoice.created', 'invoice.paid', 'payment.received', 'bill.created', 'customer.created', 'bill.approved', 'asset.depreciated'];

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw Object.assign(new Error('Invalid address'), { status: 400 }); }
  const insecureOk = process.env.WEBHOOK_ALLOW_INSECURE === '1';
  const fail = (m) => Object.assign(new Error(m), { status: 400 });
  if (u.protocol !== 'https:' && !(insecureOk && u.protocol === 'http:')) throw fail('Use an https address');
  if (u.username || u.password) throw fail('The address cannot contain a user name or password');
  if (insecureOk) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw fail('That address is not allowed');
  return u;
}

export const sign = (secret, t, body) => crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

export async function deliver(hook, event, payload) {
  const id = crypto.randomUUID();
  const body = JSON.stringify({ id, event, created: Math.floor(Date.now() / 1000), data: payload });
  const t = Math.floor(Date.now() / 1000);
  let status = null, error = null;
  try {
    const u = await assertSafeUrl(hook.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fluxo-Event': event, 'X-Fluxo-Signature': `t=${t},v1=${sign(hook.secret, t, body)}`, 'User-Agent': 'Fluxo-Webhooks/1' }, body, redirect: 'manual', signal: ctrl.signal });
    clearTimeout(timer);
    status = r.status;
  } catch (e) { error = String(e.message || e).slice(0, 200); }
  const ok = status !== null && status >= 200 && status < 300;
  try {
    run('INSERT INTO webhook_deliveries(id,webhook_id,event,status,ok,error) VALUES(?,?,?,?,?,?)', id, hook.id, event, status, ok ? 1 : 0, error);
    run(`UPDATE webhooks SET last_status=?, last_at=CURRENT_TIMESTAMP, failures=CASE WHEN ? THEN 0 ELSE failures+1 END,
         active=CASE WHEN ? THEN active WHEN failures+1>=10 THEN 0 ELSE active END WHERE id=?`, status, ok ? 1 : 0, ok ? 1 : 0, hook.id);
    run('DELETE FROM webhook_deliveries WHERE webhook_id=? AND id NOT IN (SELECT id FROM webhook_deliveries WHERE webhook_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50)', hook.id, hook.id);
  } catch (e) { console.error('[webhooks] could not record delivery:', e.message); }
  return { ok, status, error };
}

/** Dispara (sem esperar) o evento para os avisos ativos da empresa atual que o assinam. */
export function emit(event, payload) {
  const store = als.getStore();
  const work = async () => {
    try {
      for (const hook of all('SELECT * FROM webhooks WHERE active=1')) {
        let evs = [];
        try { evs = JSON.parse(hook.events || '[]'); } catch { evs = []; }
        if (evs.includes('*') || evs.includes(event)) await deliver(hook, event, payload);
      }
    } catch (e) { console.error('[webhooks] emit failed', event, e.message); }
  };
  setImmediate(() => (store ? als.run(store, work) : work()));
}
