// src/planConfig.js
// ARQUIVO DE AJUSTE (o único dos arquivos de "selo de plano" que é específico do produto): aqui ficam as ligações com este app.
// Os demais (PlanBadge, PlanUpsellModal, PlanPreview, planPreview, planStrings) são genéricos e iguais em todos os CRMs.
// Os planos, preços, o plano mínimo de cada recurso e o que cada plano acrescenta vêm do SERVIDOR (/me, /public/plans).
// Aqui só ficam: textos dos recursos, quais itens de menu têm selo e três ajustes simples.

export { API_URL } from "./api"; // trocar aqui: a constante com o endereço do servidor deste app

export const APP_NAME = "Fluxo"; // trocar aqui: nome do produto (aparece na faixa "Você está vendo o … como o plano …")
export const PREVIEW_STORAGE_KEY = "fluxo_preview_plan"; // trocar aqui: chave do localStorage (única por produto)
export const CURRENCY = "USD"; // trocar aqui: moeda dos preços do catálogo (código ISO)

// Itens de menu -> recurso do servidor (chave de FEATURES em server/src/plans.js). O menu (NAV em App.jsx) consulta esta tabela
// pelo caminho da página: para pôr selo em outro item, UMA linha aqui.
export const NAV_GATES = {
  "/credit-memos": "credit_memos",
  "/recurring": "recurring",
  "/bills": "bills",
  "/purchase-orders": "purchase_orders",
  "/connections": "bank_feeds",
  "/projects": "time_tracking",
  "/payroll": "payroll",
  "/assets": "fixed_assets",
  "/close": "close_checklist",
};

