import { describe, it, expect } from 'vitest';
import { buildBudgetComparison, mesDeComparacion } from '../budget-comparison';
import { alertasDeComparativa } from '../salud';

/**
 * Las alertas de desviación son el semáforo de la comparativa traducido a
 * mensajes. Aquí se ejercita el semáforo REAL (no un doble), porque lo que puede
 * romperse es justo el acuerdo entre los dos módulos: qué se considera alerta y
 * qué no.
 *
 * El caso que más importa es el del presupuesto sin `mes`: medir el real de enero
 * a hoy contra el plan de los doce meses marca rojo a cualquiera que vaya al día.
 */
const COMPANY = 'company-1';
const YEAR = 2026; // el año "en curso" del stub
const MES_ACTUAL = 9; // el stub fecha el último asiento en septiembre

const cuenta = (id: string, code: string, name: string, type: string, parentId: string | null = null) => ({
  id,
  code,
  name,
  type,
  parentId,
  isActive: true,
});

const CATALOGO = [
  cuenta('acc-gasto', '6', 'GASTOS', 'GASTO'),
  cuenta('acc-personal', '6.01', 'Gastos de personal', 'GASTO', 'acc-gasto'),
  cuenta('acc-salarios', '6.01.01', 'Salarios', 'GASTO', 'acc-personal'),
  cuenta('acc-ing', '4', 'INGRESOS', 'INGRESO'),
  cuenta('acc-ventas', '4.01.01', 'Ventas', 'INGRESO', 'acc-ing'),
];

/** Stub de Prisma: solo lo que consume la comparativa (convención del repo, sin BD). */
function prismaStub(opts: {
  real?: { accountId: string; month: number; debit?: number; credit?: number }[];
  budget?: { accountId: string; month: number; amount: number }[];
  catalogo?: ReturnType<typeof cuenta>[];
  fechaAsiento?: string;
}) {
  return {
    journalEntry: { findFirst: async () => ({ date: new Date(opts.fechaAsiento || `${YEAR}-09-15T12:00:00Z`) }) },
    account: { findMany: async () => opts.catalogo || CATALOGO },
    budget: { findMany: async () => (opts.budget || []).filter((b) => b.amount > 0) },
    $queryRawUnsafe: async () =>
      (opts.real || []).map((r) => ({
        account_id: r.accountId,
        month: `${YEAR}-${String(r.month).padStart(2, '0')}`,
        deb: r.debit || 0,
        cred: r.credit || 0,
      })),
  };
}

/** Comparativa del período en curso — el uso correcto, el que hace salud.ts. */
const comparar = (opts: Parameters<typeof prismaStub>[0], extra: Record<string, unknown> = {}) =>
  buildBudgetComparison(prismaStub(opts) as never, COMPANY, { year: YEAR, mes: MES_ACTUAL, ...extra });

describe('alertasDeComparativa — desviación de gasto', () => {
  it('una categoría 20% por encima del presupuesto es una alerta crítica que la nombra', async () => {
    const cmp = await comparar({
      budget: [{ accountId: 'acc-salarios', month: 1, amount: 1000 }],
      real: [{ accountId: 'acc-salarios', month: 1, debit: 1200 }],
    });
    const alertas = alertasDeComparativa(cmp);
    const cat = alertas.find((a) => a.mensaje.includes('Gastos de personal'));
    expect(cat).toBeDefined();
    expect(cat!.tipo).toBe('PRESUPUESTO');
    expect(cat!.severidad).toBe('critical');
    expect(cat!.mensaje).toContain('20%');
  });

  it('gastar 30% por debajo del presupuesto es informativo, nunca crítico', async () => {
    const cmp = await comparar({
      budget: [{ accountId: 'acc-salarios', month: 1, amount: 1000 }],
      real: [{ accountId: 'acc-salarios', month: 1, debit: 700 }],
    });
    const alertas = alertasDeComparativa(cmp).filter((a) => a.mensaje.includes('Gastos de personal'));
    expect(alertas).toHaveLength(1);
    expect(alertas[0].severidad).toBe('info');
    expect(alertas[0].mensaje).toContain('mejor de lo previsto');
  });
});

