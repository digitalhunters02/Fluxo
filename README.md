# Fluxo — accounting and payroll for U.S. small businesses

A complete bookkeeping, banking and payroll app (a QuickBooks alternative) with **unlimited users**. The interface is available in
**English (default), Spanish and Portuguese**. Standalone project, unrelated to anvil-crm.

## Run it

Requires Node 22.5+ (it uses Node's built-in SQLite, so there are no native dependencies).

```bash
npm install
npm run build          # compile the frontend
npm start              # http://localhost:4000
```

On first launch you create the owner account, choose the language and currency (USD by default) and can load six months of sample data.
From the terminal: `npm run seed` (creates `demo@fluxo.app` / `demo12345`; `LANG_CODE=es npm run seed` for another language).

Development with reload: `npm run dev` (API on :4000, frontend on :5173). Tests: `npm test`. Translations: `npm run i18n:check`.
Environment: `PORT`, `FLUXO_DB` (SQLite file path, default `server/data/fluxo.db`).

## What it does

| Area | Features |
|---|---|
| **Sales** | Invoices, estimates (convert to invoice, customers accept online with a typed signature), credit memos (apply to invoices or refund), sales receipts, recurring and batch invoices, partial payments, public share link, logo and brand color, per-line sales tax, customer statements |
| **Purchases** | Bills, purchase orders (convert to bill), expenses with receipt attachment (camera capture on phones), vendors, 1099 contractor flag and report |
| **Banking** | CSV statement import (U.S. date and number formats), auto-categorization (rules + learning), matching with existing entries, reconciliation, transfers, credit cards |
| **Connected banks (Plaid)** | Connect bank accounts with Plaid Link: live balances, history, who paid you, spending by category and top merchants; linked accounts feed the reconciliation queue with category suggestions; webhooks keep everything in sync |
| **Accounting** | Real double-entry: every document posts balanced entries; editable chart of accounts, general journal, ledger by account, budgets, classes, closing date (period lock) |
| **Payroll (U.S.)** | Employees (W-4 status, credits, state rate, deductions), pay runs with live preview, overtime, bonuses at the 22% supplemental rate, pay stubs, payroll liabilities and tax payments, Form 941 quarterly summary, W-2 box summary, payroll summary |
| **Inventory** | Average-cost products, automatic COGS on sale, adjustments, low-stock alerts |
| **Projects** | Billable time, one-click invoicing, profit per project |
| **Reports** | P&L (with prior period), P&L by class, budget vs actual, balance sheet, cash flow, A/R and A/P aging, sales by customer, expenses by category/vendor, sales tax, inventory valuation, trial balance. CSV and PDF |
| **Security** | scrypt passwords, four built-in roles plus custom roles, audit trail, full JSON backup |

### Payroll scope (be aware)
Fluxo **calculates and records** payroll using the 2026 IRS tables (Pub. 15-T percentage method for single / married filing jointly,
Social Security 6.2% up to $184,500, Medicare 1.45% + 0.9% additional, FUTA 0.6% on the first $7,000, flat state rate, SUTA from your state notice).
It does **not** e-file returns, make tax deposits or run direct deposit. Head-of-household withholding, local taxes and benefits
(Section 125) are not modelled. Tax tables live in `server/src/payroll.js` (`US_2026`) and must be reviewed every January.

## Plans (feature gating)
Every feature has a minimum plan, enforced on the server (HTTP 402) and in the UI (lock icons and an upgrade notice). Paid plans include unlimited users; the Free plan includes one user.

| Plan | Price | Adds |
|---|---|---|
| Free | $0 | 5 new invoices per month, unlimited estimates, expenses, bank CSV import and reconciliation, core reports, share by link / email button / PDF, 1 user. No card needed; it has no variable cost (no bank feeds, no server-sent email) |
| Starter | $29 | Everything in Free plus unlimited invoices, credit memos, branding, unlimited users |
| Essentials | $65 | Bills, recurring invoices, time tracking, full report set, audit log, connected banks (2) |
| Plus | $109 | Inventory, project profitability, purchase orders, budgets, classes, 1099 report, period lock, connected banks (5) |
| Advanced | $269 | Custom roles and permissions, batch invoicing, connected banks (15) |
| Payroll add-on | $35 + $5/employee | U.S. payroll (calculation and records) |

QuickBooks Online list prices for comparison: $38 / $85 / $140 / $340; payroll Core $50 + $6.50. Feature map: `server/src/plans.js`.

## Billing with Stripe
Customers pick a plan on the landing page (`/pricing?plan=plus`), pay on Stripe Checkout and land on `/welcome` to create their owner login — the server
confirms the paid session with Stripe before creating the account. Upgrades, downgrades (prorated), the payroll add-on (base + per-employee seats that follow
your headcount), card updates, invoices and cancellation happen inside Settings → Plan (in-app changes plus the Stripe customer portal).
Prices are created in Stripe on demand by lookup key (`fluxo_plan_<plan>_monthly`, `fluxo_payroll_base_monthly`, `fluxo_payroll_seat_monthly`), so there is
nothing to set up in the dashboard except the webhook: point an endpoint at `POST /api/stripe/webhook` with events `checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`. Signatures are verified (HMAC-SHA256, 5-minute tolerance, idempotent).
Past-due subscriptions keep their plan and show a banner; a canceled subscription drops to Free (the paid plan runs until the end of the paid period). To try it without a Stripe account:
`node server/test/mocks/run-stripe.js` and set `STRIPE_API_BASE=http://127.0.0.1:12111`.

## Connected banks with Plaid
Set `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV` and (recommended) `PLAID_WEBHOOK_URL=…/api/plaid/webhook`. The browser never sees the secret: the server creates
the Link token, exchanges the public token and stores the access token encrypted (AES-256-GCM, key from `FLUXO_ENCRYPTION_KEY`). Transactions come from
`/transactions/sync` with a cursor; webhooks are verified with Plaid's ES256 JWT and the body hash. Without keys (and outside production) a **demo bank** with
made-up data lets you try the whole experience. Connections per plan: Essentials 2, Plus 5, Advanced 15.

**One company per installation.** Billing, plans and bank connections belong to the company stored in this database. Selling to many customers from one
landing page needs tenant isolation (a database per customer behind subdomains) — that is the next architectural step, not built yet.

## Deliberately not built (needs a partner, license or contract)
Online card/ACH payments from customers (Stripe Connect), paying bills by ACH or check, payroll direct deposit and tax e-filing,
1099 e-filing, automatic sales-tax rates, multi-currency, email delivery of invoices and reminders (needs an email provider).

## Languages
UI strings use English keys (`t('Invoices')`). Portuguese and Spanish live in `client/src/locales/` and are generated from
`tools/i18n-legacy.txt` and `tools/i18n-extra.txt` by `npm run i18n:build`. `npm run i18n:check` fails if any string is untranslated.
Server errors are English and translated in the browser. Chart-of-accounts names, invoice prefixes and sample data follow the language chosen at setup.

## Hosting it for many customers (multi-company mode)

Set `FLUXO_MULTI=1` and every company gets its **own SQLite file** (`<data>/tenants/<slug>.db`), so data is isolated by construction. A small control database (`<data>/control.db`) only indexes companies, login emails and Stripe/Plaid ids.

- Sign-up is public: **Start free** creates a company with no card; paid plans go through Stripe Checkout and the account is created after payment. Without a confirmed payment, a new company is always on the Free plan.
- Login is email + password. The session token is `company.token`, so one domain serves everyone (no wildcard DNS). An email belongs to one company.
- Public invoice links carry the company: `/p/<company>.<token>`.
- Stripe and Plaid webhooks are routed to the right company through the control database. Recurring invoices and bank syncs run for each company.
- Platform admin: set `FLUXO_ADMIN_EMAIL` and `FLUXO_ADMIN_PASSWORD` (12+ characters) and open `/admin` to see every company, its plan and usage, and to suspend or reactivate one. There is no impersonation: you cannot read a customer's books from there.
- Without `FLUXO_MULTI`, nothing changes: one company per installation.

### Deploy
`Dockerfile` and `render.yaml` are included. SQLite needs a **persistent disk** (mounted at `/data`), so use a host that offers one (Render, Fly.io, a VPS). Steps for Render:

1. New → Blueprint → pick this repository. It creates the web service and a 10 GB disk.
2. Set `APP_URL` (your public https URL) and, when you have them, the Stripe and Plaid keys.
3. Stripe: add a webhook to `https://<your-domain>/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`; copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Plaid: set `PLAID_WEBHOOK_URL` to `https://<your-domain>/api/plaid/webhook`.
5. **Back up `/data`** (disk snapshots) and keep a copy of `FLUXO_ENCRYPTION_KEY`.

One instance serves many small companies. Scaling beyond a single machine means moving the per-company files to a shared database, which is a separate piece of work.

## Reminders, automations, team access, themes
- **Reminders** (bell + `/reminders`): overdue invoices (with a ready-to-send email from the user's own inbox), bills and estimates coming due, low stock, bank transactions to review, the U.S. tax calendar (federal estimated tax, Form 941, W-2/1099-NEC), and your own repeating reminders. Each one can be switched on or off under Settings > Automations. Nothing is sent to anyone.
- **Daily backup**: optional, a JSON copy per company in `FLUXO_BACKUP_DIR`, last 14 kept.
- **Team access by tab** (Starter and up): choose which tabs each person can view or change. Named reusable roles stay on Advanced.
- **Mobile**: top bar with a menu button and the Fluxo logo, kept below the iPhone clock/notch; the menu slides in from the left.
- **Dark mode**: toggle in the sidebar (or top bar on phones); follows the device until you choose.
