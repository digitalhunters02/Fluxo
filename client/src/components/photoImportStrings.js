// src/lustre/photoImportStrings.js — textos do "Importar de foto". Cada chave: [en, pt, es].
const S = {
  "photo.button": ["Import from photo", "Importar de foto", "Importar desde una foto"],
  "photo.title.clients": ["Import clients from a photo", "Importar clientes de uma foto", "Importar clientes desde una foto"],
  "photo.title.expense": ["Import an expense from a photo", "Importar despesa de uma foto", "Importar un gasto desde una foto"],
  "photo.intro.clients": ["Take a photo or paste a screenshot (WhatsApp chat, form, business card, contact list). The AI fills in the fields and you check everything before saving.", "Tire uma foto ou cole um print (conversa de WhatsApp, formulário, cartão de visita, lista de contatos). A IA preenche os campos e você confere tudo antes de salvar.", "Toma una foto o pega una captura (chat de WhatsApp, formulario, tarjeta de presentación, lista de contactos). La IA rellena los campos y tú revisas todo antes de guardar."],
  "photo.intro.expense": ["Take a photo of a receipt or bill, or paste a screenshot. The AI reads the total, date and store and you check everything before saving.", "Tire uma foto de um recibo ou conta, ou cole um print. A IA lê o total, a data e a loja e você confere tudo antes de salvar.", "Toma una foto de un recibo o factura, o pega una captura. La IA lee el total, la fecha y la tienda y tú revisas todo antes de guardar."],
  "photo.choose": ["Take photo or choose image", "Tirar foto ou escolher imagem", "Tomar foto o elegir imagen"],
  "photo.paste": ["You can also paste a screenshot here (Ctrl+V / Cmd+V).", "Você também pode colar um print aqui (Ctrl+V / Cmd+V).", "También puedes pegar una captura aquí (Ctrl+V / Cmd+V)."],
  "photo.reading": ["Reading the image…", "Lendo a imagem…", "Leyendo la imagen…"],
  "photo.privacy": ["The photo is read by AI to fill the fields and is not stored. Nothing is saved until you press Save.", "A foto é lida pela IA para preencher os campos e não é guardada. Nada é salvo até você apertar Salvar.", "La foto es leída por la IA para rellenar los campos y no se guarda. No se guarda nada hasta que pulses Guardar."],
  "photo.usage": ["{used} of {limit} photo reads used this month", "{used} de {limit} leituras por foto usadas neste mês", "{used} de {limit} lecturas por foto usadas este mes"],
  "photo.usageDemo": ["{used} of {limit} photo reads used in the free trial", "{used} de {limit} leituras por foto usadas no teste grátis", "{used} de {limit} lecturas por foto usadas en la prueba gratis"],
  "photo.review": ["Check what the AI found", "Confira o que a IA encontrou", "Revisa lo que encontró la IA"],
  "photo.reviewHint": ["Fix anything that is wrong. Fields marked in yellow were hard to read. Untick the ones you do not want.", "Corrija o que estiver errado. Os campos em amarelo ficaram difíceis de ler. Desmarque os que você não quer.", "Corrige lo que esté mal. Los campos en amarillo fueron difíciles de leer. Desmarca los que no quieras."],
  "photo.checkField": ["Check this one", "Confira este", "Revisa este"],
  "photo.none": ["I did not find anything to import in this image.", "Não encontrei nada para importar nesta imagem.", "No encontré nada para importar en esta imagen."],
  "photo.tryAnother": ["Try another image", "Tentar outra imagem", "Probar otra imagen"],
  "photo.save": ["Save {n}", "Salvar {n}", "Guardar {n}"],
  "photo.saving": ["Saving…", "Salvando…", "Guardando…"],
  "photo.saved": ["Saved {n}.", "Salvos {n}.", "Guardados {n}."],
  "photo.savedSome": ["Saved {a}. {b} could not be saved — they are still here, fix and try again.", "Salvos {a}. {b} não puderam ser salvos — continuam aqui, corrija e tente de novo.", "Guardados {a}. {b} no se pudieron guardar — siguen aquí, corrige e inténtalo de nuevo."],
  "photo.missingName": ["Name is required", "Nome é obrigatório", "El nombre es obligatorio"],
  "photo.missingAmount": ["Amount is required", "Valor é obrigatório", "El monto es obligatorio"],
  "photo.err.ai_not_configured": ["Photo reading is not connected on this server yet. Ask your administrator.", "A leitura por foto ainda não está ligada neste servidor. Fale com o administrador.", "La lectura por foto aún no está conectada en este servidor. Habla con tu administrador."],
  "photo.err.plan_limit": ["Photo reading is not available on your plan or you used all your reads. Upgrade your plan to import more.", "A leitura por foto não está no seu plano ou você usou todas as leituras. Faça upgrade para importar mais.", "La lectura por foto no está en tu plan o usaste todas las lecturas. Mejora tu plan para importar más."],
  "photo.err.bad_image": ["That file is not a valid image (JPEG, PNG, GIF or WebP).", "Esse arquivo não é uma imagem válida (JPEG, PNG, GIF ou WebP).", "Ese archivo no es una imagen válida (JPEG, PNG, GIF o WebP)."],
  "photo.err.too_large": ["The image is too large (max 8 MB).", "A imagem é grande demais (máximo 8 MB).", "La imagen es demasiado grande (máximo 8 MB)."],
  "photo.err.ai_failed": ["I could not read the image right now. Try again in a moment.", "Não consegui ler a imagem agora. Tente de novo em instantes.", "No pude leer la imagen ahora. Inténtalo de nuevo en un momento."],
  "photo.warn.80": ["You have used {used} of {limit} photo reads included in your plan this month.", "Você usou {used} de {limit} leituras por foto incluídas no seu plano neste mês.", "Usaste {used} de {limit} lecturas por foto incluidas en tu plan este mes."],
  "photo.warn.100": ["You used all {limit} photo reads included in your plan this month.", "Você usou todas as {limit} leituras por foto incluídas no seu plano neste mês.", "Usaste las {limit} lecturas por foto incluidas en tu plan este mes."],
  "photo.warn.credit_80": ["You have used US$ {spent} of your US$ {cap} extra limit this month.", "Você usou US$ {spent} do seu limite extra de US$ {cap} neste mês.", "Usaste US$ {spent} de tu límite extra de US$ {cap} este mes."],
  "photo.warn.credit_100": ["You reached your extra limit of US$ {cap} this month.", "Você atingiu o seu limite extra de US$ {cap} neste mês.", "Llegaste a tu límite extra de US$ {cap} este mes."],
  "photo.credit.title": ["Keep importing with extra reads", "Continue importando com leituras extras", "Sigue importando con lecturas extra"],
  "photo.credit.body": ["Each extra photo costs US$ {price}, added to your next invoice. You choose a monthly limit and can turn it off any time.", "Cada foto extra custa US$ {price}, somada à sua próxima fatura. Você escolhe um limite mensal e pode desligar quando quiser.", "Cada foto extra cuesta US$ {price}, sumada a tu próxima factura. Tú eliges un límite mensual y puedes desactivarlo cuando quieras."],
  "photo.credit.cap": ["Monthly limit for extras", "Limite mensal para extras", "Límite mensual para extras"],
  "photo.credit.accept": ["I agree to be charged US$ {price} per extra photo, up to US$ {cap} per month, on my subscription invoice.", "Concordo em ser cobrado US$ {price} por foto extra, até US$ {cap} por mês, na fatura da minha assinatura.", "Acepto que se me cobre US$ {price} por foto extra, hasta US$ {cap} al mes, en la factura de mi suscripción."],
  "photo.credit.on": ["Turn on extra reads", "Ativar leituras extras", "Activar lecturas extra"],
  "photo.credit.active": ["Extra reads are on: US$ {spent} of US$ {cap} used this month (US$ {price} per photo).", "Leituras extras ativas: US$ {spent} de US$ {cap} usados neste mês (US$ {price} por foto).", "Lecturas extra activas: US$ {spent} de US$ {cap} usados este mes (US$ {price} por foto)."],
  "photo.credit.off": ["Turn off extra reads", "Desligar leituras extras", "Desactivar lecturas extra"],
  "photo.credit.wait": ["Or wait for the next monthly cycle.", "Ou espere o próximo ciclo mensal.", "O espera al próximo ciclo mensual."],
  "photo.credit.ownerOnly": ["Only the account owner can turn on extra reads. Ask the owner.", "Só o dono da conta pode ativar leituras extras. Peça ao dono.", "Solo el dueño de la cuenta puede activar lecturas extra. Pídeselo al dueño."],
  "photo.credit.upgrade": ["Photo reading is included in the Essential and Complete plans. Upgrade to use it.", "A leitura por foto está incluída nos planos Essencial e Completo. Faça upgrade para usar.", "La lectura por foto está incluida en los planes Esencial y Completo. Mejora tu plan para usarla."],
  "photo.err.credit_limit": ["You reached your extra reads limit for this month. Approve a new limit or wait for the next cycle.", "Você atingiu o limite de leituras extras deste mês. Aprove um novo limite ou espere o próximo ciclo.", "Llegaste al límite de lecturas extra de este mes. Aprueba un nuevo límite o espera al próximo ciclo."],
  "photo.err.no_billing": ["We could not find your subscription to bill. Contact support.", "Não encontrei a sua assinatura para cobrar. Fale com o suporte.", "No encontré tu suscripción para cobrar. Habla con soporte."],
  "photo.err.accept_required": ["You need to accept the price and the limit.", "É preciso aceitar o preço e o limite.", "Debes aceptar el precio y el límite."],
  "photo.err.other": ["Something went wrong. Try again.", "Algo deu errado. Tente de novo.", "Algo salió mal. Inténtalo de nuevo."],
  "photo.f.name": ["Name", "Nome", "Nombre"],
  "photo.f.phone": ["Phone", "Telefone", "Teléfono"],
  "photo.f.email": ["Email", "E-mail", "Correo"],
  "photo.f.address": ["Address", "Endereço", "Dirección"],
  "photo.f.type": ["Type", "Tipo", "Tipo"],
  "photo.f.description": ["Description", "Descrição", "Descripción"],
  "photo.f.amount": ["Amount", "Valor", "Monto"],
  "photo.f.date": ["Date", "Data", "Fecha"],
  "photo.f.source": ["Source", "Origem", "Origen"],
  "photo.f.interest": ["Interested in", "Interesse", "Interés"],
  "photo.f.company": ["Company", "Empresa", "Empresa"],
  "photo.f.notes": ["Notes", "Observações", "Notas"],
  "photo.title.contacts": ["Import contacts from a photo", "Importar contatos de uma foto", "Importar contactos desde una foto"],
  "photo.title.tenants": ["Import tenants from a photo", "Importar inquilinos de uma foto", "Importar inquilinos desde una foto"],
  "photo.title.suppliers": ["Import suppliers from a photo", "Importar fornecedores de uma foto", "Importar proveedores desde una foto"],
  "photo.title.customers": ["Import customers from a photo", "Importar clientes de uma foto", "Importar clientes desde una foto"],
  "photo.title.leads": ["Import leads from a photo", "Importar leads de uma foto", "Importar leads desde una foto"],
  "photo.intro.leads": ["Take a photo or paste a screenshot of a chat (WhatsApp, Messenger, Instagram, marketplace), a lead form or a note. The AI fills in the lead and you check everything before saving.", "Tire uma foto ou cole um print de uma conversa (WhatsApp, Messenger, Instagram, marketplace), de um formulário de lead ou de um bilhete. A IA preenche o lead e você confere tudo antes de salvar.", "Toma una foto o pega una captura de un chat (WhatsApp, Messenger, Instagram, marketplace), de un formulario de lead o de una nota. La IA rellena el lead y tú revisas todo antes de guardar."],
  "photo.f.category": ["Category", "Categoria", "Categoría"],
};

