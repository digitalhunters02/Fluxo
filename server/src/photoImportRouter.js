// photoImport.pg.js — "Importar de foto" + uso extra (créditos) para CRMs em POSTGRES (um cliente por instalação).
// Não mexe em billing.js/auth.js do produto: o produto injeta o que já tem (createPhotoImportRouter({...})).
//   app.use("/api/photo-import", createPhotoImportRouter({ pool, requireAuth, requireAdmin, requirePage, effectivePlan, getSubscription,
//     planLimits: { gratis: 0, basico: 0, essencial: 100, completo: 500 }, kindsOpts: {...}, appName: "Binder", sendNotice }));
//   await initPhotoImportSchema(pool);  // depois do initSchema do produto
//   startPhotoBilling({ pool, getSubscription });
// Produto sem is_admin (ex.: accounts.role = 'owner'): passe adminWhere: "role = 'owner'" e isAdmin: (a) => a?.role === 'owner'. Sem permissão por página: omita requirePage.
// Regras: só do 2º plano pago em diante; leitura nunca salva nada; imagem nunca é gravada; extras só com aceite do administrador,
// teto mensal, cobrança em lote como linha pendente (invoiceitems) na próxima fatura do Stripe com Idempotency-Key.
import crypto from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { buildKinds, extractFromPhoto, isConfigured, MAX_IMAGE_BYTES } from "./photoImport.js";

const MIGRATION_DAYS = () => Number(process.env.PHOTO_MIGRATION_DAYS ?? 30);
const MIGRATION_BONUS = () => Number(process.env.PHOTO_MIGRATION_BONUS ?? 100);
const DEMO_PHOTO_LIMIT = 3;
export const EXTRA_PRICE_CENTS = () => Math.max(1, Math.round(Number(process.env.PHOTO_EXTRA_CENTS ?? 10)));
export const CAP_OPTIONS_CENTS = () =>
  String(process.env.PHOTO_EXTRA_CAPS_CENTS || "1000,2500,5000,10000").split(",").map((n) => Math.round(Number(n))).filter((n) => n > 0);
const ym = () => new Date().toISOString().slice(0, 7);
const monthStart = () => `${ym()}-01T00:00:00Z`;
const usd = (cents) => (cents / 100).toFixed(2);

// Tabelas do módulo (uma instrução por item). Produto com um banco por empresa (SQLite) aplica isto em CADA banco novo (ver sqlitePool.js).
export const PHOTO_IMPORT_DDL = [
  `CREATE TABLE IF NOT EXISTS photo_imports (
    id SERIAL PRIMARY KEY,
    account_id TEXT,
    kind TEXT,
    records INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    input_tokens INTEGER,
    output_tokens INTEGER,
    extra_cents INTEGER NOT NULL DEFAULT 0,
    billing_batch TEXT,
    billed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS usage_credit (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    cap_cents INTEGER NOT NULL DEFAULT 0,
    price_cents INTEGER NOT NULL DEFAULT 0,
    accepted_at TIMESTAMPTZ,
    accepted_by TEXT,
    last_lang TEXT,
    notice_ym_80 TEXT, notice_ym_100 TEXT, notice_cap_ym_80 TEXT, notice_cap_ym_100 TEXT,
    CONSTRAINT usage_credit_single CHECK (id = 1)
  )`,
];

export async function initPhotoImportSchema(pool) {
  for (const ddl of PHOTO_IMPORT_DDL) await pool.query(ddl);
}

const one = async (pool, t, p) => (await pool.query(t, p)).rows[0];

async function getCredit(pool) {
  const r = await one(pool, "SELECT * FROM usage_credit WHERE id = 1");
  return { enabled: !!r?.enabled, capCents: r?.cap_cents || 0, priceCents: r?.price_cents || 0, row: r || {} };
}
async function extraSpentCents(pool) {
  return Number((await one(pool, "SELECT COALESCE(SUM(extra_cents), 0)::int n FROM photo_imports WHERE created_at >= $1", [monthStart()])).n);
}

