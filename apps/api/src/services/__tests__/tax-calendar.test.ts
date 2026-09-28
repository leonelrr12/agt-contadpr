import { describe, it, expect } from 'vitest';
import { getSaldoITBMS } from '../tax-calendar';

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
