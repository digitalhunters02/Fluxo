import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, run, insert, setSetting, getSetting, applyLanguage } from './db.js';
import * as acc from './accounting.js';
import * as bank from './banking.js';
import * as pay from './payroll.js';
import { hashPassword } from './auth.js';

const D = (v) => Math.round(v * 100); // dólares -> centavos

// Textos do exemplo em cada idioma (nomes próprios de empresas ficam iguais).
const TXT = {
  en: { capital: 'Initial owner investment', item_site: 'Website design & build', item_hour: 'Consulting (hour)', item_plan: 'Monthly support plan', item_kit: 'Wi-Fi 6 Router Kit', item_cam: 'Outdoor IP Camera',
    rent: 'Office rent', hosting: 'Hosting & servers', ads: 'Online ads', util: 'Internet & electricity', fees: 'Monthly bank fee', licenses: 'Project licenses', portal: 'Student portal', rec: 'Monthly support —',
    project: 'Scheduling app —', time: ['Requirements', 'Prototype', 'Back end', 'Integrations', 'Testing', 'Review meeting'], rent_manual: 'Rent (entered manually)',
    pay: ['ACH', 'Check', 'Card', 'Wire'], bank: ['ACH PAYMENT CEDAR PROPERTIES', 'MONTHLY SERVICE FEE', 'UBER *TRIP 1288', 'OFFICE DEPOT #0042', 'INTEREST EARNED', 'DEPOSIT UNIDENTIFIED CLIENT'], rules: ['service fee', 'uber', 'office depot'],
    contractor: 'Logo design', cls: ['Services', 'Products'], credit_line: 'Service credit', title: 'Software Engineer', title2: 'Designer', title3: 'Office Manager', company: 'Harbor Digital Studio' },
  pt: { capital: 'Aporte inicial de capital', item_site: 'Desenvolvimento de site', item_hour: 'Consultoria (hora)', item_plan: 'Plano de suporte mensal', item_kit: 'Kit Roteador Wi-Fi 6', item_cam: 'Câmera IP Externa',
    rent: 'Aluguel do escritório', hosting: 'Hospedagem e servidores', ads: 'Anúncios online', util: 'Internet e energia', fees: 'Tarifa bancária mensal', licenses: 'Licenças do projeto', portal: 'Portal do aluno', rec: 'Suporte mensal —',
    project: 'App de agendamento —', time: ['Levantamento de requisitos', 'Protótipo', 'Back-end', 'Integrações', 'Testes', 'Reunião de revisão'], rent_manual: 'Aluguel (lançado manualmente)',
    pay: ['ACH', 'Cheque', 'Cartão', 'Transferência'], bank: ['ACH PAYMENT CEDAR PROPERTIES', 'MONTHLY SERVICE FEE', 'UBER *TRIP 1288', 'OFFICE DEPOT #0042', 'INTEREST EARNED', 'DEPOSIT UNIDENTIFIED CLIENT'], rules: ['service fee', 'uber', 'office depot'],
    contractor: 'Design de logotipo', cls: ['Serviços', 'Produtos'], credit_line: 'Crédito de serviço', title: 'Engenheiro de software', title2: 'Designer', title3: 'Gerente de escritório', company: 'Harbor Digital Studio' },
  es: { capital: 'Aporte inicial de capital', item_site: 'Diseño y desarrollo de sitio web', item_hour: 'Consultoría (hora)', item_plan: 'Plan de soporte mensual', item_kit: 'Kit de router Wi-Fi 6', item_cam: 'Cámara IP exterior',
    rent: 'Alquiler de la oficina', hosting: 'Hosting y servidores', ads: 'Anuncios en línea', util: 'Internet y electricidad', fees: 'Comisión bancaria mensual', licenses: 'Licencias del proyecto', portal: 'Portal del estudiante', rec: 'Soporte mensual —',
    project: 'App de citas —', time: ['Requisitos', 'Prototipo', 'Back end', 'Integraciones', 'Pruebas', 'Reunión de revisión'], rent_manual: 'Alquiler (registrado manualmente)',
    pay: ['ACH', 'Cheque', 'Tarjeta', 'Transferencia'], bank: ['ACH PAYMENT CEDAR PROPERTIES', 'MONTHLY SERVICE FEE', 'UBER *TRIP 1288', 'OFFICE DEPOT #0042', 'INTEREST EARNED', 'DEPOSIT UNIDENTIFIED CLIENT'], rules: ['service fee', 'uber', 'office depot'],
    contractor: 'Diseño de logotipo', cls: ['Servicios', 'Productos'], credit_line: 'Crédito por servicio', title: 'Ingeniero de software', title2: 'Diseñador', title3: 'Gerente de oficina', company: 'Harbor Digital Studio' },
};

