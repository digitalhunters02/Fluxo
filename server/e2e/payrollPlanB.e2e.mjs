// Folha "Plano B" NO NAVEGADOR (servidor real + front buildado): conta bancária do funcionário, folha, arquivo NACHA (download),
// depósitos (marcar como pago), Form 941 / W-2 / EFW2 (PDF e arquivo), CSV do IRIS e auditoria — em inglês no computador (1280×900)
// e em português no celular (390×844, toque), sem rolagem lateral.
//   (na raiz)  npm run build   e depois   node server/e2e/payrollPlanB.e2e.mjs
// Porta: PLANB_PORT (padrão 7960). Banco: PLANB_DB (padrão <tmp>/fluxo-planb-e2e/fluxo.db), apagado no começo.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PORT = Number(process.env.PLANB_PORT || 7960);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.PLANB_DB || path.join(os.tmpdir(), "fluxo-planb-e2e", "fluxo.db");
const SHOTS = process.env.PLANB_SHOTS || path.join(path.dirname(DB), "shots");
fs.mkdirSync(path.dirname(DB), { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
for (const f of [DB, DB + "-wal", DB + "-shm"]) fs.rmSync(f, { force: true });
const pt = (await import(path.join(root, "client/src/locales/pt.js"))).default;
const L = (lang) => (k) => (lang === "en" ? k.replace(/§.*$/, "") : pt[k] ?? k.replace(/§.*$/, ""));

let log = "";
const srv = spawn(process.execPath, ["--no-warnings", "server/src/index.js"], { cwd: root, env: { ...process.env, PORT: String(PORT), FLUXO_DB: DB, STRIPE_SECRET_KEY: "", ANTHROPIC_API_KEY: "", HARBOR_API_URL: "" } });
srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/status`)).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
const call = async (p, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const setup = await call("/setup", "POST", { company_name: "Acme Cafe", name: "Dona", email: "dona@example.test", password: "senha-longa-123", plan: "advanced", lang: "en" });
const token = setup.body.token; assert.ok(token, JSON.stringify(setup.body));
await call("/plan", "PUT", { payroll: true }, token);
// prestador 1099 (pago por cheque, acima do limite de 2026)
const accts = (await call("/accounts", "GET", undefined, token)).body;
const A = (code) => accts.find((a) => a.code === code).id;
const c = await call("/contacts", "POST", { kind: "vendor", name: "Joe Design LLC", is_1099: 1, tax_id: "12-3456780", address: "200 Pine Rd, Dallas, TX 75201" }, token);
assert.equal((await call("/expenses", "POST", { date: "2026-05-01", contact_id: c.body.id, account_id: A("6400"), paid_from_id: A("1010"), amount: 250000, description: "Design", method: "check" }, token)).status, 200);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
let failed = 0, passed = 0, page = null;
const consoleErrors = [];
const step = async (name, fn) => {
  try { await fn(); passed++; console.log("ok  -", name); }
  catch (e) { failed++; try { await page?.screenshot({ path: path.join(SHOTS, `falha-${failed}.png`), fullPage: true }); } catch { /* */ } console.log("ERRO-", name, "\n      ", String(e.message).split("\n").slice(0, 8).join("\n       ")); }
};
const noHScroll = async (where) => {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: window.innerWidth, bw: document.body.scrollWidth,
    who: [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > window.innerWidth + 1 && b.width > 0 && !e.closest('.overflow-x-auto') && getComputedStyle(e).position !== 'fixed'; }).slice(0, 5).map((e) => `${e.tagName}.${String(e.className).slice(0, 60)} "${(e.textContent || '').slice(0, 40)}"`) }));
  assert.ok(r.sw <= r.w + 1 && r.bw <= r.w + 1, `${where}: rolagem lateral (${r.sw}/${r.bw} > ${r.w}) ${r.who.join(' | ')}`);
};
const download = async (click) => { const [d] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), click()]); const p = await d.path(); return { name: d.suggestedFilename(), buf: fs.readFileSync(p) }; };

async function flow({ lang, viewport, mobile, emp, period, payDate, depositKey, quarter, first }) {
  const t = L(lang);
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, acceptDownloads: true, locale: lang === "pt" ? "pt-BR" : "en-US" });
  await ctx.addInitScript(([tk, lg]) => { localStorage.setItem("fluxo_token", tk); localStorage.setItem("fluxo_lang", lg); }, [token, lang]);
  page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[${lang}] ${m.text()}`); });
  page.on("pageerror", (e) => consoleErrors.push(`[${lang}] ${e.message}`));
  const tag = `${lang} ${viewport.width}x${viewport.height}`;
  const dialog = () => page.getByRole("dialog");

  if (first) await step(`${tag}: Configurações > Folha (arquivo do banco e dados do empregador)`, async () => {
    await page.goto(`${BASE}/settings/payroll`);
    await page.getByTestId("nacha-company").fill("Acme Cafe");
    await page.getByTestId("nacha-ein").fill("12-3456789");
    await page.getByTestId("nacha-odfi").fill("021000021");
    await page.getByTestId("save-nacha").click();
    await page.getByText(t("Settings saved")).first().waitFor();
    for (const [id, v] of [["er-address", "1 Market St"], ["er-city", "Austin"], ["er-state", "TX"], ["er-zip", "73301"], ["er-bso", "AB12CD34"], ["er-contact", "Dona"], ["er-phone", "5125550100"], ["er-email", "dona@example.test"]]) await page.getByTestId(id).fill(v);
    await page.getByTestId("save-employer").click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="save-employer"]') || document.querySelector('[data-testid="save-employer"]').disabled);
    await noHScroll("settings/payroll");
  });

  await step(`${tag}: novo funcionário com endereço e conta de depósito direto (mascarada)`, async () => {
    await page.goto(`${BASE}/payroll/employees`);
    await page.getByRole("button", { name: t("+ New employee") }).click();
    const d = dialog();
    await d.getByLabel(t("Name"), { exact: true }).fill(emp.name);
    await d.getByLabel(t("SSN / Tax ID")).fill(emp.ssn);
    await d.getByLabel(t("Annual salary"), { exact: true }).fill("62400");
    await d.getByLabel(t("Street address")).fill("10 Main St");
    await d.getByLabel(t("City")).fill("Austin");
    await d.getByLabel(t("State (2 letters)")).fill("TX");
    await d.getByLabel(t("ZIP code")).fill("73301");
    await d.getByRole("button", { name: t("Save"), exact: true }).click();
    await dialog().waitFor({ state: "detached" });
    await page.locator("tr", { hasText: emp.name }).getByRole("button", { name: t("Edit") }).first().click();
    await page.getByTestId("bank-routing").fill("011000015");
    await page.getByTestId("bank-account").fill(emp.account);
    await page.getByTestId("bank-save").click();
    await page.getByText(t("Bank details saved")).first().waitFor();
    await noHScroll("employee modal");
    await dialog().getByRole("button", { name: t("Cancel") }).click();
    await page.locator("tr", { hasText: emp.name }).getByText(`****${emp.account.slice(-4)}`).first().waitFor();
    assert.equal(await page.getByText(emp.account).count(), 0, "conta completa não aparece");
    await noHScroll("employees");
  });

  await step(`${tag}: folha finalizada e arquivo NACHA baixado (com a confirmação)`, async () => {
    await page.goto(`${BASE}/payroll/runs`);
    await page.getByRole("button", { name: t("+ New pay run") }).click();
    const d = dialog();
    await d.getByLabel(t("Period start")).fill(period[0]);
    await d.getByLabel(t("Period end")).fill(period[1]);
    await d.getByLabel(t("Pay date")).fill(payDate);
    const fin = d.getByRole("button", { name: t("Finalize payroll") });
    await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].some((b) => !b.disabled && /Finali/.test(b.textContent)));
    page.once("dialog", (x) => x.accept());
    await fin.click();
    await dialog().waitFor({ state: "detached" });
    const us = new Date(`${payDate}T00:00:00`).toLocaleDateString("en-US");
    await page.locator("tr", { hasText: us }).locator('button[data-testid^="nacha-"]').first().click();
    await page.getByTestId("nacha-notice").waitFor();
    assert.equal((await page.getByTestId("nacha-notice").textContent()).trim(), t("Upload this file to your bank's ACH/Direct deposit portal. Fluxo does not send money."));
    assert.equal(await page.getByTestId("nacha-download").isDisabled(), true, "sem a confirmação o botão fica desligado");
    await dialog().getByTestId("review-check").check();
    const f = await download(() => page.getByTestId("nacha-download").click());
    assert.match(f.name, /\.ach$/);
    const lines = f.buf.toString().trimEnd().split("\r\n");
    assert.ok(lines.every((l) => l.length === 94) && lines.length % 10 === 0, "NACHA 94/10");
    assert.ok(lines.some((l) => l.startsWith("622") && l.includes(emp.account)));
    await noHScroll("nacha modal");
    await dialog().getByRole("button", { name: t("Close") }).last().click();
  });

  await step(`${tag}: depósitos de impostos — marcar como pago com confirmação do EFTPS`, async () => {
    await page.goto(`${BASE}/payroll/deposits`);
    assert.match(await page.getByTestId("eftps-notice").textContent(), new RegExp(t("Pay at EFTPS.gov — Fluxo does not pay taxes for you.").replace(/[.$]/g, "\\$&")));
    const row = page.locator(`[data-deposit="${depositKey}"]:visible`).first();
    await row.getByTestId("mark-paid").click();
    await page.getByTestId("pay-eftps").fill("270099887766");
    await noHScroll("pay modal");
    await page.getByTestId("pay-save").click();
    await dialog().waitFor({ state: "detached" });
    await page.locator(`[data-deposit="${depositKey}"]:visible`).first().getByText("#270099887766").waitFor();
    await page.locator(`[data-deposit="${depositKey}"]:visible`).first().getByText(t("Paid§deposit"), { exact: true }).waitFor();
    await noHScroll("deposits");
    await page.screenshot({ path: path.join(SHOTS, `planb-deposits-${lang}-${viewport.width}.png`), fullPage: true });
  });

  await step(`${tag}: Form 941 (PDF), W-2/W-3 (PDF), EFW2 e CSV do IRIS (beta)`, async () => {
    await page.goto(`${BASE}/payroll/forms`);
    const card941 = page.locator("section", { hasText: t("Form 941 — quarterly federal tax return") });
    await card941.getByLabel(t("Quarter")).selectOption(String(quarter));
    await card941.getByText(t("Review, sign and file it yourself (paper or your e-file provider).")).waitFor();
    assert.equal(await card941.getByTestId("dl-941").isDisabled(), true);
    await card941.getByTestId("review-check").check();
    const p941 = await download(() => card941.getByTestId("dl-941").click());
    assert.equal(p941.buf.slice(0, 5).toString(), "%PDF-"); assert.match(p941.name, new RegExp(`Q${quarter}`));
    const w2 = page.locator("section", { hasText: t("W-2 and W-3") });
    await w2.getByText(emp.name).locator("visible=true").first().waitFor();
    await w2.getByTestId("review-check").first().check();
    const pw2 = await download(() => w2.getByTestId("dl-w2").click());
    assert.equal(pw2.buf.slice(0, 5).toString(), "%PDF-");
    await w2.getByTestId("review-check").nth(1).check();
    const ef = await download(() => w2.getByTestId("dl-efw2").click());
    assert.ok(ef.buf.toString().split("\r\n").filter(Boolean).every((r) => r.length === 512), "EFW2 512");
    const n99 = page.locator("section", { hasText: t("1099-NEC for contractors") });
    await n99.getByText("Joe Design LLC").locator("visible=true").first().waitFor();
    assert.equal((await n99.getByTestId("iris-beta").textContent()).trim(), t("beta — verify against the current IRIS template before uploading"));
    await n99.getByTestId("review-check").nth(1).check();
    const csv = await download(() => n99.getByTestId("dl-iris").click());
    assert.match(csv.buf.toString(), /^Form Type,Tax Year,/); assert.match(csv.buf.toString(), /1099-NEC,2026,EIN,123456789/);
    await noHScroll("forms");
    await page.screenshot({ path: path.join(SHOTS, `planb-forms-${lang}-${viewport.width}.png`), fullPage: true });
  });

  await step(`${tag}: auditoria dos arquivos da folha (quem, quando, tipo, totais)`, async () => {
    await page.goto(`${BASE}/payroll/files`);
    await page.getByText(t("Direct deposit file (NACHA)")).locator("visible=true").first().waitFor();
    assert.ok(await page.getByText("Dona").locator("visible=true").count() >= 5);
    await noHScroll("files");
    await page.goto(`${BASE}/payroll/runs`); await noHScroll("runs");
    await page.screenshot({ path: path.join(SHOTS, `planb-${lang}-${viewport.width}.png`), fullPage: true });
  });
  await ctx.close();
}

try {
  await flow({ lang: "en", viewport: { width: 1280, height: 900 }, mobile: false, first: true, emp: { name: "Maria Lopez", ssn: "123-45-6789", account: "44443333" }, period: ["2026-10-01", "2026-10-14"], payDate: "2026-10-16", depositKey: "941:M:2026-10", quarter: 4 });
  await flow({ lang: "pt", viewport: { width: 390, height: 844 }, mobile: true, first: false, emp: { name: "Joao Souza", ssn: "234-56-7890", account: "55556666" }, period: ["2026-09-01", "2026-09-14"], payDate: "2026-09-18", depositKey: "941:M:2026-09", quarter: 3 });
} finally {
  await browser.close(); srv.kill();
}
const relevant = consoleErrors.filter((e) => !/favicon|ERR_CERT_AUTHORITY_INVALID|Failed to load resource: the server responded with a status of 40[134]/.test(e)); // certificado: fontes do Google atrás do proxy desta máquina
if (relevant.length) { console.log("Erros no console:\n  " + relevant.join("\n  ")); failed++; }
console.log(`\n${passed} passos ok, ${failed} com erro`);
if (failed) { console.log(log.slice(-3000)); process.exit(1); }
