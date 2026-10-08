import type { PrismaClient } from '@agt-contador/prisma-schema';

/**
 * Origen de un asiento: de dónde salió el movimiento que el contador está mirando.
 *
 * Se resuelve SOLO por evidencia (FK del documento que lo generó, `source` de la
 * Transaction, flags del propio asiento). Cuando no hay rastro se dice MANUAL en
 * lugar de adivinar: un origen inventado en un papel de trabajo es peor que decir
 * "no consta".
 */
export interface EntryOrigin {
  kind: string;
  icon: string;
  label: string;
  detail?: string;
  /**
   * Documento origen abrible desde la UI: la factura emitida tiene PDF propio
   * (`invoice`) y la recibida vive en el visor de la DGI (`url`, el enlace del
   * CUTE que mandó el trabajador o subió la empresa).
   */
  link?: { type: 'invoice'; id: string; label: string } | { type: 'url'; url: string; label: string };
}

/** Etiquetas legibles de Transaction.type (lo que el usuario ve en el chat/importador). */
const TYPE_LABELS: Record<string, string> = {
  GASTO: 'Gasto',
  INGRESO: 'Ingreso',
  VENTA: 'Venta',
  COBRO_CLIENTE: 'Cobro de cliente',
  PRESTAMO: 'Préstamo recibido',
  PAGO_PRESTAMO: 'Pago de préstamo',
  PAGO_ITBMS: 'Pago de ITBMS',
  PLANILLA: 'Planilla',
};

/** Orígenes que la Transaction deja marcados con `metadata.source`. */
const SOURCE_ORIGINS: Record<string, EntryOrigin> = {
  'import-cobros': {
    kind: 'IMPORTACION',
    icon: '📥',
    label: 'Importación de cobros',
    detail: 'Archivo maestro de cobros',
  },
  'import-masivo': {
    kind: 'IMPORTACION',
    icon: '📥',
    label: 'Importación masiva',
    detail: 'Carga de archivo (CSV/Excel)',
  },
  'compensacion-r52': {
    kind: 'COMPENSACION',
    icon: '🔖',
    label: 'Compensación ITBMS (R52)',
    detail: 'Retenciones aplicadas al ITBMS por pagar',
  },
  planilla: { kind: 'PLANILLA', icon: '🧮', label: 'Planilla', detail: 'Carga de planilla' },
  'factura-pdf': { kind: 'FACTURA', icon: '🧾', label: 'Factura emitida', detail: 'Módulo Facturas PDF' },
  // `source` que manda la captura al asistente (dialog.source → metadata.source)
  ocr: { kind: 'CAPTURA', icon: '📷', label: 'Foto de factura (OCR)', detail: 'Capturada con la cámara' },
  pdf: { kind: 'CAPTURA', icon: '📎', label: 'PDF de factura', detail: 'Subida como archivo' },
  'chat-cobro': {
    kind: 'COBRO',
    icon: '💰',
    label: 'Cobro de factura',
    detail: 'Registrado con el asistente',
  },
};

