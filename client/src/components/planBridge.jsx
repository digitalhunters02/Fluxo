// Liga o kit de "selo de plano" (PlanBadge, PlanUpsellModal, PlanPreview) ao Fluxo: tema claro/escuro, idioma, catálogo do servidor
// e o caminho da tela de planos. É o único arquivo de "cola" do kit neste app.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlanProvider } from '../PlanUpsellModal.jsx';
import { lang } from '../i18n.jsx';
import { ADDON_NAMES } from '../planConfig.js';

const IDX = { en: 0, pt: 1, es: 2 };
const isDarkNow = () => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

/** Segue o tema escuro do app (classe "dark" no <html>). */
function useDark() {
  const [dark, setDark] = useState(isDarkNow);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDarkNow()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}
export function usePlanTheme() {
  const dark = useDark();
  return useMemo(() => (dark ? { accent: '#a5b4fc', card: '#11192c', light: false } : { accent: '#4f46e5', card: '#ffffff', light: true }), [dark]);
}

/** Complementos entram na lista do selo como "planos" extras (nome traduzido + preço), sem aparecer no seletor "ver como plano". */
const withAddons = (catalog = [], addons = {}) => [
  ...catalog,
  ...Object.values(addons).map((a) => ({ key: a.key, name: (ADDON_NAMES[a.key] || [a.key])[IDX[lang] ?? 0] || a.key, rank: 99, price: a.price, adds: [] })),
];
const withAddonGates = (gates = {}) => Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, g.addon ? { ...g, minPlan: g.addon } : g]));

/** App logado: selos conforme o plano em vigor (que é o plano visto, quando o dono usa "ver como plano"). */
export function AppPlanProvider({ me, children }) {
  const nav = useNavigate();
  const theme = usePlanTheme();
  const catalog = useMemo(() => withAddons(me.catalog, me.addons), [me.catalog, me.addons]);
  const gates = useMemo(() => withAddonGates(me.gates), [me.gates]);
  return (
    <PlanProvider catalog={catalog} gates={gates} enabled={me.role !== 'cpa'} canUpgrade={me.role === 'owner'} langKey={lang} theme={theme} onGoPlans={() => nav('/settings/plan')}>
      {children}
    </PlanProvider>
  );
}

/** Página pública de preços: catálogo vindo de /public/plans; sem bloqueios (ninguém está logado) e sem botão "Ver planos". */
export function PublicPlanProvider({ data, children }) {
  const theme = usePlanTheme();
  const catalog = useMemo(() => withAddons(data?.catalog, data?.addons), [data]);
  return <PlanProvider catalog={catalog} gates={withAddonGates(data?.gates)} enabled={false} canUpgrade={false} langKey={lang} theme={theme}>{children}</PlanProvider>;
}
