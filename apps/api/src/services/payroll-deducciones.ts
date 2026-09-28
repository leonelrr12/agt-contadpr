/**
 * Deducciones de acreedores: si la cuota aplica, cuánto se descuenta y cuándo termina.
 *
 * Es PURO como `payroll-calc.ts`, y por la misma razón: lo que decide un descuento al
 * sueldo de una persona tiene que poder probarse sin base de datos. El servicio
 * (`payroll-acreedores.ts`) aporta los datos —catálogo e historial de cuotas— y el
 * motor de la corrida aporta la base del período.
 *
 * La regla que sostiene todo: **`monto > 0` es la única marca de "cuota aplicada"**. El
 * saldo es la suma de lo aplicado y el número de cuota es ese conteo + 1, así que una
 * cuota SALTADA (`monto 0` con `omitida`) no mueve ni el saldo ni el calendario: el
 * contador se salta una cuota puntual sin desarmar la deducción.
 *
 * Dos topes, y termina el que llegue primero:
 *  · `cuotas` — cuántas FALTAN desde el corte (no las pactadas originalmente).
 *  · el remanente de la deuda — la última cuota es lo que queda y la deuda se extingue
 *    sola. Sin este tope, un préstamo se descontaría para siempre.
 *
 * **La cuota es MENSUAL**, aunque el empleado cobre por quincena o por semana: el banco
 * y la mueblería pactan por mes. Se reparte entre los pagos del mes con el mismo reparto
 * del ISR —los intermedios llevan la división y el último cierra— y **una cuota se
 * aplica una vez al mes**, no una vez por pago. Tratarla "por pago" le descontaba 4,33
 * cuotas al mes al que cobra semanal, y le acortaba el plazo a un tercio.
 */

import { r2, sumarMontos } from '../lib/money';
import type { TipoCorrida } from './payroll-calc';

export type TipoDeduccion = 'FIJO' | 'PORCENTAJE';

/**
 * Estado de la cuota en ESTE período. El orden de evaluación importa y está probado en
 * ese orden: lo que ya terminó está terminado, lo salte el contador o no.
 */
export type EstadoCuota =
  | 'APLICA'
  | 'OMITIDA_MANUAL'
  | 'SUSPENDIDA_DICIEMBRE'
  | 'NO_ACTIVA'
  | 'FUERA_DE_FECHAS'
  | 'TERMINADA_CUOTAS'
  | 'TERMINADA_SALDO'
  | 'SIN_MONTO';

/** La fila del catálogo ya normalizada para la corrida. */
export interface DeduccionCalc {
  deduccionId: string;
  employeeId: string;
  /** Texto libre del acreedor: viaja congelado al ítem y a la descripción del asiento. */
  acreedor: string;
  cuentaId: string;
  tipo: TipoDeduccion;
  montoFijo?: number | null;
  porcentaje?: number | null;
  /** Cuotas que faltan desde el corte. */
  cuotas?: number | null;
  /** Remanente por descontar. `null` = sin tope (no termina sola). */
  saldoPendiente: number | null;
  /** Cuotas ya APLICADAS —las que CERRARON su mes— en corridas vivas. */
  cuotasAplicadas: number;
  /**
   * Lo que ya se le descontó por ESTA deducción en los pagos anteriores del mes. Lo
   * usa el pago que cierra el mes para tomar exactamente lo que falta de la cuota, sin
   * perder céntimos ni cobrar dos veces.
   */
  yaDescontadoEnElMes?: number;
  fechaInicio?: Date | null;
  fechaFin?: Date | null;
  aplicaEnDiciembre: boolean;
  isActive: boolean;
  /** El contador la saltó en ESTA corrida. */
  omitida?: boolean;
  /** Monto ajustado a mano para esta cuota: manda sobre el calculado. */
  montoAjustado?: number | null;
}

