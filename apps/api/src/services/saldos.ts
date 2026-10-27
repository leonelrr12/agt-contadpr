/**
 * Saldos de documentos de terceros. Fuente única para el panel Terceros, el
 * aging y el resumen económico.
 *
 * Un invoice con `paymentMethod: 'EFECTIVO'` se cobró en el mostrador: NO es
 * CxC aunque su `status` siga en PENDIENTE (el módulo Facturas PDF no lo marca
 * PAGADA al emitirlo). Sin esto, el panel y el aging muestran como deuda una
 * venta que ya se cobró.
 */

export function invoiceSaldo(i: {
  total: number;
  paidAmount?: number | null;
  status: string;
  paymentMethod?: string | null;
}): number {
  if (i.status === 'PAGADA' || i.status === 'RECHAZADA') return 0;
  if (i.paymentMethod === 'EFECTIVO') return 0;
  return Math.max(0, Math.round(((Number(i.total) || 0) - (Number(i.paidAmount) || 0)) * 100) / 100);
}

/** Los Bills del proveedor no tienen abonos parciales: o se pagó o se debe. */
export function billSaldo(b: { total: number; status: string }): number {
  if (b.status === 'PAGADA' || b.status === 'RECHAZADA') return 0;
  return Math.max(0, Math.round((Number(b.total) || 0) * 100) / 100);
}

/** Facturas que sí representan una cuenta por cobrar (crédito, no contado). */
export function esCxC(i: { paymentMethod?: string | null }): boolean {
  return i.paymentMethod !== 'EFECTIVO';
}

/**
 * Filtro Prisma para los reportes/agregados de CxC. Las facturas sin
 * `paymentMethod` son las de crédito creadas por import/chat/manual; las de
 * contado (EFECTIVO) ya se cobraron y no deben inflar la cuenta por cobrar.
 */
export function filtroFacturaCredito() {
  return { OR: [{ paymentMethod: null }, { paymentMethod: { not: 'EFECTIVO' } }] };
}
