/**
 * Anulación de asientos. Fuente única: la usan el diario, Planilla, Inventario y
 * la anulación de declaraciones.
 *
 * La regla depende de si el asiento llegó a aprobarse:
 *
 *  · **CONFIRMADO** — el asiento se contabilizó y después se corrigió. El original
 *    **sigue contando** en el período en que se registró (marcarlo ANULADO borraba el
 *    gasto de enero y reescribía la historia) y el reverso se crea **fechado hoy**,
 *    neteándolo desde el mes de la corrección. El original queda con `anuladoPorId`.
 *  · **BORRADOR / RECHAZADO** — nunca se aprobó: no hay nada que netear. Se marca
 *    ANULADO y listo. Crearle un reverso CONFIRMADO dejaba un asiento inverso sumando
 *    en cuentas como 2.1.07.01 mientras el original —RECHAZADO— no contaba en los
 *    informes: un saldo fantasma (caso ALBRYND, julio 2026).
 *
 * Los informes excluyen RECHAZADO y ANULADO; incluyen BORRADOR. Por eso, en los dos
 * caminos el efecto neto es cero desde el período de la corrección.
 *
 * Tiene que correr dentro de una transacción: si algo falla, no queda ni la marca ni
 * el reverso.
 */

import { crearTransaccionReversion } from './reversion-transaction';

export interface AsientoAnulado {
  original: any;
  /** `null` cuando el original no estaba aprobado: se anuló sin reverso. */
  reversal: any | null;
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

  // Nunca se aprobó: no hay movimiento contabilizado que revertir. Se anula y sale
  // de los informes por estado —sin dejar un espejo CONFIRMADO que sume solo—.
  if (original.status !== 'CONFIRMADO') {
    await tx.journalEntry.update({
      where: { id: original.id },
      data: { status: 'ANULADO' },
    });
    return { original: { ...original, status: 'ANULADO' }, reversal: null };
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

  // El original conserva su Transaction (el hecho económico existió). El reverso
  // lleva su propia Transaction con importe negativo: así los reportes que suman
  // Transaction.amount (Anexos, Proveedores) netean en el período de la corrección
  // en vez de mostrar dos compras o de ignorar la anulación.
  await crearTransaccionReversion(tx, {
    companyId,
    userId,
    journalEntryId: reversal.id,
    originalJournalEntryId: original.id,
    description: reversal.description,
    date: reversal.date,
    source: 'anulacion',
  });

  await tx.journalEntry.update({
    where: { id: original.id },
    data: { anuladoPorId: reversal.id },
  });

  return { original: { ...original, anuladoPorId: reversal.id }, reversal };
}
