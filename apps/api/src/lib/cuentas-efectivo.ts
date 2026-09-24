/**
 * Cuentas de efectivo de la empresa: el rango clásico del catálogo (Caja 1.1.01,
 * Bancos 1.1.02) o cualquiera marcada con alias de efectivo — mismo criterio que
 * ya usa admin.js para el selector de bancos. Los descendientes entran por prefijo
 * de código, así que marcar el padre alcanza para arrastrar sus subcuentas.
 *
 * Fuente ÚNICA: la usan el flujo de caja (routes/reports.ts) y la proyección de
 * caja (services/salud.ts). Si divergen, el informe y el panel muestran cifras
 * distintas del mismo dinero — que es exactamente el bug que este módulo evita.
 */

export const CASH_CODES = ['1.1.01', '1.1.02'];

export async function cuentasEfectivo(
  prisma: any,
  companyId: string,
): Promise<{ code: string; name: string }[]> {
  const esAliasEfectivo = (a: string) => {
    const s = String(a || '').trim().toLowerCase();
    return s === 'caja' || s === 'banco' || s === 'efectivo' || s.startsWith('banco-');
  };

  const accs = await prisma.account.findMany({
    where: { companyId, type: 'ACTIVO' },
    select: { code: true, name: true, aliases: true },
    orderBy: { code: 'asc' },
  });
  const esRaiz = (a: any) =>
    CASH_CODES.some(c => a.code === c || String(a.code).startsWith(`${c}.`)) ||
    (a.aliases || []).some(esAliasEfectivo);

  const raices = accs.filter(esRaiz);
  return accs
    .filter((a: any) => raices.some((r: any) => a.code === r.code || String(a.code).startsWith(`${r.code}.`)))
    .map((a: any) => ({ code: a.code, name: a.name }));
}

/** Set de códigos de efectivo: el atajo para clasificar líneas y plantillas. */
export async function codigosEfectivo(prisma: any, companyId: string): Promise<Set<string>> {
  const cuentas = await cuentasEfectivo(prisma, companyId);
  return new Set<string>(cuentas.map((c: any) => c.code));
}
