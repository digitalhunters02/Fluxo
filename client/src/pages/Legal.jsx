import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { t, lang, LANGS, setLang } from '../i18n.jsx';
import { LEGAL } from './legalText.js';

/** Termos de Uso e Política de Privacidade (rascunho): página pública, no idioma escolhido, com o aviso "revisar com advogado". */
export default function Legal({ kind }) {
  const doc = LEGAL[lang] || LEGAL.en, body = doc[kind];
  useEffect(() => { document.title = `${body.title} — Fluxo`; }, [body.title]);
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold text-slate-900"><span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">F</span>Fluxo</Link>
          <select aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs">{Object.entries(LANGS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-6">
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900" role="note" data-testid="legal-draft-banner">{doc.banner}</p>
        <h1 className="text-2xl font-semibold text-slate-900">{body.title}</h1>
        <p className="mt-1 text-sm text-slate-500">{doc.updated}</p>
        <nav className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label={t('Legal')}>
          <Link className={`hover:underline ${kind === 'terms' ? 'font-semibold text-slate-900' : 'text-brand-700'}`} to="/terms">{LEGAL[lang].terms.title}</Link>
          <Link className={`hover:underline ${kind === 'privacy' ? 'font-semibold text-slate-900' : 'text-brand-700'}`} to="/privacy">{LEGAL[lang].privacy.title}</Link>
        </nav>
        {body.sections.map((s) => (
          <section key={s.h} className="mt-6">
            <h2 className="text-base font-semibold text-slate-900">{s.h}</h2>
            {s.p.map((x) => <p key={x} className="mt-2 break-words text-sm leading-relaxed text-slate-700">{x}</p>)}
          </section>
        ))}
        <p className="mt-8 border-t border-slate-200 pt-4 text-xs text-slate-500">{doc.banner}</p>
        <p className="mt-4"><Link to="/" className="btn btn-ghost">{t('Back to Fluxo')}</Link></p>
      </main>
    </div>
  );
}

/** Links pequenos para as duas páginas (rodapé do login, do cadastro e dos preços). */
export function LegalLinks({ className = '' }) {
  return (
    <p className={`text-xs ${className}`}>
      <Link className="underline" to="/terms" data-testid="link-terms">{LEGAL[lang].terms.title}</Link> · <Link className="underline" to="/privacy" data-testid="link-privacy">{LEGAL[lang].privacy.title}</Link>
    </p>
  );
}
