import { describe, it, expect } from 'vitest';
import { buildBudgetComparison } from '../budget-comparison';

/**
 * La comparativa cruza el presupuesto (positivo, en la dirección natural de la
 * cuenta) contra el real del libro. Estos casos fijan las reglas que no se ven
 * a simple vista: el signo por tipo, la materialidad, el gasto sin presupuesto,
 * los meses sin transcurrir y el rollup por categoría.
 */
const COMPANY = 'company-1';
const YEAR = 2026;

/** Cuenta del catálogo de prueba. */
const cuenta = (id: string, code: string, name: string, type: string, parentId: string | null = null) => ({
  id,
  code,
  name,
  type,
  parentId,
  isActive: true,
});

const CATALOGO = [
  cuenta('acc-ing', '4', 'INGRESOS', 'INGRESO'),
  cuenta('acc-ventas', '4.01.01', 'Ventas de Servicios', 'INGRESO', 'acc-ing'),
  cuenta('acc-gasto', '6', 'GASTOS', 'GASTO'),
  cuenta('acc-salarios', '6.01.01', 'Salarios', 'GASTO', 'acc-gasto'),
  cuenta('acc-alquiler', '6.01.02', 'Alquiler', 'GASTO', 'acc-gasto'),
];

/** Stub de Prisma: solo lo que usa el servicio (convención del repo, sin BD). */
function prismaStub(opts: {
  real?: { accountId: string; month: number; debit?: number; credit?: number }[];
  budget?: { accountId: string; month: number; amount: number }[];
}) {
  return {
    journalEntry: { findFirst: async () => ({ date: new Date(`${YEAR}-09-15T12:00:00Z`) }) },
    account: { findMany: async () => CATALOGO },
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

const correr = (opts: Parameters<typeof prismaStub>[0], extra: Record<string, unknown> = {}) =>
  buildBudgetComparison(prismaStub(opts) as never, COMPANY, { year: YEAR, ...extra });

const fila = (out: any, code: string) => out.filas.find((f: any) => f.code === code);

describe('buildBudgetComparison — normalización de signo', () => {
  it('un ingreso sale positivo (crédito − débito) y un gasto también (débito − crédito)', async () => {
    const out = await correr({
      real: [
        { accountId: 'acc-ventas', month: 1, credit: 1000 },
        { accountId: 'acc-salarios', month: 1, debit: 400 },
      ],
    });
    expect(fila(out, '4.01.01').real).toBe(1000);
    expect(fila(out, '6.01.01').real).toBe(400);
  });

  it('un gasto registrado al crédito resta (no se usa valor absoluto)', async () => {
    const out = await correr({
      real: [
        { accountId: 'acc-salarios', month: 1, debit: 500 },
        { accountId: 'acc-salarios', month: 2, credit: 200 }, // reverso
      ],
    });
    expect(fila(out, '6.01.01').real).toBe(300);
  });
});

describe('buildBudgetComparison — variación y semáforo', () => {
  const presupuesto = [{ accountId: 'acc-salarios', month: 1, amount: 1000 }];

  it('dentro del 5% es verde', async () => {
    const out = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 1030 }], budget: presupuesto });
    const f = fila(out, '6.01.01');
    expect(f.variacion).toBe(30);
    expect(f.variacionPct).toBe(3);
    expect(f.semaforo).toBe('verde');
  });

  it('un gasto 10% por encima del presupuesto es ámbar (no verde)', async () => {
    const out = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 1100 }], budget: presupuesto });
    const f = fila(out, '6.01.01');
    expect(f.variacionPct).toBe(10);
    expect(f.semaforo).toBe('ambar');
    expect(f.direccion).toBe('desfavorable');
  });

  it('un gasto 20% por encima es rojo', async () => {
    const out = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 1200 }], budget: presupuesto });
    expect(fila(out, '6.01.01').semaforo).toBe('rojo');
  });

  it('gastar por debajo del presupuesto nunca es rojo, pero avisa si el desvío es grande', async () => {
    const poco = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 900 }], budget: presupuesto });
    expect(poco.filas[0].direccion).toBe('favorable');
    expect(poco.filas[0].semaforo).toBe('verde');

    // −30%: no es una alerta de gasto, pero el presupuesto estaba mal estimado
    const mucho = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 700 }], budget: presupuesto });
    const f = fila(mucho, '6.01.01');
    expect(f.variacionPct).toBe(-30);
    expect(f.direccion).toBe('favorable');
    expect(f.semaforo).toBe('ambar');
  });

  it('ingresar menos de lo presupuestado es desfavorable', async () => {
    const out = await correr({
      real: [{ accountId: 'acc-ventas', month: 1, credit: 900 }],
      budget: [{ accountId: 'acc-ventas', month: 1, amount: 1000 }],
    });
    const f = fila(out, '4.01.01');
    expect(f.direccion).toBe('desfavorable');
    expect(f.semaforo).toBe('ambar');
  });

  it('movimiento sin presupuesto: rojo y sin porcentaje (no se divide por cero)', async () => {
    const out = await correr({ real: [{ accountId: 'acc-alquiler', month: 1, debit: 900 }] });
    const f = fila(out, '6.01.02');
    expect(f.budget).toBe(0);
    expect(f.variacionPct).toBeNull();
    expect(f.semaforo).toBe('rojo');
  });

  it('una desviación por debajo de la materialidad (25 USD) queda neutra', async () => {
    const out = await correr({ real: [{ accountId: 'acc-salarios', month: 1, debit: 1010 }], budget: presupuesto });
    expect(fila(out, '6.01.01').semaforo).toBe('neutro');
  });

  it('cuenta con presupuesto y sin movimientos aparece con real 0', async () => {
    const out = await correr({ budget: presupuesto });
    const f = fila(out, '6.01.01');
    expect(f.real).toBe(0);
    expect(f.variacion).toBe(-1000);
  });
});

