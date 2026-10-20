// "Importar de foto": botão + janela (módulo compartilhado). A IA só lê; a pessoa confere e salva pelo cadastro normal.
import { useMemo, useState } from 'react';
import { Button, Modal } from './ui.jsx';
import PhotoImportModal from './PhotoImportModal.jsx';
import { photoT } from './photoImportStrings.js';
import { api, getToken } from '../api.js';
import { lang } from '../i18n.jsx';
import PlanBadge, { usePlanGate } from '../PlanBadge.jsx';

const CLS = {
  btnPrimary: 'inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50',
  btnGhost: 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50',
  input: 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-600/30',
  inputWarn: '!bg-amber-50 !border-amber-400', warnBox: 'rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-slate-800', warnText: 'text-amber-700',
  panel: 'rounded-lg border border-slate-200 bg-slate-50 p-3',
};
const photoApi = {
  status: () => api.get('/photo-import/status'),
  setCredit: (body) => api.put('/photo-import/credit', body),
  read: async (file, kind, language) => {
    const form = new FormData();
    form.append('kind', kind); form.append('lang', language); form.append('file', file, file.name || 'photo.jpg');
    const res = await fetch('/api/photo-import', { method: 'POST', headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {}, body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { code: data.code, status: res.status });
    return data;
  },
};

export default function PhotoImportButton({ kind, title, fields, validate, toPayload, onSave, onImported }) {
  const [open, setOpen] = useState(false);
  const gate = usePlanGate('photo_import'); // plano sem leitura por foto: o botão ganha o selo e abre a janelinha do plano
  const tt = useMemo(() => {
    const base = photoT(lang);
    return title ? (k, v) => (k === `photo.title.${kind}` ? title : base(k, v)) : base;
  }, [title, kind]);
  return (
    <>
      <Button variant="ghost" onClick={() => (gate.locked ? gate.open() : setOpen(true))} data-testid="photo-import-open" data-plan-locked={gate.locked ? gate.minPlan : undefined}>📷 {photoT(lang)('photo.button')}{gate.locked && <PlanBadge gate="photo_import" inherit />}</Button>
      {open && (
        <PhotoImportModal
          Modal={Modal} t={tt} lang={lang} api={photoApi} kind={kind} fields={fields} validate={validate} toPayload={toPayload}
          onSave={onSave} onImported={onImported} onClose={() => setOpen(false)} cls={CLS}
        />
      )}
    </>
  );
}
