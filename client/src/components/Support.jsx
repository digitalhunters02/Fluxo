// Contato de suporte visível em todo o produto (decisão do Jadson: support@impactdigital.network em TODOS os CRMs).
// Um só lugar para trocar o endereço. Textos em en/pt/es pelo t() do app.
import { useState } from 'react';
import { t } from '../i18n.jsx';

export const SUPPORT_EMAIL = 'support@impactdigital.network';
export const supportHref = (subject = 'Fluxo help') => `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`;

/** Linha discreta embaixo da tela de entrada. */
export function SupportLine({ className = '' }) {
  return (
    <p className={`text-center text-xs ${className}`} data-testid="login-support">
      {t('Need help?')} <a href={supportHref()} className="font-medium underline">{SUPPORT_EMAIL}</a>
    </p>
  );
}

/** Item do menu lateral (fundo escuro). */
export function SupportNavLink() {
  return (
    <a href={supportHref()} data-testid="nav-support" className="mt-3 block text-xs text-indigo-200 underline hover:text-white">
      {t('Help and support')}
    </a>
  );
}

/** Cartão "Ajuda e suporte" em Configurações (todo mundo vê). */
export function SupportCard() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(SUPPORT_EMAIL); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* sem permissão: o endereço continua na tela */ }
  }
  return (
    <div data-testid="support-card" className="card mb-4 p-4">
      <h3 className="font-semibold">{t('Help and support')}</h3>
      <p className="mt-0.5 text-sm text-slate-500">{t('Questions, a problem, or an idea? Write to us and we reply by email.')}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <b data-testid="support-email" className="select-all break-all text-sm">{SUPPORT_EMAIL}</b>
        <a href={supportHref()} data-testid="support-write" className="btn">{t('Write to support')}</a>
        <button type="button" onClick={copy} data-testid="support-copy" className="btn btn-ghost">{copied ? t('Copied') : t('Copy address')}</button>
      </div>
      <p className="mt-2 text-xs text-slate-500">{t('Tip: tell us what you were doing and what you expected to see.')}</p>
    </div>
  );
}
