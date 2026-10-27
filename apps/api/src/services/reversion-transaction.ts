/**
 * Reversos y anulaciones: la Transaction espejo con importe NEGATIVO.
 *
 * El original sigue contando en su período; el reverso lo netea desde el día de
 * la corrección. Sin esta Transaction negativa, los reportes que suman
 * `Transaction.amount` (Anexos, Proveedores) veían el original y la corrección
 * como dos compras distintas (o no veían la anulación, porque el reverso no
 * tenía Transaction).
 *
 * Solo se crea si el original tiene tercero (provider/RUC/ids): si no lo tenía,
 * el original tampoco entraba al Anexo y un reverso negativo lo restaría de más.
 * La metadata se copia para que el reverso resuelva el mismo maestro.
 */

export interface ReversionOpts {
  companyId: string;
  userId: string;
  /** JournalEntry del reverso (el asiento espejo). */
  journalEntryId: string;
  /** JournalEntry original que se anula/corrige. */
  originalJournalEntryId: string;
  description: string;
  date: Date;
  source: 'anulacion' | 'reversion';
}

function tieneTercero(m: Record<string, any>): boolean {
  return !!(m.provider || m.nombre || m.ruc || m.clientId || m.supplierId);
}

export async function crearTransaccionReversion(tx: any, opts: ReversionOpts): Promise<any | null> {
  // Los stubs de tests viejos no implementan estas operaciones: en ese caso no
  // hay dato que copiar y el reverso simplemente no crea Transaction.
  if (typeof tx?.transaction?.findFirst !== 'function' || typeof tx?.transaction?.create !== 'function') {
    return null;
  }

  const original = await tx.transaction.findFirst({
    where: { journalEntryId: opts.originalJournalEntryId, companyId: opts.companyId },
    select: { amount: true, type: true, concept: true, paymentMethod: true, metadata: true },
  });
  if (!original) return null;

  let metadata: Record<string, any> = {};
  try { metadata = JSON.parse(original.metadata || '{}'); } catch { /* metadata corrupta */ }
  if (!tieneTercero(metadata)) return null;

  return tx.transaction.create({
    data: {
      type: original.type,
      // Negar el importe original (no `-abs`): si el original ya era un reverso,
      // el nuevo reverso tiene que devolverlo al signo contrario.
      amount: -Number(original.amount || 0),
      description: opts.description,
      concept: original.concept || (opts.source === 'anulacion' ? 'Anulación' : 'Reversión'),
      paymentMethod: original.paymentMethod,
      date: opts.date,
      companyId: opts.companyId,
      createdById: opts.userId,
      journalEntryId: opts.journalEntryId,
      metadata: JSON.stringify({
        ...metadata,
        source: opts.source,
        reversalOf: opts.originalJournalEntryId,
      }),
    },
  });
}
