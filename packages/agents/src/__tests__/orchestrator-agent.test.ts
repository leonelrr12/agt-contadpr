import { describe, it, expect, beforeEach } from 'vitest';
import { OrchestratorAgent } from '../orchestrator-agent';
import { basePrismaStub } from './stubs';

function makePrismaStub() {
  let entryIdCounter = 0;
  const cuentas = [
    { id: 'acct-caja', code: '1.1.01', aliases: ['caja'], name: 'Caja', type: 'ACTIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-banco', code: '1.1.02.01', aliases: ['banco-general'], name: 'Banco General', type: 'ACTIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-banco-2', code: '1.1.02.02', aliases: [], name: 'Banco Nacional', type: 'ACTIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-clientes', code: '1.1.03.01', aliases: ['clientes'], name: 'Clientes', type: 'ACTIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-tarjeta', code: '2.1.03', aliases: ['tarjeta-credito'], name: 'Tarjetas de Crédito', type: 'PASIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-proveedores', code: '2.1.01', aliases: ['proveedores'], name: 'Proveedores', type: 'PASIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-inventario', code: '1.1.04.01', aliases: ['inventario-mercancia'], name: 'Inventario de Mercancía', type: 'ACTIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-prestamos', code: '2.2.01', aliases: ['prestamos-lp'], name: 'Préstamos por Pagar LP', type: 'PASIVO', isActive: true, requiresAnexo: false },
    { id: 'acct-ventas', code: '4.01.01', aliases: ['ventas'], name: 'Ventas', type: 'INGRESO', isActive: true, requiresAnexo: false },
    { id: 'acct-combustible', code: '6.01.02', name: 'Gastos de Combustible', type: 'GASTO', isActive: true, requiresAnexo: false },
    { id: 'acct-honorarios', code: '6.02.01', name: 'Honorarios Profesionales', type: 'GASTO', isActive: true, requiresAnexo: true },
    { id: 'acct-gastos-varios', code: '6.06.01', aliases: ['gasto'], name: 'Gastos Varios', type: 'GASTO', isActive: true, requiresAnexo: false },
  ];
  const createdSuppliers: any[] = [];
  const createdBills: any[] = [];
  const createdClients: any[] = [];
  const createdInvoices: any[] = [];
  return {
    ...basePrismaStub(),
    __createdSuppliers: createdSuppliers,
    __createdBills: createdBills,
    __createdClients: createdClients,
    __createdInvoices: createdInvoices,
    company: {
      findUnique: async () => ({ declaraITBMS: true }),
    },
    concept: {
      findMany: async () => [
        { name: 'Combustible', accountId: 'acct-combustible', confidence: 0.95, account: { name: 'Gastos de Combustible' } },
        { name: 'Honorarios', accountId: 'acct-honorarios', confidence: 0.95, account: { name: 'Honorarios Profesionales' } },
        { name: 'Ventas', accountId: 'acct-ventas', confidence: 0.95, account: { name: 'Ventas' } },
      ],
    },
    account: {
      findMany: async () => cuentas,
      findFirst: async (args: any) => cuentas.find((c) => c.id === args?.where?.id) || null,
    },
    supplier: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async (args: any) => {
        createdSuppliers.push(args.data);
        return { id: 'sup-1', ...args.data };
      },
      update: async (args: any) => ({ id: 'sup-1', ...args.data }),
    },
    bill: {
      findMany: async () => [],
      create: async (args: any) => {
        createdBills.push(args.data);
        return { id: 'bill-1', ...args.data };
      },
      update: async (args: any) => ({ id: 'bill-1', ...args.data }),
    },
    client: {
      findMany: async () => [],
      findFirst: async () => null,
      create: async (args: any) => {
        createdClients.push(args.data);
        return { id: 'cli-1', ...args.data };
      },
    },
    invoice: {
      findMany: async () => [],
      create: async (args: any) => {
        createdInvoices.push(args.data);
        return { id: 'inv-1', ...args.data };
      },
      update: async (args: any) => ({ id: 'inv-1', ...args.data }),
    },
    journalEntry: {
      create: async (args: any) => {
        entryIdCounter++;
        return { id: `entry-${entryIdCounter}`, ...args.data, createdAt: new Date(), updatedAt: new Date() };
      },
    },
    transaction: {
      create: async (args: any) => ({ id: `tx-${entryIdCounter}`, ...args.data }),
      findFirst: async () => ({ id: 'tx-1', metadata: '{}' }),
      update: async (args: any) => ({ id: 'tx-1', ...args.data }),
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

  it('una compra al contado de una EMPRESA (RUC) crea el proveedor maestro y NO crea Bill', async () => {
    const prisma: any = makePrismaStub();
    const agent = new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
    const result: any = {
      dialog: {
        type: 'GASTO',
        amount: 40,
        description: 'Combustible',
        concept: 'Combustible',
        paymentMethod: 'EFECTIVO',
        date: '2026-10-27',
        provider: 'FERRETERÍA XYZ',
        ruc: '8-733-2267-88',
        missingFields: [],
      },
      entry: {
        debit: [{ accountId: 'acct-combustible', amount: 40, name: 'Gastos de Combustible' }],
        credit: [{ accountId: 'acct-caja', amount: 40, name: 'Caja' }],
        description: 'Combustible',
      },
      classification: { accountId: 'acct-combustible', concept: 'Combustible', confidence: 0.95 },
    };

    const saved: any = await agent.confirm(result);
    expect(saved.autoCreated?.type).toBe('proveedor_nuevo');
    expect(prisma.__createdSuppliers).toHaveLength(1);
    expect(prisma.__createdSuppliers[0].name).toBeTruthy();
    expect(prisma.__createdBills).toHaveLength(0); // al contado no hay CxP
  });

  it('una cédula en un gasto sin Anexo NO crea proveedor (regla B)', async () => {
    const prisma: any = makePrismaStub();
    const agent = new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
    const result: any = {
      dialog: {
        type: 'GASTO',
        amount: 40,
        description: 'Combustible',
        concept: 'Combustible',
        paymentMethod: 'EFECTIVO',
        date: '2026-10-27',
        provider: 'CARLOS ORTIZ PINEDA',
        ruc: '4-756-445',
        missingFields: [],
      },
      entry: {
        debit: [{ accountId: 'acct-combustible', amount: 40, name: 'Gastos de Combustible' }],
        credit: [{ accountId: 'acct-caja', amount: 40, name: 'Caja' }],
        description: 'Combustible',
      },
      classification: { accountId: 'acct-combustible', concept: 'Combustible', confidence: 0.95 },
    };

    const saved: any = await agent.confirm(result);

    expect(saved.autoCreated).toBeNull();
    expect(prisma.__createdSuppliers).toHaveLength(0);
  });

  it('una venta al contado crea el cliente maestro y NO crea Invoice', async () => {
    const prisma: any = makePrismaStub();
    const agent = new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
    const result: any = {
      dialog: {
        type: 'VENTA',
        amount: 100,
        description: 'Venta de servicio',
        concept: 'Ventas',
        paymentMethod: 'EFECTIVO',
        date: '2026-10-27',
        provider: 'CLIENTE XYZ',
        ruc: '8-777-1',
        missingFields: [],
      },
      entry: {
        debit: [{ accountId: 'acct-caja', amount: 100, name: 'Caja' }],
        credit: [{ accountId: 'acct-ventas', amount: 100, name: 'Ventas' }],
        description: 'Venta de servicio',
      },
      classification: { accountId: 'acct-ventas', concept: 'Ventas', confidence: 0.95 },
    };

    const saved: any = await agent.confirm(result);

    expect(saved.autoCreated?.type).toBe('cliente_nuevo');
    expect(prisma.__createdClients).toHaveLength(1);
    expect(prisma.__createdClients[0].name).toBe('CLIENTE XYZ');
    expect(prisma.__createdInvoices).toHaveLength(0); // al contado no hay CxC
  });

  it('un gasto con Anexo crea el proveedor con el concepto en Notas', async () => {
    const prisma: any = makePrismaStub();
    const agent = new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
    const result: any = {
      dialog: {
        type: 'GASTO',
        amount: 100,
        description: 'Honorarios',
        concept: 'Honorarios',
        paymentMethod: 'EFECTIVO',
        date: '2026-10-27',
        provider: 'CONSULTORA XYZ',
        ruc: '8-123-456',
        missingFields: [],
      },
      entry: {
        debit: [{ accountId: 'acct-honorarios', amount: 100, name: 'Honorarios Profesionales' }],
        credit: [{ accountId: 'acct-caja', amount: 100, name: 'Caja' }],
        description: 'Honorarios',
      },
      classification: { accountId: 'acct-honorarios', concept: 'Honorarios', confidence: 0.95 },
    };

    const saved: any = await agent.confirm(result);

    expect(saved.autoCreated?.type).toBe('proveedor_nuevo');
    expect(prisma.__createdSuppliers).toHaveLength(1);
    expect(prisma.__createdSuppliers[0].notes).toBe('Concepto: Honorarios');
    expect(prisma.__createdBills).toHaveLength(0);
  });
});
