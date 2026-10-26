import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { findOrCreateClient, findOrCreateSupplier } from '../counterparty';
import { hashField, hashRucBase } from '@agt-contador/shared';

/**
 * Prisma de mentira con lo mínimo que usa counterparty: findFirst/findMany/
 * create/update por companyId, taxIdHash e id. Permite verificar la identidad
 * canónica (RUC base + DV) y el relleno sin sobrescritura.
 */
function fakePrisma() {
  const rows: Record<'client' | 'supplier', any[]> = { client: [], supplier: [] };
  let seq = 0;

  const model = (name: 'client' | 'supplier') => ({
    async findFirst({ where }: any) {
      return rows[name].find((r) => match(r, where)) || null;
    },
    async findMany({ where }: any) {
      return rows[name].filter((r) => match(r, where)).map((r) => ({ id: r.id, name: r.name }));
    },
    async create({ data }: any) {
      const row = { id: `${name[0]}${++seq}`, ...data };
      rows[name].push(row);
      return row;
    },
    async update({ where, data }: any) {
      const row = rows[name].find((r) => r.id === where.id);
      if (!row) throw new Error('no existe');
      Object.assign(row, data);
      return row;
    },
  });

  function match(row: any, where: any): boolean {
    if (where.companyId && row.companyId !== where.companyId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.taxIdHash !== undefined && row.taxIdHash !== where.taxIdHash) return false;
    if (where.name?.equals !== undefined) {
      const a = String(row.name).toLowerCase();
      const b = String(where.name.equals).toLowerCase();
      if (a !== b) return false;
    }
    return true;
  }

  return { client: model('client'), supplier: model('supplier'), rows };
}

describe('identidad canónica de terceros', () => {
  const original = process.env.FIELD_ENC_KEY;
  beforeEach(() => {
    process.env.FIELD_ENC_KEY = Buffer.alloc(32, 3).toString('base64');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FIELD_ENC_KEY;
    else process.env.FIELD_ENC_KEY = original;
  });

  it('crea el cliente con RUC base + DV separado y hash canónico', async () => {
    const prisma: any = fakePrisma();
    const c = await findOrCreateClient(prisma, 'co-1', {
      name: 'FERRETERÍA EL TORNILLO, S.A.',
      taxId: '342-240-75526-50',
      address: 'Calle 1',
      fiscalSource: 'XML',
    });

    expect(c.taxId).toBe('342-240-75526');
    expect(c.dv).toBe('50');
    expect(c.taxIdHash).toBe(hashRucBase('342-240-75526'));
    expect(c.fiscalSource).toBe('XML');
  });

  it('el mismo RUC con y sin DV encuentra el mismo cliente y completa sin pisar', async () => {
    const prisma: any = fakePrisma();
    const primero = await findOrCreateClient(prisma, 'co-1', {
      name: 'Ferretería El Tornillo, S.A.',
      taxId: '342-240-75526-50',
      address: 'Calle 1',
      phone: '+507 6000-0000',
    });

    const segundo = await findOrCreateClient(prisma, 'co-1', {
      name: 'Ferreteria El Tornillo',
      taxId: '342-240-75526',
      address: 'OTRA DIRECCIÓN', // no debe pisar
      email: 'compras@tornillo.com', // sí debe completar
    });

    expect(segundo.id).toBe(primero.id);
    expect(prisma.rows.client).toHaveLength(1);
    expect(segundo.address).toBe('Calle 1');
    expect(segundo.email).toBe('compras@tornillo.com');
    expect(segundo.dv).toBe('50');
  });

  it('compatibilidad: encuentra un hash legacy calculado sobre el RUC con guiones', async () => {
    const prisma: any = fakePrisma();
    // Registro viejo: hash sobre el texto crudo, sin DV separado.
    await prisma.client.create({
      data: { companyId: 'co-1', name: 'RIBA SMITH S A', taxId: '8-733-2267', taxIdHash: hashField('8-733-2267') },
    });

    const encontrado = await findOrCreateClient(prisma, 'co-1', {
      name: 'RIBA SMITH, S.A.',
      taxId: '8-733-2267-88',
    });

    expect(encontrado.id).toBe('c1');
    expect(prisma.rows.client).toHaveLength(1);
    expect(encontrado.dv).toBe('88');
  });

  it('el proveedor guarda DV, dirección y ubicación en el alta', async () => {
    const prisma: any = fakePrisma();
    const s = await findOrCreateSupplier(prisma, 'co-1', {
      name: 'RIBA SMITH S A',
      taxId: '8-733-2267-88',
      phone: '+507 300-0000',
      address: 'Zona Industrial',
      location: '8-8-8',
      taxIdType: 'RUC',
      fiscalSource: 'PDF',
    });

    expect(s.taxId).toBe('8-733-2267');
    expect(s.dv).toBe('88');
    expect(s.address).toBe('Zona Industrial');
    expect(s.location).toBe('8-8-8');
    expect(s.fiscalSource).toBe('PDF');
  });
});
