/**
 * Lógica compartida de retención de ITBMS SUFRIDA (Panamá).
 *
 * Un cliente agente de retención retiene el 50% (por defecto) del ITBMS de la
 * factura al pagarnos. La retención NO es saldo de CxC: es crédito fiscal del
 * vendedor (Form. 430, renglón 52) y se registra en la cuenta activa
 * `itbms-retenido-terceros` en el asiento del cobro.
 *
 * Modelo confirmado (2026-09-05): el cliente paga el neto (total − retención)
 * — de una vez o en abonos en efectivo — y la retención se materializa como
 * evento único en el pago que completa el cobro (aplicado == saldo).
 * Guardas: retención nunca supera el porcentaje del ITBMS de la factura, y el
 * caso "saldo menor que la retención pendiente" NO se aplica en silencio.
 */

export const RETENCION_EPS = 0.01;

export interface ClienteAgentePerfil {
  esAgenteRetenedor?: boolean;
  porcentajeRetencionItbms?: number | null;
  vigenciaRetencionDesde?: Date | null;
  vigenciaRetencionHasta?: Date | null;
}

/** ¿El cliente era agente retenedor en la fecha de la operación? */
export function esAgenteRetencionEn(client: ClienteAgentePerfil | null, fechaOperacion: Date): boolean {
  if (!client?.esAgenteRetenedor) return false;
  const fecha = new Date(fechaOperacion);
  if (client.vigenciaRetencionDesde && fecha.getTime() < new Date(client.vigenciaRetencionDesde).getTime()) return false;
  if (client.vigenciaRetencionHasta && fecha.getTime() > new Date(client.vigenciaRetencionHasta).getTime()) return false;
  return true;
}

/**
 * Retención total esperada de una factura según el perfil del cliente:
 * porcentaje × ITBMS de la factura (0 si no aplica).
 */
export function retencionTotalEsperada(
  client: ClienteAgentePerfil | null,
  itbms: number,
  fechaFactura: Date,
): number {
  if (!esAgenteRetencionEn(client, fechaFactura)) return 0;
  if (!itbms || itbms <= 0) return 0;
  const pct = client?.porcentajeRetencionItbms ?? 0.5;
  return Math.round(itbms * pct * 100) / 100;
}

/** Retención pendiente de una factura: total esperada − ya registrada. */
export function retencionPendiente(totalEsperada: number, yaRetenido: number): number {
  return Math.max(0, Math.round((totalEsperada - yaRetenido) * 100) / 100);
}

export interface CuentaConAlias {
  id: string;
  aliases?: string[] | null;
}

/** Busca la cuenta del catálogo por alias (igual que 'clientes'/'caja'). */
export function findAccountByAlias(accounts: CuentaConAlias[], alias: string): CuentaConAlias | null {
  for (const a of accounts) {
    const aliases = (a.aliases || []).map(x => x.trim().toLowerCase());
    if (aliases.includes(alias)) return a;
  }
  return null;
}

/**
 * Describe el resultado de una fila de cobro con posible retención para la UI.
 * Devuelve la retención sugerida (solo informativa; nunca se aplica sola).
 */
export function sugerirRetencion(input: {
  client: ClienteAgentePerfil | null;
  fechaFactura: Date;
  itbms: number;
  saldo: number;
  efectivo: number;
  retencionDeclarada: number;
  retencionTotalEsperada: number;
}): { esperada: number; sugerida: number; motivo: 'ninguna' | 'cierre' | 'excede' } {
  const { saldo, efectivo, retencionDeclarada, retencionTotalEsperada } = input;
  if (retencionDeclarada > 0) return { esperada: retencionTotalEsperada, sugerida: 0, motivo: 'ninguna' };
  if (retencionTotalEsperada <= 0) return { esperada: 0, sugerida: 0, motivo: 'ninguna' };
  const restante = Math.round((saldo - efectivo) * 100) / 100;
  // Pago que deja exactamente la retención pendiente → probable cierre con retención
  if (Math.abs(restante - retencionTotalEsperada) <= RETENCION_EPS) {
    return { esperada: retencionTotalEsperada, sugerida: retencionTotalEsperada, motivo: 'cierre' };
  }
  return { esperada: retencionTotalEsperada, sugerida: 0, motivo: 'ninguna' };
}
