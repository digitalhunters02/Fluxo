# Fluxo — tarefas

Última atualização: 2026-10-19. Marque `[x]` quando concluir (e anote a data). Quem faz: **Eu** (Claude), **Você**, ou **Juntos**.

## Pendentes

### Antes de abrir ao público
- [ ] **Você** — Testar o app no iPhone e no computador (fluxo completo: cadastro, fatura, pagamento, recorrente, lupa, modo escuro) e anotar o que estranhar.
- [ ] **Juntos** — Subir na VPS (Docker ou `node`), com disco persistente. Dockerfile ainda **não foi testado** num Docker real.
- [ ] **Juntos** — Variáveis de ambiente na VPS: `APP_URL`, `FLUXO_MULTI=1`, `FLUXO_TRUST_PROXY=1`, `FLUXO_ENCRYPTION_KEY` (guardar cópia **fora** do servidor), `FLUXO_ADMIN_EMAIL`, `FLUXO_ADMIN_PASSWORD`. Novas (2026-10-19): `SOURCE_COMMIT` (a Coolify já define; aparece no `/healthz`), `FLUXO_BACKUP_DIR`/`FLUXO_BACKUP_KEEP` (opcionais) e, só **depois** que o e-mail funcionar, `FLUXO_CLEANUP=1` (liga a limpeza automática de contas Free paradas).
- [ ] **Você** — Contratar/configurar o provedor de e-mail (SMTP ou Resend) + `MAIL_FROM`; depois **Eu** testo de verdade (conferir spam): "Esqueci a senha", confirmação de e-mail do cadastro, fatura por e-mail com PDF e o aviso de conta parada. **Sem isso essas quatro coisas ficam desligadas** (o app avisa com clareza, não trava nada e nunca finge que enviou).
- [ ] **Você** — Chaves reais do Stripe (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) e webhook `https://<domínio>/api/stripe/webhook`; **Juntos** testamos assinatura, troca de plano e cancelamento.
- [ ] **Você** — Plaid: confirmar conta em Production + `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_WEBHOOK_URL`; **Juntos** testamos conexão bancária real.
- [ ] **Você** — Passar o domínio real; **Eu** troco `app.fluxo.example` na landing (EN/ES/PT) e publico.
- [ ] **Juntos** — Backup: o Fluxo já faz sozinho um `.zip` diário de todos os bancos (guarda 7) em `/data/backups/_platform/` e tem comando de restauração testado (README → *Backup and restore*). **Falta você:** copiar essa pasta para FORA do servidor (snapshot da VPS, rclone/S3 ou backup do volume na Coolify), guardar a `FLUXO_ENCRYPTION_KEY` fora do servidor e **repetir uma restauração de teste na VPS** (5 minutos, passo a passo no README).
- [ ] **Você** — Revisar os **rascunhos** dos Termos de Uso e da Política de Privacidade (`/terms` e `/privacy`, EN/PT/ES, feitos em 2026-10-19) com um advogado e preencher os trechos entre [colchetes] (razão social, estado da lei, reembolso, limite de responsabilidade, prazos de guarda, e-mails de contato, nomes de hospedagem/e-mail). Depois **Eu** tiro o aviso de rascunho.
- [ ] **Juntos** — Monitoramento simples: o `/healthz` já responde versão, banco ok, e-mail e idade do último backup (503 se o banco não responder). **Falta você:** apontar um monitor (UptimeRobot, Uptime Kuma ou o da Coolify) para `https://<domínio>/healthz` com aviso por e-mail/WhatsApp; e a rotação de logs (Docker/Coolify).

