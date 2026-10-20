import { t, lang } from '../i18n.jsx';
import { useState } from 'react';
import { api } from '../api.js';
import { Button, Field, Input, Modal, useAction, useToast } from './ui.jsx';
import { useAuth } from '../App.jsx';
import { LockedButton } from '../components/plan.jsx';

/** Faixa pequena com o que sobrou da franquia do mês. */
export function AiLeft({ status }) {
  if (!status) return null;
  return <p className="text-xs text-slate-500" data-testid="ai-left">{t('{0} of {1} AI requests left this month.', [status.left, status.limit])}</p>;
}

/** "Escrever com IA": rascunho do e-mail de cobrança de uma fatura vencida. A pessoa revisa e envia pelo próprio e-mail. */
export function AiCollectionButton({ docId, email, tenant, variant = 'ghost' }) {
  const { has } = useAuth();
  const toast = useToast();
  const [run, busy] = useAction();
  const [open, setOpen] = useState(false);
  const [d, setD] = useState(null);
  const [tone, setTone] = useState('friendly');
  if (!has('ai_assistant')) return <LockedButton gate="ai_assistant" variant={variant} data-testid="ai-collection">{t('Write with AI')}</LockedButton>;
  const link = async () => { try { const doc = await api.get(`/doc/${docId}`); return `${location.origin}/p/${tenant ? `${tenant}.` : ''}${doc.share_token}`; } catch { return ''; } };
  const write = async (tn = tone) => { const r = await run(() => api.post('/ai/collection', { doc_id: docId, tone: tn, lang })); if (r) { const l = await link(); setD({ ...r, body: l ? r.body.replace('{link}', l) : r.body.replace('{link}', '').trim() }); } };
  const final = d ? d.body : '';
  return (
    <>
      <Button variant={variant} onClick={() => { setOpen(true); setD(null); write(); }} data-testid="ai-collection">{t('Write with AI')}</Button>
      {open && <Modal title={t('Payment reminder')} onClose={() => setOpen(false)} footer={d ? <>
        <Button variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(`${d.subject}\n\n${final}`); toast(t('Copied')); } catch { prompt(t('Copy the text:'), final); } }}>{t('Copy')}</Button>
        <a className="btn btn-primary" href={`mailto:${email || ''}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(final)}`} data-testid="ai-mailto">{t('Open in my email')}</a></> : null}>
        {!d ? <p className="py-6 text-center text-sm text-slate-500">{busy ? t('Writing…') : t('Could not write it right now.')}</p> : <div className="space-y-3">
          <Field label={t('Subject')}><Input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></Field>
          <Field label={t('Message')}><textarea className="field h-48" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} data-testid="ai-body" /></Field>
          <div className="flex flex-wrap items-center gap-2">
            <select className="field !w-auto text-sm" value={tone} onChange={(e) => { setTone(e.target.value); write(e.target.value); }} aria-label={t('Tone')}><option value="friendly">{t('Friendly')}</option><option value="firm">{t('Firm')}</option></select>
            <span className="text-xs text-slate-500" data-testid="ai-source">{d.source === 'ai' ? t('Written by AI. Read it before you send it.') : t('Standard text (the AI answer did not match your invoice, so it was not used).')}</span>
          </div>
          <AiLeft status={d.status} />
        </div>}
      </Modal>}
    </>
  );
}

/** "Explicar em palavras simples": resumo do período; a IA só recebe números já calculados e o texto é conferido. */
export function AiExplain({ from, to }) {
  const { has } = useAuth();
  const [run, busy] = useAction();
  const [r, setR] = useState(null);
  if (!has('ai_assistant')) return <div className="no-print border-b border-slate-100 p-3"><LockedButton gate="ai_assistant" data-testid="ai-explain-locked">{t('Explain in plain words')}</LockedButton></div>;
  return (
    <div className="no-print border-b border-slate-100 p-3" data-testid="ai-explain">
      <Button variant="ghost" disabled={busy} onClick={async () => { const x = await run(() => api.post('/ai/explain', { from, to, lang })); if (x) setR(x); }}>{busy ? t('Writing…') : t('Explain in plain words')}</Button>
      {r && <div className="mt-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-950"><p data-testid="ai-explain-text">{r.text}</p>
        <p className="mt-2 text-xs text-slate-500">{r.source === 'ai' ? t('Written by AI from the numbers in this report. Check it against the report.') : t('Summary generated from the numbers in this report.')}</p><AiLeft status={r.status} /></div>}
    </div>
  );
}
