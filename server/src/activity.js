// "Última vez que alguém usou esta empresa": gravado no máximo uma vez por dia (login e uso da API). A limpeza de contas Free
// abandonadas (cleanup.js) olha isto junto com o que foi criado nos dados, para nunca apagar quem ainda usa.
import { als, getSetting, setSetting } from './db.js';

const seen = new Map(); // empresa -> dia já gravado neste processo (evita uma escrita por requisição)
export function touchActivity(now = new Date()) {
  const key = als.getStore()?.slug || '', day = now.toISOString().slice(0, 10);
  if (seen.get(key) === day) return;
  try { if (getSetting('last_activity_at', '') < day) setSetting('last_activity_at', day); seen.set(key, day); } catch { /* nunca atrapalha a requisição */ }
}
export const forgetActivityCache = () => seen.clear();
