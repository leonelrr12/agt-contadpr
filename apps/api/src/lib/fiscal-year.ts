/**
 * Año fiscal activo de una empresa: el año del último asiento contable no
 * anulado (el cierre NO cuenta — es del año anterior). Si no hay
 * movimientos, el año calendario actual.
 * Se usa para que los informes SIN filtro de fechas muestren el período
 * en curso de forma consistente (diario, resultados, dashboard, balance).
 */
export async function getAnioFiscal(prisma: any, companyId: string): Promise<number> {
  const lastEntry = await prisma.journalEntry.findFirst({
    where: { companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  return lastEntry ? lastEntry.date.getFullYear() : new Date().getFullYear();
}

/** Período del año fiscal: 01-01..31-12 del año dado (fechas Date). */
export function anioFiscalRange(anio: number): { start: Date; end: Date } {
  return {
    start: new Date(`${anio}-01-01T00:00:00.000Z`),
    end: new Date(`${anio}-12-31T23:59:59.999Z`),
  };
}
