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
| **Security** | scrypt passwords, four built-in roles plus custom roles, read-only accountant invitations (link by email, end access instantly), audit trail, full JSON backup |

### Payroll scope (be aware)
Fluxo **calculates and records** payroll using the 2026 IRS tables (Pub. 15-T percentage method for single / married filing jointly,
Social Security 6.2% up to $184,500, Medicare 1.45% + 0.9% additional, FUTA 0.6% on the first $7,000, flat state rate, SUTA from your state notice).
It does **not** e-file returns, make tax deposits or run direct deposit. Head-of-household withholding, local taxes and benefits
(Section 125) are not modelled. Tax tables live in `server/src/payroll.js` (`US_2026`) and must be reviewed every January.

## Plans (feature gating)
Every feature has a minimum plan, enforced on the server (HTTP 402) and in the UI (lock icons and an upgrade notice). Paid plans include unlimited users; the Free plan includes one user.

| Plan | Price | Adds |
|---|---|---|
| Free | $0 | 5 new invoices per month, unlimited estimates, expenses, bank CSV import and reconciliation, core reports, import from QuickBooks/Xero, sales tax by state, download all your data, share by link / email button / PDF, 1 user. No card needed; it has no variable cost (no bank feeds, no server-sent email) |
| Starter | $29 | Everything in Free plus unlimited invoices, credit memos, branding, unlimited users, 1 accountant (read-only) |
| Essentials | $65 | Bills, recurring invoices, time tracking, full report set, audit log, connected banks (2), AI assistant (30 uses/month) |
| Plus | $109 | Inventory, project profitability, purchase orders, budgets, classes, 1099 report, period lock, connected banks (5), AI assistant (100/month), up to 3 accountants |
| Advanced | $269 | Custom roles and permissions, batch invoicing, online payments with card and bank (ACH), unlimited accountants, AI assistant (300/month), connected banks (15) |
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
- Plan badges and "View as plan": every feature that needs a higher plan shows a small badge with the plan name and opens a friendly "Available on the X plan" window. The platform owner can open **View as plan** (top of every page) and see the whole app as any plan, without changing the account or billing. Set `OWNER_EMAILS` (comma-separated) to the owner's email(s); only a confirmed email of a company owner on that list is obeyed (the `X-Preview-Plan` header is ignored for everyone else). While previewing, plan and billing changes answer 409.
- Without `FLUXO_MULTI`, nothing changes: one company per installation.

### Deploy
`Dockerfile` and `render.yaml` are included. SQLite needs a **persistent disk** (mounted at `/data`), so use a host that offers one (Render, Fly.io, a VPS). Steps for Render:

1. New → Blueprint → pick this repository. It creates the web service and a 10 GB disk.
2. Set `APP_URL` (your public https URL) and, when you have them, the Stripe and Plaid keys.
3. Stripe: add a webhook to `https://<your-domain>/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`; copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
4. Plaid: set `PLAID_WEBHOOK_URL` to `https://<your-domain>/api/plaid/webhook`.
5. **Back up `/data`** (see *Backup and restore* below) and keep a copy of `FLUXO_ENCRYPTION_KEY` somewhere that is **not** the server.

One instance serves many small companies. Scaling beyond a single machine means moving the per-company files to a shared database, which is a separate piece of work.

## Backup and restore (all companies, tested)
**What is backed up**: every database in one `.zip` — `main.db`, `control.db` (the index of companies, login emails, Stripe/Plaid links) and one file per company — plus `manifest.json` with, for each database, the SHA-256 of the file, the SQLite integrity check, row counts and a hash of the content of every table. The copy is made with `VACUUM INTO`, so it is consistent while the server keeps running. **The encryption key is never inside the file**: keep `FLUXO_ENCRYPTION_KEY` apart (password manager). Without it, SSN/EIN, bank tokens and 2FA secrets in a restored copy will not open; the restore warns you when the key on the machine differs from the one used for the backup.

