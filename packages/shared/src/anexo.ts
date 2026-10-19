/**
 * Reglas del flag "Lleva Anexo" (`Account.requiresAnexo`), compartidas por el
 * import (API) y el chat/agentes. Ver Tuning.md §5.
 *
 * Con el flag activo, además de fecha/concepto/monto, la cuenta exige
 * RUC/Cédula y Nombre del tercero, y Nº de factura cuando la fila es a crédito.
 * Sin el flag, la fila solo exige fecha/concepto/monto.
 */

/** Fila a crédito: queda debiendo al tercero. La TARJETA de crédito NO cuenta
 *  (se le paga al emisor, no al proveedor). */
export function esFilaCredito(row: { paymentMethod?: string | null }): boolean {
  return row.paymentMethod === 'CREDITO';
}

/** Campos que exige la cuenta por llevar Anexo (vacío si no lo lleva). */
export function missingAnexoFields(
  row: {
    ruc?: string | null;
    provider?: string | null;
    reference?: string | null;
    paymentMethod?: string | null;
  },
  cuenta: { requiresAnexo: boolean } | null | undefined,
): string[] {
  if (!cuenta?.requiresAnexo) return [];
  const missing: string[] = [];
  if (!(row.ruc || '').trim()) missing.push('RUC/Cédula');
  if (!(row.provider || '').trim()) missing.push('Nombre');
  if (esFilaCredito(row) && !(row.reference || '').trim()) {
    missing.push('Nº de factura (obligatorio en crédito)');
  }
  return missing;
}