/** Carrega uma empresa fictícia (EUA) com ~6 meses de movimento, apenas se estiver vazia. */
export function loadDemo(lang = getSetting('lang', 'en')) {
  if (get('SELECT 1 FROM docs LIMIT 1') || get('SELECT 1 FROM journal_entries LIMIT 1')) return false;
  const x = TXT[lang] || TXT.en;
  const user = get('SELECT * FROM users ORDER BY id LIMIT 1');
  const A = (code) => get('SELECT id FROM accounts WHERE code=?', code).id;
  const bankAcc = A('1010');
  const t = acc.today();
  const day = (monthsAgo, d) => { const base = acc.addMonths(t.slice(0, 7) + '-01', -monthsAgo); const v = base.slice(0, 8) + String(d).padStart(2, '0'); return v > t ? t : v; };

  if (['Minha Empresa', 'My Company', 'Mi Empresa'].includes(getSetting('company_name'))) setSetting('company_name', x.company);
  setSetting('default_tax_rate', '6');

  acc.postEntry({ date: day(6, 1), memo: x.capital, lines: [{ account_id: bankAcc, debit: D(80000) }, { account_id: A('3000'), credit: D(80000) }], user_id: user?.id });

  const cust = {}, vend = {};
  for (const [k, name, email, terms] of [['a', 'Brightside Dental', 'billing@brightside.example', 15], ['b', 'Harbor Coffee Co.', 'accounts@harborcoffee.example', 30], ['c', 'Summit Fitness', 'office@summitfit.example', 15],
    ['d', 'Maple Street Bakery', 'owner@maplestreet.example', 7], ['e', 'Northwind Realty', 'ap@northwind.example', 30]]) cust[k] = insert("INSERT INTO contacts(kind,name,email,terms_days) VALUES('customer',?,?,?)", name, email, terms);
  for (const [k, name, tax] of [['imob', 'Cedar Properties', ''], ['forn', 'TechSupply Wholesale', ''], ['cloud', 'CloudNine Hosting', ''], ['mkt', 'AdBoost Marketing', '']])
    vend[k] = insert("INSERT INTO contacts(kind,name,email,terms_days) VALUES('vendor',?,?,15)", name, `${k}@vendor.example`);
  vend.free = insert("INSERT INTO contacts(kind,name,email,terms_days,is_1099,tax_id) VALUES('vendor','Jordan Lee Design','jordan@freelance.example',15,1,'')");

  const it = {};
  it.site = insert("INSERT INTO items(name,kind,price,income_account_id,tax_rate) VALUES(?,'service',?,?,0)", x.item_site, D(4500), A('4100'));
  it.consult = insert("INSERT INTO items(name,kind,price,income_account_id,tax_rate) VALUES(?,'service',?,?,0)", x.item_hour, D(150), A('4100'));
  it.suporte = insert("INSERT INTO items(name,kind,price,income_account_id,tax_rate) VALUES(?,'service',?,?,0)", x.item_plan, D(650), A('4100'));
  it.kit = insert("INSERT INTO items(name,sku,kind,price,cost,track_inventory,reorder_point,income_account_id,tax_rate) VALUES(?,'KIT-001','product',?,0,1,5,?,6)", x.item_kit, D(199), A('4000'));
  it.cam = insert("INSERT INTO items(name,sku,kind,price,cost,track_inventory,reorder_point,income_account_id,tax_rate) VALUES(?,'CAM-010','product',?,0,1,3,?,6)", x.item_cam, D(149), A('4000'));

  const firstBill = acc.saveDoc({ type: 'bill', contact_id: vend.forn, issue_date: day(5, 3), due_date: day(5, 18), lines: [
    { item_id: it.kit, description: x.item_kit, qty: 40, unit_price: D(105) }, { item_id: it.cam, description: x.item_cam, qty: 25, unit_price: D(78) }] }, user);
  acc.addPayment(firstBill.id, { date: day(5, 18), amount: firstBill.total, account_id: bankAcc, method: x.pay[0] }, user);
  const bill2 = acc.saveDoc({ type: 'bill', contact_id: vend.forn, issue_date: day(2, 4), due_date: day(2, 19), lines: [{ item_id: it.kit, description: x.item_kit, qty: 20, unit_price: D(110) }] }, user);
  acc.addPayment(bill2.id, { date: day(2, 19), amount: bill2.total, account_id: bankAcc, method: x.pay[1] }, user);

  for (let m = 5; m >= 0; m--) {
    const rent = acc.saveDoc({ type: 'bill', contact_id: vend.imob, issue_date: day(m, 2), due_date: day(m, 10), lines: [{ description: x.rent, qty: 1, unit_price: D(3200), account_id: A('6000') }] }, user);
    if (day(m, 10) <= t) acc.addPayment(rent.id, { date: day(m, 10), amount: D(3200), account_id: bankAcc, method: x.pay[0] }, user);
    const cloud = acc.saveDoc({ type: 'bill', contact_id: vend.cloud, issue_date: day(m, 5), due_date: day(m, 12), lines: [{ description: x.hosting, qty: 1, unit_price: D(420 + m * 15), account_id: A('6300') }] }, user);
    if (day(m, 12) <= t) acc.addPayment(cloud.id, { date: day(m, 12), amount: D(420 + m * 15), account_id: bankAcc, method: x.pay[2] }, user);
    acc.saveExpense({ date: day(m, 8), contact_id: vend.mkt, account_id: A('6200'), paid_from_id: bankAcc, amount: D(900 + (m % 3) * 250), description: x.ads }, user);
    acc.saveExpense({ date: day(m, 15), account_id: A('6500'), paid_from_id: bankAcc, amount: D(310 + m * 7), description: x.util }, user);
    acc.saveExpense({ date: day(m, 25), account_id: A('6800'), paid_from_id: bankAcc, amount: D(24.9), description: x.fees }, user);
  }
  acc.saveExpense({ date: day(3, 12), contact_id: vend.free, account_id: A('6400'), paid_from_id: bankAcc, amount: D(1200), description: x.contractor }, user);
  acc.saveExpense({ date: day(1, 12), contact_id: vend.free, account_id: A('6400'), paid_from_id: bankAcc, amount: D(1100), description: x.contractor }, user);

  const clsServices = insert('INSERT INTO classes(name) VALUES(?)', x.cls[0]), clsProducts = insert('INSERT INTO classes(name) VALUES(?)', x.cls[1]);
  const keys = Object.keys(cust);
  for (let m = 5; m >= 0; m--) {
    for (let i = 0; i < 4; i++) {
      const c = cust[keys[(m + i) % keys.length]];
      const terms = get('SELECT terms_days FROM contacts WHERE id=?', c).terms_days;
      const issue = day(m, 3 + i * 6), due = acc.addDays(issue, terms);
      const lines = [{ item_id: it.site, description: x.item_site, qty: 1, unit_price: D(3500 + 600 * i), tax_rate: 0, class_id: clsServices }];
      if (i % 2 === 0) lines.push({ item_id: it.kit, description: x.item_kit, qty: 1 + (m % 3), unit_price: D(199), tax_rate: 6, class_id: clsProducts });
      if (i === 3) lines.push({ item_id: it.cam, description: x.item_cam, qty: 2, unit_price: D(149), tax_rate: 6, class_id: clsProducts });
      const inv = acc.saveDoc({ type: 'invoice', contact_id: c, issue_date: issue, due_date: due, post: true, lines }, user);
      const payDate = acc.addDays(due, i === 2 ? 6 : -1);
      if (m >= 1 && !(m === 1 && i === 2) && payDate <= t) acc.addPayment(inv.id, { date: payDate, amount: inv.total, account_id: bankAcc, method: x.pay[i % 4] }, user);
      else if (m === 0 && i === 0 && payDate <= t) acc.addPayment(inv.id, { date: payDate, amount: Math.round(inv.total / 2), account_id: bankAcc, method: x.pay[0] }, user);
    }
  }
  acc.saveDoc({ type: 'estimate', contact_id: cust.e, issue_date: day(0, 1), due_date: acc.addDays(day(0, 1), 30), post: true,
    lines: [{ item_id: it.site, description: x.portal, qty: 1, unit_price: D(9800), tax_rate: 0 }, { item_id: it.consult, description: x.item_hour, qty: 12, unit_price: D(150), tax_rate: 0 }] }, user);

  // nota de crédito parcial, ordem de compra e orçamento anual
  acc.saveDoc({ type: 'credit', contact_id: cust.a, issue_date: day(0, 2), due_date: day(0, 2), post: true, lines: [{ description: x.credit_line, qty: 1, unit_price: D(300), tax_rate: 0 }] }, user);
  acc.saveDoc({ type: 'po', contact_id: vend.forn, issue_date: day(0, 1), due_date: acc.addDays(day(0, 1), 14), post: true, lines: [{ item_id: it.kit, description: x.item_kit, qty: 15, unit_price: D(112) }] }, user);
  const year = t.slice(0, 4);
  const budget = (code, amount) => { for (let m = 1; m <= 12; m++) run('INSERT INTO budgets(account_id,month,amount) VALUES(?,?,?)', A(code), `${year}-${String(m).padStart(2, '0')}`, D(amount)); };
  budget('4100', 14000); budget('4000', 2500); budget('6000', 3200); budget('6200', 1100); budget('6300', 700); budget('6100', 0);

  const proj = insert('INSERT INTO projects(name,contact_id,hourly_rate,budget) VALUES(?,?,?,?)', `${x.project} Brightside Dental`, cust.a, D(150), D(15000));
  for (let i = 0; i < 6; i++) insert('INSERT INTO time_entries(project_id,user_id,date,hours,description,billable) VALUES(?,?,?,?,?,1)', proj, user?.id ?? null, acc.addDays(t, -i * 2), 3 + (i % 3), x.time[i]);
  acc.saveExpense({ date: day(0, 5), contact_id: vend.cloud, account_id: A('6300'), paid_from_id: bankAcc, amount: D(240), description: x.licenses, project_id: proj }, user);

  run('INSERT INTO recurring(name,template,frequency,next_date,auto_post) VALUES(?,?,?,?,1)', `${x.rec} Summit Fitness`,
    JSON.stringify({ contact_id: cust.c, terms_days: 7, lines: [{ item_id: it.suporte, description: x.item_plan, qty: 1, unit_price: D(650), tax_rate: 0 }] }), 'monthly', acc.addMonths(day(0, 1), 1));

  // folha: 3 funcionários, 3 rodadas mensais finalizadas e o depósito federal do primeiro mês
  const emp = (n, pos, basis, rate, extra = {}) => insert('INSERT INTO employees(name,position,hire_date,pay_basis,pay_rate,frequency,filing_status,state_pct,pretax_deduction) VALUES(?,?,?,?,?,?,?,?,?)',
    n, pos, acc.addMonths(t, -14), basis, rate, 'monthly', extra.status || 'single', extra.state || 0, extra.pretax || 0);
  const e1 = emp('Taylor Morgan', x.title, 'year', D(96000), { status: 'married', state: 4, pretax: D(300) });
  const e2 = emp('Riley Chen', x.title2, 'year', D(72000), { state: 4 });
  const e3 = emp('Casey Brooks', x.title3, 'hour', D(24), { state: 4 });
  const runs = [];
  for (const m of [3, 2, 1]) {
    const d = pay.saveRun({ type: 'regular', period_start: day(m, 1), period_end: acc.addDays(acc.addMonths(day(m, 1), 1), -1), pay_date: day(m, 28),
      lines: [{ employee_id: e1 }, { employee_id: e2 }, { employee_id: e3, hours: 160 }] }, user);
    runs.push(pay.finalizeRun(d.id, bankAcc, user));
  }
  const fed = pay.liabilities().filter((l) => ['fit', 'ss_ee', 'ss_er', 'med_ee', 'med_er', 'addmed_ee'].includes(l.component));
  const firstRunLiab = fed.map((l) => ({ component: l.component, amount: Math.round(l.outstanding / 3) })).filter((i) => i.amount > 0);
  if (firstRunLiab.length) pay.remit({ items: firstRunLiab, date: acc.addDays(runs[0].pay_date, 10) > t ? t : acc.addDays(runs[0].pay_date, 10), account_id: bankAcc }, user);

  // banco: extrato importado (parte pareia com lançamentos existentes, parte vira sugestão por regra)
  for (const [i, p] of x.rules.entries()) run('INSERT INTO bank_rules(pattern,account_id,direction) VALUES(?,?,?)', p, [A('6800'), A('6600'), A('6700')][i], 'out');
  acc.saveExpense({ date: acc.addDays(t, -3), account_id: A('6000'), paid_from_id: bankAcc, amount: D(3200), description: x.rent_manual }, user);
  bank.importTxns(bankAcc, [
    { date: acc.addDays(t, -3), description: x.bank[0], amount: -D(3200) },
    { date: acc.addDays(t, -2), description: x.bank[1], amount: -D(24.9) },
    { date: acc.addDays(t, -2), description: x.bank[2], amount: -D(34.7) },
    { date: acc.addDays(t, -1), description: x.bank[3], amount: -D(87.5) },
    { date: acc.addDays(t, -1), description: x.bank[4], amount: D(12.37) },
    { date: t, description: x.bank[5], amount: D(1500) },
  ]);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const lang = ['en', 'pt', 'es'].includes(process.env.LANG_CODE) ? process.env.LANG_CODE : 'en';
  if (!get('SELECT 1 FROM users LIMIT 1')) {
    applyLanguage(lang);
    insert("INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,'owner')", 'Demo', 'demo@fluxo.app', hashPassword('demo12345'));
    console.log('User created: demo@fluxo.app / demo12345');
  }
  console.log(loadDemo(lang) ? 'Demo data loaded.' : 'Database already has data; nothing done.');
}
