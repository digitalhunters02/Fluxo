// src/PlanBadge.jsx
// PARA QUE SERVE: o SELO DE PLANO — uma pílula pequena com o nome do plano mínimo (ex.: "Business") que aparece ao lado de
// itens de menu, abas e botões que exigem um plano acima do atual. Quem já tem o plano não vê o selo.
// Também guarda o "contexto de planos" (PlanContext) que o resto do kit lê: catálogo, mapa recurso -> plano, idioma, tema.
// ONDE LIGAR: envolva o app com <PlanProvider> (PlanUpsellModal.jsx) e use:
//     <PlanBadge gate="reports" />      // some sozinho se o plano atual já libera "reports"
//     <PlanBadge plan="business" />     // sempre mostra (tela de planos / página de vendas)
//     <PlanBadge gate="reports" inherit /> // dentro de um botão colorido: usa a cor do texto do botão
//     const g = usePlanGate("reports"); // { locked, minPlan, minName, open() } — open() abre a janelinha
import { createContext, useContext } from "react";
import { planStr, planFill } from "./planStrings";

export const PlanContext = createContext(null);

const EMPTY = {
  catalog: [], gates: {}, enabled: false, langKey: "en", theme: { accent: "#888888", card: "#222222", light: false },
  canUpgrade: false, openGate() {}, planName: (k) => (k ? k[0].toUpperCase() + k.slice(1) : ""),
};
export const usePlan = () => useContext(PlanContext) || EMPTY;

// Estado de um recurso para o plano EM VIGOR: `locked` só é verdadeiro quando o servidor disse que o plano atual não libera.
export function usePlanGate(gate) {
  const ctx = usePlan();
  const g = gate ? ctx.gates[gate] : null;
  const minPlan = (g && g.minPlan) || null;
  return {
    locked: !!(ctx.enabled && g && g.locked),
    minPlan,
    minName: minPlan ? ctx.planName(minPlan) : "",
    open: () => ctx.openGate(gate),
  };
}

export default function PlanBadge({ gate, plan, inherit, className, style }) {
  const ctx = usePlan();
  const g = usePlanGate(gate);
  const key = plan || (gate && g.locked ? g.minPlan : null);
  if (!key) return null;
  const name = ctx.planName(key);
  const accent = (ctx.theme && ctx.theme.accent) || "#888888";
  return (
    <span
      data-plan-badge={key}
      title={planFill(planStr(ctx.langKey).badgeTitle, { plan: name })}
      className={className}
      style={{
        display: "inline-flex", alignItems: "center", flex: "none", whiteSpace: "nowrap", verticalAlign: "middle",
        marginLeft: 6, padding: "1px 8px", borderRadius: 999, fontSize: 10, lineHeight: "16px", fontWeight: 600, letterSpacing: 0.2,
        color: inherit ? "inherit" : accent,
        background: `color-mix(in srgb, ${inherit ? "currentColor" : accent} 13%, transparent)`,
        border: `1px solid color-mix(in srgb, ${inherit ? "currentColor" : accent} 42%, transparent)`,
        ...style,
      }}
    >
      {name}
    </span>
  );
}
