// Sobe o simulador do Stripe numa porta (padrão 12111) para testar a cobrança localmente sem conta no Stripe.
import { createStripeMock } from './stripe.js';
const { server } = createStripeMock(process.env.STRIPE_SECRET_KEY || 'sk_test_123');
server.listen(Number(process.env.MOCK_STRIPE_PORT || 12111), () => console.log(`Stripe mock em http://127.0.0.1:${server.address().port}`));
