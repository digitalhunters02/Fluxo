// PhotoImportModal.tailwind.jsx — "Importar de foto" para CRMs em Tailwind (Binder, Parcel, Harbor, Fluxo, Ledger, Anvil...).
// SEM dependência de UI do produto além do <Modal> dele: tudo entra por props, então o mesmo arquivo serve a todos.
//   <PhotoImportModal Modal={Modal} t={t} lang={language} api={photoApi} kind="clients" fields={[...]} validate toPayload onSave onClose onImported cls={...} />
//   photoApi = { status(), read(file, kind, lang), setCredit(body) }  (3 fetchs para /ai/photo-import — ver README)
//   t(chave) lê o dicionário do produto com as chaves photo.* (photoImportStrings.js → nest()); as variáveis {x} são trocadas aqui dentro.
// Regras: a IA só lê; a pessoa confere/edita; nada é salvo sozinho; a imagem nunca é guardada; campo difícil de ler fica em amarelo.
import { useEffect, useRef, useState } from "react";

export const DEFAULT_CLS = {
  input: "w-full rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-brand/30",
  inputWarn: "bg-amber-50 border-amber-400",
  btnPrimary: "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold bg-brand text-white hover:brightness-95 disabled:opacity-50 disabled:cursor-not-allowed",
  btnGhost: "inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold border border-line bg-white text-ink hover:bg-wash disabled:opacity-50",
  ink: "text-ink", muted: "text-muted", faint: "text-faint", danger: "text-rose", warnText: "text-amber-700",
  warnBox: "rounded-lg bg-amber-50 border border-amber-200 p-2.5 text-xs text-ink",
  panel: "rounded-lg border border-line bg-wash p-3",
  row: "rounded-lg border border-line p-3", rowErr: "rounded-lg border border-rose p-3",
  drop: "w-full rounded-lg border-2 border-dashed border-line bg-wash py-8 flex flex-col items-center gap-2 text-sm font-medium text-ink hover:opacity-90",
  link: "underline underline-offset-2",
};

// Reduz a foto no aparelho (lado maior 1600 px, JPEG): menos bytes e custo, texto continua legível.
async function shrink(file) {
  try {
    if (file.size < 300 * 1024 && /jpe?g|png|webp/.test(file.type)) return file;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(bmp.width * k));
    cv.height = Math.max(1, Math.round(bmp.height * k));
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
    return blob ? new File([blob], "photo.jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

export function CameraIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" />
    </svg>
  );
}

