import { describe, it, expect } from 'vitest';
import { crearTransaccionReversion } from '../reversion-transaction';

const opts = {
  companyId: 'co-1',
  userId: 'u1',
  journalEntryId: 'je-rev',
  originalJournalEntryId: 'je-orig',
  description: 'ANULACIÓN: Compra',
  date: new Date('2026-10-27T12:00:00Z'),
  source: 'anulacion' as const,
};

function fakeTx(original: any) {
  const created: any[] = [];
  return {
    created,
    transaction: {
      findFirst: async () => original,
      create: async ({ data }: any) => {
        created.push(data);
        return { id: 'rev-tx', ...data };
      },
    },
  };
}

describe('Transaction espejo de anulación/corrección', () => {
  it('crea el importe negativo con la metadata y el tercero del original', async () => {
    const tx = fakeTx({
      amount: 100,
      type: 'GASTO',
      concept: 'Honorarios',
      paymentMethod: null,
      metadata: JSON.stringify({
        provider: 'PROVEEDOR XYZ',
        ruc: '8-1-1',
        supplierId: 's1',
        invoiceNumber: 'A-1',
      }),
    });

    const r: any = await crearTransaccionReversion(tx as any, opts);

    expect(r.amount).toBe(-100);
    expect(r.type).toBe('GASTO');
    expect(r.concept).toBe('Honorarios');
    expect(r.journalEntryId).toBe('je-rev');
    expect(JSON.parse(r.metadata)).toMatchObject({
      provider: 'PROVEEDOR XYZ',
      ruc: '8-1-1',
      supplierId: 's1',
      invoiceNumber: 'A-1',
      source: 'anulacion',
      reversalOf: 'je-orig',
    });
  });

  it('no inventa un reverso si el original no tenía tercero', async () => {
    const tx = fakeTx({
      amount: 100,
      type: 'GASTO',
      concept: null,
      paymentMethod: null,
      metadata: JSON.stringify({ source: 'inventario' }),
    });

    expect(await crearTransaccionReversion(tx as any, opts)).toBeNull();
    expect(tx.created).toHaveLength(0);
  });

  it('no crea nada si el original no tiene Transaction', async () => {
    const tx = fakeTx(null);
    expect(await crearTransaccionReversion(tx as any, opts)).toBeNull();
    expect(tx.created).toHaveLength(0);
  });

  it('si el original ya era un reverso negativo, el espejo es positivo', async () => {
    const tx = fakeTx({
      amount: -100,
      type: 'GASTO',
      concept: 'Anulación',
      paymentMethod: null,
      metadata: JSON.stringify({ provider: 'PROVEEDOR XYZ' }),
    });

    const r: any = await crearTransaccionReversion(tx as any, { ...opts, source: 'reversion' });
    expect(r.amount).toBe(100);
    expect(JSON.parse(r.metadata).source).toBe('reversion');
  });
});