// De quem cobrar: a assinatura do Stripe deste app (webhook) ou BILLING_STRIPE_CUSTOMER_ID / BILLING_STRIPE_SUBSCRIPTION_ID.
async function billingTarget(getSubscription, envBilling = true) {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  let sub = null;
  try { sub = await getSubscription?.(); } catch { /* sem assinatura */ }
  const customer = (envBilling && process.env.BILLING_STRIPE_CUSTOMER_ID) || sub?.stripe_customer_id || null;
  const subscription = (envBilling && process.env.BILLING_STRIPE_SUBSCRIPTION_ID) || sub?.stripe_subscription_id || null;
  return customer ? { customer, subscription } : null;
}

async function stripePost(path, params, idempotencyKey) {
  const base = String(process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${process.env.STRIPE_SECRET_KEY}:`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || `Stripe ${res.status}`);
  return data;
}

/* ------------------------------ avisos 80% / 100% ------------------------------ */
const T = {
  en: {
    s80: "You used 80% of your photo reads this month",
    b80: (u, l) => `You have used ${u} of ${l} photo reads included in your plan this month. When they run out you can turn on extra reads in the app (you choose a monthly limit).`,
    s100: "You reached your photo read limit this month",
    b100: (u, l, p) => `You used all ${l} photo reads included in your plan. You can wait for the next cycle or turn on extra reads in the app: each extra photo costs US$ ${p}, billed on your next invoice, up to the monthly limit you choose.`,
    c80: "You used 80% of your extra photo credit",
    cb80: (s, c) => `You have used US$ ${s} of your US$ ${c} monthly limit for extra photo reads.`,
    c100: "You reached your extra photo credit limit",
    cb100: (c) => `You used all of your US$ ${c} monthly limit for extra photo reads. Open the app to approve a new limit, or wait for the next cycle.`,
  },
  pt: {
    s80: "Você usou 80% das leituras por foto deste mês",
    b80: (u, l) => `Você usou ${u} de ${l} leituras por foto incluídas no seu plano neste mês. Quando acabarem, você pode ativar leituras extras no app (você escolhe um limite mensal).`,
    s100: "Você atingiu o limite de leituras por foto deste mês",
    b100: (u, l, p) => `Você usou todas as ${l} leituras por foto incluídas no seu plano. Você pode esperar o próximo ciclo ou ativar leituras extras no app: cada foto extra custa US$ ${p}, cobrada na sua próxima fatura, até o limite mensal que você escolher.`,
    c80: "Você usou 80% do seu crédito extra de fotos",
    cb80: (s, c) => `Você usou US$ ${s} do seu limite mensal de US$ ${c} para leituras extras por foto.`,
    c100: "Você atingiu o limite do seu crédito extra de fotos",
    cb100: (c) => `Você usou todo o seu limite mensal de US$ ${c} para leituras extras por foto. Abra o app para aprovar um novo limite ou espere o próximo ciclo.`,
  },
  es: {
    s80: "Usaste el 80% de tus lecturas por foto de este mes",
    b80: (u, l) => `Usaste ${u} de ${l} lecturas por foto incluidas en tu plan este mes. Cuando se agoten puedes activar lecturas extra en la app (tú eliges un límite mensual).`,
    s100: "Llegaste al límite de lecturas por foto de este mes",
    b100: (u, l, p) => `Usaste las ${l} lecturas por foto incluidas en tu plan. Puedes esperar al próximo ciclo o activar lecturas extra en la app: cada foto extra cuesta US$ ${p}, cobrada en tu próxima factura, hasta el límite mensual que elijas.`,
    c80: "Usaste el 80% de tu crédito extra de fotos",
    cb80: (s, c) => `Usaste US$ ${s} de tu límite mensual de US$ ${c} para lecturas extra por foto.`,
    c100: "Llegaste al límite de tu crédito extra de fotos",
    cb100: (c) => `Usaste todo tu límite mensual de US$ ${c} para lecturas extra por foto. Abre la app para aprobar un nuevo límite o espera al próximo ciclo.`,
  },
};

async function maybeNotify(pool, { used, included, credit, spentCents, sendNotice, appName, adminWhere = "is_admin::text IN ('1','true','t')", adminSql }) {
  try {
    const admins = (await pool.query(adminSql || `SELECT email FROM accounts WHERE (${adminWhere}) AND email IS NOT NULL`)).rows.map((r) => r.email);
    if (!admins.length) return;
    const row = (await one(pool, "SELECT * FROM usage_credit WHERE id = 1")) || {};
    const tx = T[row.last_lang] || T.en;
    const month = ym();
    const send = async (col, subject, text) => {
      await pool.query(`INSERT INTO usage_credit (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
      await pool.query(`UPDATE usage_credit SET ${col} = $1 WHERE id = 1`, [month]);
      for (const to of admins) console.log(`[usage-credit] aviso para ${to}: ${appName} — ${subject}`);
      for (const to of admins) Promise.resolve(sendNotice ? sendNotice(to, `${appName} — ${subject}`, text) : console.log(`[notice] ${to}: ${subject}`)).catch(() => {});
    };
    if (included > 0 && used >= included && row.notice_ym_100 !== month) await send("notice_ym_100", tx.s100, tx.b100(used, included, usd(credit.priceCents || EXTRA_PRICE_CENTS())));
    else if (included > 0 && used >= Math.ceil(included * 0.8) && used < included && row.notice_ym_80 !== month) await send("notice_ym_80", tx.s80, tx.b80(used, included));
    if (credit.enabled && credit.capCents > 0) {
      if (spentCents + credit.priceCents > credit.capCents && row.notice_cap_ym_100 !== month) await send("notice_cap_ym_100", tx.c100, tx.cb100(usd(credit.capCents)));
      else if (spentCents >= credit.capCents * 0.8 && row.notice_cap_ym_80 !== month) await send("notice_cap_ym_80", tx.c80, tx.cb80(usd(spentCents), usd(credit.capCents)));
    }
  } catch (e) {
    console.error("[usage-credit] aviso falhou:", e.message);
  }
}

