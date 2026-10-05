// Tells Harbor (Impact Digital's admin CRM) about a new trial signup so it shows up
// under Leads with the product name. Fire-and-forget: a signup must never wait on,
// or fail because of, Harbor.
//   - Active only when HARBOR_API_URL is set (e.g. https://harbor-api.example.com).
//   - Authenticates with this product's ADMIN_SUMMARY_KEY (the same secret Harbor
//     already uses to read the product) in the X-Capture-Key header.
//   - 5 s timeout; errors are logged without the URL, key or payload.
//   - Never sends passwords or tokens: only name, e-mail, company and plan/trial notes.
const PRODUCT_NAME = "Fluxo";

function reportLead(lead = {}) {
  try {
    const base = String(process.env.HARBOR_API_URL || "").trim().replace(/\/+$/, "");
    const key = process.env.ADMIN_SUMMARY_KEY;
    const fetchFn = globalThis.fetch;
    if (!base || !key || typeof fetchFn !== "function") return Promise.resolve(false);
    const email = String(lead.email || "").trim();
    const company = String(lead.company || "").trim();
    const name = String(lead.name || "").trim() || company || email.split("@")[0];
    if (!name) return Promise.resolve(false);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    if (timer.unref) timer.unref();
    return fetchFn(`${base}/api/public/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Capture-Key": key },
      body: JSON.stringify({
        name,
        email,
        company,
        product: PRODUCT_NAME,
        source: "Trial signup",
        notes: String(lead.notes || "").slice(0, 500),
      }),
      signal: ctrl.signal,
    })
      .then((res) => {
        if (!res.ok) console.error(`[harbor-lead] Harbor answered HTTP ${res.status}`);
        return res.ok;
      })
      .catch((err) => {
        console.error(`[harbor-lead] could not reach Harbor: ${err && err.name === "AbortError" ? "timeout" : (err && err.message) || "error"}`);
        return false;
      })
      .finally(() => clearTimeout(timer));
  } catch (err) {
    console.error(`[harbor-lead] skipped: ${(err && err.message) || "error"}`);
    return Promise.resolve(false);
  }
}

export { reportLead, PRODUCT_NAME };
