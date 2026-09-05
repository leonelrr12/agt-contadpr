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

export interface RetencionCobroInfo {
  /** Tope aceptado para la retención de este cobro. */
  cap: number;
  /** Porcentaje usado para el tope (perfil del cliente o 50% estándar). */
  pct: number;
  /** ¿El cliente ya está marcado como agente vigente para la fecha de la factura? */
  esAgente: boolean;
}

/**
 * Info de retención para un COBRO, tolerante a clientes sin perfil: cuando el
 * cliente no está marcado como agente se usa el 50% estándar de la DGI como
 * tope (la evidencia del cobro —retención explícita o cierre del neto— marca
 * al cliente después). El perfil solo ajusta el porcentaje, no bloquea.
 */
export function retencionCobroInfo(
  client: ClienteAgentePerfil | null,
  itbms: number,
  fechaFactura: Date,
): RetencionCobroInfo {
  if (!itbms || itbms <= 0) return { cap: 0, pct: 0, esAgente: false };
  const esAgente = esAgenteRetencionEn(client, fechaFactura);
  const pct = esAgente ? (client?.porcentajeRetencionItbms ?? 0.5) : 0.5;
  return { cap: Math.round(itbms * pct * 100) / 100, pct, esAgente };
}

/**
 * Marca al cliente como agente de retención a partir de la evidencia del
 * cobro (retención efectivamente aplicada). Respeta el porcentaje existente
 * o lo deriva de la retención; fija la vigencia desde la fecha de la factura
 * si el cliente no tenía ninguna (para que la operación quede cubierta).
 */
export async function marcarClienteAgente(
  prisma: any,
  clientId: string,
  fechaFactura: Date,
  retencion: number,
  itbms: number,
): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, esAgenteRetenedor: true, porcentajeRetencionItbms: true, vigenciaRetencionDesde: true },
  });
  if (!client || client.esAgenteRetenedor) return; // ya marcado — no pisar
  const data: any = { esAgenteRetenedor: true };
  if ((client.porcentajeRetencionItbms ?? 0.5) === 0.5 && itbms > 0 && retencion > 0) {
    data.porcentajeRetencionItbms = Math.min(1, Math.max(0, retencion / itbms));
  }
  if (!client.vigenciaRetencionDesde) {
    data.vigenciaRetencionDesde = new Date(fechaFactura);
  }
  await prisma.client.update({ where: { id: clientId }, data });
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
