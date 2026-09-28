import { describe, it, expect } from 'vitest';
import { ultimosMeses, saldoCuentasPasivo, lineasPagoCSS } from '../payroll-css';
import type { CuentasPlanilla } from '../payroll-calc';
import { sumarMontos } from '../../lib/money';

/**
 * El único tramo puro del módulo de CSS. Se prueba porque el cruce de año es
 * exactamente donde estos helpers se rompen en silencio: en enero, "los últimos 6
 * meses" tienen que ser del año anterior y el orden tiene que seguir siendo
 * cronológico.
 */
describe('ultimosMeses', () => {
  it('devuelve los últimos N meses, del más viejo al más nuevo', () => {
    expect(ultimosMeses(3, new Date(2026, 8, 25))).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('cruza el año sin inventarse meses', () => {
    expect(ultimosMeses(4, new Date(2026, 1, 10))).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('un solo mes es el mes corriente', () => {
    expect(ultimosMeses(1, new Date(2026, 0, 1))).toEqual(['2026-01']);
  });

  it('rellena el mes con dos dígitos', () => {
    for (const periodo of ultimosMeses(12, new Date(2026, 11, 31))) {
      expect(periodo).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});

/**
 * El saldo del pasivo de la CSS se pide por CONCEPTO (obrero, patrono, riesgos) y
 * las cuentas pueden ser la misma. Contarla dos veces diría que se le debe el doble
 * a la CSS justo en las empresas que todavía no partieron su catálogo.
 */
describe('saldoCuentasPasivo', () => {
  /** Prisma de mentira: cada cuenta tiene el saldo que se le acreditó. */
  const prismaCon = (saldos: Record<string, number>) => ({
    journalLine: {
      aggregate: async ({ where }: any) => ({ _sum: { debit: 0, credit: saldos[where.accountId] ?? 0 } }),
    },
  });

  it('suma las subcuentas cuando el catálogo está partido', async () => {
    const prisma = prismaCon({ 'a-obrero': 100, 'a-patrono': 250, 'a-riesgos': 25 });
    expect(await saldoCuentasPasivo(prisma, 'c1', ['a-obrero', 'a-patrono', 'a-riesgos'])).toBe(375);
  });

  it('cuenta una sola vez la cuenta que resuelve por varios conceptos', async () => {
    const prisma = prismaCon({ 'a-obrero': 375 });
    expect(await saldoCuentasPasivo(prisma, 'c1', ['a-obrero', 'a-obrero', 'a-obrero'])).toBe(375);
  });

  it('ignora los conceptos sin cuenta resuelta', async () => {
    const prisma = prismaCon({ 'a-obrero': 100 });
    expect(await saldoCuentasPasivo(prisma, 'c1', ['a-obrero', null, ''])).toBe(100);
  });
});

/**
 * El pago a la CSS descarga CADA cuenta por pagar con su monto: con el catálogo
 * partido, un débito único a la cuenta del obrero dejaría las subcuentas del patrono
 * acreditadas para siempre.
 */
describe('lineasPagoCSS', () => {
  const cuentas = (over: Partial<CuentasPlanilla> = {}): CuentasPlanilla => ({
    sueldo: 'c-sueldo', horasExtras: 'c-extras', decimo: 'c-decimo', vacaciones: 'c-vacaciones',
    ss: 'c-ss', se: 'c-se', isr: 'c-isr', otrasDeducciones: 'c-otras',
    ssPatronal: 'c-ss-patronal', sePatronal: 'c-se-patronal', riesgosPatronal: 'c-riesgos-patronal',
    ssPatronalGasto: 'c-ss-pat-gasto', sePatronalGasto: 'c-se-pat-gasto', riesgosGasto: 'c-riesgos-gasto',
    decimoPorPagar: 'c-decimo-xp', vacacionesPorPagar: 'c-vacaciones-xp',
    prestacionesPorPagar: 'c-prestaciones-xp',
    ...over,
  });
  const debitos = (lineas: { debit: number }[]) => sumarMontos(...lineas.map((l) => l.debit));
  const creditos = (lineas: { credit: number }[]) => sumarMontos(...lineas.map((l) => l.credit));

  it('debita cada cuenta con su concepto y acredita el banco por el total', () => {
    const lineas = lineasPagoCSS(
      [
        { clave: 'ss', importe: 100 },
        { clave: 'ssPatronal', importe: 250 },
        { clave: 'riesgosPatronal', importe: 25 },
      ],
      cuentas(),
      'c-banco',
    );

    expect(lineas.find((l) => l.accountId === 'c-ss')!.debit).toBe(100);
    expect(lineas.find((l) => l.accountId === 'c-ss-patronal')!.debit).toBe(250);
    expect(lineas.find((l) => l.accountId === 'c-riesgos-patronal')!.debit).toBe(25);
    expect(lineas.find((l) => l.accountId === 'c-banco')!.credit).toBe(375);
    expect(debitos(lineas)).toBe(creditos(lineas));
  });

  it('funde en un solo débito los conceptos que caen en la misma cuenta', () => {
    // Catálogo sin partir: el pasivo del patrono y el de los riesgos SON el del
    // obrero. Tres líneas a la misma cuenta se leerían como un error de carga.
    const sinPartir = cuentas({ ssPatronal: 'c-ss', riesgosPatronal: 'c-ss' });
    const lineas = lineasPagoCSS(
      [
        { clave: 'ss', importe: 100 },
        { clave: 'ssPatronal', importe: 250 },
        { clave: 'riesgosPatronal', importe: 25 },
      ],
      sinPartir,
      'c-banco',
    );

    expect(lineas).toHaveLength(2);
    expect(lineas.find((l) => l.accountId === 'c-ss')!.debit).toBe(375);
    expect(lineas.find((l) => l.accountId === 'c-banco')!.credit).toBe(375);
  });

  it('no emite líneas de los conceptos que no se pagan', () => {
    const lineas = lineasPagoCSS(
      [
        { clave: 'ssPatronal', importe: 250 },
        { clave: 'se', importe: 0 },
        { clave: 'isr', importe: 0 },
      ],
      cuentas(),
      'c-banco',
    );

    expect(lineas).toHaveLength(2);
    expect(lineas.some((l) => l.accountId === 'c-se')).toBe(false);
  });
});
