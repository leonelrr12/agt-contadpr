/**
 * Construye un filtro de fecha { gte?, lte? } para queries de Prisma.
 * Solo incluye las claves que tengan valor; devuelve undefined si no hay filtro.
 *
 * Uso:
 *   const dateFilter = buildDateFilter(req.query.startDate, req.query.endDate);
 *   if (dateFilter) where.journalEntry = { ...where.journalEntry, date: dateFilter };
 */
export function buildDateFilter(
  startDate?: string | string[],
  endDate?: string | string[],
): Record<string, unknown> | undefined {
  const start = Array.isArray(startDate) ? startDate[0] : startDate;
  const end = Array.isArray(endDate) ? endDate[0] : endDate;

  const date: Record<string, unknown> = {};
  if (start) date.gte = new Date(start + 'T00:00:00.000Z');
  if (end) date.lte = new Date(end + 'T23:59:59.999Z');

  return Object.keys(date).length > 0 ? date : undefined;
}
