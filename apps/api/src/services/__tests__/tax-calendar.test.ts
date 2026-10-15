import { describe, it, expect } from 'vitest';
import { getSaldoITBMS, estimateITBMS } from '../tax-calendar';

/**
 * El saldo de ITBMS que muestra el calendario fiscal. Se prueba por lo que costó:
 * exigir asientos CONFIRMADO dejaba el número en cero en una empresa con la
 * contabilidad cargada y sin aprobar —ODESA, 819 asientos en BORRADOR, calendario en
 * cero— y contradecía a los informes, que cuentan los borradores.
 */
describe('getSaldoITBMS', () => {
  /** Prisma de mentira: devuelve las líneas y deja ver con qué `where` se pidieron. */
  const prismaCon = (lineas: { debit: number; credit: number }[], capturado: any = {}) => ({
    journalLine: {
      findMany: async (args: any) => {
        capturado.where = args.where;
        return lineas;
      },
    },
  });

  it('créditos (ventas) menos débitos (compras y pagos a la DGI)', async () => {
    const prisma = prismaCon([
      { debit: 0, credit: 700 }, // ITBMS cobrado en una venta
      { debit: 200, credit: 0 }, // ITBMS de una compra (crédito fiscal)
    ]);
    expect(await getSaldoITBMS(prisma, 'c1')).toBe(500);
  });

  it('cuenta los BORRADORES: solo excluye RECHAZADO y ANULADO', async () => {
    const cap: any = {};
    await getSaldoITBMS(prismaCon([], cap), 'c1');
    expect(cap.where.journalEntry.status).toEqual({ notIn: ['RECHAZADO', 'ANULADO'] });
  });

  it('nunca devuelve negativo: un crédito fiscal a favor no es una deuda', async () => {
    const prisma = prismaCon([{ debit: 300, credit: 100 }]);
    expect(await getSaldoITBMS(prisma, 'c1')).toBe(0);
  });

  it('redondea a dos decimales', async () => {
    const prisma = prismaCon([{ debit: 0, credit: 0.1 + 0.2 }]);
    expect(await getSaldoITBMS(prisma, 'c1')).toBe(0.3);
  });
});

/**
 * El corte del mes del estimado. El bug: `new Date(year, month, 0)` es la MEDIANOCHE
 * del último día y los asientos se guardan a mediodía local (`parseLocalDate`), así
 * que todo lo cargado el último día del mes quedaba fuera del estimado que el
 * calendario le enseña al contador como «lo que vas a deber».
 */
describe('estimateITBMS', () => {
  /** Prisma de mentira que aplica el filtro de fecha como lo haría la BD. */
  const prismaConAsientos = (asientos: { fecha: Date; debit: number; credit: number }[]) => ({
    journalLine: {
      findMany: async (args: any) => asientos.filter((a) => a.fecha <= args.where.journalEntry.date.lte),
    },
  });

  it('⭐ incluye los asientos del ÚLTIMO día del mes (a mediodía local)', async () => {
    const prisma = prismaConAsientos([
      { fecha: new Date(2026, 8, 15, 12, 0, 0), debit: 0, credit: 700 }, // dentro
      { fecha: new Date(2026, 8, 30, 12, 0, 0), debit: 0, credit: 300 }, // último día, mediodía
      { fecha: new Date(2026, 9, 1, 12, 0, 0), debit: 0, credit: 999 }, // ya es octubre
    ]);
    // Con el corte viejo (30-sep 00:00) esto daba 700: se perdía el asiento del día 30.
    expect(await estimateITBMS(prisma, 'c1', '2026-09')).toBe(1000);
  });

  it('incluye un reverso de anulación fechado el último día a cualquier hora', async () => {
    const prisma = prismaConAsientos([
      { fecha: new Date(2026, 8, 30, 23, 30, 0), debit: 50, credit: 0 }, // `new Date()` del reverso
    ]);
    expect(await estimateITBMS(prisma, 'c1', '2026-09')).toBe(0); // 50 de crédito fiscal netea a 0
  });

  it('diciembre cierra en su propio año', async () => {
    const prisma = prismaConAsientos([
      { fecha: new Date(2026, 11, 31, 12, 0, 0), debit: 0, credit: 120 },
      { fecha: new Date(2027, 0, 1, 12, 0, 0), debit: 0, credit: 500 },
    ]);
    expect(await estimateITBMS(prisma, 'c1', '2026-12')).toBe(120);
  });
});
