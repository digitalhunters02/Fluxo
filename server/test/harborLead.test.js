import test from "node:test";
import assert from "node:assert/strict";
import { reportLead, PRODUCT_NAME } from "../src/harborLead.js";

const realFetch = globalThis.fetch;
const saved = { url: process.env.HARBOR_API_URL, key: process.env.ADMIN_SUMMARY_KEY };
test.afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of [["HARBOR_API_URL", saved.url], ["ADMIN_SUMMARY_KEY", saved.key]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("harborLead: posts the lead to Harbor with the product name and X-Capture-Key", async () => {
  process.env.HARBOR_API_URL = "https://harbor-api.example.test/";
  process.env.ADMIN_SUMMARY_KEY = "k".repeat(40);
  let call;
  globalThis.fetch = async (url, init) => { call = { url, init }; return { ok: true, status: 201 }; };
  const ok = await reportLead({ name: "Ana", email: "ana@acme.test", company: "Acme", notes: "3-day trial", password: "secret" });
  assert.equal(ok, true);
  assert.equal(call.url, "https://harbor-api.example.test/api/public/leads");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-Capture-Key"], "k".repeat(40));
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, { name: "Ana", email: "ana@acme.test", company: "Acme", product: PRODUCT_NAME, source: "Trial signup", notes: "3-day trial" });
  assert.ok(!call.init.body.includes("secret"));
  assert.ok(call.init.signal);
});

test("harborLead: inactive without HARBOR_API_URL (no request)", async () => {
  delete process.env.HARBOR_API_URL;
  process.env.ADMIN_SUMMARY_KEY = "k".repeat(40);
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true }; };
  assert.equal(await reportLead({ name: "A", email: "a@b.test" }), false);
  assert.equal(called, false);
});

test("harborLead: never throws or rejects when Harbor fails, and does not log the key", async () => {
  process.env.HARBOR_API_URL = "https://harbor-api.example.test";
  process.env.ADMIN_SUMMARY_KEY = "SECRETKEY".repeat(5);
  const logs = [];
  const origErr = console.error;
  console.error = (...a) => logs.push(a.join(" "));
  try {
    globalThis.fetch = async () => { throw new Error("boom"); };
    assert.equal(await reportLead({ name: "A", email: "a@b.test" }), false);
    globalThis.fetch = async () => ({ ok: false, status: 500 });
    assert.equal(await reportLead({ name: "A", email: "a@b.test" }), false);
    globalThis.fetch = () => { throw new Error("sync boom"); };
    assert.equal(await reportLead({ name: "A", email: "a@b.test" }), false);
  } finally { console.error = origErr; }
  assert.ok(logs.length >= 3);
  assert.ok(!logs.join("\n").includes("SECRETKEY"));
});

test("harborLead: falls back to company / e-mail for the lead name", async () => {
  process.env.HARBOR_API_URL = "https://h.test";
  process.env.ADMIN_SUMMARY_KEY = "k".repeat(40);
  const bodies = [];
  globalThis.fetch = async (u, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 201 }; };
  await reportLead({ email: "joe@x.test" });
  await reportLead({ email: "joe@x.test", company: "Joe Co" });
  assert.equal(bodies[0].name, "joe");
  assert.equal(bodies[1].name, "Joe Co");
});
