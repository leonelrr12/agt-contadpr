/**
 * Servicio compartido para sincronizar entidades (Client/Supplier + Invoice/Bill)
 * a partir de un JournalEntry.
 *
 * Usado por:
 * - import.ts (executeImportRows)
 * - journal.ts (PUT /:id — edición de asientos)
 * - orchestrator-agent.ts (flujo chat — vía autoCreateEntity interno)
 */

// Dedupe de contrapartes centralizado (RUC → nombre) en counterparty.ts
import { findOrCreateClient, findOrCreateSupplier, r2 } from './counterparty';

const CXC_ACCOUNTS = ['1.1.03.01']; // Clientes (cuentas por cobrar)
const CXP_ACCOUNTS = ['2.1.01'];    // Proveedores (cuentas por pagar)

export interface SyncResult {
  type: string;
  name: string;
}

/**
 * Sincroniza las entidades auxiliares (Client/Supplier + Invoice/Bill)
 * basándose en las líneas actuales de un JournalEntry.
 *
 * - Si hay línea a cuenta CxC (1.1.03.01): crea/find Cliente + Invoice
 * - Si hay línea a cuenta CxP (2.1.01): crea/find Supplier + Bill
 * - Si había Invoice/Bill vinculado y YA NO hay línea CxC/CxP: lo elimina (si PENDIENTE)
 */