/* ------------------------------ cobrança no Stripe ------------------------------ */
export async function billExtras({ pool, getSubscription, envBilling = true }) {
  const result = { batches: 0, cents: 0, failed: 0, skipped: 0 };
  const target = await billingTarget(getSubscription, envBilling);
  if (!target) {
    result.skipped = Number((await one(pool, "SELECT COUNT(*)::int n FROM photo_imports WHERE extra_cents > 0 AND billed_at IS NULL")).n);
    return result;
  }
  const users = (await pool.query("SELECT DISTINCT COALESCE(account_id::text, '0') a FROM photo_imports WHERE extra_cents > 0 AND billed_at IS NULL AND billing_batch IS NULL")).rows;
  for (const { a } of users) {
    await pool.query("UPDATE photo_imports SET billing_batch = $1 WHERE COALESCE(account_id::text, '0') = $2 AND extra_cents > 0 AND billed_at IS NULL AND billing_batch IS NULL", [crypto.randomUUID(), a]);
  }
  const batches = (await pool.query("SELECT billing_batch b, COUNT(*)::int n, SUM(extra_cents)::int cents FROM photo_imports WHERE billing_batch IS NOT NULL AND billed_at IS NULL GROUP BY billing_batch")).rows;
  for (const b of batches) {
    const params = new URLSearchParams();
    params.append("customer", target.customer);
    if (target.subscription) params.append("subscription", target.subscription);
    params.append("currency", "usd");
    params.append("amount", String(b.cents));
    params.append("description", `Photo reads beyond plan: ${b.n} × US$ ${usd(Math.round(b.cents / b.n))}`);
    params.append("metadata[source]", "photo_import_extra");
    params.append("metadata[batch]", b.b);
    try {
      const item = await stripePost("invoiceitems", params, `photo-extra-${b.b}`);
      await pool.query("UPDATE photo_imports SET billed_at = now() WHERE billing_batch = $1", [b.b]);
      result.batches++; result.cents += b.cents;
      console.log(`[usage-credit] lote ${b.b}: ${b.n} leituras, US$ ${usd(b.cents)} → ${item.id || "ok"}`);
    } catch (e) {
      result.failed++;
      console.error(`[usage-credit] lote ${b.b} não cobrado (tenta de novo): ${e.message}`);
    }
  }
  return result;
}

