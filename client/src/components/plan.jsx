import { Link } from 'react-router-dom';
import { t } from '../i18n.jsx';
import { useAuth } from '../App.jsx';
import { Card } from './ui.jsx';

export const PLAN_LABEL = { starter: t('Starter'), essentials: t('Essentials'), plus: t('Plus'), advanced: t('Advanced'), addon: t('Payroll add-on') };

/** Aviso mostrado no lugar de uma tela que o plano atual não inclui. */
export function UpgradeNotice({ feature }) {
  const { planInfo } = useAuth();
  const need = feature === 'payroll' ? 'addon' : planInfo.minimum[feature];
  return (
    <Card className="mx-auto mt-10 max-w-xl text-center">
      <div className="text-3xl" aria-hidden="true">🔒</div>
      <h2 className="mt-2 text-lg font-semibold text-slate-900">{need === 'addon' ? t('The payroll add-on is not active') : t('This feature is not in your plan')}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {need === 'addon' ? t('Turn on the payroll add-on to run payroll.') : t('Available from the {0} plan. You are on {1}.', [PLAN_LABEL[need], PLAN_LABEL[planInfo.plan]])}
      </p>
      <Link to="/settings/plan" className="btn btn-primary mt-4">{t('See plans')}</Link>
    </Card>
  );
}

/** Mostra os filhos só se o recurso estiver no plano; senão, o aviso de upgrade. */
export function Gate({ feature, children }) {
  const { has } = useAuth();
  return has(feature) ? children : <UpgradeNotice feature={feature} />;
}

/** Pequeno cadeado ao lado de itens bloqueados. */
export const Lock = () => <span className="ml-1 text-xs opacity-70" aria-label={t('Locked')} role="img">🔒</span>;