describe('buildBudgetComparison — meses sin transcurrir', () => {
  it('un mes futuro sin movimiento se marca futuro, no neutro', async () => {
    const out = await correr({});
    // (hoy = 15-09-2026 en el stub: diciembre todavía no transcurrió)
    expect(out.mensual[11].futuro).toBe(true);
    expect(out.mensual[11].semaforo).toBe('futuro');
    expect(out.mensual[0].futuro).toBe(false);
  });

  it('un asiento con fecha adelantada no se esconde como futuro', async () => {
    const out = await correr({
      real: [{ accountId: 'acc-alquiler', month: 12, debit: 300 }],
      budget: [{ accountId: 'acc-alquiler', month: 12, amount: 100 }],
    });
    expect(out.mensual[11].futuro).toBe(false);
    expect(out.mensual[11].semaforo).toBe('rojo');
  });
});

describe('buildBudgetComparison — totales y rollup por categoría', () => {
  it('la utilidad neta es ingresos − costos − gastos', async () => {
    const out = await correr({
      real: [
        { accountId: 'acc-ventas', month: 1, credit: 10000 },
        { accountId: 'acc-salarios', month: 1, debit: 3000 },
        { accountId: 'acc-alquiler', month: 1, debit: 1000 },
      ],
    });
    const totales = out.totales as any;
    expect(totales.utilidadNeta.real).toBe(6000);
    expect(totales.gastos.real).toBe(4000);
  });

  it('la categoría recalcula su desviación sobre el total, no promedia porcentajes', async () => {
    // Salarios +10% y Alquiler −50%: el promedio de porcentajes daría −20%,
    // pero sobre el total (2000 presupuestado, 1900 real) es −5%.
    const out = await correr({
      real: [
        { accountId: 'acc-salarios', month: 1, debit: 1100 },
        { accountId: 'acc-alquiler', month: 1, debit: 800 },
      ],
      budget: [
        { accountId: 'acc-salarios', month: 1, amount: 1000 },
        { accountId: 'acc-alquiler', month: 1, amount: 1000 },
      ],
    });
    const cat = out.categorias.find((c) => c.categoriaKey === '6') as any;
    expect(cat.budget).toBe(2000);
    expect(cat.real).toBe(1900);
    expect(cat.variacionPct).toBe(-5);
  });

  it('los montos del período se acumulan por mes (mes=9 vs año completo)', async () => {
    const real = [
      { accountId: 'acc-salarios', month: 3, debit: 500 },
      { accountId: 'acc-salarios', month: 11, debit: 700 },
    ];
    const hasta9 = await correr({ real }, { mes: 9 });
    const anio = await correr({ real });
    expect(fila(hasta9, '6.01.01').real).toBe(500);
    expect(fila(anio, '6.01.01').real).toBe(1200);
  });
});
