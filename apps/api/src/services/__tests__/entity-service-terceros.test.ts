import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncEntityFromEntry } from '../entity-service';
import { hashRucBase } from '@agt-contador/shared';

function fakePrisma(metadata: Record<string, any>, type = 'GASTO', concept = '') {
  const rows: Record<'client' | 'supplier', any[]> = { client: [], supplier: [] };
  const bills: any[] = [];
  const invoices: any[] = [];
  const txnUpdates: any[] = [];
  let seq = 0;

  const model = (name: 'client' | 'supplier') => ({
    async findFirst({ where }: any) {
      return rows[name].find((r) =>
        (!where.companyId || r.companyId === where.companyId)
        && (where.taxIdHash === undefined || r.taxIdHash === where.taxIdHash)
        && (where.name?.equals === undefined || String(r.name).toLowerCase() === String(where.name.equals).toLowerCase())) || null;
    },
    async findMany({ where }: any) {
      return rows[name].filter((r) => !where?.companyId || r.companyId === where.companyId).map((r) => ({ id: r.id, name: r.name }));
    },
    async create({ data }: any) {
      const row = { id: `${name[0]}${++seq}`, ...data };
      rows[name].push(row);
      return row;
    },
    async update({ where, data }: any) {
      const row = rows[name].find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  });

  return {
    rows, bills, invoices, txnUpdates,
    journalEntry: { findUnique: async () => null },
    transaction: {
      findFirst: async () => ({ id: 'tx1', type, concept, metadata: JSON.stringify(metadata), amount: 100, description: 'Compra' }),
      update: async ({ where, data }: any) => { txnUpdates.push({ where, data }); return {}; },
    },
    invoice: {
      findMany: async () => invoices,
      findFirst: async () => null,
      delete: async () => {},
      create: async ({ data }: any) => { invoices.push(data); return data; },
    },
    bill: {
      findMany: async () => bills,
      findFirst: async () => null,
      delete: async () => {},
      create: async ({ data }: any) => { bills.push(data); return data; },
      update: async () => {},
    },
    client: model('client'),
    supplier: model('supplier'),
  };
}

const entry = (lines: any[]) => ({ id: 'je1', date: '2026-10-26T12:00:00.000Z', description: 'Compra al contado', lines });

describe('terceros desde el asiento', () => {
  const original = process.env.FIELD_ENC_KEY;
  beforeEach(() => { process.env.FIELD_ENC_KEY = Buffer.alloc(32, 9).toString('base64'); });
  afterEach(() => {
    if (original === undefined) delete process.env.FIELD_ENC_KEY;
    else process.env.FIELD_ENC_KEY = original;
  });

  it('una compra al contado (sin CxP) crea el proveedor y NO crea Bill', async () => {
    const prisma: any = fakePrisma({ provider: 'FERRETERÍA XYZ', ruc: '8-733-2267-88', fiscalSource: 'PDF' });
    const lines = [
      { account: { code: '6.01.01' }, debit: 100, credit: 0 },
      { account: { code: '1.1.02.01' }, debit: 0, credit: 100 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toMatchObject({ type: 'proveedor_maestro', name: 'FERRETERÍA XYZ' });
    expect(prisma.rows.supplier).toHaveLength(1);
    const s = prisma.rows.supplier[0];
    expect(s.taxId).toBe('8-733-2267');
    expect(s.dv).toBe('88');
    expect(s.taxIdHash).toBe(hashRucBase('8-733-2267'));
    expect(prisma.bills).toHaveLength(0);
    // La transacción queda vinculada al tercero, aunque no haya Bill.
    const meta = JSON.parse(prisma.txnUpdates[0].data.metadata);
    expect(meta.supplierId).toBe(s.id);
  });

  it('una compra a crédito (CxP) crea proveedor + Bill, sin duplicar el maestro', async () => {
    const prisma: any = fakePrisma({ provider: 'RIBA SMITH S A', ruc: '342-240-75526-50' });
    const lines = [
      { account: { code: '6.01.01' }, debit: 100, credit: 0 },
      { account: { code: '2.1.01' }, debit: 0, credit: 100 },
    ];

    await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(prisma.rows.supplier).toHaveLength(1);
    expect(prisma.bills).toHaveLength(1);
    expect(prisma.rows.supplier[0]).toMatchObject({ taxId: '342-240-75526', dv: '50' });
  });

  it('una venta al contado (o de servicios) alimenta el maestro de clientes, no el de proveedores', async () => {
    const prisma: any = fakePrisma({ provider: 'CLIENTE XYZ', ruc: '8-999-123' }, 'VENTA');
    const lines = [
      { account: { code: '1.1.01' }, debit: 100, credit: 0 },
      { account: { code: '4.01.01' }, debit: 0, credit: 100 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toMatchObject({ type: 'cliente_maestro', name: 'CLIENTE XYZ' });
    expect(prisma.rows.client).toHaveLength(1);
    expect(prisma.rows.client[0].taxId).toBe('8-999-123');
    expect(prisma.rows.supplier).toHaveLength(0);
    expect(prisma.invoices).toHaveLength(0); // al contado no hay CxC/Invoice
    const meta = JSON.parse(prisma.txnUpdates[0].data.metadata);
    expect(meta.clientId).toBe(prisma.rows.client[0].id);
  });

  it('un cobro a una CxC no crea una Invoice nueva, pero sí alimenta el cliente', async () => {
    const prisma: any = fakePrisma({ provider: 'CLIENTE XYZ' }, 'COBRO_CLIENTE');
    const lines = [
      { account: { code: '1.1.02.01' }, debit: 100, credit: 0 },
      { account: { code: '1.1.03.01' }, debit: 0, credit: 100 }, // CxC al HABER = cobro
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toMatchObject({ type: 'cliente_maestro' });
    expect(prisma.rows.client).toHaveLength(1);
    expect(prisma.invoices).toHaveLength(0);
    expect(prisma.rows.supplier).toHaveLength(0);
  });

  it('un pago a una CxP no crea un Bill nuevo ni un proveedor', async () => {
    const prisma: any = fakePrisma({ provider: 'PROVEEDOR XYZ' }, 'PAGO_PROVEEDOR');
    const lines = [
      { account: { code: '2.1.01' }, debit: 100, credit: 0 }, // CxP al DEBE = pago
      { account: { code: '1.1.02.01' }, debit: 0, credit: 100 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toBeNull();
    expect(prisma.bills).toHaveLength(0);
    expect(prisma.rows.supplier).toHaveLength(0);
  });

  it('un débito en cuenta Anexo crea el proveedor con el concepto en Notas', async () => {
    // Tipo distinto de GASTO/COMPRA y sin línea 5.x/6.x: sin la regla de Anexo
    // este asiento NO creaba proveedor. La cuenta Anexo es la que lo justifica.
    const prisma: any = fakePrisma(
      { provider: 'CONSULTORA XYZ', ruc: '8-123-456' },
      'ACTIVO',
      'Honorarios',
    );
    const lines = [
      { account: { code: '1.1.04.01', name: 'Activo', requiresAnexo: true }, debit: 100, credit: 0 },
      { account: { code: '1.1.02.01', name: 'Banco', requiresAnexo: false }, debit: 0, credit: 100 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toMatchObject({ type: 'proveedor_maestro', name: 'CONSULTORA XYZ' });
    expect(prisma.rows.supplier).toHaveLength(1);
    expect(prisma.rows.supplier[0].notes).toBe('Concepto: Honorarios');
    expect(prisma.bills).toHaveLength(0);
  });

  it('una compra a crédito en cuenta Anexo crea Bill y deja la nota', async () => {
    const prisma: any = fakePrisma(
      { provider: 'CONSULTORA XYZ', ruc: '8-123-456' },
      'COMPRA',
      'Honorarios',
    );
    const lines = [
      {
        account: { code: '6.02.01', name: 'Honorarios Profesionales', requiresAnexo: true },
        debit: 100,
        credit: 0,
      },
      { account: { code: '2.1.01', name: 'Proveedores' }, debit: 0, credit: 100 },
    ];

    await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(prisma.rows.supplier).toHaveLength(1);
    expect(prisma.rows.supplier[0].notes).toBe('Concepto: Honorarios');
    expect(prisma.bills).toHaveLength(1);
  });

  it('una venta con costo en cuenta Anexo no crea proveedor', async () => {
    // 5.01.01 está marcada Anexo para la compra; en una venta con inventario el
    // débito es el costo de lo vendido y el nombre de la metadata es el CLIENTE.
    const prisma: any = fakePrisma({ provider: 'CLIENTE XYZ' }, 'VENTA', 'Ventas');
    const lines = [
      { account: { code: '1.1.01', name: 'Caja' }, debit: 100, credit: 0 },
      { account: { code: '4.01.01', name: 'Ventas' }, debit: 0, credit: 100 },
      {
        account: { code: '5.01.01', name: 'Costo de Productos Vendidos', requiresAnexo: true },
        debit: 50,
        credit: 0,
      },
      { account: { code: '1.1.04.01', name: 'Inventario' }, debit: 0, credit: 50 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toMatchObject({ type: 'cliente_maestro' });
    expect(prisma.rows.client).toHaveLength(1);
    expect(prisma.rows.supplier).toHaveLength(0);
  });

  it('si el proveedor ya existe, la nota no se pisa', async () => {
    const prisma: any = fakePrisma({ provider: 'CONSULTORA XYZ', ruc: '8-123-456' }, 'GASTO', 'Honorarios');
    prisma.rows.supplier.push({
      id: 's1',
      companyId: 'co-1',
      name: 'CONSULTORA XYZ',
      taxId: '8-123-456',
      notes: 'Nota del usuario',
    });
    const lines = [
      {
        account: { code: '6.02.01', name: 'Honorarios Profesionales', requiresAnexo: true },
        debit: 100,
        credit: 0,
      },
      { account: { code: '1.1.02.01', name: 'Banco' }, debit: 0, credit: 100 },
    ];

    await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(prisma.rows.supplier).toHaveLength(1);
    expect(prisma.rows.supplier[0].notes).toBe('Nota del usuario');
  });
});
