// Enviar o link da cobrança pelo WhatsApp ou por mensagem de texto: abre o app do próprio aparelho com a mensagem pronta,
// e quem manda é a pessoa (do número dela). Nada sai do servidor e nenhum número é guardado em conta de mensagens.
export function shareUrls({ phone = '', text = '' }) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`; // EUA: número sem o código do país
  const enc = encodeURIComponent(text);
  return {
    whatsapp: digits ? `https://wa.me/${digits}?text=${enc}` : `https://wa.me/?text=${enc}`,
    sms: `sms:${digits ? `+${digits}` : ''}?&body=${enc}`,
  };
}
