import { describe, it, expect } from 'vitest';
import { fusionarTercero } from '../tercero-merge';

function fakePrisma(opts: {
  client?: any[];
  supplier?: any[];
  transactions?: any[];
  counts?: Partial<Record<'bills' | 'invoices' | 'retenciones' | 'workerAccounts' | 'inventoryMovements', number>>;
}) {
  const updates: any[] = [];
  const deletes: any[] = [];
  const txUpdates: any[] = [];
  const ops: string[] = [];
  const prisma: any = {
    $transaction: async (cb: any) => cb(prisma),
    client: {
      findFirst: async ({ where }: any) => (opts.client || []).find((x) => x.id === where.id) || null,
      update: async ({ where, data }: any) => {
        updates.push({ model: 'client', where, data });
        ops.push(`update:client:${where.id}`);
        return { id: where.id, ...data };
      },
      delete: async ({ where }: any) => {
        deletes.push({ model: 'client', where });
        ops.push(`delete:client:${where.id}`);
        return { id: where.id };
      },
    },
    supplier: {
      findFirst: async ({ where }: any) => (opts.supplier || []).find((x) => x.id === where.id) || null,
      update: async ({ where, data }: any) => {
        updates.push({ model: 'supplier', where, data });
        ops.push(`update:supplier:${where.id}`);
        return { id: where.id, ...data };
      },
      delete: async ({ where }: any) => {
        deletes.push({ model: 'supplier', where });
        ops.push(`delete:supplier:${where.id}`);
        return { id: where.id };
      },
    },
    bill: { updateMany: async () => ({ count: opts.counts?.bills ?? 0 }) },
    workerAccount: { updateMany: async () => ({ count: opts.counts?.workerAccounts ?? 0 }) },
    inventoryMovement: { updateMany: async () => ({ count: opts.counts?.inventoryMovements ?? 0 }) },
    invoice: { updateMany: async () => ({ count: opts.counts?.invoices ?? 0 }) },
    retentionItbms: { updateMany: async () => ({ count: opts.counts?.retenciones ?? 0 }) },
    transaction: {
      findMany: async () => opts.transactions || [],
      update: async ({ where, data }: any) => {
        txUpdates.push({ where, metadata: JSON.parse(data.metadata) });
        return { id: where.id, ...data };
      },
    },
  };
  return { prisma, updates, deletes, txUpdates, ops };
}

const proveedorOrigen = {
  id: 's1', name: 'Ferrteria El Valle', taxId: null, dv: null, taxIdHash: null,
  phone: '6000-0000', email: null, address: null, location: null, tradeName: null,
  contactName: null, taxIdType: null, paymentTerms: '30', notes: 'nota dup',
  fiscalSource: 'MANUAL', fiscalUpdatedAt: null,
};
const proveedorDestino = {
  id: 's2', name: 'Ferreteria el valle', taxId: null, dv: null, taxIdHash: null,
  phone: null, email: null, address: null, location: null, tradeName: null,
  contactName: null, taxIdType: null, paymentTerms: '30', notes: null,
  fiscalSource: null, fiscalUpdatedAt: null,
};

