import { describe, it, expect } from 'vitest';
import { buildAnexosDgiReport } from '../reports';

/**
 * Anexos-DGI por cuenta. El Detalle de cada fila es el del MOVIMIENTO
 * (`Transaction.description`), no la metadata: la metadata nunca guardó texto
 * —solo provider/ruc/reference/invoiceNumber— y el anexo lo leía de ahí, así
 * que la columna salía vacía en todas las filas.
 */

const cuenta = { id: 'acc-1', code: '6.02.01', name: 'Honorarios', requiresAnexo: true };

const prismaStub = (txs: any[], extras: { invoices?: any[]; bills?: any[] } = {}) => ({
  journalEntry: { findFirst: async () => null }, // sin asientos: año calendario
  transaction: { findMany: async () => txs },
  invoice: { findMany: async () => extras.invoices ?? [] },
  bill: { findMany: async () => extras.bills ?? [] },
});

const tx = (over: Record<string, any>) => ({
  id: 't1', date: new Date('2026-03-10T12:00:00Z'), amount: 100,
  metadata: JSON.stringify({ provider: 'FERRETERIA CENTRAL', ruc: '8-123-456' }),
  journalEntryId: 'je-1', type: 'GASTO', description: null, concept: null, ...over,
});

const detalle = (r: any) => r.terceros[0].detalle[0];

describe('Anexos-DGI: detalle y factura por movimiento', () => {
  it('el detalle es el del movimiento (columna description)', async () => {
    const r = await buildAnexosDgiReport(prismaStub([tx({ description: 'Compra de Materiales' })]) as any, 'c1', { cuenta });
    expect(detalle(r).detalle).toBe('Compra de Materiales');
  });

  it('sin descripción cae al concepto clasificado', async () => {
    const r = await buildAnexosDgiReport(prismaStub([tx({ concept: 'Materia prima' })]) as any, 'c1', { cuenta });
    expect(detalle(r).detalle).toBe('Materia prima');
  });

  it('la factura sale de la metadata, del Bill del asiento o de la referencia', async () => {
    const conMeta = await buildAnexosDgiReport(
      prismaStub([tx({ metadata: JSON.stringify({ provider: 'X', invoiceNumber: 'FE-001' }) })]) as any, 'c1', { cuenta });
    expect(detalle(conMeta).factura).toBe('FE-001');

    const conBill = await buildAnexosDgiReport(
      prismaStub([tx({})], { bills: [{ journalEntryId: 'je-1', number: 'B-77' }] }) as any, 'c1', { cuenta });
    expect(detalle(conBill).factura).toBe('B-77');

    const conRef = await buildAnexosDgiReport(
      prismaStub([tx({ metadata: JSON.stringify({ provider: 'X', reference: 'REF-9' }) })]) as any, 'c1', { cuenta });
    expect(detalle(conRef).factura).toBe('REF-9');

    const sinNada = await buildAnexosDgiReport(prismaStub([tx({})]) as any, 'c1', { cuenta });
    expect(detalle(sinNada).factura).toBeNull();
  });

  it('agrupa por tercero+RUC y totaliza', async () => {
    const r = await buildAnexosDgiReport(prismaStub([
      tx({ id: 't1', description: 'Uno', amount: 100 }),
      tx({ id: 't2', description: 'Dos', amount: 50.5 }),
      tx({ id: 't3', description: 'Otro', amount: 20, metadata: JSON.stringify({ provider: 'OTRO', ruc: '8-999' }) }),
    ]) as any, 'c1', { cuenta });
    expect(r.totalTerceros).toBe(2);
    expect(r.terceros[0].detalle.map((f: any) => f.detalle)).toEqual(['Uno', 'Dos']);
    expect(r.terceros[0].total).toBe(150.5);
    expect(r.total).toBe(170.5);
  });

  it('una transacción sin tercero no entra al anexo', async () => {
    const r = await buildAnexosDgiReport(prismaStub([
      tx({ description: 'Sin proveedor', metadata: JSON.stringify({ source: 'import-masivo' }) }),
    ]) as any, 'c1', { cuenta });
    expect(r.totalTerceros).toBe(0);
  });
});
