import { describe, it, expect } from 'vitest';
import { rangoDelMes, mesActual, comparativoEmpresas } from '../despacho-comparativo';

/**
 * El comparativo muestra, una al lado de la otra, las ventas/gastos/resultado de
 * cada empresa. Dos cosas no pueden fallar: que el rango del mes sea el correcto
 * (un día de corrimiento cambia el número del mes entero) y que una empresa rota
 * no deje sin comparativo a las demás.
 */

describe('rangoDelMes', () => {
  it('cubre el mes entero, del 1 a las 00:00 al último día a las 23:59', () => {
    const r = rangoDelMes('2026-10');
    expect(r.start.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(r.end.toISOString()).toBe('2026-10-31T23:59:59.999Z');
  });

  it('sabe cuántos días tiene cada mes (febrero incluido)', () => {
    expect(rangoDelMes('2026-02').end.toISOString()).toBe('2026-02-28T23:59:59.999Z');
    expect(rangoDelMes('2024-02').end.toISOString()).toBe('2024-02-29T23:59:59.999Z'); // bisiesto
    expect(rangoDelMes('2026-04').end.toISOString()).toBe('2026-04-30T23:59:59.999Z');
  });
});

describe('mesActual', () => {
  it('usa la zona de Panamá: a las 23:00 UTC todavía es el día —y el mes— anterior', () => {
    // 1 de noviembre 02:00 UTC = 31 de octubre 21:00 en Panamá
    expect(mesActual(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10');
    expect(mesActual(new Date('2026-11-01T06:00:00Z'))).toBe('2026-11');
  });
});

describe('comparativoEmpresas', () => {
  const prismaFalso = (porEmpresa: any) => ({
    journalEntry: {
      findFirst: async ({ where }: any) => porEmpresa[where.companyId]?.ultimoAsiento ?? null,
    },
    journalLine: {
      groupBy: async ({ where }: any) => porEmpresa[where.journalEntry.companyId]?.lineas ?? [],
    },
    account: {
      findMany: async ({ where }: any) => {
        const ids = where.id.in;
        const cuentas = Object.values(porEmpresa).flatMap((e: any) => e.cuentas || []);
        return cuentas.filter((c: any) => ids.includes(c.id));
      },
    },
  });

  const cuenta = (id: string, name: string, type: string) => ({ id, name, type });

  it('arma la fila de cada empresa con su mes y su año', async () => {
    const prisma = prismaFalso({
      c1: {
        ultimoAsiento: { date: new Date('2026-10-15T12:00:00') },
        cuentas: [cuenta('a1', 'Ventas', 'INGRESO'), cuenta('a2', 'Gastos', 'GASTO')],
        lineas: [
          { accountId: 'a1', _sum: { debit: 0, credit: 1000 } },
          { accountId: 'a2', _sum: { debit: 400, credit: 0 } },
        ],
      },
    });

    const [e] = await comparativoEmpresas(prisma, [{ id: 'c1', name: 'Uno', role: 'contador' }], '2026-10');

    expect(e.mes).toEqual({ ingresos: 1000, gastos: 400, resultado: 600, periodo: '2026-10' });
    expect(e.anio.resultado).toBe(600);
    expect(e.anio.desde).toBe(2026);
  });

  it('una empresa que falla queda en cero y las demás igual salen', async () => {
    const prisma: any = prismaFalso({
      c2: {
        ultimoAsiento: { date: new Date('2026-10-15T12:00:00') },
        cuentas: [cuenta('a1', 'Ventas', 'INGRESO')],
        lineas: [{ accountId: 'a1', _sum: { debit: 0, credit: 500 } }],
      },
    });
    const original = prisma.journalEntry.findFirst;
    prisma.journalEntry.findFirst = async (args: any) => {
      if (args.where.companyId === 'c1') throw new Error('esa empresa está rota');
      return original(args);
    };

    const r = await comparativoEmpresas(prisma, [
      { id: 'c1', name: 'Rota', role: 'contador' },
      { id: 'c2', name: 'Sana', role: 'contador' },
    ], '2026-10');

    expect(r[0].mes.resultado).toBe(0);
    expect(r[1].mes.ingresos).toBe(500);
  });
});