export interface ContextoCuota {
  tipo: TipoCorrida;
  /** La fecha de PAGO: es el ancla del módulo ("en diciembre" es cuándo se paga). */
  fechaPago: Date;
  /**
   * Qué pago del mes es este (1-based) y cuántos hay. Son los mismos datos con los que
   * el motor reparte el ISR mensual, y acá hacen falta por lo mismo: **la cuota de un
   * acreedor es MENSUAL** —así la pacta el banco o la mueblería—, así que un empleado
   * que cobra por quincena o por semana la paga REPARTIDA entre los pagos del mes. Sin
   * esto, una cuota de 100 se descontaba 4,33 veces al mes al que cobra semanal.
   */
  pagoNumero: number;
  pagosDelMes: number;
}

/**
 * Lo que el contador ajusta de una deducción en UNA corrida: saltarla o cambiarle el
 * monto de esta cuota. Llega del body (el desglose de la pantalla) y `previsualizarCorrida`
 * lo funde con el catálogo antes de que el motor vea nada.
 */
export interface AjusteDeduccion {
  deduccionId: string;
  omitida?: boolean;
  /** Monto de esta cuota; teclear 0 es saltarla. */
  monto?: number;
}

/** La cuota resuelta de una deducción para una corrida. */
export interface CuotaResuelta {
  deduccionId: string;
  employeeId: string;
  acreedor: string;
  cuentaId: string;
  estado: EstadoCuota;
  /** Legible para la pantalla; cadena vacía cuando aplica. */
  motivo: string;
  /** 1-based sobre las aplicadas; `null` si no aplica. */
  cuotaNumero: number | null;
  cuotasTotales: number | null;
  /**
   * ¿Este pago CIERRA la cuota del mes? Los pagos intermedios de un empleado quincenal
   * o semanal son abonos de la misma cuota: solo el que cierra la cuenta como cuota
   * aplicada (es lo que persiste `cuotaNumero`).
   */
  cierraCuota: boolean;
  monto: number;
  saldoAntes: number | null;
  saldoDespues: number | null;
  /** Higiene de la configuración, para la pantalla (cadena vacía si no hay nada). */
  aviso: string;
}

/** El tope de la deuda: `saldoInicial` manda sobre `montoTotal`; sin ninguno, no hay. */
export function topeDeuda(d: { saldoInicial?: number | null; montoTotal?: number | null }): number | null {
  if (d.saldoInicial != null) return r2(d.saldoInicial);
  if (d.montoTotal != null) return r2(d.montoTotal);
  return null;
}

/** Lo que queda por descontar al corte. `null` = sin tope. */
export function saldoPendienteDe(tope: number | null, aplicado: number): number | null {
  return tope == null ? null : r2(tope - aplicado);
}

/** La base de una deducción en porcentaje: lo mismo que cotiza (R2/R3). */
export function baseDeduccion(sueldo: number, horasExtras: number): number {
  return sumarMontos(sueldo, horasExtras);
}

/** ¿Es diciembre la fecha de pago? Los meses de JS son 0-based. */
function esDiciembre(fecha: Date): boolean {
  return fecha.getMonth() === 11;
}

/**
 * El orden de evaluación ES la regla:
 *
 *  1. desactivada            → NO_ACTIVA
 *  2. corrida que no es de sueldo → NO_ACTIVA (un descuento de mueblería contra el
 *     décimo no es lo que se pactó; si algún día se quiere, es un flag más)
 *  3. fuera de fechas        → FUERA_DE_FECHAS (bordes inclusive)
 *  4. cuotas completas       → TERMINADA_CUOTAS
 *  5. deuda saldada          → TERMINADA_SALDO
 *  6. diciembre sin permiso  → SUSPENDIDA_DICIEMBRE
 *  7. la saltó el contador   → OMITIDA_MANUAL
 *  8. el resto               → APLICA
 */
