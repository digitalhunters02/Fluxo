import { t } from '../i18n.jsx';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { date, money, number, setFormat } from '../format.js';
import { Button, ErrorBox, Loading, useLoad } from '../components/ui.jsx';

export default function PublicDoc() {
  const { token } = useParams();
  const { data, loading, error } = useLoad(async () => { const r = await api.get(`/public/doc/${token}`); setFormat(r.company); return r; }, [token]);
  if (loading) return <Loading />;
  if (error) return <div className="mx-auto mt-20 max-w-md"><ErrorBox error={error} /></div>;
  const { doc: d, customer: c, company } = data;
  const name = { invoice: t('INVOICE'), estimate: t('ESTIMATE') }[d.type];
  return (
    <div className="mx-auto max-w-3xl p-4 md:p-8">
      <div className="no-print mb-4 flex justify-end"><Button onClick={() => window.print()}>{t('Print / save as PDF')}</Button></div>
      <div className="card p-6 md:p-8">
        <div className="flex flex-wrap justify-between gap-4 border-b border-slate-100 pb-5">
          <div><div className="text-lg font-semibold">{company.company_name}</div><div className="text-sm text-slate-500">{company.company_tax_id}</div><div className="whitespace-pre-line text-sm text-slate-500">{company.company_address}</div></div>
          <div className="text-right"><div className="text-xl font-semibold">{name}</div><div className="text-slate-500">{d.number}</div>
            {d.status === 'paid' && <div className="mt-1 inline-block rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">{t('PAID')}</div>}</div>
        </div>
        <div className="grid gap-4 py-5 text-sm sm:grid-cols-3">
          <div><div className="text-xs uppercase text-slate-500">{t('To§transfer')}</div><div className="font-medium">{c.name}</div><div className="text-slate-500">{c.tax_id}</div></div>
          <div><div className="text-xs uppercase text-slate-500">{t('Issued')}</div>{date(d.issue_date)}</div>
          <div><div className="text-xs uppercase text-slate-500">{d.type === 'estimate' ? t('Valid until') : t('Due')}</div>{date(d.due_date)}</div>
        </div>
        <table className="w-full text-sm"><thead className="border-b text-left text-xs uppercase text-slate-500"><tr><th className="py-2">{t('Description')}</th><th className="text-right">{t('Qty')}</th><th className="text-right">{t('Price')}</th><th className="text-right">{t('Total')}</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{d.lines.map((l) => <tr key={l.id}><td className="py-2.5">{l.description || l.item_name}</td><td className="num text-right">{number(l.qty, 3)}</td><td className="num text-right">{money(l.unit_price)}</td><td className="num text-right">{money(l.amount)}</td></tr>)}</tbody></table>
        <dl className="ml-auto mt-4 w-full max-w-xs space-y-1.5 text-sm">
          <div className="flex justify-between"><dt className="text-slate-500">{t('Subtotal')}</dt><dd className="num">{money(d.subtotal)}</dd></div>
          <div className="flex justify-between"><dt className="text-slate-500">{t('Taxes')}</dt><dd className="num">{money(d.tax)}</dd></div>
          <div className="flex justify-between border-t pt-2 text-base font-semibold"><dt>{t('Total')}</dt><dd className="num">{money(d.total)}</dd></div>
          {d.type === 'invoice' && <div className="flex justify-between font-semibold"><dt>{t('To pay')}</dt><dd className="num">{money(d.total - d.paid)}</dd></div>}
        </dl>
        {d.notes && <p className="mt-5 whitespace-pre-line border-t pt-4 text-sm text-slate-600">{d.notes}</p>}
        <p className="mt-6 text-center text-xs text-slate-400">{company.invoice_footer}</p>
      </div>
    </div>
  );
}