// fields: [{ key, label (chave i18n), type: "text"|"number"|"date"|"select", options?: [{value,label (chave i18n ou texto)}], wide? }]
export default function PhotoImportModal({ Modal, t: tRaw, lang, api, kind, fields, toPayload, validate, onSave, onClose, onImported, cls: clsIn }) {
  const cls = { ...DEFAULT_CLS, ...(clsIn || {}) };
  const t = (key, vars) => Object.entries(vars || {}).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), String(tRaw(key) ?? key));
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState("pick"); // pick | reading | review | saving
  const [rows, setRows] = useState([]);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [cap, setCap] = useState(null);
  const [agree, setAgree] = useState(false);
  const [credBusy, setCredBusy] = useState(false);
  const [credErr, setCredErr] = useState("");
  const fileRef = useRef(null);

  // Esc fecha (nem todo <Modal> do produto trata o teclado)
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    api.status().then((s) => { setStatus(s); setCap(s.credit?.capCents || s.credit?.capOptionsCents?.[1] || s.credit?.capOptionsCents?.[0] || null); }).catch(() => setStatus({ configured: true, limit: 1, used: 0 }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const errText = (e) => { const k = `photo.err.${e.code}`; const v = t(k); return v && v !== k ? v : t("photo.err.other"); };

  async function read(file) {
    if (!file) return;
    setErr(""); setPhase("reading");
    try {
      const r = await api.read(await shrink(file), kind, lang);
      setNote(r.note || "");
      setStatus((s) => ({ ...(s || {}), used: r.usage.used, limit: r.usage.limit, credit: r.credit, warn: r.warn }));
      setRows((r.records || []).map((rec, i) => ({ ...rec, _id: i, _on: true, _err: "" })));
      setPhase("review");
    } catch (e) {
      setErr(errText(e)); setPhase("pick");
      if (e.code === "plan_limit" || e.code === "credit_limit") api.status().then(setStatus).catch(() => {});
    }
  }

  async function setCredit(enabled) {
    setCredBusy(true); setCredErr("");
    try {
      const r = await api.setCredit(enabled ? { enabled: true, capCents: cap, accept: true } : { enabled: false });
      setStatus((s) => ({ ...s, credit: r.credit, warn: null }));
      setAgree(false); setErr("");
    } catch (e) { setCredErr(errText(e)); } finally { setCredBusy(false); }
  }

  // Ctrl+V / Cmd+V com um print
  useEffect(() => {
    if (phase !== "pick") return undefined;
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (item) { e.preventDefault(); read(item.getAsFile()); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const setCell = (id, key, value) => setRows((rs) => rs.map((r) => (r._id === id ? { ...r, [key]: value, _err: "", unclearFields: (r.unclearFields || []).filter((f) => f !== key) } : r)));
  const chosen = rows.filter((r) => r._on);

  async function saveAll() {
    setPhase("saving"); setErr("");
    let ok = 0; const left = [];
    for (const r of rows) {
      if (!r._on) { left.push(r); continue; }
      const bad = validate?.(r);
      if (bad) { left.push({ ...r, _err: t(bad) }); continue; }
      try { await onSave(toPayload(r)); ok++; } catch (e) { left.push({ ...r, _err: e.message || t("photo.err.other") }); }
    }
    if (ok) onImported?.();
    const failed = left.filter((r) => r._on);
    if (failed.length === 0) { onClose(); return; }
    setRows(left); setPhase("review");
    setErr(ok ? t("photo.savedSome", { a: ok, b: failed.length }) : t("photo.err.other"));
  }

  const cr = status?.credit;
  const usd = (c) => (c / 100).toFixed(2);
  const vars = { used: status?.used ?? 0, limit: status?.limit ?? 0, price: cr ? usd(cr.priceCents) : "", cap: cr ? usd(cap || cr.capCents || 0) : "", spent: cr ? usd(cr.spentCents) : "" };
  const outOfPlan = !!status && status.limit > 0 && status.used >= status.limit;
  const extraOk = !!cr?.enabled && !cr.capReached;
  const blocked = status && (!status.configured ? "ai_not_configured" : status.limit === 0 ? "plan_limit" : outOfPlan && !extraOk ? "plan_limit" : "");
  const warnText = status?.warn ? t(`photo.warn.${status.warn}`, status.warn.startsWith("credit") ? { spent: usd(cr.spentCents), cap: usd(cr.capCents) } : vars) : "";
  const showPanel = !!cr && cr.eligible && (outOfPlan || cr.enabled || ["100", "credit_100"].includes(status?.warn));
  const warnBanner = (testid) => warnText && <p className={`${cls.warnBox} mb-3`} data-testid={testid}>⚠ {warnText}</p>;

  return (
    <Modal title={t(`photo.title.${kind}`)} onClose={onClose}>
      <div data-testid="photo-modal" className="min-w-0">
        {phase === "pick" || phase === "reading" ? (
          <>
            <p className={`${cls.muted} text-sm mb-4`}>{t(`photo.intro.${kind}`)}</p>
            {warnBanner("photo-warn")}
            {blocked === "ai_not_configured" || (blocked && cr && !cr.eligible) ? (
              <p role="alert" className={`${cls.danger} text-sm mb-3`} data-testid="photo-blocked">{blocked === "ai_not_configured" ? t("photo.err.ai_not_configured") : t("photo.credit.upgrade")}</p>
            ) : blocked ? null : (
              <>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" data-testid="photo-file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; read(f); }} />
                <button type="button" onClick={() => fileRef.current?.click()} disabled={phase === "reading"} className={cls.drop}>
                  <CameraIcon size={26} />
                  {phase === "reading" ? t("photo.reading") : t("photo.choose")}
                </button>
                <p className={`${cls.muted} text-xs mt-2`}>{t("photo.paste")}</p>
              </>
            )}
            {showPanel && (
              <div className={`${cls.panel} mt-3`} data-testid="photo-credit">
                {cr.enabled && !cr.capReached ? (
                  <>
                    <p className={`${cls.ink} text-xs`} data-testid="photo-credit-active">{t("photo.credit.active", { spent: usd(cr.spentCents), cap: usd(cr.capCents), price: usd(cr.priceCents) })}</p>
                    {cr.isOwner && <button type="button" onClick={() => setCredit(false)} disabled={credBusy} className={`${cls.danger} ${cls.link} text-xs mt-2`} data-testid="photo-credit-off">{t("photo.credit.off")}</button>}
                  </>
                ) : (
                  <>
                    <h4 className={`${cls.ink} text-sm font-semibold mb-1`}>{t("photo.credit.title")}</h4>
                    <p className={`${cls.muted} text-xs mb-2`}>{t("photo.credit.body", vars)}</p>
                    {cr.isOwner ? (
                      <>
                        <label className="block mb-3">
                          <span className={`${cls.muted} text-xs font-medium block mb-1`}>{t("photo.credit.cap")}</span>
                          <select className={cls.input} value={cap || ""} onChange={(e) => setCap(Number(e.target.value))} data-testid="photo-credit-cap">
                            {cr.capOptionsCents.map((v) => <option key={v} value={v}>US$ {usd(v)}</option>)}
                          </select>
                        </label>
                        <label className={`flex items-start gap-2 text-xs mb-3 ${cls.ink}`}>
                          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-0.5" data-testid="photo-credit-agree" />
                          <span>{t("photo.credit.accept", vars)}</span>
                        </label>
                        {credErr && <p role="alert" className={`${cls.danger} text-xs mb-2`}>{credErr}</p>}
                        <button type="button" className={cls.btnPrimary} onClick={() => setCredit(true)} disabled={!agree || credBusy || !cap} data-testid="photo-credit-on">{t("photo.credit.on")}</button>
                        <p className={`${cls.muted} text-xs mt-2`}>{t("photo.credit.wait")}</p>
                      </>
                    ) : <p className={`${cls.muted} text-xs`}>{t("photo.credit.ownerOnly")}</p>}
                  </>
                )}
              </div>
            )}
            {err && <p role="alert" className={`${cls.danger} text-sm mt-3`} data-testid="photo-error">{err}</p>}
          </>
        ) : (
          <>
            <h4 className={`${cls.ink} text-sm font-semibold mb-1`}>{t("photo.review")}</h4>
            <p className={`${cls.muted} text-xs mb-3`}>{t("photo.reviewHint")}</p>
            {warnBanner("photo-warn-review")}
            {note && <p className={`${cls.warnBox} mb-3`}>⚠ {note}</p>}
            {rows.length === 0 && (
              <div className="text-center py-4">
                <p className={`${cls.muted} text-sm mb-3`} data-testid="photo-none">{t("photo.none")}</p>
                <button type="button" className={cls.btnGhost} onClick={() => { setPhase("pick"); setNote(""); setErr(""); }}>{t("photo.tryAnother")}</button>
              </div>
            )}
            <div className="grid gap-3">
              {rows.map((r) => (
                <div key={r._id} className={`${r._err ? cls.rowErr : cls.row} ${r._on ? "" : "opacity-50"}`} data-testid="photo-row">
                  <label className={`flex items-center gap-2 text-xs mb-2 ${cls.muted}`}>
                    <input type="checkbox" checked={r._on} onChange={(e) => setRows((rs) => rs.map((x) => (x._id === r._id ? { ...x, _on: e.target.checked } : x)))} />
                    <span>#{r._id + 1}</span>
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {fields.map((f) => {
                      const unclear = (r.unclearFields || []).includes(f.key);
                      const common = { value: r[f.key] ?? "", onChange: (e) => setCell(r._id, f.key, e.target.value), disabled: !r._on, "aria-label": t(f.label), "data-testid": `photo-${f.key}`, className: `${cls.input} ${unclear ? cls.inputWarn : ""}` };
                      return (
                        <div key={f.key} className={`min-w-0 ${f.wide ? "sm:col-span-2" : ""}`}>
                          <span className={`text-[11px] font-medium block mb-0.5 ${unclear ? cls.warnText : cls.muted}`}>{t(f.label)}{unclear ? ` — ${t("photo.checkField")}` : ""}</span>
                          {f.type === "select"
                            ? <select {...common}>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label ? (t(o.label) !== o.label ? t(o.label) : o.label) : o.value}</option>)}</select>
                            : <input {...common} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} step={f.type === "number" ? "0.01" : undefined} />}
                        </div>
                      );
                    })}
                  </div>
                  {r._err && <p role="alert" className={`${cls.danger} text-xs mt-2`}>{r._err}</p>}
                </div>
              ))}
            </div>
            {err && <p role="alert" className={`${cls.danger} text-sm mt-3`} data-testid="photo-error">{err}</p>}
            {rows.length > 0 && (
              <div className="mt-4 flex gap-2 flex-wrap">
                <button type="button" className={cls.btnPrimary} onClick={saveAll} disabled={phase === "saving" || chosen.length === 0} data-testid="photo-save">
                  {phase === "saving" ? t("photo.saving") : t("photo.save", { n: chosen.length })}
                </button>
                <button type="button" className={cls.btnGhost} onClick={() => { setPhase("pick"); setRows([]); setNote(""); setErr(""); }} disabled={phase === "saving"}>{t("photo.tryAnother")}</button>
              </div>
            )}
          </>
        )}
        {status && status.limit > 0 && !showPanel && <p className={`${cls.muted} text-[11px] mt-4`}>{t(status.demo ? "photo.usageDemo" : "photo.usage", { used: status.used, limit: status.limit })}</p>}
        <p className={`${cls.muted} text-[11px] mt-1`}>{t("photo.privacy")}</p>
      </div>
    </Modal>
  );
}
