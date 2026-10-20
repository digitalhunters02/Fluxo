// src/PlanPreview.jsx
// PARA QUE SERVE: "Ver como plano", só para o DONO da plataforma. (1) <PlanPreview> é o seletor (lista TODOS os planos à venda,
// vindos do catálogo do servidor, mais "Meu plano"); (2) <PlanPreviewBar> é a faixa fixa e clara no topo enquanto o dono está
// vendo como outro plano, com o botão "Voltar ao meu plano"; (3) <PlanPreviewFrame> encaixa a faixa acima do app sem cobrir a
// barra do celular. Escolher um plano recarrega o app já vendo como aquele cliente: selos, bloqueios, limites e janelinhas
// seguem o plano visto (o servidor devolve o plano em vigor). A conta do dono nunca muda.
// ONDE LIGAR: no app logado:
//     <PlanPreviewFrame active={!!me?.previewPlan} bar={<PlanPreviewBar me={me} langKey={langKey} />}> …app… </PlanPreviewFrame>
// e, em qualquer tela (ex.: topo da área principal):  <PlanPreview theme={theme} langKey={langKey} me={me} />
// `me` é a resposta de /me: { owner, previewPlan, catalog:[{key,name}] }.
import { useEffect, useState } from "react";
import { Eye, ChevronDown, ChevronUp } from "lucide-react"; // trocar aqui: o seu pacote de ícones, se não for lucide-react
import { getPreviewPlan, setPreviewPlan } from "./planPreview";
import { planStr, planFill } from "./planStrings";
import { APP_NAME } from "./planConfig";

const FRAME_CSS = `
.plan-previewbar { position: sticky; top: 0; z-index: 50; box-sizing: border-box; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 44px; padding: calc(6px + env(safe-area-inset-top, 0px)) max(14px, env(safe-area-inset-right, 0px)) 6px max(14px, env(safe-area-inset-left, 0px)); background: #fbbf24; color: #1a0f2b; font-family: ui-sans-serif, system-ui; border-bottom: 1px solid rgba(0,0,0,0.25); }
@media (min-width: 761px) { .plan-previewbar { border-radius: 0 0 12px 12px; margin-bottom: 8px; } }
@media (max-width: 760px), (max-height: 500px) and (pointer: coarse) {
  .plan-preview-on { display: flex; flex-direction: column; height: 100vh; height: 100dvh; max-width: 100%; overflow: hidden; }
  .plan-preview-on > .plan-previewbar { flex: none; }
  .plan-preview-on > :not(.plan-previewbar) { flex: 1 1 0%; min-height: 0 !important; height: auto !important; }
}
`;

// Encaixa a faixa acima do app. Sem prévia ativa, não muda nada no visual.
export function PlanPreviewFrame({ active, bar, children }) {
  return (
    <div className={active ? "plan-preview-on" : undefined}>
      {active && <style>{FRAME_CSS}</style>}
      {active && bar}
      {children}
    </div>
  );
}

export function PlanPreviewBar({ me, langKey }) {
  const x = planStr(langKey);
  const current = me && me.owner ? me.previewPlan : null;
  if (!current) return null;
  const plan = ((me.catalog || []).find((p) => p.key === current) || {}).name || current;
  return (
    <div className="plan-previewbar" role="status" data-testid="plan-preview-bar">
      <Eye size={16} style={{ flex: "none" }} aria-hidden="true" />
      <span style={{ flex: "1 1 160px", minWidth: 0, fontSize: 13, fontWeight: 700, lineHeight: "18px", overflowWrap: "anywhere" }}>
        {planFill(x.previewViewing, { app: APP_NAME, plan })}
      </span>
      <button
        type="button" data-testid="plan-preview-back"
        onClick={() => { setPreviewPlan(null); window.location.reload(); }}
        style={{ flex: "none", minHeight: 40, padding: "0 14px", borderRadius: 10, border: 0, background: "#1a0f2b", color: "#fbbf24", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
      >
        {x.previewBack}
      </button>
    </div>
  );
}

export default function PlanPreview({ theme, langKey, me }) {
  const x = planStr(langKey);
  const [open, setOpen] = useState(false);
  const isOwner = !!(me && me.owner);
  // Se este navegador guardou um plano de prévia mas a conta não é de dono, esquece (o servidor já ignora o cabeçalho).
  useEffect(() => { if (me && !me.owner && getPreviewPlan()) setPreviewPlan(null); }, [me]);
  if (!isOwner) return null;
  const current = me.previewPlan || null;
  const plans = me.catalog || [];
  const accent = (theme && theme.accent) || "#888888";
  const choose = (plan) => { setPreviewPlan(plan); window.location.reload(); };
  const chip = (on) => ({ minHeight: 40, padding: "0 14px", borderRadius: 10, fontSize: 13, background: on ? `color-mix(in srgb, ${accent} 16%, transparent)` : "transparent", color: on ? accent : "inherit", border: `1px solid ${on ? accent : "rgba(128,128,128,0.4)"}`, cursor: "pointer" });

  return (
    <div style={{ maxWidth: "100%", marginBottom: 16 }} data-testid="plan-preview">
      <div style={{ border: "1px solid rgba(128,128,128,0.3)", borderRadius: 12, background: "rgba(128,128,128,0.06)", boxSizing: "border-box" }}>
        <button type="button" onClick={() => setOpen((o) => !o)} data-testid="plan-preview-toggle" aria-expanded={open}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "0 12px", minHeight: 44, background: "transparent", border: 0, color: "inherit", textAlign: "left", cursor: "pointer" }}>
          <Eye size={16} style={{ color: accent, flex: "none" }} aria-hidden="true" />
          <span style={{ flex: "1 1 0%", minWidth: 0, fontSize: 14, fontWeight: 600 }}>{x.previewLabel}</span>
          {open ? <ChevronUp size={16} style={{ opacity: 0.5 }} /> : <ChevronDown size={16} style={{ opacity: 0.5 }} />}
        </button>
        {open && (
          <div style={{ padding: "0 12px 12px", borderTop: "1px solid rgba(128,128,128,0.25)" }}>
            <p style={{ margin: "8px 0 0", fontSize: 11, lineHeight: "16px", opacity: 0.6 }}>{x.previewHint}</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <button type="button" data-plan-choice="mine" onClick={() => choose(null)} style={chip(!current)}>{x.previewMine}</button>
              {plans.map((p) => (
                <button type="button" key={p.key} data-plan-choice={p.key} onClick={() => choose(p.key)} style={chip(current === p.key)}>{p.name}</button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
