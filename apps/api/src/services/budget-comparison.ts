/**
 * Comparativa presupuesto vs real (F2).
 *
 * Fuente ÚNICA de cálculo: la usan el GET /api/budgets/comparison y el export
 * xlsx/csv — igual que buildBalanceGeneral/buildFlujoCaja en routes/reports.ts,
 * para que la pantalla y el archivo nunca discrepen.
 *
 * Convención de signo: el presupuesto se guarda SIEMPRE POSITIVO y en la
 * dirección natural de la cuenta; aquí el real se lleva a esa misma dirección
 * (débito−crédito para ACTIVO/GASTO/COSTO, crédito−débito para el resto). A
 * diferencia de estado-resultados NO se usa Math.abs: la comparativa es lineal y
 * el valor absoluto taparía un movimiento registrado al lado contrario.
 */
import { getAnioFiscal, anioFiscalRange } from '../lib/fiscal-year';

/** Umbrales del semáforo, en tanto por uno (amarillo 5%, rojo 15%). */
export const BUDGET_UMBRALES = { amarillo: 0.05, rojo: 0.15, minimo: 25 };

const TIPOS_RESULTADO = ['INGRESO', 'GASTO', 'COSTO'];

// Misma lista que journal.ts (naturaleza deudora de la cuenta)
const esNaturalezaDeudora = (tipo: string) => ['ACTIVO', 'GASTO', 'COSTO'].includes(tipo);

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export type BudgetSemaforo = 'verde' | 'ambar' | 'rojo' | 'neutro' | 'futuro';
export type BudgetDireccion = 'favorable' | 'desfavorable' | null;

export interface BudgetEvaluacion {
  variacion: number;
  variacionPct: number | null;
  semaforo: BudgetSemaforo;
  direccion: BudgetDireccion;
}

export interface BudgetComparisonOptions {
  year?: number;
  /** Mes de cierre del período (1..12). Sin él, el año completo. */
  mes?: number | null;
  tipos?: 'resultado' | 'todas';
}

/** Varía y califica un par presupuesto/real. `futuro` = todavía no transcurrió. */
function evaluar(tipo: string, budget: number, real: number, futuro: boolean): BudgetEvaluacion {
  const variacion = r2(real - budget);
  const favorable =
    tipo === 'INGRESO' ? variacion >= 0 : tipo === 'GASTO' || tipo === 'COSTO' ? variacion <= 0 : null;
  const direccion: BudgetDireccion =
    favorable === null || Math.round(variacion * 100) === 0 ? null : favorable ? 'favorable' : 'desfavorable';

  if (futuro) return { variacion, variacionPct: null, semaforo: 'futuro', direccion: null };

  // El denominador va en valor absoluto: la utilidad y el neto mensual pueden ser
  // negativos (pérdida presupuestada) y ahí el signo daría una desviación falsa.
  const base = Math.abs(budget);
  const variacionPct = base > 0 ? r2((variacion / base) * 100) : null;
  // Ambos en cero: no hay nada que calificar
  if (Math.round(budget * 100) === 0 && Math.round(real * 100) === 0) {
    return { variacion: 0, variacionPct: null, semaforo: 'neutro', direccion: null };
  }
  // Materialidad: por debajo del mínimo el ruido no se pinta
  if (Math.abs(variacion) < BUDGET_UMBRALES.minimo) {
    return { variacion, variacionPct, semaforo: 'neutro', direccion };
  }
  // Movimiento sin presupuesto: no se divide por cero, va directo a rojo
  if (base === 0) return { variacion, variacionPct: null, semaforo: 'rojo', direccion };

  const desviacion = Math.abs(variacion) / base;
  let semaforo: BudgetSemaforo;
  if (desviacion <= BUDGET_UMBRALES.amarillo) semaforo = 'verde';
  // Desviarse ahorrando no es un problema de gasto, es de presupuestación
  else if (favorable === true) semaforo = desviacion <= BUDGET_UMBRALES.rojo ? 'verde' : 'ambar';
  else semaforo = desviacion <= BUDGET_UMBRALES.rojo ? 'ambar' : 'rojo';
  return { variacion, variacionPct, semaforo, direccion };
}

const sumar = (arr: number[], hasta: number) => r2(arr.slice(0, hasta).reduce((s, n) => s + (Number(n) || 0), 0));

