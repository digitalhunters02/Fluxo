// src/PlanUpsellModal.jsx
// PARA QUE SERVE: a janelinha amigável "Disponível no plano X" que abre quando a pessoa toca num item com selo de plano:
// o que o recurso faz, o preço do plano (mensal e anual), o que mais o plano inclui e dois botões ("Ver planos" / "Agora não").
// E o <PlanProvider>, que entrega o catálogo e o mapa recurso -> plano (vindos do servidor) a todo o app.
// ONDE LIGAR: uma vez, em volta do app já logado:
//     <PlanProvider catalog={me.catalog} gates={me.gates} langKey={langKey} theme={theme} enabled={!somenteLeitura}
//                   canUpgrade={!somenteLeitura} onGoPlans={() => abrirTelaDePlanos()}>…</PlanProvider>
// (na página de vendas, sem login: catalog/gates vêm de /public/plans e canUpgrade={false} ou onGoPlans leva ao cadastro).
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Check, Lock, X } from "lucide-react"; // trocar aqui: o seu pacote de ícones, se não for lucide-react
import { PlanContext, usePlan } from "./PlanBadge";
import PlanBadge from "./PlanBadge";
import { planStr, planFill, planMoney, gateText } from "./planStrings";

export function PlanProvider({ catalog = [], gates = {}, enabled = true, langKey = "en", theme, canUpgrade = true, onGoPlans, children }) {
  const [openKey, setOpenKey] = useState(null);
  const planName = useCallback((key) => {
    const p = catalog.find((c) => c.key === key);
    return p ? p.name : key ? key[0].toUpperCase() + key.slice(1) : "";
  }, [catalog]);
  const openGate = useCallback((gate) => { if (gate && gates[gate]) setOpenKey(gate); }, [gates]);
  const value = useMemo(
    () => ({ catalog, gates, enabled, langKey, theme: theme || {}, canUpgrade, planName, openGate }),
    [catalog, gates, enabled, langKey, theme, canUpgrade, planName, openGate]
  );
  return (
    <PlanContext.Provider value={value}>
      {children}
      {openKey && <PlanUpsellModal gate={openKey} onClose={() => setOpenKey(null)} onGoPlans={() => { setOpenKey(null); if (onGoPlans) onGoPlans(openKey); }} />}
    </PlanContext.Provider>
  );
}

const BTN = { minHeight: 44, borderRadius: 10, padding: "0 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", flex: "1 1 140px" };

export function PlanUpsellModal({ gate, onClose, onGoPlans }) {
  const { catalog, gates, langKey, theme, canUpgrade, planName } = usePlan();
  const x = planStr(langKey);
  const primaryRef = useRef(null);
  useEffect(() => {
    if (primaryRef.current) primaryRef.current.focus();
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const minPlan = gates[gate] && gates[gate].minPlan;
  const plan = catalog.find((p) => p.key === minPlan);
  const text = gateText(gate, langKey);
  const accent = theme.accent || "#888888";
  const light = !!theme.light;
  const others = ((plan && plan.adds) || []).filter((g) => g !== gate && gateText(g, langKey));
  const shown = others.slice(0, 6);
  const price = plan && plan.price;

  const node = (
    <div
      data-testid="plan-upsell-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", padding: "max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(16px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left))", boxSizing: "border-box" }}
    >
      <div
        role="dialog" aria-modal="true" aria-labelledby="plan-upsell-title" data-testid="plan-upsell"
        style={{ width: "100%", maxWidth: 420, maxHeight: "100%", overflowY: "auto", overflowX: "hidden", boxSizing: "border-box", borderRadius: 16, padding: 20, background: theme.card || (light ? "#fff" : "#222"), color: light ? "#1b1530" : "#ffffff", border: "1px solid rgba(128,128,128,0.35)", boxShadow: "0 20px 60px rgba(0,0,0,0.45)", fontFamily: "ui-sans-serif, system-ui", overflowWrap: "anywhere" }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <Lock size={18} style={{ color: accent, marginTop: 3, flex: "none" }} aria-hidden="true" />
          <h2 id="plan-upsell-title" style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 18, lineHeight: "24px", fontWeight: 700, color: accent }}>
            {planFill(x.modalTitle, { plan: planName(minPlan) })}
          </h2>
          <button type="button" onClick={onClose} aria-label={x.close} style={{ flex: "none", width: 40, height: 40, marginTop: -8, marginRight: -8, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "transparent", border: 0, color: "inherit", opacity: 0.6, cursor: "pointer" }}>
            <X size={18} />
          </button>
        </div>

        {text && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{text.name}<PlanBadge plan={minPlan} /></div>
            <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: "20px", opacity: 0.8 }}>{text.what}</p>
          </div>
        )}

        {price && (
          <div data-testid="plan-upsell-price" style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, background: `color-mix(in srgb, ${accent} 10%, transparent)`, border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)` }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{planFill(x.priceMonthly, { price: planMoney(price.month, langKey) })}</div>
            {price.year > 0 && <div style={{ fontSize: 13, opacity: 0.75, marginTop: 2 }}>{planFill(x.priceYearly, { price: planMoney(price.year, langKey) })}</div>}
          </div>
        )}

        {shown.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, opacity: 0.85 }}>{planFill(x.alsoIncludes, { plan: planName(minPlan) })}</div>
            <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {shown.map((g) => (
                <li key={g} style={{ display: "flex", gap: 8, fontSize: 13, lineHeight: "18px", opacity: 0.85 }}>
                  <Check size={14} style={{ color: accent, flex: "none", marginTop: 2 }} aria-hidden="true" />
                  <span style={{ minWidth: 0 }}>{gateText(g, langKey).name}</span>
                </li>
              ))}
              {others.length > shown.length && <li style={{ fontSize: 13, opacity: 0.6, paddingLeft: 22 }}>{x.andMore}</li>}
            </ul>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 18 }}>
          {canUpgrade && (
            <button ref={primaryRef} type="button" onClick={onGoPlans} data-testid="plan-upsell-plans" style={{ ...BTN, background: accent, color: light ? "#ffffff" : "#1a0f2b", border: 0 }}>
              {x.seePlans}
            </button>
          )}
          <button ref={canUpgrade ? undefined : primaryRef} type="button" onClick={onClose} data-testid="plan-upsell-close" style={{ ...BTN, background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.45)" }}>
            {canUpgrade ? x.notNow : x.close}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== "undefined" ? createPortal(node, document.body) : node;
}

export default PlanUpsellModal;
