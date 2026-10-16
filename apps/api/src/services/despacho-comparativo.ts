/**
 * Comparativo entre empresas del despacho: ventas, costos+gastos y resultado,
 * del mes y del año fiscal en curso.
 *
 * **No es un balance consolidado.** Sumar los libros de empresas distintas que no
 * comparten patrimonio es una decisión contable que nadie pidió, y hacerlo mal es
 * peor que no hacerlo: acá las empresas se muestran **una al lado de la otra**,
 * cada una con sus números, y la decisión de sumarlas queda en quien mira.
 *
 * Los números salen de `calcularEstadoResultados` —la MISMA función del informe
 * de cada empresa— así que la tabla no puede decir algo distinto que el informe
 * que esa empresa muestra en su pantalla.
 *
 * El «año» es el año fiscal de CADA empresa (el de su último asiento), no un
 * rango único: dos empresas con años fiscales distintos se comparan en su propio
 * período en curso, que es lo que el contador tiene en la cabeza.
 */

import { calcularEstadoResultados } from './estado-resultados';
import type { EmpresaAccesible } from './empresas-usuario';

export interface ComparativoEmpresa {
  id: string;
  name: string;
  role: string;
  /** El mes pedido (o el actual, si no se pidió ninguno). */
  mes: { ingresos: number; gastos: number; resultado: number; periodo: string };
  /** El año fiscal en curso de esa empresa. */
  anio: { ingresos: number; gastos: number; resultado: number; desde: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Rango del mes 'YYYY-MM' en UTC, que es como están guardadas las fechas. */
export function rangoDelMes(mes: string): { start: Date; end: Date; periodo: string } {
  const [y, m] = mes.split('-').map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)),
    periodo: mes,
  };
}

/** El mes en curso en la zona de la empresa (Panamá), no en UTC. */
export function mesActual(ahora = new Date()): string {
  const local = new Date(ahora.getTime() - 5 * 3600000); // UTC-5 (Panamá)
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function comparativoEmpresas(
  prisma: any,
  empresas: EmpresaAccesible[],
  mes?: string,
): Promise<ComparativoEmpresa[]> {
  const periodo = mes && /^\d{4}-\d{2}$/.test(mes) ? mes : mesActual();
  const rango = rangoDelMes(periodo);

  const resultados = await Promise.all(
    empresas.map(async (e) => {
      const base: ComparativoEmpresa = {
        id: e.id,
        name: e.name,
        role: e.role,
        mes: { ingresos: 0, gastos: 0, resultado: 0, periodo },
        anio: { ingresos: 0, gastos: 0, resultado: 0, desde: new Date().getUTCFullYear() },
      };
      try {
        // El año primero: si una empresa falla, la fila queda en cero y las demás
        // igual se muestran (el contador pierde el comparativo entero si no).
        const [anio, delMes] = await Promise.all([
          calcularEstadoResultados(prisma, e.id, {}),
          calcularEstadoResultados(prisma, e.id, { startDate: rango.start, endDate: rango.end }),
        ]);
        base.anio = {
          ingresos: r2(anio.ingresos.total),
          gastos: r2(anio.costos.total + anio.gastos.total),
          resultado: r2(anio.utilidadNeta),
          desde: anio.periodo.anioFiscal,
        };
        base.mes = {
          ingresos: r2(delMes.ingresos.total),
          gastos: r2(delMes.costos.total + delMes.gastos.total),
          resultado: r2(delMes.utilidadNeta),
          periodo,
        };
      } catch (err: any) {
        console.error(`[Despacho] Comparativo de ${e.id}:`, err?.message);
      }
      return base;
    }),
  );
  return resultados;
}
