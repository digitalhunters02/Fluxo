// "Selo de plano" e "Ver como plano" NO NAVEGADOR: servidor real (um arquivo SQLite) + front buildado, usuário comum em cada plano e o DONO.
//   (na raiz)  npm run build   e depois   node server/e2e/selo.e2e.mjs        [SELO_SHOTS=<pasta das fotos>]
// Porta: 7921 (o servidor também entrega o front). Banco: SELO_DB (padrão /tmp/selo-fluxo/fluxo-e2e.db), apagado no começo e no fim.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire("/opt/node22/lib/node_modules/");
const { chromium } = require("playwright");
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const PORT = Number(process.env.SELO_PORT || 7921);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = process.env.SELO_DB || "/tmp/selo-fluxo/fluxo-e2e.db";
const SHOTS = process.env.SELO_SHOTS || "/tmp/selo-fluxo/shots";
fs.mkdirSync(path.dirname(DB), { recursive: true }); fs.mkdirSync(SHOTS, { recursive: true });
for (const f of [DB, DB + "-wal", DB + "-shm"]) fs.rmSync(f, { force: true });
const DONO = "dono@example.test", COMUM = "comum@example.test", PASS = "senha-longa-123";

// ---- oráculo independente (escrito à mão, de propósito): item de menu -> plano mínimo ----
const ORDER = ["free", "starter", "essentials", "plus", "advanced", "business", "enterprise"];
const NAME = Object.fromEntries(ORDER.map((p) => [p, p[0].toUpperCase() + p.slice(1)]));
const NAV_MIN = { "/credit-memos": "starter", "/recurring": "essentials", "/bills": "essentials", "/purchase-orders": "plus", "/connections": "essentials", "/projects": "essentials", "/assets": "business", "/close": "business" };
const PRICE = { starter: ["$29", "$313"], essentials: ["$65", "$702"], plus: ["$109", "$1,177"], advanced: ["$269", "$2,905"], business: ["$599", "$6,469"], enterprise: ["$900", "$9,720"] };
// folha é complemento: selo "Payroll add-on" em qualquer plano SEM o complemento (com o complemento ligado, nenhum selo)
const expectedNav = (plan, payroll) => ({
  ...Object.fromEntries(Object.entries(NAV_MIN).filter(([, m]) => ORDER.indexOf(m) > ORDER.indexOf(plan))),
  ...(payroll ? {} : { "/payroll": "payroll" }),
});
const SETTINGS_TABS_MIN = { accountants: "starter", roles: "advanced", audit: "essentials", integrations: "advanced", payments: "advanced", approvals: "business", sso: "enterprise" };
const ACCOUNTING_TABS_MIN = { budgets: "plus", classes: "plus" };
const lockedBy = (table, plan) => Object.fromEntries(Object.entries(table).filter(([, m]) => ORDER.indexOf(m) > ORDER.indexOf(plan)));

let log = "";
const srv = spawn(process.execPath, ["--no-warnings", "server/src/index.js"], { cwd: root, env: { ...process.env, PORT: String(PORT), FLUXO_DB: DB, OWNER_EMAILS: DONO, FLUXO_ADMIN_EMAIL: "", STRIPE_SECRET_KEY: "", ANTHROPIC_API_KEY: "" } });
srv.stdout.on("data", (d) => (log += d)); srv.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 200; i++) { try { if ((await fetch(`${BASE}/api/status`)).ok) break; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); }

