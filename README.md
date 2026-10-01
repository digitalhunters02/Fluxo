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
| **Sales** | Invoices, estimates (convert to invoice), recurring invoices, partial payments, public share link, per-line sales tax, customer statements |
| **Purchases** | Bills, expenses with receipt attachment, vendors, 1099 contractor flag and report |
| **Banking** | CSV statement import (U.S. date and number formats), auto-categorization (rules + learning), matching with existing entries, reconciliation, transfers, credit cards |
| **Accounting** | Real double-entry: every document posts balanced entries; editable chart of accounts, general journal, ledger by account |
| **Payroll (U.S.)** | Employees (W-4 status, credits, state rate, deductions), pay runs with live preview, overtime, bonuses at the 22% supplemental rate, pay stubs, payroll liabilities and tax payments, Form 941 quarterly summary, W-2 box summary, payroll summary |
| **Inventory** | Average-cost products, automatic COGS on sale, adjustments, low-stock alerts |
| **Projects** | Billable time, one-click invoicing, profit per project |
| **Reports** | P&L (with prior period), balance sheet, cash flow, A/R and A/P aging, sales by customer, expenses by category/vendor, sales tax, inventory valuation, trial balance. CSV and PDF |
| **Security** | scrypt passwords, four roles (owner, accountant, sales, read-only), audit trail, full JSON backup |

### Payroll scope (be aware)
Fluxo **calculates and records** payroll using the 2026 IRS tables (Pub. 15-T percentage method for single / married filing jointly,
Social Security 6.2% up to $184,500, Medicare 1.45% + 0.9% additional, FUTA 0.6% on the first $7,000, flat state rate, SUTA from your state notice).
It does **not** e-file returns, make tax deposits or run direct deposit. Head-of-household withholding, local taxes and benefits
(Section 125) are not modelled. Tax tables live in `server/src/payroll.js` (`US_2026`) and must be reviewed every January.

### Pricing on the landing page
Proposed plans (USD/month, unlimited users): Starter $29, Essentials $65, Plus $109, Payroll add-on $35 + $5/employee —
22–30% under QuickBooks Online (Simple Start $38, Essentials $85, Plus $140; Payroll Core $50 + $6.50). Billing and plan limits
are **not implemented in the app**.

## Languages
UI strings use English keys (`t('Invoices')`). Portuguese and Spanish live in `client/src/locales/` and are generated from
`tools/i18n-legacy.txt` and `tools/i18n-extra.txt` by `npm run i18n:build`. `npm run i18n:check` fails if any string is untranslated.
Server errors are English and translated in the browser. Chart-of-accounts names, invoice prefixes and sample data follow the language chosen at setup.
