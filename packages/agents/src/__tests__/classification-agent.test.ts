import { describe, it, expect, beforeEach } from 'vitest';
import { ClassificationAgent } from '../classification-agent';

function makePrismaStub() {
  const concepts = [
    { name: 'Combustible', accountId: 'acct-combustible', confidence: 0.95, account: { name: 'Gastos de Combustible' } },
    { name: 'Electricidad', accountId: 'acct-electricidad', confidence: 0.9, account: { name: 'Gastos de Electricidad' } },
    { name: 'Internet', accountId: 'acct-internet', confidence: 0.9, account: { name: 'Gastos de Internet' } },
  ];
  const accounts = [
    { id: 'acct-combustible', name: 'Gastos de Combustible', code: '6.01.02', type: 'GASTO', isActive: true },
    { id: 'acct-electricidad', name: 'Gastos de Electricidad', code: '6.01.03', type: 'GASTO', isActive: true },
    { id: 'acct-internet', name: 'Gastos de Internet', code: '6.01.04', type: 'GASTO', isActive: true },
    { id: 'acct-gastos-varios', name: 'Gastos Varios', code: '6.06.01', type: 'GASTO', isActive: true },
    { id: 'acct-ventas', name: 'Ventas', code: '4.01.01', type: 'INGRESO', isActive: true },
    { id: 'acct-clientes', name: 'Clientes', code: '1.1.03.01', type: 'ACTIVO', isActive: true },
    { id: 'acct-otros-ingresos', name: 'Otros Ingresos', code: '4.02', type: 'INGRESO', isActive: true },
  ];

  return {
    concept: {
      findMany: async () => concepts,
    },
    account: {
      findMany: async () => accounts,
    },
  };
}

describe('ClassificationAgent', () => {
  let agent: ClassificationAgent;

  beforeEach(() => {
    agent = new ClassificationAgent({ prisma: makePrismaStub(), companyId: 'demo-company' });
  });

  it('finds exact match by concept name', async () => {
    const result = await agent.classify('Combustible');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
    expect(result.confidence).toBe(0.95);
  });

  it('finds exact match case-insensitive', async () => {
    const result = await agent.classify('combustible');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
  });

  it('finds partial match by prefix', async () => {
    const result = await agent.classify('Combustible Diesel');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
    expect(result.confidence).toBeLessThan(0.95);
  });

  it('falls back to generic account based on transaction type', async () => {
    const result = await agent.classify('Consultoría de desarrollo web', 'COBRO_CLIENTE');
    expect(result.concept).toBe('Consultoría de desarrollo web');
    expect(result.accountId).toBe('acct-clientes');
    expect(result.confidence).toBe(0.5);
  });

  it('falls back to Gastos Varios for unknown GASTO', async () => {
    const result = await agent.classify('Hosting y dominio', 'GASTO');
    expect(result.accountId).toBe('acct-gastos-varios');
    expect(result.confidence).toBe(0.5);
  });

  it('returns confidence 0 when no match and no generic fallback', async () => {
    const emptyAgent = new ClassificationAgent({
      prisma: {
        concept: { findMany: async () => [] },
        account: { findMany: async () => [] },
      },
      companyId: 'demo-company',
    });
    const result = await emptyAgent.classify('Unknown Concept', 'GASTO');
    expect(result.confidence).toBe(0);
    expect(result.accountId).toBe('');
  });
});