export function estadoDeCuota(d: DeduccionCalc, ctx: ContextoCuota): EstadoCuota {
  if (!d.isActive) return 'NO_ACTIVA';
  if (ctx.tipo !== 'SUELDO') return 'NO_ACTIVA';
  if (d.fechaInicio && ctx.fechaPago < d.fechaInicio) return 'FUERA_DE_FECHAS';
  if (d.fechaFin && ctx.fechaPago > d.fechaFin) return 'FUERA_DE_FECHAS';
  if (d.cuotas != null && d.cuotasAplicadas >= d.cuotas) return 'TERMINADA_CUOTAS';
  if (d.saldoPendiente != null && d.saldoPendiente <= 0) return 'TERMINADA_SALDO';
  if (!d.aplicaEnDiciembre && esDiciembre(ctx.fechaPago)) return 'SUSPENDIDA_DICIEMBRE';
  if (d.omitida) return 'OMITIDA_MANUAL';
  return 'APLICA';
}

/** El texto que ve el contador en el desglose. */
export function motivoDeEstado(estado: EstadoCuota, d: DeduccionCalc): string {
  switch (estado) {
    case 'NO_ACTIVA':
      return d.isActive ? 'solo corre en corridas de sueldo' : 'la deducción está desactivada';
    case 'FUERA_DE_FECHAS':
      return 'fuera de las fechas de la deducción';
    case 'TERMINADA_CUOTAS':
      return `ya se aplicaron las ${d.cuotas} cuota(s)`;
    case 'TERMINADA_SALDO':
      return 'la deuda quedó saldada';
    case 'SUSPENDIDA_DICIEMBRE':
      return 'suspendida en diciembre';
    case 'OMITIDA_MANUAL':
      return 'la saltaste en esta corrida';
    case 'SIN_MONTO':
      return 'la cuota quedó en cero';
    default:
      return '';
  }
}

/**
 * La cuota del MES: el fijo, o el porcentaje de la base, topada por el remanente.
 *
 * El tope es lo que hace que la última cuota sea lo que queda de la deuda y esta
 * termine sola. Sin tope, un préstamo se descontaría para siempre.
 */
export function cuotaMensual(d: DeduccionCalc, base: number, yaDescontadoEnElMes = 0): number {
  const bruto = d.tipo === 'FIJO' ? r2(d.montoFijo ?? 0) : r2(base * (d.porcentaje ?? 0));
  if (d.saldoPendiente == null) return bruto;
  // Al remanente se le devuelve lo ya descontado ESTE mes: el saldo del período ya tiene
  // descontados los abonos del mes en curso, y sin eso la última cuota de un quincenal
  // se quedaba corta (el que cierra no cobraba lo que faltaba).
  return Math.min(bruto, r2(d.saldoPendiente + yaDescontadoEnElMes));
}

/**
 * Lo que se descuenta en ESTE pago: la cuota del mes repartida entre los pagos del mes.
 *
 * Es el mismo reparto del ISR (`isrDelPago`): los pagos intermedios llevan la división
 * redondeada y **el último cierra el mes** con lo que falte (`cuota − lo ya descontado
 * este mes`). Así el acreedor cobra la cuota completa una vez al mes, el empleado no
 * siente el mes entero en un solo pago, y no se pierde ni un céntimo por redondeo.
 *
 * Para quien cobra mensual (`pagosDelMes = 1`) esto es la cuota entera: el mismo camino
 * sirve para las tres periodicidades.
 */
export function cuotaDelPago(cuota: number, ctx: ContextoCuota, yaDescontadoEnElMes = 0): number {
  if (ctx.pagosDelMes <= 1 || ctx.pagoNumero >= ctx.pagosDelMes) {
    return r2(cuota - yaDescontadoEnElMes);
  }
  return r2(cuota / ctx.pagosDelMes);
}

/**
 * El monto de esta cuota, ya repartido. Un ajuste manual del contador manda sobre todo
 * —es un acto deliberado— y `avisosDeDeduccion` reporta si supera la deuda.
 */
