/**
 * Estado de resultados de UNA empresa y UN período. **Única fuente de cálculo**:
 * la usan el informe de la empresa (`GET /reports/estado-resultados`) y el
 * comparativo del despacho, para que el número que se ve en la tabla comparativa
 * sea exactamente el que muestra el informe de esa empresa.
 *
 * Doctrina del repo para los asientos que cuentan: los que NO están RECHAZADOS ni
 * ANULADOS y no son de cierre (`isClosing`) — o sea que los BORRADOR **sí**
 * cuentan (decisión del 15-10-2026), porque el contador carga y aprueba después.
 *
 * Ingresos se leen como crédito − débito (una venta acredita); costos y gastos al
 * revés y en valor absoluto, que es como se muestran en el informe.
 */

import { getAnioFiscal, anioFiscalRange } from '../lib/fiscal-year';

export interface EstadoResultados {
  periodo: { start: Date; end: Date; anioFiscal: number };
  ingresos: { detalle: Record<string, number>; total: number };
  costos: { detalle: Record<string, number>; total: number };
  gananciaBruta: number;
  gastos: { detalle: Record<string, number>; total: number };
  utilidadNeta: number;
}

export interface RangoResultados {
  /** 'YYYY-MM-DD' o Date. Sin nada, se usa el año fiscal activo de la empresa. */
  startDate?: string | Date;
  endDate?: string | Date;
}

export async function calcularEstadoResultados(
  prisma: any,
  companyId: string,
  rango: RangoResultados = {},
): Promise<EstadoResultados> {
  const anioFiscal = await getAnioFiscal(prisma, companyId);
  // `periodo` en la respuesta es SIEMPRE el año fiscal de la empresa (como antes
  // de extraer esto a un servicio): si hay filtro, el filtro manda para calcular,
  // pero el período informado sigue siendo el año en curso.
  const periodo = anioFiscalRange(anioFiscal);
  const conFiltro = !!(rango.startDate || rango.endDate);
  const fecha: any = {};
  if (rango.startDate) fecha.gte = new Date(rango.startDate);
  else if (!conFiltro) fecha.gte = periodo.start;
  if (rango.endDate) fecha.lte = new Date(rango.endDate);
  else if (!conFiltro) fecha.lte = periodo.end;
  const hayFecha = Object.keys(fecha).length > 0;

  const grouped = await prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: {
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        isClosing: false,
        ...(hayFecha ? { date: fecha } : {}),
      },
      account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
    },
  });

  const accounts = await prisma.account.findMany({
    where: { id: { in: grouped.map((g: any) => g.accountId) } },
    select: { id: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a: any) => [a.id, a]));

  let totalIngresos = 0;
  let totalGastos = 0;
  let totalCostos = 0;
  const ingresos: Record<string, number> = {};
  const gastos: Record<string, number> = {};
  const costos: Record<string, number> = {};

  for (const g of grouped) {
    const acc: any = byId.get(g.accountId);
    if (!acc) continue;
    const monto = (g._sum.credit || 0) - (g._sum.debit || 0);
    if (acc.type === 'INGRESO') {
      totalIngresos += monto;
      ingresos[acc.name] = (ingresos[acc.name] || 0) + monto;
    } else if (acc.type === 'GASTO') {
      totalGastos += Math.abs(monto);
      gastos[acc.name] = (gastos[acc.name] || 0) + Math.abs(monto);
    } else if (acc.type === 'COSTO') {
      totalCostos += Math.abs(monto);
      costos[acc.name] = (costos[acc.name] || 0) + Math.abs(monto);
    }
  }

  return {
    periodo: { start: periodo.start, end: periodo.end, anioFiscal },
    ingresos: { detalle: ingresos, total: totalIngresos },
    costos: { detalle: costos, total: totalCostos },
    gananciaBruta: totalIngresos - totalCostos,
    gastos: { detalle: gastos, total: totalGastos },
    utilidadNeta: totalIngresos - totalCostos - totalGastos,
  };
}
