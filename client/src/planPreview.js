// src/planPreview.js
// PARA QUE SERVE: "Ver como plano" (só para o dono da plataforma). Guarda o plano escolhido no navegador e o manda em todo
// pedido ao servidor (cabeçalho X-Preview-Plan). O servidor só obedece se a conta for de dono (OWNER_EMAILS); para qualquer
// outra conta o cabeçalho é ignorado.
// ONDE LIGAR: importe este arquivo UMA vez no começo do app (main.jsx):   import "./planPreview";
import { API_URL, PREVIEW_STORAGE_KEY as KEY } from "./planConfig";

export function getPreviewPlan() {
  try { const v = localStorage.getItem(KEY); return v && /^[a-z0-9_-]{1,32}$/.test(v) ? v : null; } catch { return null; }
}
export function setPreviewPlan(plan) {
  try { if (plan) localStorage.setItem(KEY, plan); else localStorage.removeItem(KEY); } catch { /* sem armazenamento */ }
}

if (typeof window !== "undefined" && !window.__planPreviewFetch) {
  window.__planPreviewFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const plan = getPreviewPlan();
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (plan && url.startsWith(API_URL)) {
      const headers = new Headers((init && init.headers) || (typeof input !== "string" && input.headers) || {});
      headers.set("X-Preview-Plan", plan);
      return original(input, { ...(init || {}), headers });
    }
    return original(input, init);
  };
}