export function montoDeCuota(d: DeduccionCalc, base: number, ctx: ContextoCuota): number {
  if (d.montoAjustado != null) return r2(d.montoAjustado);
  const yaEnElMes = d.yaDescontadoEnElMes ?? 0;
  return cuotaDelPago(cuotaMensual(d, base, yaEnElMes), ctx, yaEnElMes);
}

/**
 * Higiene de la CONFIGURACIÓN, sin mirar la corrida: lo que la pantalla del catálogo
 * puede decir de una deducción aunque todavía no haya corrido nada.
 */
export function avisosDeCatalogo(d: DeduccionCalc): string {
  if (!d.isActive) return '';
  if (ctxVivo(d) && d.cuotas == null && d.saldoPendiente == null) {
    return 'no tiene cuotas ni monto total: se va a descontar todos los períodos';
  }
  if (d.tipo === 'PORCENTAJE' && !((d.porcentaje ?? 0) > 0)) {
    return 'está configurada por porcentaje pero la tasa quedó en cero';
  }
  return '';
}

/** Higiene para la corrida: el ajuste del contador primero, y si no la de la ficha. */
export function avisosDeDeduccion(d: DeduccionCalc, c: CuotaResuelta): string {
  if (c.estado === 'APLICA' && d.montoAjustado != null && d.saldoPendiente != null && d.montoAjustado > r2(d.saldoPendiente)) {
    return `el monto ajustado (${r2(d.montoAjustado).toFixed(2)}) supera lo que queda de la deuda (${r2(d.saldoPendiente).toFixed(2)})`;
  }
  return avisosDeCatalogo(d);
}

/** Solo avisa de lo que sigue corriendo: una deducción terminada ya no es un problema. */
function ctxVivo(d: DeduccionCalc): boolean {
  return d.cuotas == null || d.cuotasAplicadas < d.cuotas;
}

/** Una cuota resuelta por deducción: las que aplican y las que no (con su motivo). */
export function resolverDeducciones(
  ds: DeduccionCalc[],
  ctx: ContextoCuota & { base: number },
): CuotaResuelta[] {
  // El último pago del mes es el que cierra la cuota; los anteriores son abonos de esa
  // misma cuota (empleado quincenal o semanal).
  const cierra = ctx.pagosDelMes <= 1 || ctx.pagoNumero >= ctx.pagosDelMes;

  return ds.map((d) => {
    let estado = estadoDeCuota(d, ctx);
    let monto = 0;
    if (estado === 'APLICA') {
      monto = montoDeCuota(d, ctx.base, ctx);
      // Teclear 0 es saltarla: no aplica, no mueve el saldo y no avanza el calendario.
      if (monto <= 0) estado = 'SIN_MONTO';
    }
    const cuota: CuotaResuelta = {
      deduccionId: d.deduccionId,
      employeeId: d.employeeId,
      acreedor: d.acreedor,
      cuentaId: d.cuentaId,
      estado,
      motivo: motivoDeEstado(estado, d),
      cuotaNumero: estado === 'APLICA' ? d.cuotasAplicadas + 1 : null,
      cuotasTotales: d.cuotas ?? null,
      cierraCuota: cierra,
      monto,
      saldoAntes: d.saldoPendiente,
      saldoDespues: d.saldoPendiente == null ? null : r2(d.saldoPendiente - monto),
      aviso: '',
    };
    cuota.aviso = avisosDeDeduccion(d, cuota);
    return cuota;
  });
}

/** Lo que se le descuenta al empleado por acreedores: el total que va al asiento. */
export function totalAplicado(cuotas: CuotaResuelta[]): number {
  return sumarMontos(
    ...cuotas.filter((c) => c.estado === 'APLICA' && c.monto > 0).map((c) => c.monto),
  );
}

/** ¿Esta cuota se persiste en el detalle de la corrida? Solo las que dejan rastro. */
export function sePersiste(c: CuotaResuelta): boolean {
  return c.estado === 'APLICA' || c.estado === 'OMITIDA_MANUAL' || c.estado === 'SUSPENDIDA_DICIEMBRE';
}