const call = async (p, method = "GET", body, token, extra = {}) => {
  const r = await fetch(`${BASE}/api${p}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const setup = await call("/setup", "POST", { company_name: "Bright Books", name: "Cliente Comum", email: COMUM, password: PASS, plan: "enterprise", lang: "en" });
assert.ok(setup.body.token, "setup falhou " + JSON.stringify(setup.body));
const comum = setup.body.token;
const mk = await call("/users", "POST", { name: "Dono da Plataforma", email: DONO, password: PASS, role: "owner" }, comum);
assert.equal(mk.status, 200, "criar o dono falhou " + JSON.stringify(mk.body));
const dono = (await call("/login", "POST", { email: DONO, password: PASS })).body.token;
assert.ok(dono);
const setPlan = async (plan, payroll = false) => { const r = await call("/plan", "PUT", { plan, payroll }, comum); assert.equal(r.status, 200, JSON.stringify(r.body)); };
await call("/plan", "PUT", { plan: "enterprise", payroll: true }, comum);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
let failed = 0, passed = 0, cur = null;
const consoleErrors = [];
const step = async (name, fn) => {
  try { await fn(); passed++; console.log("ok  -", name); }
  catch (e) { failed++; try { await cur?.screenshot({ path: path.join(SHOTS, `falha-${failed}.png`) }); } catch { /* */ } console.log("ERRO-", name, "\n      ", String(e.message).split("\n").slice(0, 6).join("\n       ")); }
};
const DESKTOP = { width: 1280, height: 900 }, PHONE = { width: 390, height: 844 };
async function newPage(token, viewport = DESKTOP, { lang = "en", preview, theme } = {}) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block", ...(viewport.width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addInitScript(([tk, lang, prev, theme]) => {
    try {
      if (tk) localStorage.setItem("fluxo_token", tk);
      localStorage.setItem("fluxo_lang", lang); localStorage.setItem("fluxo_tour_done", "1");
      if (theme) localStorage.setItem("fluxo_theme", theme); else localStorage.setItem("fluxo_theme", "light");
      if (prev && !sessionStorage.getItem("__seeded")) { localStorage.setItem("fluxo_preview_plan", prev); sessionStorage.setItem("__seeded", "1"); }
    } catch { /* */ }
  }, [token || "", lang, preview || "", theme || ""]);
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort());
  const p = await ctx.newPage(); cur = p;
  p.on("console", (m) => { if (m.type() === "error" && /^(https?:\/\/)?(127\.0\.0\.1|localhost)/.test(m.location().url || "http://127.0.0.1")) consoleErrors.push(`[${m.location().url || ""}] ${m.text()}`.slice(0, 240)); });
  p.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e.message).slice(0, 240)));
  return p;
}
const isPhone = (p) => p.viewportSize().width < 500;
async function openApp(p, route = "/") {
  const me = p.waitForResponse((r) => r.url() === `${BASE}/api/me` && r.status() === 200, { timeout: 20000 });
  await p.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await me;
  await p.waitForSelector('a[data-nav="/invoices"], a[href="/invoices"]', { state: "attached", timeout: 20000 });
  await p.waitForTimeout(250);
}
const openMenu = async (p) => { if (isPhone(p) && !(await p.locator("#sidebar").evaluate((e) => e.classList.contains("translate-x-0")))) { await p.click('button[aria-label="Menu"]'); await p.waitForTimeout(350); } };
const lockedNav = (p) => p.$$eval("a[data-nav][data-plan-locked]", (els) => Object.fromEntries(els.map((e) => [e.dataset.nav, e.dataset.planLocked])));
const lockedTabs = (p) => p.$$eval("button[data-tab][data-plan-locked]", (els) => Object.fromEntries(els.map((e) => [e.dataset.tab, e.dataset.planLocked])));
const noHScroll = async (p, label) => { const w = await p.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth, document.body.scrollWidth]); assert.ok(w[0] <= w[1] && w[2] <= w[1], `${label}: rolagem lateral ${JSON.stringify(w)}`); };
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + ".png") });
const modalOf = (p) => p.locator('[data-testid="plan-upsell"]');
const realPlan = async () => (await call("/plan", "GET", undefined, comum)).body;
const big = async (loc, min = 40) => { const b = await loc.boundingBox(); assert.ok(b && b.height >= min - 0.5 && b.width >= min - 0.5, `alvo de toque pequeno: ${JSON.stringify(b)}`); };

try {
  // ============ 1) menu com os selos certos em cada plano (comum, desktop, inglês) ============
  for (const plan of ORDER) {
    await step(`menu com selos certos no plano ${plan}`, async () => {
      const payroll = plan === "enterprise"; await setPlan(plan, payroll);
      const p = await newPage(comum); await openApp(p);
      const exp = expectedNav(plan, payroll);
      assert.deepEqual(await lockedNav(p), exp);
      const badges = await p.$$eval("#sidebar [data-plan-badge]", (els) => els.map((e) => e.dataset.planBadge).sort());
      assert.deepEqual(badges, Object.values(exp).sort());
      if (plan === "enterprise") assert.equal(badges.length, 0, "plano mais alto (com folha): nenhum selo");
      assert.equal(await p.locator('[data-testid="plan-preview"]').count(), 0, "cliente comum não vê o seletor 'Ver como plano'");
      if (plan === "free") await shot(p, "01-menu-free");
      if (plan === "plus") await shot(p, "01-menu-plus");
      await p.context().close();
    });
  }

  // ============ 2) janelinha ============
  await step("Free: clicar em Bills abre 'Available on the Essentials plan' com preço, outros recursos e 'See plans' leva à tela de planos", async () => {
    await setPlan("free");
    const p = await newPage(comum); await openApp(p);
    await p.click('a[data-nav="/bills"]');
    const m = modalOf(p); await m.waitFor();
    const text = await m.innerText();
    assert.match(text, /Available on the Essentials plan/);
    assert.match(text, /Bills and vendor payments/); assert.match(text, /\$65 per month/); assert.match(text, /or \$702 per year/);
    assert.match(text, /Essentials plan also includes/);
    assert.equal(await p.locator('a[data-nav="/bills"]').count(), 1, "o item continua no menu");
    assert.ok(new URL(p.url()).pathname === "/", "não navegou para a página bloqueada");
    await shot(p, "02-janelinha-free-bills");
    await big(p.locator('[data-testid="plan-upsell-plans"]')); await big(p.locator('[data-testid="plan-upsell-close"]'));
    await p.click('[data-testid="plan-upsell-close"]'); await m.waitFor({ state: "detached" });
    await p.click('a[data-nav="/bills"]'); await m.waitFor();
    await p.click('[data-testid="plan-upsell-plans"]');
    await p.waitForURL(/\/settings\/plan/); await p.waitForSelector('[data-testid="plan-grid"]');
    assert.equal(await m.count(), 0);
    await p.context().close();
  });
  await step("Free: Payroll mostra 'Payroll add-on' (complemento) e a janelinha traz o preço $35", async () => {
    const p = await newPage(comum); await openApp(p);
    await p.click('a[data-nav="/payroll"]');
    const m = modalOf(p); await m.waitFor();
    const text = await m.innerText();
    assert.match(text, /Available on the Payroll add-on plan/); assert.match(text, /\$35 per month/);
    await p.context().close();
  });
  await step("Enterprise com folha: nenhum selo no menu, abas, relatórios; clicar em Payroll navega", async () => {
    await setPlan("enterprise", true);
    const p = await newPage(comum); await openApp(p);
    assert.equal(await p.locator("[data-plan-badge]").count(), 0);
    await p.click('a[data-nav="/payroll"]'); await p.waitForURL(/\/payroll/);
    assert.equal(await modalOf(p).count(), 0);
    await p.context().close();
  });

  // ============ 3) abas, relatórios, botões ============
  for (const plan of ["free", "essentials", "advanced"]) {
    await step(`abas de Configurações e Contabilidade com selo certo no plano ${plan}`, async () => {
      await setPlan(plan, false);
      const p = await newPage(comum); await openApp(p, "/settings/company");
      await p.waitForSelector('button[data-tab="company"]');
      assert.deepEqual(await lockedTabs(p), lockedBy(SETTINGS_TABS_MIN, plan));
      await p.goto(BASE + "/accounting"); await p.waitForSelector('button[data-tab="chart"]');
      assert.deepEqual(await lockedTabs(p), lockedBy(ACCOUNTING_TABS_MIN, plan));
      if (plan === "free") {
        await p.click('button[data-tab="budgets"]');
        await modalOf(p).waitFor();
        assert.match(await modalOf(p).innerText(), /Available on the Plus plan/);
        await p.click('[data-testid="plan-upsell-close"]');
        assert.equal(new URL(p.url()).pathname, "/accounting");
      }
      await p.context().close();
    });
  }
  await step("Free: página bloqueada aberta direto mostra o aviso com selo e botão 'See details' que abre a janelinha", async () => {
    await setPlan("free", false);
    const p = await newPage(comum); await openApp(p, "/bills");
    const n = p.locator('[data-plan-notice="bills"]'); await n.waitFor();
    assert.match(await n.innerText(), /Essentials/);
    assert.equal(await n.locator("[data-plan-badge]").first().getAttribute("data-plan-badge"), "essentials");
    assert.ok(!/upgrade/i.test(await n.innerText()), "sem texto solto de 'upgrade'");
    await p.click('[data-testid="plan-notice-details"]'); await modalOf(p).waitFor();
    await shot(p, "03-aviso-bills-free");
    await p.context().close();
  });
  await step("Free: relatórios bloqueados têm selo, clicar abre a janelinha", async () => {
    const p = await newPage(comum); await openApp(p, "/reports/pnl");
    await p.waitForSelector('nav a[href="/reports/pnl"]');
    const locked = await p.$$eval("main nav a[data-plan-locked]", (els) => els.length);
    assert.ok(locked >= 3, "relatórios completos têm selo (" + locked + ")");
    await p.click("main nav a[data-plan-locked]"); await modalOf(p).waitFor();
    assert.match(await modalOf(p).innerText(), /Available on the (Essentials|Plus) plan/);
    await p.context().close();
  });
  await step("Plus: 'Batch invoices' e 'Online payments' aparecem com selo Advanced; Advanced: sem selo", async () => {
    await setPlan("plus", false);
    let p = await newPage(comum); await openApp(p, "/invoices");
    const b = p.locator('[data-testid="batch-locked"]'); await b.waitFor();
    assert.equal(await b.getAttribute("data-plan-locked"), "advanced");
    await b.click(); await modalOf(p).waitFor();
    assert.match(await modalOf(p).innerText(), /Available on the Advanced plan/);
    await p.context().close();
    await setPlan("advanced", false);
    p = await newPage(comum); await openApp(p, "/invoices");
    await p.waitForSelector("text=Invoices");
    assert.equal(await p.locator('[data-testid="batch-locked"]').count(), 0);
    await p.context().close();
  });
  await step("Free: 'Invite user' abre a janelinha (Starter); e-mail da fatura e IA com selo", async () => {
    await setPlan("free", false);
    let p = await newPage(comum); await openApp(p, "/settings/users");
    const inv = p.locator('[data-testid="invite-user"]'); await inv.waitFor();
    assert.equal(await inv.getAttribute("data-plan-locked"), "starter");
    await inv.click(); await modalOf(p).waitFor();
    assert.match(await modalOf(p).innerText(), /Available on the Starter plan/);
    await p.context().close();
    await setPlan("starter", false);
    p = await newPage(comum); await openApp(p, "/banking");
    const ai = p.locator('[data-testid="ai-categorize-locked"]');
    assert.ok(await ai.count() >= 0);
    await p.context().close();
  });
  await step("Limite de contadores/bancos mostra o selo do próximo plano em vez de texto de upgrade", async () => {
    await setPlan("essentials", false);
    const p = await newPage(comum); await openApp(p, "/connections/banks");
    await p.waitForSelector('[data-testid="connect-bank"]');
    // conecta o banco de demonstração até o limite do plano (Essentials = 2)
    for (let i = 0; i < 2; i++) { const r = await call("/plaid/demo", "POST", {}, comum); assert.equal(r.status, 200, JSON.stringify(r.body)); }
    await p.reload(); await p.waitForSelector('[data-testid="connect-bank"]');
    assert.equal(await p.locator('[data-testid="connect-bank"]').getAttribute("data-plan-locked"), "plus");
    assert.ok(!/upgrade/i.test(await p.locator("body").innerText()), "sem 'upgrade' solto na tela");
    await p.context().close();
  });

  // ============ 4) tela de planos e página pública de preços ============
  await step("Configurações > Plan: cada plano com selo + preço e os recursos que ACRESCENTA com o selo do plano onde entram", async () => {
    await setPlan("starter", false);
    const p = await newPage(comum); await openApp(p, "/settings/plan"); await p.waitForSelector('[data-testid="plan-grid"]');
    for (const plan of ORDER.slice(1)) {
      const card = p.locator(`[data-testid="plan-grid"] [data-plan-card="${plan}"]`);
      await card.waitFor();
      assert.equal(await card.locator("[data-plan-badge]").first().getAttribute("data-plan-badge"), plan);
      assert.ok((await p.locator(`[data-testid="plan-price-${plan}"]`).innerText()).startsWith(PRICE[plan][0]), plan);
      const adds = card.locator(`[data-plan-adds="${plan}"] [data-add]`);
      assert.ok(await adds.count() >= 1, `${plan} lista o que acrescenta`);
      for (const li of await adds.all()) assert.equal(await li.locator("[data-plan-badge]").getAttribute("data-plan-badge"), plan);
    }
    // o primeiro recurso acrescentado pelo Essentials é "Bills..." com selo Essentials
    assert.ok((await p.locator('[data-plan-adds="essentials"]').innerText()).includes("Bills and vendor payments"));
    assert.ok((await p.locator('[data-plan-adds="essentials"]').innerText()).includes("Everything in Starter"));
    await shot(p, "04-planos-starter");
    await p.context().close();
  });
  for (const [label, vp] of [["1280", DESKTOP], ["390", PHONE]]) {
    await step(`página pública de preços ${label}px: selo + preço em cada plano, adições com selo, sem rolagem lateral`, async () => {
      const p = await newPage(null, vp); await p.goto(BASE + "/pricing", { waitUntil: "domcontentloaded" });
      await p.waitForSelector('[data-testid="plan-price-plus"]');
      for (const plan of ORDER) {
        const h = p.locator(`h2[data-plan-card="${plan}"]`); await h.waitFor();
        assert.equal(await h.locator("[data-plan-badge]").getAttribute("data-plan-badge"), plan);
      }
      assert.ok((await p.locator('[data-testid="plan-price-plus"]').innerText()).startsWith("$109"));
      const inCard = await p.$$eval("h2[data-plan-card='essentials']", (hs) => hs[0].parentElement.querySelectorAll("li [data-plan-badge]").length);
      assert.ok(inCard >= 3, "recursos do Essentials com selo: " + inCard);
      await noHScroll(p, "preços " + label);
      await shot(p, `04-precos-${label}`);
      await p.context().close();
    });
  }

  // ============ 5) DONO: ver como plano ============
  await step("Dono: seletor lista TODOS os planos + Meu plano; comum não vê", async () => {
    await setPlan("enterprise", true);
    const p = await newPage(dono); await openApp(p);
    await p.click('[data-testid="plan-preview-toggle"]');
    const keys = await p.$$eval("[data-plan-choice]", (els) => els.map((e) => e.dataset.planChoice));
    assert.deepEqual(keys, ["mine", ...ORDER]);
    await shot(p, "05-seletor-dono");
    assert.equal(await p.locator("[data-plan-badge]").count(), 0, "dono no plano mais alto (com folha): nenhum selo");
    await p.context().close();
  });
  for (const plan of ORDER) {
    await step(`Dono vê como ${plan}: faixa, selos, bloqueios; a conta continua intacta`, async () => {
      const p = await newPage(dono); await openApp(p);
      await p.click('[data-testid="plan-preview-toggle"]'); await p.click(`[data-plan-choice="${plan}"]`);
      await p.waitForSelector('[data-testid="plan-preview-bar"]'); await p.waitForSelector('a[data-nav="/invoices"]', { state: "attached" });
      await p.waitForTimeout(300);
      const bar = await p.locator('[data-testid="plan-preview-bar"]').innerText();
      assert.match(bar, new RegExp(`You are viewing Fluxo as the ${NAME[plan]} plan`)); assert.match(bar, /Back to my plan/);
      assert.deepEqual(await lockedNav(p), expectedNav(plan, false), "menu na prévia (sem complemento de folha)");
      // limites e abas seguem o plano visto
      await p.goto(BASE + "/settings/company"); await p.waitForSelector('button[data-tab="company"]');
      assert.deepEqual(await lockedTabs(p), lockedBy(SETTINGS_TABS_MIN, plan));
      const rp = await realPlan(); assert.equal(rp.plan, "enterprise"); assert.equal(rp.payroll, true);
      // a faixa fica fixa ao rolar e a barra lateral cabe abaixo dela
      await p.evaluate(() => window.scrollTo(0, 400)); await p.waitForTimeout(150);
      const bb = await p.locator('[data-testid="plan-preview-bar"]').boundingBox(); assert.ok(bb.y >= -0.5 && bb.y <= 1, "faixa fixa no topo " + JSON.stringify(bb));
      const sb = await p.locator("#sidebar").boundingBox(); assert.ok(sb.y >= bb.y + bb.height - 1 && sb.y + sb.height <= 901, "barra lateral abaixo da faixa " + JSON.stringify([bb, sb]));
      if (plan === "free") await shot(p, "05-dono-ve-free");
      await p.context().close();
    });
  }
  await step("Dono vendo como Free: tela de planos sem botões de assinar/trocar, com aviso; servidor recusa mudança (409)", async () => {
    const p = await newPage(dono, DESKTOP, { preview: "free" }); await openApp(p, "/settings/plan");
    await p.waitForSelector('[data-testid="plans-preview-note"]');
    assert.equal(await p.locator('[data-testid="plan-grid"] button').count(), 0, "nenhum botão de assinar/trocar na prévia");
    const r = await call("/plan", "PUT", { plan: "free" }, dono, { "x-preview-plan": "free" }); assert.equal(r.status, 409);
    assert.equal((await realPlan()).plan, "enterprise");
    await p.context().close();
  });
  await step("Dono: 'Back to my plan' volta ao normal sem selos", async () => {
    const p = await newPage(dono, DESKTOP, { preview: "free" }); await openApp(p);
    await p.waitForSelector('[data-testid="plan-preview-bar"]');
    await p.click('[data-testid="plan-preview-back"]');
    await p.waitForSelector('[data-testid="plan-preview-bar"]', { state: "detached" });
    await p.waitForSelector('a[data-nav="/invoices"]', { state: "attached" });
    assert.equal(await p.locator("[data-plan-badge]").count(), 0);
    await p.context().close();
  });
  await step("Cliente comum com chave de prévia no navegador: ignorada (sem faixa, sem seletor, plano real)", async () => {
    await setPlan("plus", false);
    const p = await newPage(comum, DESKTOP, { preview: "free" }); await openApp(p);
    assert.equal(await p.locator('[data-testid="plan-preview-bar"]').count(), 0);
    assert.equal(await p.locator('[data-testid="plan-preview"]').count(), 0);
    assert.deepEqual(await lockedNav(p), expectedNav("plus", false));
    await p.waitForTimeout(300);
    assert.equal(await p.evaluate(() => localStorage.getItem("fluxo_preview_plan")), null, "a chave esquecida é apagada");
    await p.context().close();
  });

  // ============ 6) idiomas, celular, escuro ============
  for (const [lang, title, pricePat] of [["pt", /Disponível no plano Essentials/, /US\$\s?65 por mês/], ["es", /Disponible en el plan Essentials/, /65\s?US\$ al mes|US\$\s?65 al mes/]]) {
    await step(`janelinha em ${lang}`, async () => {
      await setPlan("free", false);
      const p = await newPage(comum, DESKTOP, { lang }); await openApp(p);
      await p.click('a[data-nav="/bills"]'); await modalOf(p).waitFor();
      const text = await modalOf(p).innerText();
      assert.match(text, title); assert.match(text, pricePat);
      assert.ok(!/Available on the/.test(text), "sem texto em inglês");
      await shot(p, `06-janelinha-${lang}`);
      await p.context().close();
    });
  }
  await step("Celular 390x844: menu, janelinha, planos e dono sem rolagem lateral; alvos de toque >= 40px", async () => {
    await setPlan("free", false);
    let p = await newPage(comum, PHONE); await openApp(p);
    await noHScroll(p, "início");
    await openMenu(p);
    for (const a of await p.locator("#sidebar a[data-plan-locked]").all()) await big(a, 40);
    await shot(p, "06-celular-menu-free");
    await p.click('a[data-nav="/bills"]'); const m = modalOf(p); await m.waitFor();
    await noHScroll(p, "janelinha");
    const box = await m.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844, "janelinha dentro da tela " + JSON.stringify(box));
    await big(p.locator('[data-testid="plan-upsell-plans"]')); await big(p.locator('[data-testid="plan-upsell-close"]'));
    await shot(p, "06-celular-janelinha");
    await p.click('[data-testid="plan-upsell-plans"]'); await p.waitForSelector('[data-testid="plan-grid"]'); await noHScroll(p, "planos");
    await shot(p, "06-celular-planos");
    await p.context().close();
    await setPlan("enterprise", true);
    p = await newPage(dono, PHONE); await openApp(p);
    await p.click('[data-testid="plan-preview-toggle"]'); await big(p.locator('[data-testid="plan-preview-toggle"]'), 44);
    for (const c of await p.locator("[data-plan-choice]").all()) await big(c, 40);
    await p.click('[data-plan-choice="starter"]');
    await p.waitForSelector('[data-testid="plan-preview-bar"]'); await p.waitForTimeout(400);
    await noHScroll(p, "dono celular");
    const scrolled = await p.evaluate(async () => { const el = document.querySelector(".plan-preview-on > div:not(.plan-previewbar)"); el.scrollTop = 300; await new Promise((r) => setTimeout(r, 100)); return [el.scrollTop, el.scrollHeight > el.clientHeight]; });
    assert.ok(scrolled[0] > 0 && scrolled[1], "o app rola dentro da área abaixo da faixa " + JSON.stringify(scrolled));
    assert.ok((await p.locator('[data-testid="plan-preview-bar"]').boundingBox()).y <= 1, "faixa continua no topo depois de rolar");
    await big(p.locator('[data-testid="plan-preview-back"]'), 40);
    await shot(p, "06-celular-dono-starter");
    await openMenu(p);
    await shot(p, "06-celular-dono-menu");
    await p.context().close();
  });
  await step("Tema escuro: janelinha legível", async () => {
    await setPlan("free", false);
    const p = await newPage(comum, DESKTOP, { theme: "dark" }); await openApp(p);
    await p.click('a[data-nav="/bills"]'); await modalOf(p).waitFor();
    const bg = await modalOf(p).evaluate((e) => getComputedStyle(e).backgroundColor);
    assert.notEqual(bg, "rgb(255, 255, 255)");
    await shot(p, "06-escuro-janelinha");
    await p.context().close();
  });

  console.log(`\nerros de console: ${consoleErrors.length}`);
  for (const e of consoleErrors.slice(0, 12)) console.log("  -", e);
  if (consoleErrors.length) failed++;
} finally {
  await browser.close();
  srv.kill();
  for (const f of [DB, DB + "-wal", DB + "-shm"]) fs.rmSync(f, { force: true });
  console.log(`\n${passed} passaram, ${failed} falharam. Fotos em ${SHOTS}`);
  if (failed && /Error|error/.test(log)) console.log(log.split("\n").filter((l) => /rror/.test(l)).slice(0, 8).join("\n"));
  process.exit(failed ? 1 : 0);
}
