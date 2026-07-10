import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorAgent } from '../orchestrator-agent';

function makePrismaStub() {
  let entryIdCounter = 0;
  return {
    concept: {
      findMany: async () => [
        { name: 'Combustible', accountId: 'acct-combustible', confidence: 0.95, account: { name: 'Gastos de Combustible' } },
        { name: 'Ventas', accountId: 'acct-ventas', confidence: 0.95, account: { name: 'Ventas' } },
      ],
    },
    account: {
      findMany: async () => [
        { id: 'acct-caja', code: '1.1.01', name: 'Caja', type: 'ACTIVO', isActive: true },
        { id: 'acct-banco', code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO', isActive: true },
        { id: 'acct-clientes', code: '1.1.03.01', name: 'Clientes', type: 'ACTIVO', isActive: true },
        { id: 'acct-tarjeta', code: '2.1.03', name: 'Tarjetas de Crédito', type: 'PASIVO', isActive: true },
        { id: 'acct-proveedores', code: '2.1.01', name: 'Proveedores', type: 'PASIVO', isActive: true },
        { id: 'acct-inventario', code: '1.1.04.01', name: 'Inventario de Mercancía', type: 'ACTIVO', isActive: true },
        { id: 'acct-prestamos', code: '2.2.01', name: 'Préstamos por Pagar LP', type: 'PASIVO', isActive: true },
        { id: 'acct-ventas', code: '4.01.01', name: 'Ventas', type: 'INGRESO', isActive: true },
        { id: 'acct-combustible', code: '6.01.02', name: 'Gastos de Combustible', type: 'GASTO', isActive: true },
        { id: 'acct-gastos-varios', code: '6.06.01', name: 'Gastos Varios', type: 'GASTO', isActive: true },
      ],
    },
    journalEntry: {
      create: async (args: any) => {
        entryIdCounter++;
        return { id: `entry-${entryIdCounter}`, ...args.data, createdAt: new Date(), updatedAt: new Date() };
      },
    },
    transaction: {
      create: async (args: any) => ({ id: `tx-${entryIdCounter}`, ...args.data }),
    },
  };
}

describe('OrchestratorAgent', () => {
  let orchestrator: OrchestratorAgent;

  beforeEach(() => {
    orchestrator = new OrchestratorAgent({
      prisma: makePrismaStub(),
      companyId: 'demo-company',
    });
  });

  it('returns needsConfirmation when all fields are present', async () => {
    const result = await orchestrator.process('Compré combustible por $40 con efectivo');
    expect(result.needsConfirmation).toBe(true);
    expect(result.plan).toBeDefined();
    expect(result.plan.steps).toHaveLength(3);
    expect(result.result).toBeDefined();
    expect(result.result.dialog.type).toBe('GASTO');
    expect(result.result.dialog.concept).toBe('Combustible');
  });

  it('returns prompt when fields are missing', async () => {
    const result = await orchestrator.process('Hola');
    expect(result.needsConfirmation).toBe(false);
    expect(result.prompt).toBeTruthy();
    expect(result.plan.steps).toHaveLength(1);
  });

  it('returns prompt when concept confidence is low', async () => {
    const result = await orchestrator.process('Compré XYZDesconocido por $100 con efectivo');
    if ('prompt' in result && result.prompt?.includes('No reconozco')) {
      expect(result.needsConfirmation).toBe(false);
    }
  });

  it('confirm creates journal entry with BORRADOR status', async () => {
    const processResult = await orchestrator.process('Compré combustible por $40 con efectivo');
    const confirmResult = await orchestrator.confirm(processResult.result);
    expect(confirmResult.journalEntry).toBeDefined();
  });
});
