## Importar de foto (IA) e uso extra

Em **Customers** e **Vendors** há o botão "Import from photo": tire uma foto ou cole um print (cartão de visita, conversa, nota); a IA preenche os campos e a pessoa
**confere e edita antes de salvar** (nada é salvo sozinho e a imagem nunca é gravada: só contagem e tokens no banco da empresa). Limite por mês e por empresa:
Essentials 100 · Plus 250 · Advanced 500 · Business 1.500 · Enterprise 5.000 (Free e Starter não incluem); empresa nova +100 nos primeiros 30 dias.
Depois do limite, o dono aprova um teto mensal (US$ 10/25/50/100) e cada leitura extra (US$ 0,10) vira **uma linha** na próxima fatura do Stripe da própria empresa
(settings `stripe_customer_id`). Um banco por empresa = uso e crédito por empresa. Usa `ANTHROPIC_API_KEY`. Rotas: `/api/photo-import`.
Despesas por foto ficam para depois (exigem escolher conta contábil). Testes: `server/test/photoImport.test.js` e `server/e2e/photo.e2e.mjs` (precisa de `npm run build`).