export async function buildBudgetComparison(prisma: any, companyId: string, opts: BudgetComparisonOptions = {}) {
  const anioFiscal = await getAnioFiscal(prisma, companyId);
  const year = opts.year && opts.year >= 2000 ? opts.year : anioFiscal;
  const mes = opts.mes && opts.mes >= 1 && opts.mes <= 12 ? opts.mes : null;
  const tipos: 'resultado' | 'todas' = opts.tipos === 'todas' ? 'todas' : 'resultado';
  const hastaMes = mes ?? 12; // el período siempre arranca en enero

  const hoy = new Date();
  const mesActual = year === hoy.getFullYear() ? hoy.getMonth() + 1 : year < hoy.getFullYear() ? 12 : 0;
  // Un año entero en el futuro no tiene nada que comparar; un año en curso sí,
  // aunque el período elegido llegue hasta diciembre (los meses sin real salen en 0).
  const anioFuturo = mesActual === 0;
  // "Sin transcurrir" solo si además no hay movimiento: hay asientos con fecha
  // adelantada y marcarlos como futuro escondería un gasto real.
  const esFuturo = (real: number) => (anioFuturo && Math.round(real * 100) === 0);

  const { start, end } = anioFiscalRange(year);

  const filtroTipos = tipos === 'resultado' ? `AND a.type IN ('INGRESO', 'GASTO', 'COSTO')` : '';
  const [realRows, budgetRows, accounts] = await Promise.all([
    prisma.$queryRawUnsafe(`
      SELECT l."accountId" AS account_id,
             to_char(je.date, 'YYYY-MM') AS month,
             SUM(l.debit) AS deb, SUM(l.credit) AS cred
      FROM "JournalLine" l
      JOIN "JournalEntry" je ON l."journalEntryId" = je.id
      JOIN "Account" a ON l."accountId" = a.id
      WHERE je."companyId" = '${companyId}'
        AND je.status NOT IN ('RECHAZADO', 'ANULADO') AND je."isClosing" = false
        ${filtroTipos}
        AND je.date >= '${start.toISOString()}' AND je.date <= '${end.toISOString()}'
      GROUP BY 1, 2
    `) as Promise<any[]>,
    prisma.budget.findMany({
      where: { companyId, year, amount: { gt: 0 } },
      select: { accountId: true, month: true, amount: true },
    }) as Promise<any[]>,
    // Catálogo completo (incluye los padres, que dan el nombre de la categoría)
    prisma.account.findMany({
      where: { companyId },
      select: { id: true, code: true, name: true, type: true, parentId: true, isActive: true },
    }) as Promise<any[]>,
  ]);

  const accById = new Map<string, any>(accounts.map((a) => [a.id, a]));
  const conHijos = new Set<string>(accounts.filter((a) => a.parentId).map((a) => a.parentId as string));

  const realByAcc = new Map<string, number[]>();
  for (const row of realRows) {
    const acc = accById.get(row.account_id);
    if (!acc) continue;
    const idx = Number(String(row.month).slice(5, 7)) - 1;
    if (idx < 0 || idx > 11) continue;
    const signo = esNaturalezaDeudora(acc.type) ? 1 : -1;
    const monto = signo * (Number(row.deb) - Number(row.cred));
    const arr = realByAcc.get(row.account_id) || new Array(12).fill(0);
    arr[idx] += monto;
    realByAcc.set(row.account_id, arr);
  }

  const budgetByAcc = new Map<string, number[]>();
  for (const row of budgetRows) {
    const arr = budgetByAcc.get(row.accountId) || new Array(12).fill(0);
    arr[row.month - 1] += Number(row.amount) || 0;
    budgetByAcc.set(row.accountId, arr);
  }

  // Unión presupuesto ∪ real: una cuenta con presupuesto y sin movimientos debe
  // aparecer (real 0), y una con movimientos y sin presupuesto también.
  const ids = new Set<string>([...budgetByAcc.keys(), ...realByAcc.keys()]);
  for (const id of [...ids]) if (!accById.has(id)) ids.delete(id);

  const claveCategoria = (acc: any) => {
    if (acc.parentId) {
      const padre = accById.get(acc.parentId);
      if (padre) return { categoriaKey: padre.code, categoriaName: padre.name };
    }
    const prefijo = String(acc.code).split('.').slice(0, -1).join('.');
    return prefijo
      ? { categoriaKey: prefijo, categoriaName: '(sin categoría)' }
      : { categoriaKey: 'OTRAS', categoriaName: 'Otras cuentas' };
  };

  const filas = [...ids]
    .map((id) => {
      const acc = accById.get(id);
      const budget = sumar(budgetByAcc.get(id) || [], hastaMes);
      const real = sumar(realByAcc.get(id) || [], hastaMes);
      const { categoriaKey, categoriaName } = claveCategoria(acc);
      return {
        accountId: id,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        esHoja: !conHijos.has(id),
        categoriaKey,
        categoriaName,
        budget,
        real,
        ...evaluar(acc.type, budget, real, esFuturo(real)),
      };
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

  // Rollup por cuenta padre: se recalcula variación/%/semáforo sobre los TOTALES
  // de la categoría (promediar los porcentajes de los hijos daría un número falso).
  const categorias = [...new Set(filas.map((f) => f.categoriaKey))]
    .map((key) => {
      const propias = filas.filter((f) => f.categoriaKey === key);
      const budget = r2(propias.reduce((s, f) => s + f.budget, 0));
      const real = r2(propias.reduce((s, f) => s + f.real, 0));
      // Una categoría puede mezclar tipos (p. ej. una cuenta mal clasificada): se
      // califica por el tipo de mayor peso — presupuesto y, si no hay, movimiento.
      const peso = new Map<string, number>();
      for (const f of propias) peso.set(f.type, (peso.get(f.type) || 0) + (f.budget || Math.abs(f.real)));
      const tipoDom = [...peso.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || propias[0].type;
      return {
        categoriaKey: key,
        categoriaName: propias[0].categoriaName,
        budget,
        real,
        ...evaluar(tipoDom, budget, real, esFuturo(real)),
      };
    })
    .sort((a, b) => String(a.categoriaKey).localeCompare(String(b.categoriaKey), undefined, { numeric: true }));

  const totalPorTipo = (tipo: string) => {
    const propias = filas.filter((f) => f.type === tipo);
    const budget = r2(propias.reduce((s, f) => s + f.budget, 0));
    const real = r2(propias.reduce((s, f) => s + f.real, 0));
    return { budget, real };
  };

  const totales: Record<string, unknown> = {};
  if (tipos === 'resultado') {
    const ingresos = totalPorTipo('INGRESO');
    const costos = totalPorTipo('COSTO');
    const gastos = totalPorTipo('GASTO');
    const bruta = { budget: r2(ingresos.budget - costos.budget), real: r2(ingresos.real - costos.real) };
    const neta = { budget: r2(bruta.budget - gastos.budget), real: r2(bruta.real - gastos.real) };
    totales.ingresos = { ...ingresos, ...evaluar('INGRESO', ingresos.budget, ingresos.real, esFuturo(ingresos.real)) };
    totales.costos = { ...costos, ...evaluar('COSTO', costos.budget, costos.real, esFuturo(costos.real)) };
    totales.gastos = { ...gastos, ...evaluar('GASTO', gastos.budget, gastos.real, esFuturo(gastos.real)) };
    totales.utilidadBruta = { ...bruta, ...evaluar('INGRESO', bruta.budget, bruta.real, esFuturo(bruta.real)) };
    totales.utilidadNeta = { ...neta, ...evaluar('INGRESO', neta.budget, neta.real, esFuturo(neta.real)) };
  } else {
    const budget = r2(filas.reduce((s, f) => s + f.budget, 0));
    const real = r2(filas.reduce((s, f) => s + f.real, 0));
    totales.general = { budget, real, ...evaluar('GASTO', budget, real, esFuturo(real)) };
  }

  // Serie mensual para la gráfica: el neto (ingresos − costos − gastos) más el
  // detalle por tipo, para que el chart pueda mostrar cualquiera de los dos.
  // Ojo: todas las cuentas están normalizadas en POSITIVO, así que gastos y
  // costos hay que restarlos aquí — sumarlos daría volumen de actividad, no neto.
  const sumaDe = (mapa: Map<string, number[]>, tipos: string[], i: number) =>
    r2(
      filas
        .filter((f) => tipos.includes(f.type))
        .reduce((s, f) => s + (mapa.get(f.accountId)?.[i] || 0), 0),
    );

  const mensual = Array.from({ length: 12 }, (_, i) => {
    const mesNum = i + 1;
    const budget = r2(sumaDe(budgetByAcc, ['INGRESO'], i) - sumaDe(budgetByAcc, ['COSTO', 'GASTO'], i));
    const real = r2(sumaDe(realByAcc, ['INGRESO'], i) - sumaDe(realByAcc, ['COSTO', 'GASTO'], i));
    const futuro = (anioFuturo || (year === hoy.getFullYear() && mesNum > mesActual)) && Math.round(real * 100) === 0;
    const detalle: Record<string, { budget: number; real: number }> = {};
    for (const [clave, tipo] of [
      ['ingresos', 'INGRESO'],
      ['costos', 'COSTO'],
      ['gastos', 'GASTO'],
    ] as const) {
      detalle[clave] = { budget: sumaDe(budgetByAcc, [tipo], i), real: sumaDe(realByAcc, [tipo], i) };
    }
    return {
      month: mesNum,
      budget,
      real,
      detalle,
      ...evaluar(tipos === 'resultado' ? 'INGRESO' : 'GASTO', budget, real, futuro),
      futuro,
    };
  });

  const matriz = filas.map((f) => ({
    accountId: f.accountId,
    budget: (budgetByAcc.get(f.accountId) || new Array(12).fill(0)).map(r2),
    real: (realByAcc.get(f.accountId) || new Array(12).fill(0)).map(r2),
  }));

  const hasta = mes ?? 12;
  return {
    year,
    anioFiscal,
    mes: mes,
    mesActual,
    tipos,
    umbrales: BUDGET_UMBRALES,
    periodo: {
      desde: `${year}-01-01`,
      hasta: `${year}-${String(hasta).padStart(2, '0')}-${new Date(Date.UTC(year, hasta, 0)).getUTCDate()}`,
      acumulado: true,
    },
    matriz,
    mensual,
    filas,
    categorias,
    totales,
  };
}