function parseMetadata(raw: string | null | undefined): Record<string, any> {
  try {
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

function fmt(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Resuelve el origen de UN asiento. Orden de prioridad:
 *  1. Marca propia del asiento (cierre fiscal, anulación, corrección).
 *  2. FK del documento: factura emitida → cobro → retención ITBMS → movimiento de
 *     kardex (la factura gana: es el documento que el contador quiere abrir).
 *  3. `metadata.source` de la Transaction (importación de cobros, R52, planilla…).
 *  4. Plantilla recurrente (`metadata.recurring` + `templateId`).
 *  5. Sin rastro verificable → asiento manual, o registro automático sin marca.
 */
export async function resolveEntryOrigin(
  prisma: PrismaClient,
  companyId: string,
  entry: { id: string; description: string; isClosing?: boolean | null; period?: string | null },
): Promise<EntryOrigin> {
  // 1. Marcas del propio asiento
  if (entry.isClosing) {
    return {
      kind: 'CIERRE',
      icon: '🔒',
      label: 'Cierre fiscal',
      detail: entry.period ? `Año fiscal ${entry.period}` : undefined,
    };
  }
  const desc = entry.description || '';
  if (desc.startsWith('ANULACIÓN:')) {
    return { kind: 'ANULACION', icon: '↩️', label: 'Anulación', detail: 'Reverso del asiento original' };
  }
  if (desc.startsWith('REVERSIÓN') || desc.includes('[ref:')) {
    return { kind: 'CORRECCION', icon: '✏️', label: 'Corrección', detail: 'Reversión del asiento original' };
  }
  // Asiento de apertura: descripción fija y sin Transaction (mismo criterio que
  // GET /import/carga-inicial/existe, que lo busca por ese texto).
  if (desc.startsWith('Carga Inicial')) {
    return {
      kind: 'CARGA_INICIAL',
      icon: '🧮',
      label: 'Carga Inicial',
      detail: 'Asiento de apertura (Administración)',
    };
  }

  // 2. Documento que lo generó (FK directa)
  const invoice = await prisma.invoice.findFirst({
    where: { companyId, journalEntryId: entry.id },
    select: { id: true, number: true, client: { select: { name: true } } },
  });
  if (invoice) {
    const num = invoice.number ? `Factura ${invoice.number}` : 'Factura sin número';
    return {
      kind: 'FACTURA',
      icon: '🧾',
      label: 'Factura emitida',
      detail: [num, invoice.client?.name].filter(Boolean).join(' · '),
      link: { type: 'invoice', id: invoice.id, label: invoice.number || 'factura' },
    };
  }

  const payment = await prisma.invoicePayment.findFirst({
    where: { journalEntryId: entry.id, invoice: { companyId } },
    select: {
      amount: true,
      retentionAmount: true,
      invoice: { select: { id: true, number: true, client: { select: { name: true } } } },
    },
  });
  if (payment) {
    const num = payment.invoice?.number ? `Factura ${payment.invoice.number}` : 'Cobro de factura';
    const ret = payment.retentionAmount > 0 ? ` · retención ${fmt(payment.retentionAmount)}` : '';
    return {
      kind: 'COBRO',
      icon: '💰',
      label: 'Cobro de factura',
      detail: [num, payment.invoice?.client?.name].filter(Boolean).join(' · ') + ret,
      link: payment.invoice
        ? { type: 'invoice', id: payment.invoice.id, label: payment.invoice.number || 'factura' }
        : undefined,
    };
  }

  const retention = await prisma.retentionItbms.findFirst({
    where: { journalEntryId: entry.id, companyId },
    select: { montoRetencion: true, invoice: { select: { id: true, number: true, client: { select: { name: true } } } } },
  });
  if (retention) {
    return {
      kind: 'RETENCION',
      icon: '🔖',
      label: 'Retención ITBMS',
      detail: [
        retention.invoice?.number ? `Factura ${retention.invoice.number}` : null,
        retention.invoice?.client?.name,
        fmt(retention.montoRetencion),
      ]
        .filter(Boolean)
        .join(' · '),
      link: retention.invoice
        ? { type: 'invoice', id: retention.invoice.id, label: retention.invoice.number || 'factura' }
        : undefined,
    };
  }

  // El asiento de un movimiento de kardex. Se busca DESPUÉS de la factura porque una
  // venta con producto tiene las dos cosas, y ahí manda la factura: es el documento
  // que el contador quiere abrir. Acá caen las compras y las salidas.
  const movimiento = await prisma.inventoryMovement.findFirst({
    where: { journalEntryId: entry.id, companyId },
    select: { origen: true, tipo: true, cantidad: true, costoTotal: true, product: { select: { nombre: true } } },
  });
  if (movimiento) {
    const etiquetas: Record<string, string> = {
      COMPRA: 'Compra de mercancía',
      APERTURA: 'Apertura de inventario',
      REGULARIZACION: 'Regularización de costo',
      AJUSTE: 'Salida de inventario',
    };
    return {
      kind: 'INVENTARIO',
      icon: '📦',
      label: etiquetas[movimiento.origen] || 'Movimiento de inventario',
      detail: [
        movimiento.product?.nombre,
        movimiento.cantidad > 0 ? `${movimiento.cantidad} u.` : null, // la regularización no mueve unidades
        fmt(movimiento.costoTotal),
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }

  // Factura RECIBIDA (la del trabajador que adelantó, o una de la empresa): el
  // documento con su URL del CUTE. Va antes que el rastro de la Transaction
  // porque es más específico y más útil — el contador quiere abrir la factura.
  const claim = await prisma.expenseClaim.findFirst({
    where: { journalEntryId: entry.id, companyId },
    select: {
      proveedor: true, numeroFactura: true, dgiUrl: true, total: true,
      worker: { select: { nombre: true } },
    },
  });
  if (claim) {
    return {
      kind: 'FACTURA_RECIBIDA',
      icon: '🧾',
      label: claim.worker ? 'Factura de trabajador' : 'Factura recibida',
      detail: [
        claim.proveedor,
        claim.numeroFactura ? `Nº ${claim.numeroFactura}` : null,
        claim.worker?.nombre,
        fmt(claim.total),
      ].filter(Boolean).join(' · '),
      link: claim.dgiUrl ? { type: 'url', url: claim.dgiUrl, label: 'factura DGI' } : undefined,
    };
  }

  // 3-5. Rastro en la Transaction que acompaña al asiento
  const tx = await prisma.transaction.findFirst({
    where: { journalEntryId: entry.id, companyId },
    select: { type: true, concept: true, metadata: true },
  });
  if (!tx) {
    return { kind: 'MANUAL', icon: '✍️', label: 'Asiento manual', detail: 'Creado desde la app' };
  }

  const meta = parseMetadata(tx.metadata);
  const provider: string | undefined = meta.provider || meta.clientName || undefined;

  if (meta.recurring) {
    const template = meta.templateId
      ? await prisma.recurringTemplate.findFirst({
          where: { id: meta.templateId, companyId },
          select: { description: true, frequency: true },
        })
      : null;
    return {
      kind: 'RECURRENTE',
      icon: '🔁',
      label: 'Transacción recurrente',
      detail: template?.description || 'Plantilla recurrente',
    };
  }

  const mapped = meta.source ? SOURCE_ORIGINS[meta.source] : undefined;
  if (mapped) return { ...mapped, detail: [mapped.detail, provider].filter(Boolean).join(' · ') };

  // Sin `source`: el asistente IA escribiendo a mano en el chat (la captura por
  // foto/PDF sí lo manda) y los asientos importados ANTES del 18-09-2026, que
  // quedaron sin marca. No se puede afirmar cuál de los dos fue.
  return {
    kind: 'AUTOMATICO',
    icon: '📥',
    label: 'Registro automático',
    detail: [TYPE_LABELS[tx.type] || tx.type, provider].filter(Boolean).join(' · ') || 'Importador o asistente IA',
  };
}