// eachTenant (opcional): produto com um banco por empresa passa uma função que roda `fn` dentro de CADA empresa (a cobrança é por empresa).
export function startPhotoBilling({ pool, getSubscription, envBilling = true, eachTenant }) {
  const every = Number(process.env.PHOTO_BILLING_INTERVAL_MS) || 30 * 60 * 1000;
  const once = () => billExtras({ pool, getSubscription, envBilling });
  const run = () => Promise.resolve(eachTenant ? eachTenant(once) : once()).catch((e) => console.error("[usage-credit] cobrança:", e.message));
  setTimeout(run, Math.min(60_000, every)).unref?.();
  setInterval(run, every).unref?.();
}

/* ------------------------------ rotas ------------------------------ */
export function createPhotoImportRouter({ pool, requireAuth, requireAdmin, requirePage, effectivePlan, getSubscription, planLimits, kindsOpts = {}, appName = "CRM", sendNotice, accountCreatedAt, adminWhere, adminSql, envBilling = true, isAdmin = (a) => !!a?.is_admin }) {
  if (!requirePage) requirePage = () => (_req, _res, next) => next(); // produto sem permissão por página
  const KINDS = buildKinds(kindsOpts);
  for (const k of kindsOpts.disableKinds || []) delete KINDS[k];
  const router = Router();
  router.use(requireAuth);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  const ar = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  async function usage(req) {
    const plan = await effectivePlan();
    const demo = !!req.account?.is_demo_trial;
    if (demo) {
      const used = Number((await one(pool, "SELECT COUNT(*)::int n FROM photo_imports WHERE account_id = $1", [req.account.id])).n);
      return { plan, used, limit: DEMO_PHOTO_LIMIT, demo: true, base: 0, migrationBonus: 0 };
    }
    const used = Number((await one(pool, "SELECT COUNT(*)::int n FROM photo_imports WHERE created_at >= $1 AND extra_cents = 0", [monthStart()])).n);
    const base = planLimits[plan] ?? 0;
    const since = accountCreatedAt ? await accountCreatedAt() : (await one(pool, "SELECT MIN(created_at) c FROM accounts"))?.c;
    const ageDays = since ? (Date.now() - new Date(since).getTime()) / 86400000 : Infinity;
    const bonus = base > 0 && ageDays <= MIGRATION_DAYS() ? MIGRATION_BONUS() : 0;
    return { plan, used, limit: base + bonus, demo: false, base, migrationBonus: bonus };
  }
  async function creditInfo(req, u) {
    const credit = await getCredit(pool);
    const spent = await extraSpentCents(pool);
    const price = credit.enabled ? credit.priceCents : EXTRA_PRICE_CENTS();
    return {
      eligible: !u.demo && u.base > 0, enabled: credit.enabled, priceCents: price, capCents: credit.capCents, spentCents: spent,
      capOptionsCents: CAP_OPTIONS_CENTS(), canBill: !!(await billingTarget(getSubscription, envBilling)), isOwner: !!isAdmin(req.account || req.user),
      capReached: credit.enabled && spent + price > credit.capCents,
    };
  }
  const warnLevel = (u, c) => {
    if (u.limit <= 0) return null;
    if (c.enabled && u.used >= u.limit) return c.capReached ? "credit_100" : c.capCents > 0 && c.spentCents >= c.capCents * 0.8 ? "credit_80" : null;
    if (u.used >= u.limit) return "100";
    return u.used >= Math.ceil(u.limit * 0.8) ? "80" : null;
  };

  router.get("/status", ar(async (req, res) => {
    const u = await usage(req);
    const credit = await creditInfo(req, u);
    res.json({ configured: isConfigured(), plan: u.plan, used: u.used, limit: u.limit, demo: u.demo, migrationBonus: u.migrationBonus || 0, kinds: Object.keys(KINDS), credit, warn: warnLevel(u, credit) });
  }));

  router.put("/credit", requireAdmin, ar(async (req, res) => {
    const u = await usage(req);
    const c = await creditInfo(req, u);
    const b = req.body || {};
    if (b.enabled === false) { await pool.query("UPDATE usage_credit SET enabled = FALSE WHERE id = 1"); return res.json({ credit: await creditInfo(req, u) }); }
    if (!c.eligible) return res.status(402).json({ error: "Extra reads only exist on plans that include photo reading.", code: "plan_limit" });
    if (b.accept !== true) return res.status(400).json({ error: "You need to accept the price and the limit.", code: "accept_required" });
    const cap = Math.round(Number(b.capCents));
    if (!c.capOptionsCents.includes(cap)) return res.status(400).json({ error: "Invalid limit.", code: "bad_cap" });
    if (!c.canBill) return res.status(409).json({ error: "We could not find your subscription to bill. Contact support.", code: "no_billing" });
    await pool.query(`INSERT INTO usage_credit (id, enabled, cap_cents, price_cents, accepted_at, accepted_by) VALUES (1, TRUE, $1, $2, now(), $3)
      ON CONFLICT (id) DO UPDATE SET enabled = TRUE, cap_cents = EXCLUDED.cap_cents, price_cents = EXCLUDED.price_cents, accepted_at = now(), accepted_by = EXCLUDED.accepted_by`,
    [cap, EXTRA_PRICE_CENTS(), req.account?.email || req.user?.email || String(req.account?.id ?? req.user?.id ?? req.userId)]);
    res.json({ credit: await creditInfo(req, u) });
  }));

  router.post("/", (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err?.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image too large (max 8 MB).", code: "too_large" });
      if (err) return res.status(400).json({ error: "Could not receive the image.", code: "bad_upload" });
      next();
    });
  }, ar(async (req, res) => {
    const kind = String(req.body?.kind || "");
    const def = KINDS[kind];
    if (!def) return res.status(400).json({ error: "Invalid import type.", code: "bad_kind" });
    await new Promise((resolve, reject) => { try { Promise.resolve(requirePage(def.page)(req, res, resolve)).catch(reject); } catch (e) { reject(e); } });
    if (res.headersSent) return;
    if (!isConfigured()) return res.status(503).json({ error: "Photo reading is not connected on this server yet.", code: "ai_not_configured" });
    if (!req.file) return res.status(400).json({ error: "Send an image.", code: "no_file" });
    const u = await usage(req);
    const c = await creditInfo(req, u);
    let extraCents = 0;
    if (u.used >= u.limit) {
      if (c.enabled && c.canBill && !c.capReached) extraCents = c.priceCents;
      else {
        return res.status(402).json({
          error: u.limit === 0 ? "Photo reading is not included in your plan." : `You used all ${u.limit} photo reads ${u.demo ? "of the free trial" : "this month"}.`,
          code: c.enabled && c.capReached ? "credit_limit" : "plan_limit", used: u.used, limit: u.limit, currentPlan: u.plan, credit: c,
        });
      }
    }
    try {
      const lang = ["en", "pt", "es"].includes(req.body?.lang) ? req.body.lang : "en";
      const out = await extractFromPhoto({ buffer: req.file.buffer, kind, kinds: KINDS, lang });
      await pool.query("INSERT INTO photo_imports (account_id, kind, records, input_tokens, output_tokens, extra_cents) VALUES ($1,$2,$3,$4,$5,$6)",
        [String(req.account?.id ?? req.user?.id ?? req.userId ?? "") || null, kind, out.records.length, out.tokens?.input ?? null, out.tokens?.output ?? null, extraCents]);
      await pool.query("INSERT INTO usage_credit (id, last_lang) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_lang = EXCLUDED.last_lang", [lang]);
      const { tokens, ...payload } = out;
      const used = extraCents ? u.used : u.used + 1;
      const after = await creditInfo(req, u);
      if (!u.demo) await maybeNotify(pool, { used, included: u.limit, credit: await getCredit(pool), spentCents: after.spentCents, sendNotice, appName, adminWhere, adminSql });
      res.json({ ...payload, usage: { used, limit: u.limit }, extra: extraCents > 0, credit: after, warn: warnLevel({ ...u, used }, after) });
    } catch (e) {
      if (e.code === "bad_image") return res.status(400).json({ error: "Send a JPEG, PNG, GIF or WebP image.", code: "bad_image" });
      console.error("[photo-import]", e.code || "", e.status || "", e.message);
      res.status(502).json({ error: "I could not read the image right now. Try again in a moment.", code: "ai_failed" });
    }
  }));

  return router;
}
