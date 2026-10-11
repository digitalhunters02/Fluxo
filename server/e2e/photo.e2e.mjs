// "Importar de foto" no Fluxo, NO NAVEGADOR: IA e Stripe simulados, servidor real (serve o front buildado), banco SQLite em arquivo temporário.
//   (na raiz) npm run build        e depois       node server/e2e/photo.e2e.mjs
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");
const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fluxo-photo-"));
const DBFILE = path.join(tmp, "fluxo.db");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(tmp, "print.png"), PNG);
const API = 4340, AIP = 4342;

let reply = {};
const ai = http.createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "tool_use", stop_sequence: null, content: [{ type: "tool_use", id: "t", name: "record_import", input: reply }], usage: { input_tokens: 1, output_tokens: 1 } })); });
}).listen(AIP);

const boot = (extra) => {
  const child = spawn(process.execPath, ["--no-warnings", "server/src/index.js"], { cwd: root, env: { ...process.env, PORT: String(API), FLUXO_DB: DBFILE, ...extra } });
  let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
  return { child, log: () => log };
};
const waitApi = async () => { for (let i = 0; i < 120; i++) { try { if ((await fetch(`http://127.0.0.1:${API}/api/status`)).ok) return; } catch { /* subindo */ } await new Promise((r) => setTimeout(r, 150)); } throw new Error("servidor não subiu"); };

let srv = boot({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${AIP}`, PHOTO_MIGRATION_DAYS: "0" });
await waitApi();
const setup = await (await fetch(`http://127.0.0.1:${API}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ company_name: "Acme Co", name: "Lee", email: "lee@x.com", password: "senha-1234", lang: "en", plan: "essentials" }) })).json();
const TOKEN = setup.token;
assert.ok(TOKEN, "setup falhou: " + JSON.stringify(setup));

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox"] });
let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log("ok  -", name); } catch (e) { failed++; console.log("ERRO-", name, "\n      ", String(e.message).split("\n").slice(0, 3).join(" ")); } };
const newPage = async (viewport, lang) => {
  const ctx = await browser.newContext({ viewport, ...(viewport.width < 500 ? { hasTouch: true, isMobile: true } : {}) });
  await ctx.addInitScript(([tk, l]) => { try { localStorage.setItem("fluxo_token", tk); localStorage.setItem("fluxo_lang", l); } catch { /* */ } }, [TOKEN, lang]);
  return ctx.newPage();
};
const go = async (page, p) => { await page.goto(`http://127.0.0.1:${API}${p}`); await page.waitForSelector('[data-testid="photo-import-open"]'); };
const openPhoto = async (page) => { await page.click('[data-testid="photo-import-open"]'); await page.waitForSelector('[data-testid="photo-modal"]'); };