**Automatic**: on a multi-company server a backup runs once a day (first one 2 minutes after the server starts) into `FLUXO_BACKUP_DIR/_platform/` (default `/data/backups/_platform/`), keeping the newest 7 (`FLUXO_BACKUP_KEEP`). `FLUXO_BACKUP_DAILY=0` turns it off, `=1` turns it on for a single-company install. **That folder is on the same disk as the data, so it only protects against mistakes. Copy it off the server** (VPS snapshot, `rsync`/`rclone` to another machine or a bucket, or Coolify's backup of the `/data` volume) — this step is yours.
**On demand**: `docker exec <container> node server/src/backupCli.js backup` (or `npm run backup` from the repository, with the same environment variables as the server). `/admin` can also start one (`POST /api/admin/backups/run`, list with `GET /api/admin/backups`); downloading is deliberately not offered in the web panel (the admin cannot read customers' books from there), copy the files from the server instead.

**Check a backup without restoring** (do this now and then): `node server/src/backupCli.js verify /path/fluxo-backup-20261019-1530.zip` — it re-reads every database and compares checksum, integrity and content with the manifest.

**Restore, step by step** (disaster or moving to a new server):
1. Put the `.zip` on the machine and make sure the **same `FLUXO_ENCRYPTION_KEY`** is set. Use the same `FLUXO_DB` path as production (`/data/fluxo.db` in Docker); `control.db` and `tenants/` are restored next to it.
2. **Stop the server** (so nothing writes while the files are replaced).
3. `node server/src/backupCli.js restore /path/fluxo-backup-20261019-1530.zip --to /data` (with an empty `/data`). If `/data` already has databases the command refuses; add `--force` to proceed — the old files are first moved to `/data/_before-restore-<date>/` so nothing is lost.
4. The command re-opens each restored database and compares its integrity and content with the backup; it must end with "identical". Anything else: stop and do not start the server.
5. Start the server and check `/healthz` (`"db":"ok"`), sign in, open an invoice.
The command messages follow `FLUXO_CLI_LANG` (or `LANG`): `en`, `pt` or `es`. A restore moves the system back to the moment of the backup: anything created after it (sign-ups, invoices) is gone, and companies deleted by the cleanup come back with the data they had then.
**Tested**: `server/test/backup.test.js` takes a backup, wrecks the live data, restores into a new folder, compares the content hash of every table with the one in the manifest, then starts a real server on the restored folder and checks login, invoices and a decrypted SSN. A damaged `.zip` is refused.

**Monitoring**: `GET /healthz` answers `200` with `{"ok":true,"version":"1.0.0","commit":"…","db":"ok","uptime_s":…,"email":"configured|not_configured","backup":{"enabled":true,"last_at":"…","age_hours":3},"warnings":[…]}` and `503` when the database does not answer. `warnings` can contain `backup_stale` (no backup for 36 h), `backup_off` and `email_not_configured`. Point your uptime tool at it: alert on a non-200 answer or a timeout, and (optionally) on `backup_stale` in the body. Set `SOURCE_COMMIT` (Coolify does) to see the deployed commit.

## Reminders, automations, team access, themes
- **Reminders** (bell + `/reminders`): overdue invoices (with a ready-to-send email from the user's own inbox), bills and estimates coming due, low stock, bank transactions to review, the U.S. tax calendar (federal estimated tax, Form 941, W-2/1099-NEC), and your own repeating reminders. Each one can be switched on or off under Settings > Automations. Nothing is sent to anyone.
- **Daily JSON copy per company** (optional, Settings > Automations): a JSON export per company in `FLUXO_BACKUP_DIR/<company>/`, last 14 kept. This is for people who want a readable file; the **real server backup** (all databases, restorable) is described under *Backup and restore* below.
- **Team access by tab** (Starter and up): choose which tabs each person can view or change. Named reusable roles stay on Advanced.
- **Mobile**: top bar with a menu button and the Fluxo logo, kept below the iPhone clock/notch; the menu slides in from the left.
- **Dark mode**: toggle in the sidebar (or top bar on phones); follows the device until you choose.

## Password recovery
"Forgot your password?" on the sign-in page emails a one-time link (valid 1 hour, stored only as a hash, invalidates open sessions when used). The reply never reveals whether an account exists, and requests are rate-limited. It needs an email provider (`SMTP_HOST…` or `RESEND_API_KEY`, plus `MAIL_FROM`) **and** `APP_URL`; until both are set the page tells people to ask the account owner, who can set a new password under Settings > Users. In multi-company mode the link carries the company, so it only ever touches that company's database. Use `FLUXO_MAIL_FILE=/tmp/emails.jsonl` to try it locally without sending anything.

## Email confirmation and cleanup of abandoned Free accounts (hosted mode)
- **Confirm your email**: a company created on the **Free** plan (hosted mode) starts with an unconfirmed owner email. The sign-up emails a link (valid 3 days, stored only as a hash). Until it is confirmed, the Free account can create up to **3 invoices** (then the API answers `403 code:email_unconfirmed` with a plain message); everything else works. The owner sees a banner and a "Send the link again" button (one email per minute, 5 per day); the link opens `/confirm-email`. Paid sign-ups, accounts that existed before this feature, users added by the owner and accountants are never limited. **Without an email provider and `APP_URL` nothing is limited** and the sign-up page, Settings → My account and `/admin` say clearly that email is off (demo/test mode); the resend endpoint answers `503` instead of pretending.
- **Unused Free accounts are deleted after a warning**. A company is a candidate only when all of this is true: Free plan; no Stripe subscription; no employees or pay runs; no connected bank; not in a company group; not suspended; **no use for 12 months** (sign-in, API use, or anything created) and **no accounting entry dated in the last 24 months** (invoices, bills, expenses, payments, journal entries, bank transactions, payroll). A candidate gets a warning email (EN/ES/PT, in the company language) and **30 days**; signing in during that time cancels it. After the deadline, if it is still idle, the company file and its JSON copies are removed, its email can register again, and a line goes to the deletion record (company, masked owner email + short hash, counts, dates; visible in `/admin`). **Nothing is ever warned or deleted while email is not configured.** Turn the daily job on with `FLUXO_CLEANUP=1` (default off); `FLUXO_CLEANUP_IDLE_MONTHS`, `FLUXO_CLEANUP_GRACE_DAYS` and `FLUXO_CLEANUP_FISCAL_MONTHS` change the 12 / 30 / 24. `/admin` shows a preview of who would be warned or deleted and has a "Run the cleanup now" button; `GET /api/admin/cleanup` and `POST /api/admin/cleanup/run` (`{"dryRun":true}`) do the same by API.

## Emailing an invoice from Fluxo (Essentials and up)
On an issued invoice, estimate or credit memo, **Email to customer** opens a window with the recipient, the subject and the full message (in the company language, all editable), a checkbox to **attach the PDF**, and a button to download that PDF first. The link to view the document online (and, when online payments are on, the note that it can be paid there) is always added at the end. Every attempt is written to the document's **Emails sent** list (who, when, to whom, sent or not). The PDF is built by `server/src/pdf.js` (no dependency; Helvetica, EN/PT/ES labels, several pages if needed) and can also be downloaded by anyone who can see sales, on any plan: `GET /api/doc/:id/pdf`. Other endpoints: `GET /api/doc/:id/emails` (draft + history) and `POST /api/doc/:id/email` (`{to, subject, message, attach_pdf}`).
Rules: plans below Essentials see a friendly "part of the Essentials plan" window (API: `402`, `feature: email_invoices`); **without an email provider nothing is sent** and the window says "Email is not set up on this server yet" (API: `503`), with Send turned off; if the provider refuses, the attempt is recorded as *Not sent* and the user gets a plain message (the technical error stays in the server log and the history). At most 60 document emails per company per hour.

## Terms of Use and Privacy Policy (DRAFT)
Public pages `/terms` and `/privacy` (English, Portuguese, Spanish; they follow the language switch) with a visible **"DRAFT — review with a lawyer"** banner. The text is in `client/src/pages/legalText.js`, written from what Fluxo really does (plans, Stripe, Plaid, AI features, deletion of unused Free accounts, export of all data). Parts in `[brackets]` are decisions the owner or a lawyer must fill in (legal entity, refund policy, governing law, liability cap, retention periods, contact emails, hosting/email provider names). Links appear on the sign-in screen, the pricing page and the Free sign-up form; hosted sign-ups store `terms_accepted` (date and version) in the company settings. When the lawyer approves the text, change `LEGAL_VERSION` in `legalText.js` and `server/src/index.js` (a test keeps both in sync) and remove the banner.

## Growth pack (Business and Enterprise plans, integrations, online payments)

New plans: **Business** ($599/month, Stripe checkout) and **Enterprise** (from $900/month with 10 companies in the group included, +$100/month per extra company; monthly Stripe subscription: base price plus a quantity item for extra companies, kept in sync when companies join or leave the group). `FLUXO_SALES_EMAIL` shows a "Contact us" button on the pricing page.

| Feature | Minimum plan | Where |
|---|---|---|
| Import from QuickBooks / Xero (chart of accounts, customers and vendors, opening balances from a trial balance) | all plans | Settings > Import |
| Email invoices and estimates from Fluxo, with the PDF attached (needs `SMTP_*` or `RESEND_API_KEY`) | Essentials | Document page → Email to customer |
| Cash forecast (13 weeks, from open invoices/bills and recurring items) | Plus | Reports |
| API keys (`flx_live_<company>.<secret>`, `/api/v1`), signed webhooks (`X-Fluxo-Signature`) | Advanced | Settings > Integrations |
| Online payments of invoices (Stripe Connect Express, optional platform fee `CONNECT_FEE_PCT`) | Advanced | Settings > Online payments; public invoice link |
| Bill approvals with a limit and separation of duties | Business | Settings > Approvals |
| Fixed assets and monthly straight-line depreciation, disposal with gain/loss | Business | Fixed assets |
| Month-end close checklist (locks the period) | Business | Month-end close |
| Group of companies and consolidated P&L / balance sheet with intercompany elimination (hosted mode, up to 5 companies; Enterprise unlimited) | Business | Settings > Group, Reports |
| Audit log CSV export | Business | Settings > Audit log |
| Single sign-on (OpenID Connect) per company | Enterprise | Settings > Single sign-on |

Environment: `STRIPE_CONNECT_WEBHOOK_SECRET` (webhook endpoint `POST /api/stripe/connect-webhook` for connected accounts, events `checkout.session.completed` and `account.updated`), `CONNECT_FEE_PCT`, `FLUXO_SALES_EMAIL`, `SSO_STATE_SECRET` (optional), `WEBHOOK_ALLOW_INSECURE=1` only for local tests.
SSO: register `<APP_URL>/api/sso/callback` as the redirect address at the identity provider; users must already exist in Fluxo.

Deliberately not built yet (needs a partner, contract or a large change): Postgres/shared database, SOC 2, multi-currency, revenue recognition, payroll tax filing and direct deposit (payroll partner), paying bills by ACH or check, automatic sales tax rates, open-invoice import.

## Security: two-step verification, password re-confirmation, hashed sessions

- **Two-step verification (TOTP)** per user (Settings → My account): any authenticator app (Google Authenticator, Authy, 1Password…). RFC 6238, 6 digits, 30 s, one step of clock drift allowed, a code can only be used once. The secret is stored encrypted (`FLUXO_ENCRYPTION_KEY`). Eight single-use **recovery codes** are shown once and stored only as SHA-256 hashes. Disabling or regenerating them needs the password and a code. No new dependency.
- **Login**: with 2FA on, `POST /api/login` answers `401 {needs_2fa:true}` until `code` (app code or recovery code) is sent. Single sign-on users follow their identity provider.
- **Require 2FA for everyone** (owner, Settings → Security): people who have not set it up can only reach the setup screen (`403 code:2fa_setup_required` on everything else). The owner must have their own 2FA first. **Lost phone**: the owner resets that person (signs them out; they set it up again).
- **Confirm the password again** (owner, Settings → Security, off by default): paying a bill, approving/rejecting a bill, creating or revoking API keys, and creating or changing users/roles require a confirmation in the last 5 minutes (`403 code:reauth_required`; the app opens a "Confirm your password" window and repeats the action). With 2FA on it also asks for the code. Use `requireFresh` / `assertFresh` (server/src/twofa.js) on any new sensitive endpoint, such as a future "Pay" button for a payment partner.
- **Sessions are stored hashed** (SHA-256); the code the browser keeps is never in the database. Sessions from before this change keep working and are converted on first use.
- Not included yet: password strength rules beyond 8 characters, per-user/daily payment limits, e-mail alerts on payments or vendor bank-detail changes.