export function mergePhotoImportStrings(TR) {
  const idx = { en: 0, pt: 1, es: 2 };
  for (const [key, vals] of Object.entries(S)) {
    for (const lang of Object.keys(idx)) TR[lang][key] = vals[idx[lang]];
  }
}

// Para produtos com dicionário ANINHADO (Binder, Parcel...): { en: { photo: {...} }, pt: {...}, es: {...} }
export function nestedPhotoStrings(extra = {}) {
  const idx = { en: 0, pt: 1, es: 2 };
  const out = { en: { photo: {} }, pt: { photo: {} }, es: { photo: {} } };
  for (const [key, vals] of Object.entries({ ...S, ...extra })) {
    if (!key.startsWith("photo.")) continue;
    const parts = key.slice(6).split(".");
    for (const lang of Object.keys(idx)) {
      let o = out[lang].photo;
      parts.slice(0, -1).forEach((p) => { if (typeof o[p] !== "object") o[p] = {}; o = o[p]; });
      o[parts.at(-1)] = vals[idx[lang]];
    }
  }
  return out;
}

// Para produtos SEM sistema de idiomas (só inglês, ex.: Anvil, Cohort, Roster): t(chave) direto do dicionário S.
export function photoT(lang = "en") {
  const i = { en: 0, pt: 1, es: 2 }[lang] ?? 0;
  return (key) => S[key]?.[i] ?? S[key]?.[0] ?? key;
}
