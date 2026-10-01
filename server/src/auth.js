import crypto from 'node:crypto';
import { get, run, insert, all } from './db.js';
import { HttpError } from './accounting.js';

export const ROLES = { owner: 'Owner', accountant: 'Accountant', sales: 'Sales', viewer: 'Read-only' };

// Matriz de permissões: módulo -> papéis que podem escrever / ler
const WRITE = {
  sales: ['owner', 'accountant', 'sales'], purchases: ['owner', 'accountant'], banking: ['owner', 'accountant'],
  accounting: ['owner', 'accountant'], projects: ['owner', 'accountant', 'sales'], inventory: ['owner', 'accountant', 'sales'],
  settings: ['owner'], users: ['owner'], payroll: ['owner', 'accountant'],
};
const READ = {
  sales: ['owner', 'accountant', 'sales', 'viewer'], purchases: ['owner', 'accountant', 'viewer'], banking: ['owner', 'accountant', 'viewer'],
  accounting: ['owner', 'accountant', 'viewer'], reports: ['owner', 'accountant', 'viewer'], projects: ['owner', 'accountant', 'sales', 'viewer'],
  inventory: ['owner', 'accountant', 'sales', 'viewer'], settings: ['owner', 'accountant', 'sales', 'viewer'], users: ['owner'], payroll: ['owner', 'accountant'],
};
export const MODULES = ['sales', 'purchases', 'banking', 'accounting', 'reports', 'projects', 'inventory', 'payroll', 'settings'];
export const permissionsFor = (role) => ({
  read: Object.keys(READ).filter((m) => READ[m].includes(role)),
  write: Object.keys(WRITE).filter((m) => WRITE[m].includes(role)),
});
/** Permissões de um usuário: papel personalizado (plano Advanced) ou um dos quatro papéis padrão. */
export function effectivePerms(u) {
  if (u.custom_role_id) {
    const r = get('SELECT * FROM roles WHERE id=?', u.custom_role_id);
    if (r) {
      const clean = (list) => JSON.parse(list).filter((m) => MODULES.includes(m) && m !== 'settings');
      const write = clean(r.write), read = [...new Set([...clean(r.read), ...write, 'settings'])];
      return { read, write };
    }
  }
  return permissionsFor(u.role);
}

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'hex'));
}

export function createSession(user_id) {
  const token = crypto.randomBytes(32).toString('hex');
  insert('INSERT INTO sessions(token,user_id) VALUES(?,?)', token, user_id);
  run('DELETE FROM sessions WHERE created_at < datetime(\'now\',\'-30 days\')');
  return token;
}

export const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, custom_role_id: u.custom_role_id || null, active: !!u.active, permissions: effectivePerms(u) });

export function authenticate(req, _res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (token) {
    const u = get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND u.active=1', token);
    if (u) req.user = u;
  }
  next();
}

export const requireAuth = (req, _res, next) => (req.user ? next() : next(new HttpError(401, 'Session expired, please sign in again')));

/** can('sales') exige leitura; can('sales', true) exige escrita. */
export const can = (module, write = false) => (req, _res, next) => {
  if (!req.user) return next(new HttpError(401, 'Session expired, please sign in again'));
  const ok = effectivePerms(req.user)[write ? 'write' : 'read'].includes(module);
  next(ok ? undefined : new HttpError(403, 'You do not have permission for this action'));
};

export function audit(req, action, entity, entity_id = null, detail = '') {
  run('INSERT INTO audit_log(user_id,user_name,action,entity,entity_id,detail) VALUES(?,?,?,?,?,?)', req.user?.id ?? null, req.user?.name ?? 'sistema', action, entity, entity_id, String(detail).slice(0, 300));
}

const attempts = new Map();
export function rateLimitLogin(key) {
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (rec.length >= 10) throw new HttpError(429, 'Too many attempts. Please wait 15 minutes.');
  rec.push(now); attempts.set(key, rec);
}
export const clearAttempts = (key) => attempts.delete(key);
export const listUsers = () => all('SELECT * FROM users ORDER BY id').map(publicUser);