### Produto
- [ ] **Você decide** — Folha de pagamento completa (depósito direto e envio de impostos): escolher parceiro (Zeal, Check, Gusto Embedded) e preço do plano.
- [ ] **Você decide** — Pagar contas e receber pagamentos de clientes (ACH/cartão): parceiro (Stripe Connect/Treasury, Dwolla…).
- [ ] **Você decide** — Acesso por aba para funcionários: hoje no Starter+; "papéis com nome" no Advanced. Manter?
- [ ] **Eu** — Tabelas de impostos de 2027: as de 2026 estão em `server/src/payroll.js` (`US_2026`). Só dá para atualizar depois que o IRS publicar a Pub. 15-T de 2027 (normalmente em dezembro); atualizo em janeiro.
- [ ] **Você** — Conferir com um contador as datas do calendário de impostos (lembretes) e as tabelas de 2026.
- [ ] **Você decide** — Contas Free **criadas antes de 2026-10-19** nasceram com o complemento de folha de pagamento ligado (erro corrigido só para contas novas). Desligar nas antigas (elas perdem a tela de folha; os dados ficam)? Posso fazer com um comando único.
- [ ] **Juntos** — Ligar a limpeza de contas Free paradas (`FLUXO_CLEANUP=1`) só depois do e-mail funcionando e dos Termos revisados; antes, olhar a prévia em `/admin` → "Unused free accounts".
- [ ] **Eu** — Conferir os preços dos concorrentes na landing a cada 3 meses (QuickBooks mudou em agosto de 2026).
- [ ] **Você decide** — Supabase/Postgres: manter SQLite (recomendado agora) ou reescrever para Postgres.
- [ ] **Eu** — Escala: mais de uma máquina exigiria banco compartilhado (só se o volume pedir).

## Concluídas
- [x] 2026-10-19 — **Confirmação de e-mail no cadastro Free**: link de 3 dias, reenvio (1/min, 5/dia), faixa no app, conta não confirmada cria até 3 faturas; quem paga, quem já existia e quem o dono cria nunca são limitados; sem e-mail configurado nada trava e o app avisa (cadastro, Minha conta e `/admin`).
- [x] 2026-10-19 — **Limpeza de contas Free abandonadas**: 12 meses sem uso + sem plano pago/folha/banco/grupo + sem lançamento dos últimos 24 meses → aviso por e-mail (EN/PT/ES) e 30 dias; entrar cancela; só então apaga e grava o registro (empresa, e-mail mascarado, contagens). Nunca apaga sem poder avisar. Desligada por padrão (`FLUXO_CLEANUP=1`), com prévia e "rodar agora" em `/admin`.
- [x] 2026-10-19 — **Enviar fatura por e-mail pelo Fluxo** (Essentials+): janela com assunto e texto editáveis, PDF anexo (feito dentro do Fluxo, sem biblioteca), baixar o PDF, histórico de envios na fatura (enviado/não enviado), mensagem amigável nos planos menores e aviso "e-mail ainda não configurado" (nunca finge que enviou).
- [x] 2026-10-19 — **Rascunho dos Termos de Uso e da Política de Privacidade** em EN/PT/ES, marcado "revisar com advogado" (falta a revisão — ver Pendentes).
- [x] 2026-10-19 — **Backup e restauração**: `.zip` com todos os bancos + manifesto (checksum, integridade, hash do conteúdo), diário com rodízio de 7, comandos `backup` / `verify` / `restore`, restauração **testada de verdade** (dados voltam idênticos; servidor sobe com a pasta restaurada) e `/healthz` útil para monitoramento. Falta copiar para fora do servidor (ver Pendentes).
- [x] 2026-10-19 — Correção: conta Free nova (hospedado) não nasce mais com o complemento de folha de pagamento ligado.
- [x] 2026-10-10 — **Autenticação em dois fatores (TOTP)** com códigos de recuperação, "2FA obrigatório" para a empresa e confirmação de senha em ações sensíveis (já estava pronto; só faltava marcar aqui).
- [x] 2026-09 — App completo: contabilidade, folha (cálculo), banco (Plaid), cobrança (Stripe), 3 idiomas.
- [x] 2026-10-01 — Plano Free, multi-empresa (um banco por cliente), painel `/admin`, acesso por aba.
- [x] 2026-10-01 — Celular (barra abaixo da hora do iPhone), modo escuro, lembretes e automações, lupa global e buscas.
- [x] 2026-10-01 — Varredura de bugs: recorrentes (inclui contas a pagar), datas, fuso, centavos, CSV, segurança de comprovantes, cabeçalhos de segurança.
- [x] 2026-10-02 — Recuperação de senha por e-mail (falta só configurar o provedor).
- [x] 2026-10-02 — Dependências sem vulnerabilidades (`npm audit`: 0).
