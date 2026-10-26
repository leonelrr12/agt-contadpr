import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registrarFacturaRecibida } from '../reembolsos';

function fakePrisma() {
  const suppliers: any[] = [];
  const claims: any[] = [];
  let seq = 0;
  const supplier = {
    async findFirst({ where }: any) {
      return suppliers.find((s) =>
        (!where.companyId || s.companyId === where.companyId)
        && (where.taxIdHash === undefined || s.taxIdHash === where.taxIdHash)
        && (where.name?.equals === undefined || String(s.name).toLowerCase() === String(where.name.equals).toLowerCase())) || null;
    },
    async findMany({ where }: any) {
      return suppliers.filter((s) => !where?.companyId || s.companyId === where.companyId).map((s) => ({ id: s.id, name: s.name }));
    },
    async create({ data }: any) {
      const row = { id: `s${++seq}`, ...data };
      suppliers.push(row);
      return row;
    },
    async update({ where, data }: any) {
      const row = suppliers.find((s) => s.id === where.id);
      Object.assign(row, data);
      return row;
    },
  };
  return {
    suppliers, claims, supplier,
    expenseClaim: {
      findFirst: async () => null,
      create: async ({ data }: any) => { const row = { id: 'claim1', ...data }; claims.push(row); return row; },
    },
  };
}

describe('registrarFacturaRecibida — maestro de proveedores', () => {
  const original = process.env.FIELD_ENC_KEY;
  beforeEach(() => { process.env.FIELD_ENC_KEY = Buffer.alloc(32, 5).toString('base64'); });
  afterEach(() => {
    if (original === undefined) delete process.env.FIELD_ENC_KEY;
    else process.env.FIELD_ENC_KEY = original;
  });

  it('crea/actualiza el proveedor con el perfil fiscal de la factura', async () => {
    const prisma: any = fakePrisma();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'co-1',
      workerId: null,
      journalEntry: { id: 'je1', date: '2026-10-26T12:00:00.000Z', lines: [{ debit: 100 }, { debit: 7 }] },
      tipo: 'GASTO',
      factura: {
        proveedor: 'FERRETERÍA XYZ',
        ruc: '8-733-2267-88',
        dv: '88',
        address: 'Calle 1',
        phone: '+507 6000-0000',
        email: 'compras@xyz.com',
        fecha: '2026-10-20',
        numeroFactura: '0001',
        total: 107,
        fiscalSource: 'XML',
      },
      origen: 'CORREO',
    });

    expect(r.creado).toBe(true);
    expect(prisma.suppliers).toHaveLength(1);
    expect(prisma.suppliers[0]).toMatchObject({
      companyId: 'co-1',
      name: 'FERRETERÍA XYZ',
      taxId: '8-733-2267',
      dv: '88',
      address: 'Calle 1',
      fiscalSource: 'XML',
    });
  });
});