describe('fusión de terceros', () => {
  it('proveedor: mueve Bill/WorkerAccount/InventoryMovement/Transactions y completa el maestro', async () => {
    const fake = fakePrisma({
      supplier: [proveedorOrigen, proveedorDestino],
      counts: { bills: 1, workerAccounts: 0, inventoryMovements: 2 },
      transactions: [
        { id: 't1', type: 'GASTO', metadata: JSON.stringify({ supplierId: 's1', provider: 'Ferrteria El Valle' }) },
        { id: 't2', type: 'COMPRA', metadata: JSON.stringify({ provider: 'Ferrteria El Valle' }) },
        { id: 't3', type: 'VENTA', metadata: JSON.stringify({ provider: 'Ferrteria El Valle' }) },
        { id: 't4', type: 'GASTO', metadata: JSON.stringify({ supplierId: 's2' }) },
      ],
    });

    const r = await fusionarTercero(fake.prisma, 'co-1', 'proveedor', 's1', 's2');

    expect(r.movidos).toEqual({
      bills: 1, invoices: 0, retenciones: 0, workerAccounts: 0,
      inventoryMovements: 2, transactions: 2,
    });
    const target = fake.updates.find((u) => u.model === 'supplier' && u.where.id === 's2');
    expect(target.data).toMatchObject({
      phone: '6000-0000',
      notes: 'nota dup',
      fiscalSource: 'MANUAL',
    });
    expect(target.data.name).toBeUndefined();
    expect(fake.deletes).toEqual([{ model: 'supplier', where: { id: 's1' } }]);
    // El delete va antes del update: si no, el hash del RUC del duplicado choca
    // con el unique (companyId, taxIdHash) al copiarlo al maestro.
    expect(fake.ops.indexOf('delete:supplier:s1')).toBeLessThan(fake.ops.indexOf('update:supplier:s2'));
    expect(fake.txUpdates.map((t) => t.where.id)).toEqual(['t1', 't2']);
    expect(fake.txUpdates.every((t) => t.metadata.supplierId === 's2')).toBe(true);
  });

  it('cliente: mueve Invoice/RetentionItbms y hereda el perfil de agente retenedor', async () => {
    const origen = {
      id: 'c1', name: 'Cliente Dup', taxId: '8-1', dv: '1', taxIdHash: 'h1',
      phone: null, email: null, address: null, location: null, tradeName: null,
      contactName: null, taxIdType: 'RUC', notes: null, fiscalSource: 'PDF',
      esAgenteRetenedor: true, porcentajeRetencionItbms: 0.5,
      vigenciaRetencionDesde: new Date('2026-01-01'), vigenciaRetencionHasta: null,
    };
    const destino = {
      id: 'c2', name: 'Cliente', taxId: null, dv: null, taxIdHash: null,
      phone: null, email: null, address: null, location: null, tradeName: null,
      contactName: null, taxIdType: null, notes: null, fiscalSource: null,
      esAgenteRetenedor: false, porcentajeRetencionItbms: 0.5,
      vigenciaRetencionDesde: null, vigenciaRetencionHasta: null,
    };
    const fake = fakePrisma({
      client: [origen, destino],
      counts: { invoices: 2, retenciones: 1 },
      transactions: [
        { id: 't1', type: 'VENTA', metadata: JSON.stringify({ clientId: 'c1' }) },
        { id: 't2', type: 'COBRO_CLIENTE', metadata: JSON.stringify({ provider: 'Cliente Dup' }) },
        { id: 't3', type: 'GASTO', metadata: JSON.stringify({ provider: 'Cliente Dup' }) },
        { id: 't4', type: 'VENTA', metadata: JSON.stringify({ clientId: 'c2' }) },
      ],
    });

    const r = await fusionarTercero(fake.prisma, 'co-1', 'cliente', 'c1', 'c2');

    expect(r.movidos).toEqual({
      bills: 0, invoices: 2, retenciones: 1, workerAccounts: 0,
      inventoryMovements: 0, transactions: 2,
    });
    const target = fake.updates.find((u) => u.model === 'client' && u.where.id === 'c2');
    expect(target.data).toMatchObject({
      taxId: '8-1',
      dv: '1',
      taxIdHash: 'h1',
      taxIdType: 'RUC',
      esAgenteRetenedor: true,
      porcentajeRetencionItbms: 0.5,
      fiscalSource: 'PDF',
    });
    expect(fake.txUpdates.map((t) => t.where.id)).toEqual(['t1', 't2']);
    expect(fake.deletes).toEqual([{ model: 'client', where: { id: 'c1' } }]);
    expect(fake.ops.indexOf('delete:client:c1')).toBeLessThan(fake.ops.indexOf('update:client:c2'));
  });

  it('exige forzar si los RUC son distintos', async () => {
    const origen = { ...proveedorOrigen, id: 's1', taxId: '8-1' };
    const destino = { ...proveedorDestino, id: 's2', taxId: '8-2' };
    const fake = fakePrisma({ supplier: [origen, destino] });

    await expect(fusionarTercero(fake.prisma, 'co-1', 'proveedor', 's1', 's2'))
      .rejects.toMatchObject({ status: 400, code: 'RUC_DISTINTO' });

    const r = await fusionarTercero(fake.prisma, 'co-1', 'proveedor', 's1', 's2', { forzar: true });
    expect(r.destino.id).toBe('s2');
    expect(fake.deletes).toHaveLength(1);
  });

  it('rechaza el mismo tercero y el que no existe', async () => {
    const fake = fakePrisma({ supplier: [proveedorOrigen, proveedorDestino] });
    await expect(fusionarTercero(fake.prisma, 'co-1', 'proveedor', 's1', 's1'))
      .rejects.toMatchObject({ status: 400 });
    await expect(fusionarTercero(fake.prisma, 'co-1', 'proveedor', 'no', 's2'))
      .rejects.toMatchObject({ status: 404 });
  });
});
