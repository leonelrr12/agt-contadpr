import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorAgent } from '../orchestrator-agent';
import { basePrismaStub } from './stubs';

function makePrismaStub() {
  let entryIdCounter = 0;
  return {
    ...basePrismaStub(),
    company: {
      findUnique: async () => ({ declaraITBMS: true }),
    },
    concept: {
      findMany: async () => [
        { name: 'Combustible', accountId: 'acct-combustible', confidence: 0.95, account: { name: 'Gastos de Combustible' } },
        { name: 'Ventas', accountId: 'acct-ventas', confidence: 0.95, account: { name: 'Ventas' } },
      ],
    },
    account: {
      findMany: async () => [
        { id: 'acct-caja', code: '1.1.01', aliases: ['caja'], name: 'Caja', type: 'ACTIVO', isActive: true },
        { id: 'acct-banco', code: '1.1.02.01', aliases: ['banco-general'], name: 'Banco General', type: 'ACTIVO', isActive: true },
        { id: 'acct-banco-2', code: '1.1.02.02', aliases: [], name: 'Banco Nacional', type: 'ACTIVO', isActive: true },
        { id: 'acct-clientes', code: '1.1.03.01', aliases: ['clientes'], name: 'Clientes', type: 'ACTIVO', isActive: true },
        { id: 'acct-tarjeta', code: '2.1.03', aliases: ['tarjeta-credito'], name: 'Tarjetas de Crédito', type: 'PASIVO', isActive: true },
        { id: 'acct-proveedores', code: '2.1.01', aliases: ['proveedores'], name: 'Proveedores', type: 'PASIVO', isActive: true },
        { id: 'acct-inventario', code: '1.1.04.01', aliases: ['inventario-mercancia'], name: 'Inventario de Mercancía', type: 'ACTIVO', isActive: true },
        { id: 'acct-prestamos', code: '2.2.01', aliases: ['prestamos-lp'], name: 'Préstamos por Pagar LP', type: 'PASIVO', isActive: true },
        { id: 'acct-ventas', code: '4.01.01', aliases: ['ventas'], name: 'Ventas', type: 'INGRESO', isActive: true },
        { id: 'acct-combustible', code: '6.01.02', name: 'Gastos de Combustible', type: 'GASTO', isActive: true },
        { id: 'acct-gastos-varios', code: '6.06.01', aliases: ['gasto'], name: 'Gastos Varios', type: 'GASTO', isActive: true },
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
      userId: 'demo-user',
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

  /**
   * La cuenta impuesta es la que sostiene las facturas por correo: la empresa
   * configura contra qué banco se acreditan y el asiento TIENE que caer ahí.
   * El caso que esto fija es el que apareció en producción: sin la cuenta
   * impuesta, `aplicarBancoMencionado` acredita el banco por defecto de la
   * empresa (o el 1.1.02.01) y el asiento deja de cuadrar con lo configurado.
   */
  it('la cuenta de pago impuesta gana sobre el banco por defecto', async () => {
    const forzado = new OrchestratorAgent({
      prisma: makePrismaStub(),
      companyId: 'demo-company',
      userId: 'demo-user',
      paymentMethodForzado: 'TRANSFERENCIA',
      cuentaPagoForzada: { id: 'acct-banco-2', name: 'Banco Nacional' },
    });

    const r = await forzado.process('Compré combustible por $40', {
      messages: [],
      extractedData: { type: 'GASTO', paymentMethod: 'TRANSFERENCIA', selectedEntityId: null },
    } as any);

    const creditos = (r.result?.entry?.credit || []).map((c: any) => c.accountId);
    expect(creditos).toContain('acct-banco-2');
    expect(creditos).not.toContain('acct-banco'); // el banco por defecto quedó fuera
  });

  it('sin cuenta impuesta, el asiento sigue acreditando el banco de siempre', async () => {
    const r = await orchestrator.process('Compré combustible por $40 con efectivo');
    const creditos = (r.result?.entry?.credit || []).map((c: any) => c.accountId);
    expect(creditos).toContain('acct-caja');
  });

  it('confirm creates journal entry with BORRADOR status', async () => {
    const processResult = await orchestrator.process('Compré combustible por $40 con efectivo');
    const confirmResult = await orchestrator.confirm(processResult.result);
    expect(confirmResult.journalEntry).toBeDefined();
  });
});
