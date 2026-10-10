// Simulador mínimo da API do Stripe (preços, checkout, assinaturas, portal) para testes e demonstração local.
import http from 'node:http';

export function createStripeMock(secretKey = 'sk_test_123') {
  const S = { prices: [], sessions: {}, subs: {}, calls: [], n: 0, portal: 0, accounts: {} };
  const nest = (pairs) => {
    const out = {};
    for (const [k, v] of pairs) {
      const path = k.match(/[^[\]]+/g); let o = out;
      path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else { o[p] = o[p] ?? (/^\d+$/.test(path[i + 1]) ? [] : {}); o = o[p]; } });
    }
    return out;
  };
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const u = new URL(req.url, 'http://x');
      const params = nest([...(req.method === 'GET' ? u.searchParams : new URLSearchParams(b)).entries()]);
      S.calls.push({ method: req.method, path: u.pathname, params, auth: req.headers.authorization, account: req.headers['stripe-account'] });
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      // controle de teste: marca uma sessão de checkout como paga e cria a assinatura correspondente
    const done = u.pathname.match(/^\/__complete\/(\w+)$/);
    if (done && S.sessions[done[1]]) {
      const sess = S.sessions[done[1]], items = Object.values(sess.params.line_items || {});
      const subId = `sub_${++S.n}`;
      S.subs[subId] = { id: subId, customer: 'cus_e2e', status: 'active', current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, cancel_at_period_end: false,
        items: { data: items.map((it, i) => ({ id: `si_${S.n}_${i}`, quantity: Number(it.quantity || 1), price: S.prices.find((p) => p.id === it.price) })) } };
      Object.assign(sess, { status: 'complete', payment_status: 'paid', customer: 'cus_e2e', subscription: subId, customer_details: { email: sess.params.customer_email || 'buyer@example.com' } });
      return send(200, { ok: true, subscription: subId });
    }
    if (req.headers.authorization !== `Bearer ${secretKey}`) return send(401, { error: { message: 'bad key' } });
      if (req.method === 'GET' && u.pathname === '/v1/prices') return send(200, { data: S.prices.filter((p) => p.lookup_key === [].concat(params.lookup_keys || [])[0] && p.active) });
      if (req.method === 'POST' && u.pathname === '/v1/accounts') { const id = `acct_${++S.n}`; S.accounts[id] = { id, charges_enabled: false, details_submitted: false, payouts_enabled: false, params }; return send(200, S.accounts[id]); }
      let am = u.pathname.match(/^\/v1\/accounts\/(\w+)$/);
      if (am && req.method === 'GET') return S.accounts[am[1]] ? send(200, S.accounts[am[1]]) : send(404, { error: { message: 'no such account' } });
      if (req.method === 'POST' && u.pathname === '/v1/account_links') return send(200, { url: `https://connect.stripe.test/setup/${params.account}`, account: params.account });
      if (req.method === 'POST' && u.pathname === '/v1/prices') {
        if (params.transfer_lookup_key === 'true') S.prices.filter((p) => p.lookup_key === params.lookup_key).forEach((p) => { p.lookup_key = null; p.active = false; });
        const p = { id: `price_${++S.n}`, unit_amount: Number(params.unit_amount), lookup_key: params.lookup_key, active: true, recurring: params.recurring };
        S.prices.push(p); return send(200, p);
      }
      if (req.method === 'POST' && u.pathname === '/v1/checkout/sessions') { const id = `cs_test_${++S.n}`; S.sessions[id] = { id, params, account: req.headers['stripe-account'], url: `https://checkout.stripe.test/c/${id}`, status: 'open' }; return send(200, S.sessions[id]); }
      let m = u.pathname.match(/^\/v1\/checkout\/sessions\/(\w+)$/);
      if (m) return S.sessions[m[1]] ? send(200, S.sessions[m[1]]) : send(404, { error: { message: 'no such session' } });
      m = u.pathname.match(/^\/v1\/subscriptions\/(\w+)$/);
      if (m && req.method === 'GET') return S.subs[m[1]] ? send(200, S.subs[m[1]]) : send(404, { error: { message: 'no such subscription' } });
      if (m && req.method === 'POST') {
        const sub = S.subs[m[1]]; const items = Object.values(params.items || {});
        for (const it of items) {
          if (it.deleted === 'true') sub.items.data = sub.items.data.filter((x) => x.id !== it.id);
          else if (it.id && it.price) { const x = sub.items.data.find((y) => y.id === it.id); x.price = S.prices.find((p) => p.id === it.price); }
          else if (it.id && it.quantity) sub.items.data.find((y) => y.id === it.id).quantity = Number(it.quantity);
          else if (it.price) sub.items.data.push({ id: `si_${++S.n}`, price: S.prices.find((p) => p.id === it.price), quantity: Number(it.quantity || 1) });
        }
        return send(200, sub);
      }
      if (req.method === 'POST' && u.pathname === '/v1/billing_portal/sessions') { S.portal++; return send(200, { url: `https://billing.stripe.test/p/${S.portal}`, customer: params.customer, return_url: params.return_url }); }
      send(404, { error: { message: `unknown ${u.pathname}` } });
    });
  });

  return { server: mock, S };
}
