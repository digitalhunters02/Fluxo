// owner.js — o DONO da plataforma e o "ver como plano".
// PARA QUE SERVE: reconhece a(s) conta(s) do dono da plataforma (variável de ambiente OWNER_EMAILS, e-mails separados por vírgula)
// e guarda, durante UMA requisição em modo "ver como plano", o plano visto. Nada é gravado: o plano real da empresa nunca muda.
// O cabeçalho X-Preview-Plan só é obedecido para quem é dono (e-mail na lista, confirmado, papel de dono da empresa);
// para qualquer outra conta ele é ignorado.
import { AsyncLocalStorage } from 'node:async_hooks';

/** { plan, userId } durante uma requisição em modo "ver como plano". */
export const previewStore = new AsyncLocalStorage();

export const ownerEmails = () => new Set(String(process.env.OWNER_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
export const isOwnerEmail = (email) => ownerEmails().has(String(email || '').trim().toLowerCase());
/** Plano visto agora (null fora do modo prévia). */
export const previewPlanNow = () => previewStore.getStore()?.plan || null;

/** Conta de dono de verdade: e-mail na lista + e-mail confirmado + papel de dono. Evita que alguém se cadastre com o e-mail do dono. */
export const isPlatformOwner = (user) => !!(user && user.role === 'owner' && user.email_verified_at && isOwnerEmail(user.email));

/**
 * Middleware (depois do login): lê X-Preview-Plan e o aplica só para o dono. `validPlans` = chaves dos planos à venda.
 * req.previewPlan fica com o plano visto; o resto do servidor lê previewPlanNow() (veja currentPlan() em plans.js).
 */
export const applyPreview = (validPlans) => (req, _res, next) => {
  const want = String(req.headers['x-preview-plan'] || '').trim().toLowerCase();
  if (want && req.user && validPlans.includes(want) && isPlatformOwner(req.user)) {
    req.previewPlan = want;
    return previewStore.run({ plan: want, userId: req.user.id }, next);
  }
  return next();
};

/** Recusa (409) ações que mexem em plano, assinatura ou cobrança enquanto o dono está vendo como outro plano. */
export const blockInPreview = (req, res, next) => {
  if (!req.previewPlan) return next();
  res.status(409).json({ error: 'You are viewing another plan. Go back to your own plan to change the subscription, billing or plan.', code: 'preview_readonly' });
};
