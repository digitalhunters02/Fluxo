// src/planStrings.js
// PARA QUE SERVE: textos do selo de plano, da janelinha "Disponível no plano X" e do "ver como plano" em inglês,
// português e espanhol (idioma desconhecido cai no inglês), mais formatação de preço e o texto de cada recurso.
// ONDE LIGAR: nada a fazer — é usado por PlanBadge.jsx, PlanUpsellModal.jsx e PlanPreview.jsx. Para outro idioma,
// acrescente um bloco igual aos de baixo. Os textos de cada RECURSO ficam em planConfig.js.
import { GATE_TEXT, CURRENCY } from "./planConfig";

const S = {
  en: {
    badgeTitle: "Needs the {plan} plan",
    modalTitle: "Available on the {plan} plan",
    priceMonthly: "{price} per month",
    priceYearly: "or {price} per year",
    free: "Free",
    alsoIncludes: "The {plan} plan also includes:",
    andMore: "and more",
    everythingIn: "Everything in {prev}, plus:",
    seePlans: "See plans",
    notNow: "Not now",
    close: "Close",
    details: "See details",
    notInPlan: "Not in your plan",
    notInPlanBody: "{what} is available on the {plan} plan and above.",
    previewLabel: "View as plan",
    previewMine: "My plan",
    previewHint: "See what customers on each plan see. Your own account does not change, and nothing is billed.",
    previewViewing: "You are viewing {app} as the {plan} plan.",
    previewBack: "Back to my plan",
    previewBlocked: "Billing and plan changes are paused while you view another plan.",
  },
  pt: {
    badgeTitle: "Precisa do plano {plan}",
    modalTitle: "Disponível no plano {plan}",
    priceMonthly: "{price} por mês",
    priceYearly: "ou {price} por ano",
    free: "Grátis",
    alsoIncludes: "O plano {plan} também inclui:",
    andMore: "e mais",
    everythingIn: "Tudo do {prev}, mais:",
    seePlans: "Ver planos",
    notNow: "Agora não",
    close: "Fechar",
    details: "Ver detalhes",
    notInPlan: "Não está no seu plano",
    notInPlanBody: "{what} está no plano {plan} e acima.",
    previewLabel: "Ver como plano",
    previewMine: "Meu plano",
    previewHint: "Veja o que os clientes de cada plano veem. A sua conta não muda e nada é cobrado.",
    previewViewing: "Você está vendo o {app} como o plano {plan}.",
    previewBack: "Voltar ao meu plano",
    previewBlocked: "Assinatura e mudança de plano ficam pausadas enquanto você vê outro plano.",
  },
  es: {
    badgeTitle: "Requiere el plan {plan}",
    modalTitle: "Disponible en el plan {plan}",
    priceMonthly: "{price} al mes",
    priceYearly: "o {price} al año",
    free: "Gratis",
    alsoIncludes: "El plan {plan} también incluye:",
    andMore: "y más",
    everythingIn: "Todo lo de {prev}, más:",
    seePlans: "Ver planes",
    notNow: "Ahora no",
    close: "Cerrar",
    details: "Ver detalles",
    notInPlan: "No está en su plan",
    notInPlanBody: "{what} está en el plan {plan} y superiores.",
    previewLabel: "Ver como plan",
    previewMine: "Mi plan",
    previewHint: "Mire lo que ven los clientes de cada plan. Su cuenta no cambia y no se cobra nada.",
    previewViewing: "Está viendo {app} como el plan {plan}.",
    previewBack: "Volver a mi plan",
    previewBlocked: "La suscripción y los cambios de plan quedan en pausa mientras ve otro plan.",
  },
};

const IDX = { en: 0, pt: 1, es: 2 };
const LOCALES = { en: "en-US", pt: "pt-BR", es: "es-ES" };
export const planLang = (langKey) => (langKey === "pt" || langKey === "es" ? langKey : "en");

export const planStr = (langKey) => S[planLang(langKey)];
export const planFill = (str, vars = {}) => String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));

// Preço do catálogo (inteiro em unidades da moeda) -> "$79", "US$ 79", "79 US$" conforme o idioma.
export function planMoney(amount, langKey) {
  const lang = planLang(langKey);
  try {
    return new Intl.NumberFormat(LOCALES[lang], { style: "currency", currency: CURRENCY, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return String(amount);
  }
}

// Nome e descrição de um recurso no idioma (null se o recurso ainda não tem texto em planConfig.js).
export function gateText(gate, langKey) {
  const g = GATE_TEXT[gate];
  if (!g) return null;
  const i = IDX[planLang(langKey)];
  return { name: g.name[i] || g.name[0], what: g.what[i] || g.what[0] };
}
