/**
 * Anulación de asientos. Fuente única: la usan el diario y el módulo de Inventario.
 *
 * Anular NO es borrar. El asiento se contabilizó y después se corrigió, así que:
 *
 *  · El original **sigue contando** en el período en que se registró. Marcarlo
 *    ANULADO lo sacaba de su propio período y el informe de enero pasaba a decir que
 *    ese gasto nunca había existido.
 *  · El reverso se crea **fechado hoy** (el día de la corrección) y netea al original
 *    desde ese mes en adelante. Es la práctica estándar: el error se corrige en el
 *    período en que se descubre, no se reescribe la historia.
 *  · El original queda marcado con `anuladoPorId`, que es una seña para la UI: ningún
 *    reporte la mira.
 *
 * Tiene que correr dentro de una transacción: si algo falla, no queda ni la marca ni
 * el reverso.
 */

export interface AsientoAnulado {
  original: any;
  reversal: any;
}

export async function anularAsiento(
  tx: any,
  companyId: string,
  userId: string,
  entryId: string,
): Promise<AsientoAnulado> {
  const original = await tx.journalEntry.findFirst({
    where: { id: entryId, companyId },
    include: { lines: true },
  });
  if (!original) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });
  if (original.anuladoPorId) throw Object.assign(new Error('El asiento ya está anulado'), { status: 400 });
  if (original.status === 'ANULADO') throw Object.assign(new Error('El asiento ya está anulado'), { status: 400 });
  if (original.description.startsWith('ANULACIÓN:')) {
    throw Object.assign(new Error('No se puede anular un asiento de reversión'), { status: 400 });
  }

  const reversal = await tx.journalEntry.create({
    data: {
      date: new Date(), // el día de la corrección, no la fecha del original
      description: `ANULACIÓN: ${original.description}`,
      status: 'CONFIRMADO',
      companyId,
      createdById: userId,
      lines: {
        create: original.lines.map((l: any) => ({
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });

  // La Transaction se queda con el original: es el registro del hecho económico. El
  // reverso se identifica por su descripción, que `entry-origin` ya reconoce.
  await tx.journalEntry.update({
    where: { id: original.id },
    data: { anuladoPorId: reversal.id },
  });

  return { original: { ...original, anuladoPorId: reversal.id }, reversal };
}
