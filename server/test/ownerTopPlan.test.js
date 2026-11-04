// Dono da plataforma sempre no plano mais alto: a empresa cujo dono (confirmado) tem e-mail em OWNER_EMAILS
// vê o plano mais alto e o complemento de folha, sem assinatura. Outras empresas seguem o plano gravado.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.FLUXO_DB = ':memory:';
process.env.OWNER_EMAILS = 'dono@example.test';
const plans = await import('../src/plans.js');
const { db, setSetting } = await import('../src/db.js');

test('topPlan é calculado da lista de planos', () => {
  assert.equal(plans.topPlan(), plans.PLAN_ORDER[plans.PLAN_ORDER.length - 1]);
  assert.equal(plans.topPlan(), 'enterprise');
});

test('sem dono na lista, vale o plano gravado', () => {
  setSetting('plan', 'free'); setSetting('addon_payroll', '0');
  assert.equal(plans.realPlan(), 'free');
  assert.equal(plans.hasAddon('payroll'), false);
});

test('empresa do dono: plano mais alto e folha, mesmo gravado como free; e-mail não confirmado não vale', () => {
  setSetting('plan', 'free'); setSetting('addon_payroll', '0');
  db.prepare("DELETE FROM users").run();
  db.prepare("INSERT INTO users (name,email,password_hash,role,email_verified_at) VALUES ('X','dono@example.test','x','owner',NULL)").run();
  assert.equal(plans.currentPlan(), 'free', 'cadastro com o e-mail do dono, mas sem confirmar');
  db.prepare("UPDATE users SET email_verified_at='2026-01-01' WHERE email='dono@example.test'").run();
  assert.equal(plans.currentPlan(), 'enterprise');
  assert.equal(plans.realPlan(), 'enterprise');
  assert.equal(plans.hasAddon('payroll'), true);
  assert.equal(plans.hasFeature('sso'), true);
  db.prepare("UPDATE users SET email='outra@example.test'").run();
  assert.equal(plans.currentPlan(), 'free', 'outro e-mail volta ao plano gravado');
});
