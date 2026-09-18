/**
 * Convierte una fecha de solo día ('YYYY-MM-DD') al Date que se guarda en la BD:
 * mediodía LOCAL, no medianoche UTC.
 *
 * La columna es un timestamp y el frontend muestra la fecha con la hora del
 * navegador: `new Date('2026-09-17')` es medianoche UTC, que en Panamá (UTC-5)
 * se ve como el 16. El mediodía local cae siempre dentro del día calendario del
 * usuario, así que es la convención de todo el repo (import, planilla, facturas,
 * OrchestratorAgent y el PUT de /journal).
 */
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}