// Texto de cada recurso com selo: nome curto + 1–2 frases do que faz. Ordem dos idiomas: [en, pt, es].
// Para um recurso novo: acrescente a chave igual à de FEATURES (ou EXTRA_GATES) no servidor.
export const GATE_TEXT = {
  credit_memos: {
    name: ["Credit memos", "Notas de crédito", "Notas de crédito"],
    what: ["Give a customer credit or a refund against an invoice, with the books adjusted for you.", "Dê crédito ou reembolso ao cliente sobre uma fatura, com a contabilidade ajustada sozinha.", "Dé crédito o reembolso al cliente sobre una factura, con la contabilidad ajustada sola."],
  },
  branding: {
    name: ["Your logo and colors", "Sua logo e suas cores", "Su logo y sus colores"],
    what: ["Put your logo and brand color on invoices, estimates and emails.", "Coloque a sua logo e a cor da sua marca nas faturas, orçamentos e e-mails.", "Ponga su logo y el color de su marca en facturas, presupuestos y correos."],
  },
  user_access: {
    name: ["More users and access by area", "Mais usuários e acesso por área", "Más usuarios y acceso por área"],
    what: ["Invite your team with their own login and choose which areas each person can see or change.", "Convide a equipe com login próprio e escolha quais áreas cada pessoa pode ver ou mudar.", "Invite a su equipo con su propio acceso y elija qué áreas puede ver o cambiar cada persona."],
  },
  accountant_access: {
    name: ["Accountant access", "Acesso do contador", "Acceso del contador"],
    what: ["Invite your accountant with a read-only login, so nobody has to send files back and forth.", "Convide o seu contador com um acesso só de leitura, sem ficar mandando arquivos de um lado para o outro.", "Invite a su contador con un acceso de solo lectura, sin enviar archivos de un lado a otro."],
  },
  unlimited_invoices: {
    name: ["Unlimited invoices", "Faturas ilimitadas", "Facturas ilimitadas"],
    what: ["Create as many invoices as you need each month, with no cap.", "Crie quantas faturas precisar por mês, sem limite.", "Cree todas las facturas que necesite cada mes, sin límite."],
  },
  bills: {
    name: ["Bills and vendor payments", "Contas a pagar e pagamento de fornecedores", "Cuentas por pagar y pago a proveedores"],
    what: ["Record what you owe, schedule payments and see due dates in one place.", "Registre o que você deve, programe pagamentos e veja os vencimentos num só lugar.", "Registre lo que debe, programe pagos y vea los vencimientos en un solo lugar."],
  },
  recurring: {
    name: ["Recurring invoices", "Faturas recorrentes", "Facturas recurrentes"],
    what: ["Bill the same customer every week or month on its own, with no retyping.", "Cobre o mesmo cliente toda semana ou todo mês, sozinho, sem digitar de novo.", "Cobre al mismo cliente cada semana o cada mes, solo, sin volver a escribir."],
  },
  time_tracking: {
    name: ["Projects and time tracking", "Projetos e controle de horas", "Proyectos y control de horas"],
    what: ["Track hours per project and turn unbilled time into an invoice.", "Registre as horas de cada projeto e transforme o tempo não cobrado em fatura.", "Registre las horas de cada proyecto y convierta el tiempo sin cobrar en factura."],
  },
  audit_log: {
    name: ["Audit log", "Histórico de alterações", "Historial de cambios"],
    what: ["See who changed what and when, to keep the books trustworthy.", "Veja quem mudou o quê e quando, para manter a contabilidade confiável.", "Vea quién cambió qué y cuándo, para mantener la contabilidad confiable."],
  },
  reports_full: {
    name: ["Full reports", "Relatórios completos", "Informes completos"],
    what: ["Aging, inventory, sales tax and more detailed reports for any period.", "Contas a pagar por idade, estoque, imposto sobre vendas e outros relatórios detalhados de qualquer período.", "Antigüedad de saldos, inventario, impuesto sobre ventas y otros informes detallados de cualquier período."],
  },
  bank_feeds: {
    name: ["Automatic bank connection", "Conexão automática com o banco", "Conexión automática con el banco"],
    what: ["Connect your bank so transactions arrive by themselves, with nothing typed twice.", "Conecte o seu banco e as transações chegam sozinhas, sem digitar duas vezes.", "Conecte su banco y las transacciones llegan solas, sin escribir dos veces."],
  },
  ai_assistant: {
    name: ["AI assistant", "Assistente de IA", "Asistente de IA"],
    what: ["Sort bank transactions, explain your numbers and draft collection messages in a click.", "Classifique transações do banco, explique os seus números e escreva mensagens de cobrança com um clique.", "Clasifique transacciones del banco, explique sus números y redacte mensajes de cobro con un clic."],
  },
  email_invoices: {
    name: ["Email invoices from the app", "Enviar fatura por e-mail pelo app", "Enviar facturas por correo desde la app"],
    what: ["Send an invoice to your customer by email in one tap, and see when it went out.", "Envie a fatura ao cliente por e-mail com um toque e veja quando foi enviada.", "Envíe la factura al cliente por correo con un toque y vea cuándo salió."],
  },
  photo_import: {
    name: ["Read receipts and documents from a photo", "Ler recibos e documentos por foto", "Leer recibos y documentos desde una foto"],
    what: ["Take a photo and the app fills in the expense or document for you to check.", "Tire uma foto e o app preenche a despesa ou o documento para você conferir.", "Tome una foto y la app completa el gasto o el documento para que lo revise."],
  },
  inventory: {
    name: ["Inventory", "Estoque", "Inventario"],
    what: ["Track quantities and average cost of what you sell, with low-stock alerts.", "Controle a quantidade e o custo médio do que você vende, com aviso de estoque baixo.", "Controle la cantidad y el costo promedio de lo que vende, con aviso de poco stock."],
  },
  project_profit: {
    name: ["Profit per project", "Lucro por projeto", "Ganancia por proyecto"],
    what: ["See what each project earned and cost, so you know which ones pay.", "Veja quanto cada projeto rendeu e custou, e saiba quais valem a pena.", "Vea cuánto rindió y costó cada proyecto, y sepa cuáles valen la pena."],
  },
  contractors_1099: {
    name: ["1099 contractors", "Prestadores 1099", "Contratistas 1099"],
    what: ["Mark vendors as 1099 contractors and get the yearly report ready for your accountant.", "Marque fornecedores como prestadores 1099 e receba o relatório anual pronto para o contador.", "Marque proveedores como contratistas 1099 y reciba el informe anual listo para su contador."],
  },
  budgets: {
    name: ["Budgets", "Orçamentos financeiros", "Presupuestos"],
    what: ["Set a budget per account and compare it with what really happened.", "Defina um orçamento por conta e compare com o que realmente aconteceu.", "Defina un presupuesto por cuenta y compárelo con lo que realmente pasó."],
  },
  purchase_orders: {
    name: ["Purchase orders", "Pedidos de compra", "Órdenes de compra"],
    what: ["Order from vendors with a purchase order and turn it into a bill when it arrives.", "Peça a fornecedores com um pedido de compra e transforme em conta a pagar quando chegar.", "Pida a proveedores con una orden de compra y conviértala en cuenta por pagar al llegar."],
  },
  period_lock: {
    name: ["Close the books", "Fechar o período", "Cerrar el período"],
    what: ["Lock past periods so nobody changes numbers that were already reported.", "Trave períodos passados para que ninguém mude números que já foram informados.", "Bloquee períodos pasados para que nadie cambie números que ya se informaron."],
  },
  classes: {
    name: ["Classes and tracking", "Classes e centros de custo", "Clases y centros de costo"],
    what: ["Tag income and expenses by department or location and get a profit report for each.", "Marque receitas e despesas por departamento ou unidade e veja o lucro de cada uma.", "Etiquete ingresos y gastos por departamento o sucursal y vea la ganancia de cada una."],
  },
  forecast: {
    name: ["Cash flow forecast", "Previsão de fluxo de caixa", "Previsión de flujo de caja"],
    what: ["See how much cash you will have in the coming weeks, from invoices and bills due.", "Veja quanto dinheiro você terá nas próximas semanas, a partir das faturas e contas a vencer.", "Vea cuánto efectivo tendrá en las próximas semanas, según facturas y cuentas por vencer."],
  },
  custom_roles: {
    name: ["Custom roles", "Funções personalizadas", "Roles personalizados"],
    what: ["Create your own roles, with exactly the access each kind of person needs.", "Crie funções suas, com exatamente o acesso que cada tipo de pessoa precisa.", "Cree sus propios roles, con exactamente el acceso que necesita cada tipo de persona."],
  },
  batch_invoices: {
    name: ["Batch invoicing", "Faturas em lote", "Facturas en lote"],
    what: ["Create invoices for many customers at once.", "Crie faturas para vários clientes de uma só vez.", "Cree facturas para muchos clientes a la vez."],
  },
  api: {
    name: ["Integrations and API", "Integrações e API", "Integraciones y API"],
    what: ["Connect Fluxo to your other systems with an API key and automatic notices.", "Ligue o Fluxo aos seus outros sistemas com chave de API e avisos automáticos.", "Conecte Fluxo con sus otros sistemas con clave de API y avisos automáticos."],
  },
  online_payments: {
    name: ["Online payment of invoices", "Pagamento online da fatura", "Pago en línea de facturas"],
    what: ["Your customers pay your invoice by card or bank transfer, and the money goes straight to you.", "Seus clientes pagam a fatura por cartão ou transferência e o dinheiro vai direto para você.", "Sus clientes pagan la factura por tarjeta o transferencia y el dinero va directo a usted."],
  },
  approvals: {
    name: ["Bill approvals", "Aprovação de contas a pagar", "Aprobación de cuentas por pagar"],
    what: ["Require a second person to approve bills before they are paid.", "Peça a uma segunda pessoa para aprovar as contas antes de pagar.", "Pida a una segunda persona que apruebe las cuentas antes de pagarlas."],
  },
  fixed_assets: {
    name: ["Fixed assets and depreciation", "Ativo imobilizado e depreciação", "Activos fijos y depreciación"],
    what: ["Keep a list of equipment and property and let the app calculate depreciation each month.", "Mantenha a lista de equipamentos e bens e deixe o app calcular a depreciação todo mês.", "Mantenga la lista de equipos y bienes y deje que la app calcule la depreciación cada mes."],
  },
  multi_company: {
    name: ["Group of companies", "Grupo de empresas", "Grupo de empresas"],
    what: ["Link several companies in a group and see consolidated reports.", "Ligue várias empresas num grupo e veja relatórios consolidados.", "Una varias empresas en un grupo y vea informes consolidados."],
  },
  close_checklist: {
    name: ["Month-end close checklist", "Roteiro de fechamento do mês", "Lista de cierre del mes"],
    what: ["Follow a step-by-step checklist to close each month without forgetting anything.", "Siga um roteiro passo a passo para fechar cada mês sem esquecer nada.", "Siga una lista paso a paso para cerrar cada mes sin olvidar nada."],
  },
  audit_export: {
    name: ["Audit log export", "Exportar o histórico de alterações", "Exportar el historial de cambios"],
    what: ["Download the full audit log as a spreadsheet for auditors.", "Baixe o histórico completo de alterações em planilha para auditores.", "Descargue el historial completo de cambios en una hoja para auditores."],
  },
  sso: {
    name: ["Single sign-on (SSO)", "Login único (SSO)", "Inicio de sesión único (SSO)"],
    what: ["Let your team sign in with the company account they already use.", "Deixe a equipe entrar com a conta da empresa que já usa.", "Deje que su equipo entre con la cuenta de la empresa que ya usa."],
  },
  payroll: {
    name: ["Payroll", "Folha de pagamento", "Nómina"],
    what: ["Run U.S. payroll with taxes, pay stubs, W-2 and 941 summaries. It is an add-on with a small fee per employee.", "Faça a folha de pagamento dos EUA com impostos, holerites e resumos de W-2 e 941. É um complemento, com uma pequena taxa por funcionário.", "Haga la nómina de EE. UU. con impuestos, recibos y resúmenes de W-2 y 941. Es un complemento, con una pequeña tarifa por empleado."],
  },
};

// Complementos vendidos à parte (não são planos): nome por idioma [en, pt, es]. O preço vem do servidor (/me → addons).
export const ADDON_NAMES = {
  payroll: ["Payroll add-on", "Complemento de folha", "Complemento de nómina"],
};
