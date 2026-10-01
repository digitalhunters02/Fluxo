# Fluxo — tarefas

Última atualização: 2026-10-02. Marque `[x]` quando concluir (e anote a data). Quem faz: **Eu** (Claude), **Você**, ou **Juntos**.

## Pendentes

### Antes de abrir ao público
- [ ] **Você** — Testar o app no iPhone e no computador (fluxo completo: cadastro, fatura, pagamento, recorrente, lupa, modo escuro) e anotar o que estranhar.
- [ ] **Juntos** — Subir na VPS (Docker ou `node`), com disco persistente. Dockerfile ainda **não foi testado** num Docker real.
- [ ] **Juntos** — Variáveis de ambiente na VPS: `APP_URL`, `FLUXO_MULTI=1`, `FLUXO_TRUST_PROXY=1`, `FLUXO_ENCRYPTION_KEY` (guardar cópia), `FLUXO_ADMIN_EMAIL`, `FLUXO_ADMIN_PASSWORD`.
- [ ] **Você** — Contratar/configurar o provedor de e-mail (SMTP ou Resend) + `MAIL_FROM`; depois **Eu** testo o fluxo "Esqueci a senha" de verdade (conferir spam).
- [ ] **Você** — Chaves reais do Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) e webhook `https://<domínio>/api/stripe/webhook`; **Juntos** testamos assinatura, troca de plano e cancelamento.
- [ ] **Você** — Plaid: confirmar conta em Production + `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_WEBHOOK_URL`; **Juntos** testamos conexão bancária real.
- [ ] **Você** — Passar o domínio real; **Eu** troco `app.fluxo.example` na landing (EN/ES/PT) e publico.
- [ ] **Juntos** — Backup do disco da VPS (agendar) e **testar a restauração**; guardar a `FLUXO_ENCRYPTION_KEY` fora do servidor.
- [ ] **Eu** — Termos de uso e Política de privacidade (rascunho) — **Você** revisa com um advogado.
- [ ] **Juntos** — Monitoramento simples (aviso se `/healthz` cair) e rotação de logs.

### Produto
- [ ] **Eu** — Confirmação de e-mail no cadastro (evita contas falsas no Free) e apagar contas Free abandonadas (12 meses, com aviso).
- [ ] **Eu** — Enviar fatura por e-mail pelo próprio Fluxo (plano Essentials+; o envio de e-mail já existe, falta a tela e a regra de plano).
- [ ] **Você decide** — Folha de pagamento completa (depósito direto e envio de impostos): escolher parceiro (Zeal, Check, Gusto Embedded) e preço do plano.
- [ ] **Você decide** — Pagar contas e receber pagamentos de clientes (ACH/cartão): parceiro (Stripe Connect/Treasury, Dwolla…).
- [ ] **Você decide** — Acesso por aba para funcionários: hoje no Starter+; "papéis com nome" no Advanced. Manter?
- [ ] **Eu** — Autenticação em dois fatores (TOTP) para proprietários.
- [ ] **Eu** — Tabelas de impostos de 2027 (atualizar em janeiro) e conferir com um contador as datas do calendário de impostos.
- [ ] **Eu** — Conferir os preços dos concorrentes na landing a cada 3 meses (QuickBooks mudou em agosto de 2026).
- [ ] **Você decide** — Supabase/Postgres: manter SQLite (recomendado agora) ou reescrever para Postgres.
- [ ] **Eu** — Escala: mais de uma máquina exigiria banco compartilhado (só se o volume pedir).

## Concluídas
- [x] 2026-09 — App completo: contabilidade, folha (cálculo), banco (Plaid), cobrança (Stripe), 3 idiomas.
- [x] 2026-10-01 — Plano Free, multi-empresa (um banco por cliente), painel `/admin`, acesso por aba.
- [x] 2026-10-01 — Celular (barra abaixo da hora do iPhone), modo escuro, lembretes e automações, lupa global e buscas.
- [x] 2026-10-01 — Varredura de bugs: recorrentes (inclui contas a pagar), datas, fuso, centavos, CSV, segurança de comprovantes, cabeçalhos de segurança.
- [x] 2026-10-02 — Recuperação de senha por e-mail (falta só configurar o provedor).
- [x] 2026-10-02 — Dependências sem vulnerabilidades (`npm audit`: 0).