describe('alertasDeComparativa — el ruido del gasto sin presupuesto', () => {
  it('cuentas con movimiento y sin presupuesto no generan ninguna alerta', async () => {
    // Doce cuentas con real y sin presupuesto: en la grilla salen rojas, pero como
    // alertas inundarían el panel y no son desviaciones sino huecos de captura.
    const catalogo = [cuenta('acc-gasto', '6', 'GASTOS', 'GASTO')];
    const real: { accountId: string; month: number; debit: number }[] = [];
    for (let i = 1; i <= 12; i++) {
      catalogo.push(cuenta(`acc-${i}`, `6.${String(i).padStart(2, '0')}`, `Gasto ${i}`, 'GASTO', 'acc-gasto'));
      real.push({ accountId: `acc-${i}`, month: 1, debit: 500 });
    }
    const cmp = await comparar({ catalogo, real });
    expect(alertasDeComparativa(cmp)).toEqual([]);
  });
});

describe('alertasDeComparativa — tope', () => {
  it('con diez categorías en rojo no pasa de ocho alertas', async () => {
    const catalogo = [cuenta('acc-gasto', '6', 'GASTOS', 'GASTO')];
    const budget: { accountId: string; month: number; amount: number }[] = [];
    const real: { accountId: string; month: number; debit: number }[] = [];
    for (let i = 1; i <= 10; i++) {
      const id = `acc-${i}`;
      catalogo.push(cuenta(id, `6.${String(i).padStart(2, '0')}`, `Gasto ${i}`, 'GASTO', 'acc-gasto'));
      budget.push({ accountId: id, month: 1, amount: 1000 });
      real.push({ accountId: id, month: 1, debit: 2000 }); // +100%: rojo en todas
    }
    const alertas = alertasDeComparativa(await comparar({ catalogo, budget, real }));
    expect(alertas.length).toBeLessThanOrEqual(8);
    expect(alertas.length).toBeGreaterThan(0);
  });
});

describe('mesDeComparacion — la trampa del presupuesto anual', () => {
  const hoy = new Date(2026, 8, 24, 12, 0, 0);

  it('para el año en curso devuelve el mes actual', () => {
    expect(mesDeComparacion(2026, hoy)).toBe(9);
  });

  it('para un año ya cerrado devuelve 12 y para uno futuro 0', () => {
    expect(mesDeComparacion(2025, hoy)).toBe(12);
    expect(mesDeComparacion(2027, hoy)).toBe(0);
  });

  it('sin `mes` los ingresos que van al día salen en rojo; con el mes en curso, no', async () => {
    // Nueve meses facturando a ritmo exacto de plan: 1.000 al mes sobre 12.000
    // anuales. Contra enero-septiembre está justo en plan; contra los doce meses
    // parece un 25% por debajo y el semáforo lo marca rojo. El que va al día
    // recibiría todos los meses un "tus ingresos están muy por debajo".
    const budget = Array.from({ length: 12 }, (_, i) => ({ accountId: 'acc-ventas', month: i + 1, amount: 1000 }));
    const real = Array.from({ length: 9 }, (_, i) => ({ accountId: 'acc-ventas', month: i + 1, credit: 1000 }));

    const alDia = await buildBudgetComparison(prismaStub({ budget, real }) as never, COMPANY, { year: YEAR, mes: MES_ACTUAL });
    expect(alDia.filas.find((f: any) => f.code === '4.01.01')!.semaforo).not.toBe('rojo');

    const sinMes = await buildBudgetComparison(prismaStub({ budget, real }) as never, COMPANY, { year: YEAR });
    expect(sinMes.filas.find((f: any) => f.code === '4.01.01')!.semaforo).toBe('rojo');
  });
});

describe('alertasDeComparativa — años sin nada que comparar', () => {
  it('un año fiscal futuro sin movimiento no produce alertas', async () => {
    const cmp = await buildBudgetComparison(prismaStub({}) as never, COMPANY, { year: 2027 });
    expect(alertasDeComparativa(cmp)).toEqual([]);
  });
});
