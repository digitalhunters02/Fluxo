# Fluxo — app store package (not published)

The web app is already installable (manifest, service worker, icons, "Install app" button). This file is what is needed to wrap it
as a native app later with Capacitor. Nothing here has been installed or submitted.

- **App name:** Fluxo
- **Suggested package ID:** `network.impactdigital.fluxo`
- **Category:** Business
- **Short description (en):** Bookkeeping, banking and payroll for small businesses.
- **Long description (en):** Fluxo: bookkeeping, banking, invoices and payroll for U.S. small businesses. Works in English, Portuguese and Spanish.
- **Descrição curta (pt):** Bookkeeping, banking and payroll for small businesses (interface em português disponível).
- **Privacy policy / terms:** to be published on the product site before submitting to a store (required by Apple and Google).
- **Screenshots needed:** phone 1080×1920 (at least 4) and tablet.
- **Icon files:** `client/public/icons/` (192, 512, maskable 512, Apple touch 180).

## Wrap with Capacitor (only when the owner asks)

```bash
npm i -D @capacitor/core @capacitor/cli
npm run build            # builds client/dist
npx cap init "Fluxo" network.impactdigital.fluxo --web-dir client/dist   # config already created: capacitor.config.json
npx cap add android      # and/or: npx cap add ios
```