export async function syncEntityFromEntry(
  prisma: any,
  companyId: string,
  journalEntry: any,
): Promise<SyncResult | null> {
  const entryId = journalEntry.id;
  const entryDate = new Date(journalEntry.date);

  // Si el entry no incluye líneas con cuenta, recargarlo completo
  let lines: any[] = journalEntry.lines || [];
  if (lines.length === 0 || !lines[0]?.account) {
    const full = await prisma.journalEntry.findUnique({
      where: { id: entryId },
      include: { lines: { include: { account: true } } },
    });
    if (full) {
      lines = full.lines || [];
    }
  }

  // Detectar si el asiento afecta CxC o CxP (comparar por code de cuenta, no por UUID)
  const hasCxC = lines.some((l: any) => CXC_ACCOUNTS.includes(l.account?.code));
  const hasCxP = lines.some((l: any) => CXP_ACCOUNTS.includes(l.account?.code));

  // Buscar metadata (provider, ruc, reference) en Transaction asociada
  const txn = await prisma.transaction.findFirst({
    where: { journalEntryId: entryId },
    select: { metadata: true, type: true, amount: true, description: true },
  });

  let metadata: Record<string, any> = {};
  if (txn?.metadata) {
    try { metadata = JSON.parse(txn.metadata); } catch { /* ignorar */ }
  }

  const provider = metadata.provider || null;
  const ruc = metadata.ruc || null;

  // ── Limpiar Invoice/Bill si ya no hay CxC/CxP ──
  if (!hasCxC) {
    const existingInvoices = await prisma.invoice.findMany({
      where: { journalEntryId: entryId, status: 'PENDIENTE' },
    });
    for (const inv of existingInvoices) {
      await prisma.invoice.delete({ where: { id: inv.id } });
    }
  }
  if (!hasCxP) {
    const existingBills = await prisma.bill.findMany({
      where: { journalEntryId: entryId, status: 'PENDIENTE' },
    });
    for (const b of existingBills) {
      await prisma.bill.delete({ where: { id: b.id } });
    }
  }

  if (!hasCxC && !hasCxP) return null;
  if (!provider) return null; // sin nombre no podemos crear entidad

  // ── CxC: Cliente + Invoice ──
  if (hasCxC) {
    // Verificar si ya existe Invoice para este entry
    const existingInv = await prisma.invoice.findFirst({
      where: { journalEntryId: entryId },
    });
    if (existingInv) {
      // El asiento pudo editarse: recalcular montos desde las líneas y actualizar
      const cxcLine = lines.find((l: any) => CXC_ACCOUNTS.includes(l.account?.code));
      const total = r2(cxcLine?.debit || cxcLine?.credit || (txn?.amount || 0));
      const itbmsLine = lines.find((l: any) => l.account?.code === '2.1.05');
      const ingresoLine = lines.find((l: any) => l.account?.code?.startsWith('4.') || l.account?.code?.startsWith('6.'));
      const itbms = r2(itbmsLine?.credit || 0);
      const base = r2(ingresoLine?.credit || (total - itbms));
      await prisma.invoice.update({
        where: { id: existingInv.id },
        data: {
          amount: base,
          itbms,
          total,
          date: entryDate,
          description: txn?.description || journalEntry.description || existingInv.description,
          // Si estaba RECHAZADA y el asiento se corrigió, reactivar
          ...(existingInv.status === 'RECHAZADA' ? { status: 'PENDIENTE' } : {}),
        },
      });
      return { type: 'cliente_existente', name: provider };
    }

    const client = await findOrCreateClient(prisma, companyId, { name: provider, taxId: ruc });

    // Calcular montos desde las líneas
    const cxcLine = lines.find((l: any) => CXC_ACCOUNTS.includes(l.account?.code));
    const total = cxcLine?.debit || cxcLine?.credit || (txn?.amount || 0);

    // Buscar línea de ITBMS (2.1.05) y ventas/ingresos (4.x o 6.x) por code
    const itbmsLine = lines.find((l: any) => l.account?.code === '2.1.05');
    const ingresoLine = lines.find((l: any) => l.account?.code?.startsWith('4.') || l.account?.code?.startsWith('6.'));
    const itbms = itbmsLine?.credit || 0;
    const base = ingresoLine?.credit || (total - itbms);

    await prisma.invoice.create({
      data: {
        companyId,
        clientId: client.id,
        number: metadata.invoiceNumber || metadata.reference || null,
        amount: base,
        itbms,
        total,
        dueDate: new Date(entryDate.getTime() + 30 * 24 * 60 * 60 * 1000),
        date: entryDate,
        description: txn?.description || journalEntry.description || '',
        journalEntryId: entryId,
      },
    });

    return { type: 'cliente_nuevo', name: provider };
  }

  // ── CxP: Supplier + Bill ──
  if (hasCxP) {
    const existingBill = await prisma.bill.findFirst({
      where: { journalEntryId: entryId },
    });
    if (existingBill) {
      // El asiento pudo editarse: recalcular montos desde las líneas y actualizar
      const cxpLine = lines.find((l: any) => CXP_ACCOUNTS.includes(l.account?.code));
      const total = r2(cxpLine?.credit || cxpLine?.debit || (txn?.amount || 0));
      const itbmsLine = lines.find((l: any) => l.account?.code === '2.1.05');
      const gastoLine = lines.find((l: any) => l.account?.code?.startsWith('6.'));
      const itbms = r2(itbmsLine?.debit || 0);
      const base = r2(gastoLine?.debit || (total - itbms));
      await prisma.bill.update({
        where: { id: existingBill.id },
        data: {
          amount: base,
          itbms,
          total,
          date: entryDate,
          description: txn?.description || journalEntry.description || existingBill.description,
          // Si estaba RECHAZADA y el asiento se corrigió, reactivar
          ...(existingBill.status === 'RECHAZADA' ? { status: 'PENDIENTE' } : {}),
        },
      });
      return { type: 'proveedor_existente', name: provider };
    }

    const supplier = await findOrCreateSupplier(prisma, companyId, { name: provider, taxId: ruc });

    const cxpLine = lines.find((l: any) => CXP_ACCOUNTS.includes(l.account?.code));
    const total = cxpLine?.credit || cxpLine?.debit || (txn?.amount || 0);

    const itbmsLine = lines.find((l: any) => l.account?.code === '2.1.05');
    const gastoLine = lines.find((l: any) => l.account?.code?.startsWith('6.'));
    const itbms = itbmsLine?.debit || 0;
    const base = gastoLine?.debit || (total - itbms);

    await prisma.bill.create({
      data: {
        companyId,
        supplierId: supplier.id,
        number: metadata.invoiceNumber || metadata.reference || null,
        amount: base,
        itbms,
        total,
        dueDate: new Date(entryDate.getTime() + 30 * 24 * 60 * 60 * 1000),
        date: entryDate,
        description: txn?.description || journalEntry.description || '',
        journalEntryId: entryId,
      },
    });

    return { type: 'proveedor_nuevo', name: provider };
  }

  return null;
}
