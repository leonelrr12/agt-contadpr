import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { syncEntityFromEntry } from '../entity-service';
import { hashRucBase } from '@agt-contador/shared';

function fakePrisma(metadata: Record<string, any>, type = 'GASTO') {
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
      findFirst: async () => ({ id: 'tx1', type, metadata: JSON.stringify(metadata), amount: 100, description: 'Compra' }),
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

  it('un cobro/venta al contado no crea proveedor', async () => {
    const prisma: any = fakePrisma({ provider: 'CLIENTE XYZ' }, 'VENTA');
    const lines = [
      { account: { code: '1.1.01' }, debit: 100, credit: 0 },
      { account: { code: '4.01.01' }, debit: 0, credit: 100 },
    ];

    const r = await syncEntityFromEntry(prisma, 'co-1', entry(lines));

    expect(r).toBeNull();
    expect(prisma.rows.supplier).toHaveLength(0);
  });
});