try {
  const page = await newPage({ width: 1280, height: 900 }, "en");
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|favicon|fonts/.test(m.text())) errors.push(m.text()); });

  await step("Clientes: foto → conferir (amarelo) → editar → desmarcar → salvar", async () => {
    await go(page, "/customers");
    reply = { records: [
      { name: "Marina Souza", phone: "(407) 555-0188", email: "marina@x.com", address: "", type: "customer", notes: "x", unclear_fields: ["phone"] },
      { name: "Café Aurora", phone: "(407) 555-0199", email: "", address: "", type: "customer", notes: null, unclear_fields: [] },
      { name: "Fulano Teste", phone: "", email: "", address: "", type: "customer", notes: null, unclear_fields: [] },
    ], note: "Confira o telefone da Marina." };
    await openPhoto(page);
    await page.setInputFiles('[data-testid="photo-file"]', path.join(tmp, "print.png"));
    await page.waitForSelector('[data-testid="photo-row"]');
    assert.equal(await page.locator('[data-testid="photo-row"]').count(), 3);
    assert.match(await page.locator('[data-testid="photo-modal"]').innerText(), /Check this one/);
    await page.locator('[data-testid="photo-row"]').nth(0).locator('[data-testid="photo-name"]').fill("Marina de Souza");
    await page.locator('[data-testid="photo-row"]').nth(2).locator('input[type="checkbox"]').uncheck();
    assert.match(await page.locator('[data-testid="photo-save"]').innerText(), /Save 2/);
    await page.click('[data-testid="photo-save"]');
    await page.waitForSelector('[data-testid="photo-modal"]', { state: "detached" });
    await page.waitForSelector("text=Marina >> visible=true"); await page.waitForSelector("text=Café >> visible=true");
    assert.equal(await page.locator("text=Fulano").count(), 0, "o desmarcado não foi salvo");
  });

  await step("Clientes: linha sem nome não é salva e mostra o erro", async () => {
    reply = { records: [{ name: "Joana Lima", phone: "", email: "", address: "", type: "customer", notes: null, unclear_fields: [] }, { name: null, phone: "(407) 555-0000", email: "", address: "", type: "customer", notes: null, unclear_fields: [] }], note: null };
    await openPhoto(page);
    await page.setInputFiles('[data-testid="photo-file"]', path.join(tmp, "print.png"));
    await page.waitForSelector('[data-testid="photo-row"]');
    await page.click('[data-testid="photo-save"]');
    await page.waitForSelector("text=Name is required");
    assert.equal(await page.locator('[data-testid="photo-row"]').count(), 1);
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="photo-modal"]', { state: "detached" });
    await page.waitForSelector("text=Joana >> visible=true");
  });

  await step("celular: janela sem rolagem lateral, em português", async () => {
    const m = await newPage({ width: 390, height: 844 }, "pt");
    reply = { records: [{ name: "Maria Silva", phone: "(407) 555-0142", email: "maria@email.com", address: "", type: "customer", notes: null, unclear_fields: ["email"] }], note: null };
    await go(m, "/customers");
    await openPhoto(m);
    await m.waitForSelector('[data-testid="photo-file"]', { state: "attached" });
    assert.match(await m.locator('[data-testid="photo-modal"]').innerText(), /Tire uma foto/);
    await m.setInputFiles('[data-testid="photo-file"]', path.join(tmp, "print.png"));
    await m.waitForSelector('[data-testid="photo-row"]');
    assert.match(await m.locator('[data-testid="photo-modal"]').innerText(), /Confira este/);
    const w = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    assert.ok(w.sw <= w.cw + 1, `rolagem lateral ${w.sw} > ${w.cw}`);
    await m.screenshot({ path: path.join(process.env.PHOTO_SHOTS || tmp, "photo-mobile.png") });
  });
  assert.deepEqual(errors, [], "sem erros no console: " + errors.join(" | "));

  // ---- créditos: aviso 80% → limite → aceite → extra → teto (Essentials: 100/mês; o servidor tem PHOTO_MIGRATION_DAYS=0) ----
  srv.child.kill(); await new Promise((r) => setTimeout(r, 600));
  srv = boot({ ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${AIP}`, PHOTO_MIGRATION_DAYS: "0", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_API_BASE: "http://127.0.0.1:9", PHOTO_EXTRA_CAPS_CENTS: "20,1000" });
  await waitApi();
  const sql = new DatabaseSync(DBFILE);
  sql.exec("DELETE FROM photo_imports; DELETE FROM usage_credit; INSERT OR REPLACE INTO settings(key,value) VALUES ('stripe_customer_id','cus_1'),('stripe_subscription_id','sub_1')");
  const add = (n) => { for (let i = 0; i < n; i++) sql.exec("INSERT INTO photo_imports (kind, records) VALUES ('clients', 1)"); };
  await step("créditos: aviso de 80%, limite, aceite, uso extra e teto", async () => {
    add(79);
    const p3 = await newPage({ width: 1280, height: 900 }, "en");
    reply = { records: [{ name: "Lia Costa", phone: "", email: "", address: "", type: "customer", notes: null, unclear_fields: [] }], note: null };
    await go(p3, "/customers");
    await openPhoto(p3);
    await p3.setInputFiles('[data-testid="photo-file"]', path.join(tmp, "print.png")); // nº 80
    await p3.waitForSelector('[data-testid="photo-row"]');
    assert.match(await p3.locator('[data-testid="photo-warn-review"]').innerText(), /80 of 100 photo reads/);
    await p3.keyboard.press("Escape");
    add(20);
    await openPhoto(p3);
    await p3.waitForSelector('[data-testid="photo-credit"]');
    assert.equal(await p3.locator('[data-testid="photo-file"]').count(), 0, "sem aceite não lê");
    assert.equal(await p3.locator('[data-testid="photo-credit-on"]').isDisabled(), true);
    await p3.selectOption('[data-testid="photo-credit-cap"]', "20");
    await p3.check('[data-testid="photo-credit-agree"]');
    await p3.click('[data-testid="photo-credit-on"]');
    await p3.waitForSelector('[data-testid="photo-credit-active"]');
    assert.match(await p3.locator('[data-testid="photo-credit-active"]').innerText(), /US\$ 0\.00 of US\$ 0\.20/);
    for (let i = 0; i < 2; i++) {
      await p3.setInputFiles('[data-testid="photo-file"]', path.join(tmp, "print.png"));
      await p3.waitForSelector('[data-testid="photo-row"]');
      await p3.click("text=Try another image");
    }
    await p3.waitForSelector('[data-testid="photo-credit"]');
    assert.match(await p3.locator('[data-testid="photo-warn"]').innerText(), /reached your extra limit of US\$ 0\.20/);
    assert.equal(await p3.locator('[data-testid="photo-file"]').count(), 0);
  });

  srv.child.kill(); await new Promise((r) => setTimeout(r, 600));
  srv = boot({ ANTHROPIC_API_KEY: "" });
  await waitApi();
  await step("sem chave da IA: aviso claro, sem botão de escolher imagem", async () => {
    const p2 = await newPage({ width: 1280, height: 800 }, "en");
    await go(p2, "/customers");
    await openPhoto(p2);
    await p2.waitForSelector('[data-testid="photo-blocked"]');
    assert.match(await p2.locator('[data-testid="photo-blocked"]').innerText(), /not connected/i);
    assert.equal(await p2.locator('[data-testid="photo-file"]').count(), 0);
  });
} catch (e) {
  failed++; console.log("ERRO geral", e.message, "\n", srv.log().slice(-600));
} finally {
  await browser.close(); srv.child.kill(); ai.close();
  console.log(failed ? `${failed} falha(s)` : "tudo certo");
  process.exit(failed ? 1 : 0);
}
