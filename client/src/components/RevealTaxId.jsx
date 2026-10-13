import { useState } from 'react';
import { t } from '../i18n.jsx';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { useAction } from './ui.jsx';

/** Mostra o SSN/EIN completo por alguns segundos, só para o dono; cada consulta fica no registro de auditoria. */
export default function RevealTaxId({ path }) {
  const { user } = useAuth();
  const [run, busy] = useAction();
  const [value, setValue] = useState('');
  if (user?.role !== 'owner') return null;
  const show = async () => {
    const r = await run(() => api.get(path));
    if (r) { setValue(r.tax_id || '—'); setTimeout(() => setValue(''), 15000); }
  };
  return (
    <div className="col-span-full text-xs text-slate-500">
      {value ? <><b className="font-mono text-slate-800">{value}</b> <button type="button" className="ml-2 text-brand-700 hover:underline" onClick={() => setValue('')}>{t('Hide')}</button></>
        : <button type="button" disabled={busy} className="text-brand-700 hover:underline" onClick={show}>{t('Show full number')}</button>}
      <span className="ml-2">{t('Each view is recorded in the audit log.')}</span>
    </div>
  );
}
