// server/src/planGates.js
// PARA QUE SERVE: calcula, a partir do catálogo de planos, o "mapa recurso -> plano mínimo" que o frontend usa para
// desenhar o SELO DE PLANO (pílula com o nome do plano) ao lado de itens de menu e botões bloqueados.
// A fonte da verdade continua sendo o catálogo de planos do servidor (plans.js): o front só consome.
//
// ONDE LIGAR: em plans.js, depois de definir PLANS (cada plano com key, name, sold, rank) e GATES
// (um recurso por linha: chave -> função que diz se o plano libera), faça:
//     import { makeGates } from "./planGates.js";
//     const gates = makeGates(PLANS, GATES, "free");           // trocar aqui: "free" = plano de quem não pagou
//     export const { minPlanForGate, publicGates, addsByPlan } = gates;
// e devolva `gates: publicGates(planoEfetivo)` na rota /me (veja plan-kit/me-extension.example.js).
//
// ACRESCENTAR UM RECURSO NOVO: uma linha em GATES, por exemplo   relatorios: (p) => p.features.reports
// e (no front) um texto em planConfig.js. Nada mais.

export function makeGates(PLANS, GATES, fallbackKey) {
  const info = (key) => PLANS[key] || PLANS[fallbackKey];
  const sold = () => Object.values(PLANS).filter((p) => p.sold).sort((a, b) => a.rank - b.rank);
  const passes = (plan, gate) => !!GATES[gate](plan);

  // Menor plano à venda que libera o recurso (null se nenhum libera).
  function minPlanForGate(gate) {
    if (!GATES[gate]) return null;
    const p = sold().find((pl) => passes(pl, gate));
    return p ? p.key : null;
  }

  // { recurso: { minPlan, locked } } — `locked` = o plano informado NÃO libera o recurso (sem plano informado, só minPlan).
  function publicGates(planKey) {
    const plan = planKey ? info(planKey) : null;
    const out = {};
    for (const gate of Object.keys(GATES)) {
      out[gate] = { minPlan: minPlanForGate(gate) };
      if (plan) out[gate].locked = !passes(plan, gate);
    }
    return out;
  }

  // { plano: [recursos que ele ACRESCENTA em relação ao plano vendido anterior] } (o primeiro plano não acrescenta nada).
  function addsByPlan() {
    const list = sold();
    const out = {};
    list.forEach((plan, i) => {
      out[plan.key] = i === 0 ? [] : Object.keys(GATES).filter((g) => passes(plan, g) && !passes(list[i - 1], g));
    });
    return out;
  }

  return { minPlanForGate, publicGates, addsByPlan };
}

