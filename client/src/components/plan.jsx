import { Link } from 'react-router-dom';
import { t, lang } from '../i18n.jsx';
import { useAuth } from '../App.jsx';
import { Button, Card } from './ui.jsx';
import PlanBadge, { usePlan, usePlanGate } from '../PlanBadge.jsx';
import { planStr, planFill, gateText } from '../planStrings.js';

export const PLAN_LABEL = { free: t('Free'), starter: t('Starter'), essentials: t('Essentials'), plus: t('Plus'), advanced: t('Advanced'), business: t('Business'), enterprise: t('Enterprise'), addon: t('Payroll add-on') };

/** Aviso no lugar de uma tela que o plano atual não inclui: nome do recurso, SELO do plano mínimo e botão que abre a janelinha
 *  "Disponível no plano X" (preço, o que mais o plano inclui, "Ver planos"). Não há mais texto solto de "faça upgrade". */
export function UpgradeNotice({ feature }) {
  const ctx = usePlan();
  const x = planStr(lang);
  const info = ctx.gates[feature];
  const minPlan = info?.minPlan;
  const text = gateText(feature, lang);
  const title = text?.name || feature;
  return (
    <div data-plan-notice={feature}><Card className="mx-auto mt-10 max-w-xl text-center">
      <h2 className="mt-1 text-lg font-semibold text-slate-900">{title}{minPlan && <PlanBadge plan={minPlan} />}</h2>
      <p className="mt-2 text-sm text-slate-500">{text ? text.what : planFill(x.notInPlanBody, { what: title, plan: ctx.planName(minPlan) })}</p>
      {info && <button type="button" className="btn btn-primary mt-4" style={{ minHeight: 44 }} data-testid="plan-notice-details" onClick={() => ctx.openGate(feature)}>{x.details}</button>}
    </Card></div>
  );
}

/** Mostra os filhos só se o recurso estiver no plano; senão, o aviso com o selo. */
export function Gate({ feature, children }) {
  const { has } = useAuth();
  return has(feature) ? children : <UpgradeNotice feature={feature} />;
}

/** Pequena linha "nome do recurso + selo + Ver detalhes" no lugar de frases soltas de upgrade (dentro de formulários e cartões). */
export function LockedHint({ gate, className = '' }) {
  const ctx = usePlan();
  const g = usePlanGate(gate);
  if (!g.locked) return null;
  const text = gateText(gate, lang);
  return (
    <button type="button" onClick={g.open} data-plan-locked={g.minPlan} aria-haspopup="dialog"
      className={`flex w-full items-center gap-2 rounded-lg bg-amber-50 p-2 text-left text-xs text-amber-800 ${className}`} style={{ minHeight: 40 }}>
      <span className="min-w-0 flex-1 break-words">{text?.name || gate}</span><PlanBadge gate={gate} style={{ marginLeft: 0 }} />
      <span className="shrink-0 underline">{planStr(lang).details}</span>
    </button>
  );
}

/** Botão de um recurso que o plano atual não libera: continua na tela, ganha o selo do plano e abre a janelinha ao tocar. Se o plano libera, não mostra nada. */
export function LockedButton({ gate, children, variant = 'ghost', ...rest }) {
  const g = usePlanGate(gate);
  if (!g.locked) return null;
  return <Button variant={variant} onClick={g.open} data-plan-locked={g.minPlan} aria-haspopup="dialog" {...rest}>{children}<PlanBadge gate={gate} inherit /></Button>;
}

/** Limite do plano atingido: selo do menor plano acima do atual que libera mais (do servidor: planInfo.nextPlan) e atalho para a tela de planos. */
export function NextPlanChip({ limit }) {
  const { planInfo, user } = useAuth();
  const next = planInfo.nextPlan?.[limit];
  if (!next) return null;
  return <span className="ml-1 inline-flex items-center" data-testid={`next-plan-${limit}`}><PlanBadge plan={next} />{user.role === 'owner' && <Link to="/settings/plan" className="ml-2 text-brand-700 underline">{planStr(lang).seePlans}</Link>}</span>;
}

// ----- Plano anual (−10%): chave Mensal/Anual e preço do período, usados na página de preços e em Configurações -----
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

/** Chave Mensal / Anual (−10%). `onChange` recebe 'month' ou 'year'. */
export function IntervalToggle({ interval, onChange }) {
  return (
    <div>
      <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label={t('Billing period')}>
        {[['month', t('Monthly')], ['year', t('Yearly (−10%)')]].map(([id, label]) => (
          <button key={id} type="button" data-testid={`billing-interval-${id}`} aria-pressed={interval === id} onClick={() => onChange(id)}
            className={`h-8 rounded-md px-3 text-sm font-semibold ${interval === id ? 'bg-brand-600 text-white' : 'text-slate-700'}`}>{label}</button>))}
      </div>
      {interval === 'year' && <p className="mx-auto mt-2 max-w-xl text-xs text-slate-600" data-testid="yearly-note">{t('Yearly plan: you pay once for 12 months. You can cancel renewal at any time; unused months are not refunded, and access continues until the end of the year you paid for. We email you before it renews.')}</p>}
    </div>
  );
}

/** Preço do plano no período escolhido, com o equivalente por mês no anual. */
export function PlanPrice({ plan, prices, yearlyPrices, interval }) {
  const yearly = interval === 'year' && plan !== 'free' && yearlyPrices;
  return (
    <>
      <div className="num my-3 text-4xl font-bold" data-testid={`plan-price-${plan}`}>{yearly ? usd(yearlyPrices[plan]) : `$${prices[plan]}`}<span className="text-sm font-normal text-slate-500">{yearly ? t('/year') : t('/month')}</span></div>
      {yearly && <p className="-mt-2 mb-3 text-xs text-slate-500">{t('equals {0}/month · 10% off', [usd(Math.round(yearlyPrices[plan] / 12 * 100) / 100)])}</p>}
    </>
  );
}
