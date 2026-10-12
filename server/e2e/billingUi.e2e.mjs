// Plano anual do Fluxo NO NAVEGADOR: a página pública de preços e Configurações > Plan mostram a chave Mensal / Anual (−10%);
// mensal = preço cheio; anual = total do ano e o equivalente por mês (planos e folha); "Choose/Subscribe" no anual pede interval=year;
// quem já paga anual vê o preço do ano, sem chave; celular sem rolagem lateral. O Stripe não é chamado (o checkout é interceptado).
//   (na raiz) npm run build        e depois       node server/e2e/billingUi.e2e.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fluxo-billing-"));
const API = Number(process.env.BASE_PORT || 4450) + Math.floor(Math.random() * 40);
let pass = 0, fail = 0;
const check = (name, ok, extra) => { if (ok) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); } };

let log = "";
const boot = async (port, dbName) => {
  const c = spawn(process.execPath, ["--no-warnings", "server/src/index.js"], { cwd: root, env: { ...process.env, PORT: String(port), FLUXO_DB: path.join(tmp, dbName), STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x", ADMIN_SUMMARY_KEY: "", BOOTSTRAP_OWNER_EMAIL: "", BOOTSTRAP_OWNER_PASSWORD: "" } });
  c.stdout.on("data", (d) => (log += d)); c.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/api/status`)).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }
  return c;
};
// duas instalações: uma já com dono (Configurações > Plan) e uma virgem (página pública de preços, onde dá para escolher plano)
const child = await boot(API, "fluxo.db"); const child2 = await boot(API + 1, "fluxo-new.db");
let browser;
const url = `http://127.0.0.1:${API}`; const urlNew = `http://127.0.0.1:${API + 1}`;
try {
  const setup = await (await fetch(`${url}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company_name: "Bright Books", name: "Lee", email: "lee@x.com", password: "senha-1234", plan: "free" }) })).json();
  if (!setup.token) throw new Error("setup falhou " + JSON.stringify(setup));
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
  const open = async (vp, route, ready, { mockBilling, authed = true, origin = url } = {}) => {
    const ctx = await browser.newContext({ ...vp, serviceWorkers: "block" });
    await ctx.addInitScript(([tk, l, authed]) => { try { if (authed) localStorage.setItem("fluxo_token", tk); localStorage.setItem("fluxo_lang", l); localStorage.setItem("fluxo_tour_done", "1"); } catch { /* */ } }, [setup.token, "en", authed]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    if (mockBilling) await page.route("**/api/me", async (rt) => { const res = await rt.fetch(); const j = await res.json(); mockBilling(j); await rt.fulfill({ response: res, json: j }); });
    await page.goto(`${origin}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(ready, { timeout: 20000 });
    return { ctx, page, errors };
  };
  const txt = async (page, id) => (await page.textContent(`[data-testid="${id}"]`)).replace(/\s+/g, " ").trim();
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  for (const [label, vp] of [["1280", { viewport: { width: 1280, height: 900 } }], ["390", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
    console.log(`\n== página pública de preços, ${label}px`);
    const pub = await open(vp, "/pricing", '[data-testid="plan-price-plus"]', { authed: false, origin: urlNew });
    const p = pub.page;
    check(`${label}: a chave Mensal/Anual aparece`, await p.isVisible('[data-testid="billing-interval-year"]'));
    check(`${label}: mensal = preço cheio ($29 / $65 / $109 / $269; Free $0)`, (await txt(p, "plan-price-starter")).startsWith("$29") && (await txt(p, "plan-price-essentials")).startsWith("$65") && (await txt(p, "plan-price-plus")).startsWith("$109") && (await txt(p, "plan-price-advanced")).startsWith("$269") && (await txt(p, "plan-price-free")).startsWith("$0"));
    check(`${label}: sem aviso do anual enquanto está no mensal`, !(await p.isVisible('[data-testid="yearly-note"]')));
    check(`${label}: folha mostra o valor mensal ($35/mo + $5)`, (await p.textContent("body")).includes("$35/mo + $5 per employee"));
    await p.click('[data-testid="billing-interval-year"]');
    check(`${label}: anual mostra o total do ano (Starter $313.20, Essentials $702, Plus $1,177.20, Advanced $2,905.20)`, (await txt(p, "plan-price-starter")).startsWith("$313.20") && (await txt(p, "plan-price-essentials")).startsWith("$702") && (await txt(p, "plan-price-plus")).startsWith("$1,177.20") && (await txt(p, "plan-price-advanced")).startsWith("$2,905.20") && (await txt(p, "plan-price-free")).startsWith("$0"), await txt(p, "plan-price-plus"));
    const body = await p.textContent("body");
    check(`${label}: mostra o equivalente por mês ($98.10 do Plus)`, body.includes("$98.10"));
    check(`${label}: folha no anual ($378/yr + $54 per employee/yr)`, body.includes("$378/yr + $54 per employee/yr"));
    check(`${label}: aviso do anual (sem reembolso / cancelar a renovação) visível`, await p.isVisible('[data-testid="yearly-note"]'));
    if (label === "390") check("390: sem rolagem lateral", (await overflow(p)) <= 1, await overflow(p));
    await p.route("**/api/public/checkout", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ url: `${urlNew}/api/status` }) }));
    const reqP = p.waitForRequest((r) => r.url().endsWith("/api/public/checkout") && r.method() === "POST");
    await p.getByRole("button", { name: "Choose Plus" }).click();
    const sent = JSON.parse((await reqP).postData() || "{}");
    check(`${label}: checkout anual envia plan=plus e interval=year`, sent.plan === "plus" && sent.interval === "year", sent);
    check(`${label}: sem erros de script`, pub.errors.length === 0, pub.errors);
    await pub.ctx.close();
  }

  for (const [label, vp] of [["1280", { viewport: { width: 1280, height: 900 } }], ["390", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }]]) {
    console.log(`\n== Configurações > Plan, ${label}px`);
    const st = await open(vp, "/settings/plan", '[data-testid="plan-price-plus"]');
    const p = st.page;
    check(`${label}: a chave Mensal/Anual aparece (cobrança ligada, assinatura nova)`, await p.isVisible('[data-testid="billing-interval-year"]'));
    check(`${label}: mensal = preço cheio ($65 Essentials, $109 Plus)`, (await txt(p, "plan-price-essentials")).startsWith("$65") && (await txt(p, "plan-price-plus")).startsWith("$109"));
    await p.click('[data-testid="billing-interval-year"]');
    check(`${label}: anual mostra o total do ano (Essentials $702, Plus $1,177.20)`, (await txt(p, "plan-price-essentials")).startsWith("$702") && (await txt(p, "plan-price-plus")).startsWith("$1,177.20"), await txt(p, "plan-price-plus"));
    check(`${label}: folha no anual ($378/yr + $54 per employee/yr)`, (await p.textContent("body")).includes("$378/yr + $54 per employee/yr"));
    if (label === "390") check("390: sem rolagem lateral", (await overflow(p)) <= 1, await overflow(p));
    await p.route("**/api/billing/checkout", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ url: `${url}/api/status` }) }));
    const reqP = p.waitForRequest((r) => r.url().endsWith("/api/billing/checkout") && r.method() === "POST");
    await p.locator('[data-testid="plan-price-plus"]').locator("xpath=ancestor::*[.//button[normalize-space()='Subscribe']][1]").getByRole("button", { name: "Subscribe" }).click();
    const sent = JSON.parse((await reqP).postData() || "{}");
    check(`${label}: Subscribe no anual envia plan=plus e interval=year`, sent.plan === "plus" && sent.interval === "year", sent);
    check(`${label}: sem erros de script`, st.errors.length === 0, st.errors);
    await st.ctx.close();
  }

  console.log("\n== quem já paga anual vê o preço do ano, sem chave");
  const sub = await open({ viewport: { width: 1280, height: 900 } }, "/settings/plan", '[data-testid="plan-price-plus"]', { mockBilling: (j) => { j.planInfo = { ...j.planInfo, billing: { ...(j.planInfo.billing || {}), managed: true, interval: "year", status: "active", hasCustomer: true } }; } });
  await sub.page.waitForTimeout(600);
  check("sem chave Mensal/Anual para quem já paga", !(await sub.page.isVisible('[data-testid="billing-interval-year"]')));
  check("mostra o preço do ano (Plus $1,177.20)", (await txt(sub.page, "plan-price-plus")).startsWith("$1,177.20"), await txt(sub.page, "plan-price-plus"));
  await sub.ctx.close();
} catch (e) {
  fail++; console.log("ERRO", e.message); console.log(log.slice(-500));
} finally {
  try { await browser?.close(); } catch { /* */ }
  child.kill(); child2.kill();
}
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
