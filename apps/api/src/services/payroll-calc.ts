/**
 * Motor de cálculo de la planilla panameña.
 *
 * Es PURo: recibe empleados, entradas y parámetros, y devuelve los montos. No toca
 * la base de datos, ni Express, ni la hora del sistema — por eso se puede probar
 * entera, igual que `costo-promedio.ts`.
 *
 * Las reglas NO se dedujeron de un manual: se verificaron contra los 77 asientos de
 * planilla ya cargados (ver PLANILLA.md §3.1). Tres de ellas contradicen lo que uno
 * supondría de memoria, así que van marcadas:
 *
 *  · **El ISR es una proyección ANUAL ×13**, no una tabla mensual progresiva. El
 *    impuesto se calcula sobre `sueldoMensual × 13` con la escala anual y se divide
 *    entre 13 para obtener la retención del mes. Con la tabla mensual, un sueldo de
 *    1.220,80/mes daría 22,81 por quincena donde el archivo dice 28,10.
 *
 *  · **El décimo cotiza SS al 7,25%** y no lleva Seguro Educativo ni ISR. Si además
 *    se le retuviera ISR, se retendría dos veces: el ×13 ya lo incluye.
 *
 *  · **El redondeo es medio-arriba** en todos los casos (`lib/money.ts`), y el neto
 *    es el RESIDUO de la resta. Esa segunda parte es la que hace que el asiento
 *    cuadre por construcción: no hay céntimo que absorber en ningún monto.
 *
 *  · **El sueldo semanal es `mensual × 12/52`**, no un prorrateo por días del mes.
 *    Es una decisión del dueño (PLANILLA.md §2): 52 semanas son 364 días, así que el
 *    reparto por días dejaría el año corto y la base de cotización también.
 */

import { r2, sumarMontos } from '../lib/money';
import {
  baseDeduccion,
  resolverDeducciones,
  totalAplicado,
  type CuotaResuelta,
  type DeduccionCalc,
} from './payroll-deducciones';

// ─── Tabla del ISR ───────────────────────────────────────────────────────────

export interface TramoISR {
  desde: number;
  hasta: number | null;
  tasa: number;
}

/**
 * Escala ANUAL del impuesto sobre la renta de personas naturales (Panamá).
 *
 * Es el default, no una constante sagrada: `PayrollSettings.tablaISR` puede
 * sobreescribirla y el contador la edita desde la pestaña Parámetros. Si cambia la
 * ley, se cambia ahí — el motor no se toca.
 */
export const TABLA_ISR_PANAMA: TramoISR[] = [
  { desde: 0, hasta: 11000, tasa: 0 },
  { desde: 11000, hasta: 50000, tasa: 0.15 },
  { desde: 50000, hasta: null, tasa: 0.25 },
];

/**
 * Meses que se proyectan para el ISR. Son 13 y no 12 porque el décimo tercer mes
 * también es renta gravable — y es justo lo que explica que el propio décimo se
 * pague sin retención.
 */
export const MESES_ISR = 13;

// ─── Entradas y salidas ──────────────────────────────────────────────────────

export type TipoCorrida = 'SUELDO' | 'DECIMO' | 'VACACIONES';
export type Periodicidad = 'SEMANAL' | 'QUINCENAL' | 'MENSUAL' | 'ANUAL' | 'EVENTUAL';
export type TipoPago = 'SEMANAL' | 'QUINCENAL' | 'MENSUAL';

export interface Tasas {
  ssObrero: number;
  seObrero: number;
  ssPatronal: number;
  sePatronal: number;
  /** Tasa general de riesgos profesionales: la del empleado sin clase asignada. */
  riesgosProfesionales: number;
  /** Tarifa por clase de riesgo (I…V). Una clase ausente NO se asume en cero. */
  riesgosPorClase: Record<string, number>;
  ssObreroDecimo: number;
  seObreroDecimo: number;
  /** El patrono cotiza el décimo a una tasa MENOR que el sueldo. */
  ssPatronalDecimo: number;
  factorDecimo: number;
  factorVacaciones: number;
  factorPrima: number;
  tablaISR: TramoISR[];
  provisionarPrestaciones: boolean;
}

export interface EmpleadoCalc {
  id: string;
  nombre: string;
  sueldoBase: number;
  tipoPago: TipoPago;
  fechaIngreso?: Date | null;
  fechaSalida?: Date | null;
  /** Clase de riesgo profesional (I…V). Sin clase, usa la tasa general. */
  claseRiesgo?: string | null;
}

/** Clases de riesgo profesional admitidas. */
export const CLASES_RIESGO = ['I', 'II', 'III', 'IV', 'V'] as const;

/**
 * Tarifa de riesgos del código: solo la clase I (1,00%). Las demás las carga el
 * contador desde Parámetros — no se inventan acá.
 */
export const TASAS_RIESGO_DEFAULT: Record<string, number> = { I: 0.01 };

/** Lo que el contador edita en el grid antes de ejecutar. Todo opcional. */
export interface EntradaItem {
  employeeId: string;
  diasTrabajados?: number;
  horasExtras?: number;
  otrosIngresos?: number;
  /**
   * Lo que se le descuenta por ausencia o tardanza. NO es una deducción al neto: es
   * salario que no se devengó, así que baja el sueldo y con él la base de cotización
   * (ver R1c). Una ausencia de días completos se carga directamente en
   * `diasTrabajados`, que ya prorratea.
   */
  menosSueldo?: number;
  /**
   * Deducciones de acreedores ya precargadas del catálogo (préstamos, embargos,
   * mueblerías). Vienen sin resolver —con el historial de cuotas aplicadas y los
   * ajustes del contador— porque el monto depende de la base del período, que se
   * conoce acá adentro.
   */
  deducciones?: DeduccionCalc[];
  /**
   * Lo que se descuenta sin acreedor identificado: lo que el contador teclea en el
   * desglose. Es lo que antes era `otrasDeducciones`.
   */
  otrasDeduccionesManual?: number;
  /**
   * @deprecated Alias de `otrasDeduccionesManual`. Se sigue aceptando porque una
   * pantalla con caché vieja no puede perder en silencio un número que el contador
   * tecleó — y ese número cambiaría el neto de una persona.
   */
  otrasDeducciones?: number;
  /** Solo en corridas de DECIMO y VACACIONES: el monto a pagar de la prestación. */
  montoPrestacion?: number;
  notas?: string;
}

export interface ContextoCorrida {
  tipo: TipoCorrida;
  periodicidad: Periodicidad;
  fechaDesde: Date;
  fechaHasta: Date;
  /**
   * Qué pago del mes es este (1-based) y cuántos hay. Es lo que permite repartir el
   * ISR mensual sin perder céntimos: los pagos intermedios llevan la división
   * redondeada y **el último cierra el mes** con la diferencia.
   */
  pagoNumero: number;
  pagosDelMes: number;
  /**
   * Cuándo se paga. Es el ancla que usa la suspensión de diciembre de las deducciones
   * de acreedores —"en diciembre" es cuándo se le paga al empleado, no a qué período
   * pertenece— y coincide con el ancla que ya usa `periodoDe` en la corrida semanal.
   */
  fechaPago: Date;
  /**
   * ISR ya retenido en los pagos anteriores de este mes, POR EMPLEADO. Va indexado
   * y no como un número suelto porque cada quien tiene su propio sueldo: el reparto
   * del mes es individual, no de la corrida.
   */
  isrYaRetenidoPorEmpleado?: Record<string, number>;
}

export interface CalculoItem {
  employeeId: string;
  diasTrabajados: number;
  sueldo: number;
  horasExtras: number;
  otrosIngresos: number;
  /** El descuento aplicado al sueldo, congelado para poder mostrarlo. */
  menosSueldo: number;
  bruto: number;
  ss: number;
  se: number;
  isr: number;
  otrasDeducciones: number;
  /**
   * El desglose por acreedor de `otrasDeducciones`. `otrasDeducciones` es siempre
   * `sumarMontos(manual, Σ de las que aplican)`: por eso lo acreditado en el asiento
   * (una cuenta por acreedor + el resto a la genérica) suma exactamente el total, sin
   * céntimo que absorber.
   */
  deducciones: CuotaResuelta[];
  /** RESIDUO: `bruto − deducciones`. Nunca se recalcula aparte. */
  neto: number;
  ssPatronal: number;
  sePatronal: number;
  riesgosPatronal: number;
  decimoGenerado: number;
  vacacionesGeneradas: number;
  primaGenerada: number;
  notas?: string;
  avisos: string[];
}

export interface TotalesCorrida {
  bruto: number;
  deducciones: number;
  neto: number;
  patronal: number;
  decimoGenerado: number;
  vacacionesGeneradas: number;
  primaGenerada: number;
}

export interface ResultadoCorrida {
  items: CalculoItem[];
  totales: TotalesCorrida;
  /** Empleados que no entraron y por qué (no es un error: es el prellenado). */
  omitidos: { employeeId: string; nombre: string; motivo: string }[];
  /**
   * Empleados que NO se pudieron calcular. Distinto de `omitidos`: esto no es
   * "no le tocaba", es "falta algo para poder pagarle". Una corrida con errores no
   * se ejecuta — dejar a alguien afuera de la nómina en silencio es el peor final.
   */
  errores: { employeeId: string; nombre: string; motivo: string }[];
}

// ─── ISR ─────────────────────────────────────────────────────────────────────

/**
 * Impuesto anual de una base gravable, aplicando la escala por tramos.
 *
 * Es PROGRESIVA: cada tramo aporta el impuesto de SU rebanada, no el de todo el
 * excedente. La diferencia solo aparece arriba de 50.000 —ahí el tramo del 25%
 * tiene que arrastrar los 5.850 que ya generó el del 15%—, pero es la diferencia
 * entre una escala real y un impuesto plano del 25%. Los tramos tienen que venir
 * contiguos y ordenados: la primera rebanada vacía corta el recorrido.
 */
export function impuestoAnual(baseAnual: number, tabla: TramoISR[] = TABLA_ISR_PANAMA): number {
  let impuesto = 0;
  for (const tramo of tabla) {
    if (baseAnual <= tramo.desde) break;
    const techo = tramo.hasta === null ? baseAnual : Math.min(baseAnual, tramo.hasta);
    impuesto += (techo - tramo.desde) * tramo.tasa;
  }
  return r2(impuesto);
}

/**
 * Retención del MES: se proyecta el año (`sueldo × 13`) y se divide entre 13.
 *
 * La proyección usa el sueldo base del contrato, no el bruto del período: está
 * verificado que las horas extras no mueven la retención (la fila con 120,32 de
 * extras retiene lo mismo que las que no los tienen).
 */
export function isrMensual(
  sueldoMensual: number,
  tabla: TramoISR[] = TABLA_ISR_PANAMA,
  meses: number = MESES_ISR,
): number {
  return r2(impuestoAnual(sueldoMensual * meses, tabla) / meses);
}

/**
 * Reparto del ISR del mes entre sus pagos.
 *
 * Los pagos intermedios llevan la división redondeada y el ÚLTIMO se queda con lo
 * que falte para cerrar el mes exacto. Sin eso el año pierde céntimos: dos pagos de
 * `r2(56,1969 / 2)` suman 56,20 cuando el mes debe 56,1969 → 56,20, pero tres pagos
 * de un tercio no cerrarían igual.
 */
export function isrDelPago(
  isrMensualCalculado: number,
  pagoNumero: number,
  pagosDelMes: number,
  yaRetenido = 0,
): number {
  if (pagosDelMes <= 1 || pagoNumero >= pagosDelMes) {
    return r2(isrMensualCalculado - yaRetenido);
  }
  return r2(isrMensualCalculado / pagosDelMes);
}

// ─── Fechas ──────────────────────────────────────────────────────────────────

/**
 * Días del mes de una fecha, contando el mes real (febrero bisiesto incluido).
 * Se calcula con `new Date(y, m+1, 0)`, no sumando 30 días.
 */
export function diasDelMes(fecha: Date): number {
  return new Date(fecha.getFullYear(), fecha.getMonth() + 1, 0).getDate();
}

/** Días entre dos fechas locales, AMBOS inclusive. */
export function diasEntre(desde: Date, hasta: Date): number {
  const a = Date.UTC(desde.getFullYear(), desde.getMonth(), desde.getDate());
  const b = Date.UTC(hasta.getFullYear(), hasta.getMonth(), hasta.getDate());
  return Math.round((b - a) / 86400000) + 1;
}

// ─── El calendario del pago semanal ──────────────────────────────────────────

/** Semanas y meses de un año: de ahí sale la conversión mensual ↔ semanal. */
export const SEMANAS_POR_ANIO = 52;
export const MESES_POR_ANIO = 12;

/** Días que cubre una semana completa de trabajo: el denominador del prorrateo. */
export const DIAS_DE_LA_SEMANA = 7;

/** Días de la semana en el orden de `Date.getDay()`: el selector de Parámetros. */
export const DIAS_SEMANA = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

/** Viernes: la semana se paga vencida, al cerrarla. */
export const DIA_PAGO_SEMANAL_DEFAULT = 5;

/**
 * El sueldo de una semana completa, a partir del mensual del contrato.
 *
 * Es `mensual × 12 / 52`, y no `mensual / 4,33` ni un prorrateo por días del mes.
 * Las dos alternativas fallan por lo mismo: 52 semanas son 364 días, así que
 * repartir el sueldo entre los días del mes paga 364/365 avos del año y deja la base
 * de cotización corta, además de romperse en la semana que cruza el fin de mes (no
 * hay "mes del período" cuando el período tiene días de dos meses).
 *
 * Con la semana completa como unidad, el año cierra exacto: 52 pagos de
 * `mensual × 12/52` suman los 12 sueldos, y el prorrateo de una semana parcial —un
 * ingreso a mitad de semana— va sobre séptimos, que es la única partición que el
 * empleado reconoce.
 */
export function sueldoSemanal(sueldoMensual: number): number {
  return r2((sueldoMensual * MESES_POR_ANIO) / SEMANAS_POR_ANIO);
}

/**
 * Cuántas veces cae `diaSemana` en el mes de `fecha`: 4 o 5.
 *
 * Es lo que hace que el ISR del mes cierre exacto en una nómina semanal. Con la
 * quincena alcanza con saber que son dos pagos; acá no: un mes tiene cuatro o cinco
 * de sus días de pago, y el reparto del impuesto necesita el número real.
 */
export function pagosSemanalesEnElMes(fecha: Date, diaSemana: number): number {
  const primeroDelMes = new Date(fecha.getFullYear(), fecha.getMonth(), 1);
  // Distancia al primer día de pago del mes (0 cuando el día 1 ya es el de pago).
  const primerPago = 1 + ((diaSemana - primeroDelMes.getDay() + 7) % 7);
  return Math.floor((diasDelMes(fecha) - primerPago) / 7) + 1;
}

/**
 * Qué pago del mes es esta fecha, contando desde 1.
 *
 * El ÚLTIMO es el que cierra el mes: se lleva el resto del ISR que los anteriores
 * dejaron pendiente (`isrDelPago`). Por eso el número tiene que salir de la fecha de
 * PAGO —la misma de la que sale `periodoMensual` y, con ella, lo ya retenido—: si
 * saliera del inicio del período, una semana que cruza el fin de mes se numeraría
 * contra un mes y cerraría contra otro.
 */
export function pagoNumeroEnElMes(fecha: Date, diaSemana: number): number {
  return Math.floor((fecha.getDate() - 1) / 7) + 1;
}

/**
 * Cuántos pagos tiene el mes de `fechaPago` según la periodicidad de la corrida.
 *
 * El semanal no es una constante: son los días de pago que ese mes tenga. La
 * quincena y el mensual sí, y se resuelven sin mirar el calendario.
 */
export function pagosDelMes(
  periodicidad: Periodicidad,
  fechaPago: Date,
  diaPagoSemanal: number = DIA_PAGO_SEMANAL_DEFAULT,
): number {
  if (periodicidad === 'QUINCENAL') return 2;
  if (periodicidad !== 'SEMANAL') return 1;
  return pagosSemanalesEnElMes(fechaPago, diaPagoSemanal);
}

// ─── Cálculo ─────────────────────────────────────────────────────────────────

/**
 * Calcula el renglón de un empleado.
 *
 * Devuelve `null` cuando el empleado no corresponde al período (no había entrado
 * todavía o ya había salido) o cuando no le quedan días trabajados. No es un error:
 * es la razón por la que el prellenado puede barrer todos los activos sin miedo.
 */
/**
 * Tarifa de riesgos que le toca a un empleado.
 *
 * Un empleado en una clase SIN tarifa cargada no se calcula en cero: se devuelve el
 * motivo. Un cero silencioso subvalúa el pasivo del patrono y no lo nota nadie —
 * ni el balance, que cuadra igual, ni el contador, que ve un número plausible.
 */
function tasaRiesgosDe(tasas: Tasas, empleado: EmpleadoCalc): number | { error: string } {
  if (!empleado.claseRiesgo) return tasas.riesgosProfesionales;
  const tasa = tasas.riesgosPorClase[empleado.claseRiesgo];
  if (tasa === undefined) {
    return {
      error:
        `No hay tasa de Riesgos Profesionales para la clase ${empleado.claseRiesgo}. ` +
        'Cargala en Parámetros antes de correr esta planilla.',
    };
  }
  return tasa;
}

export function calcularItem(
  empleado: EmpleadoCalc,
  entrada: EntradaItem,
  ctx: ContextoCorrida,
  tasas: Tasas,
): CalculoItem | { omitido: string } | { error: string } {
  const avisos: string[] = [];

  // Se resuelve ANTES de calcular nada: si falta la tarifa, esta fila no se puede
  // calcular y hay que decirlo, no pagarle al empleado un asiento incompleto.
  const tasaRiesgos = tasaRiesgosDe(tasas, empleado);
  if (typeof tasaRiesgos !== 'number') return tasaRiesgos;

  // R10 — ventana de empleo. Se recorta el período a los días que la persona
  // estuvo empleada; un ingreso a mitad de quincena no cobra la quincena completa.
  const desde = empleado.fechaIngreso && empleado.fechaIngreso > ctx.fechaDesde
    ? empleado.fechaIngreso
    : ctx.fechaDesde;
  const hasta = empleado.fechaSalida && empleado.fechaSalida < ctx.fechaHasta
    ? empleado.fechaSalida
    : ctx.fechaHasta;

  if (desde > hasta) return { omitido: 'no estaba empleado en el período' };

  const diasDisponibles = diasEntre(desde, hasta);
  const diasTrabajados = entrada.diasTrabajados ?? diasDisponibles;

  if (diasTrabajados <= 0) return { omitido: 'sin días trabajados en el período' };
  if (diasTrabajados > diasDisponibles) {
    avisos.push(
      `los días trabajados (${diasTrabajados}) superan los del período (${diasDisponibles})`,
    );
  }

  // Lo que se descuenta SIN acreedor identificado (lo que el contador teclea en el
  // desglose). Las deducciones del catálogo se resuelven más abajo, en la rama de
  // SUELDO, porque su monto depende de la base del período.
  const manual = r2(entrada.otrasDeduccionesManual ?? entrada.otrasDeducciones ?? 0);
  const notas = entrada.notas;

  // ── Corridas de SUELDO: el caso completo ──
  if (ctx.tipo === 'SUELDO') {
    // R1 — el sueldo base es MENSUAL, así que el prorrateo va contra los días del
    // MES, no los del período: una quincena de 15 días sobre un mes de 31 cobra
    // 15/31 y la siguiente 16/31, y entre las dos suman el mes exacto.
    //
    // R1b — en la SEMANAL el prorrateo va contra la SEMANA (séptimos), no contra el
    // mes: una semana que cruza el fin de mes no tiene "mes del período", y repartir
    // por días del mes pagaría 364/365 avos del año. Ver `sueldoSemanal`.
    const sueldoDelPeriodo =
      ctx.periodicidad === 'SEMANAL'
        ? r2((sueldoSemanal(empleado.sueldoBase) * diasTrabajados) / DIAS_DE_LA_SEMANA)
        : r2((empleado.sueldoBase * diasTrabajados) / diasDelMes(ctx.fechaHasta));

    // R1c — el descuento por ausencia o tardanza BAJA EL SUELDO, y con él la base de
    // cotización. No es una deducción al neto: eso acreditaría un pasivo que nadie
    // debe (¿a quién le debería la empresa el día que el empleado no trabajó?), y
    // además dejaría la CSS cotizando sobre un sueldo que no se pagó. Es salario no
    // devengado, así que se resta del sueldo ANTES de calcular SS, SE y el patronal.
    const menosSueldo = r2(entrada.menosSueldo ?? 0);
    if (menosSueldo > sueldoDelPeriodo) {
      // Un descuento mayor que el sueldo del período es un error de carga (5000 por
      // 50), no una intención: se reporta en vez de pagar un sueldo negativo.
      return {
        error:
          `El descuento por ausencia o tardanza (${menosSueldo.toFixed(2)}) supera el sueldo del período ` +
          `(${sueldoDelPeriodo.toFixed(2)}).`,
      };
    }
    const sueldo = r2(sueldoDelPeriodo - menosSueldo);
    const horasExtras = r2(entrada.horasExtras ?? 0);
    const otrosIngresos = r2(entrada.otrosIngresos ?? 0);

    // R2 — cotizan sueldo y horas extras. R3 — el bono y el viático no.
    const baseCotizacion = sumarMontos(sueldo, horasExtras);

    const ss = r2(baseCotizacion * tasas.ssObrero);
    const se = r2(baseCotizacion * tasas.seObrero);
    const isr = isrDelPago(
      isrMensual(empleado.sueldoBase, tasas.tablaISR),
      ctx.pagoNumero,
      ctx.pagosDelMes,
      ctx.isrYaRetenidoPorEmpleado?.[empleado.id] ?? 0,
    );

    // Deducciones de acreedores: el catálogo se precargó solo y acá se decide cuáles
    // aplican y por cuánto. La base del porcentaje es la misma que cotiza (R2/R3): el
    // bono y el viático no son salario, así que no engordan la cuota.
    const deducciones = resolverDeducciones(entrada.deducciones ?? [], {
      tipo: ctx.tipo,
      fechaPago: ctx.fechaPago,
      // La cuota es mensual y se reparte entre los pagos del mes (ver `cuotaDelPago`).
      pagoNumero: ctx.pagoNumero,
      pagosDelMes: ctx.pagosDelMes,
      base: baseDeduccion(sueldo, horasExtras),
    });
    for (const d of deducciones) {
      if (d.aviso) avisos.push(`${d.acreedor}: ${d.aviso}`);
    }
    const otrasDeducciones = sumarMontos(manual, totalAplicado(deducciones));

    const bruto = sumarMontos(sueldo, horasExtras, otrosIngresos);
    // R4 — el neto es el RESIDUO. Es lo único que garantiza que el asiento cuadre
    // sin absorber céntimos en un monto que el contador reconoce.
    const neto = r2(bruto - ss - se - isr - otrasDeducciones);

    // R8 — el aporte del patrono se causa sobre el sueldo, el décimo y las
    // vacaciones. Acá van sus tres partes, cada una a su cuenta de gasto.
    const ssPatronal = r2(baseCotizacion * tasas.ssPatronal);
    const sePatronal = r2(baseCotizacion * tasas.sePatronal);
    const riesgosPatronal = r2(baseCotizacion * tasaRiesgos);

    if (neto < 0) {
      // Que el aviso diga CUÁL: con varias deducciones, "las deducciones superan el
      // bruto" obliga a sumar a mano para saber cuál hay que corregir.
      const culpables = deducciones
        .filter((d) => d.estado === 'APLICA' && d.monto > 0)
        .map((d) => `${d.acreedor} ${d.monto.toFixed(2)}`);
      avisos.push(
        'las deducciones superan el bruto: el neto a pagar queda en negativo' +
          (culpables.length ? ` (${culpables.join(' · ')})` : ''),
      );
    }

    return {
      employeeId: empleado.id,
      diasTrabajados,
      sueldo,
      horasExtras,
      otrosIngresos,
      menosSueldo,
      bruto,
      ss,
      se,
      isr,
      otrasDeducciones,
      deducciones,
      neto,
      ssPatronal,
      sePatronal,
      riesgosPatronal,
      // R5 — los acumulados se congelan en el ítem con el factor vigente hoy: cambiar
      // el factor mañana no puede reescribir lo ya devengado.
      decimoGenerado: r2(bruto * tasas.factorDecimo),
      vacacionesGeneradas: r2(bruto * tasas.factorVacaciones),
      primaGenerada: r2(bruto * tasas.factorPrima),
      notas,
      avisos,
    };
  }

  // ── Corridas de DECIMO y VACACIONES: se paga una prestación ya devengada ──
  const monto = r2(entrada.montoPrestacion ?? 0);
  if (monto <= 0) return { omitido: 'sin monto a pagar en el período' };

  // R6 — el décimo lleva SS al 7,25% (verificado contra los asientos cargados) y ni
  // Seguro Educativo ni ISR: el ×13 del ISR mensual ya lo incluye, así que retenerle
  // ISR acá sería retener dos veces.
  // R7 — las vacaciones no llevan ninguna retención de seguridad social: se paga una
  // prestación ya devengada, no un sueldo.
  const ss = ctx.tipo === 'DECIMO' ? r2(monto * tasas.ssObreroDecimo) : 0;
  const se = ctx.tipo === 'DECIMO' ? r2(monto * tasas.seObreroDecimo) : 0;
  // Las deducciones de acreedores NO corren contra una prestación: se pactan contra
  // el sueldo. Acá solo va lo que el contador teclee a mano, como hasta ahora.
  const deducciones: CuotaResuelta[] = [];
  const otrasDeducciones = manual;
  const neto = r2(monto - ss - se - otrasDeducciones);

  // R8 — el patrono SÍ cotiza sobre la prestación, y en el décimo a una tasa menor
  // que la del sueldo.
  //
  // El décimo lleva SOLO Seguro Social del patrono: el contador dio una sola tasa
  // para el décimo (10,75%), y del lado del empleado el Seguro Educativo también es
  // cero. Si resultara que el patrono sí paga SE o riesgos sobre el décimo, son dos
  // líneas acá — se deja dicho en vez de escondido.
  const ssPatronal = r2(monto * (ctx.tipo === 'DECIMO' ? tasas.ssPatronalDecimo : tasas.ssPatronal));
  const sePatronal = ctx.tipo === 'VACACIONES' ? r2(monto * tasas.sePatronal) : 0;
  const riesgosPatronal = ctx.tipo === 'VACACIONES' ? r2(monto * tasaRiesgos) : 0;

  if (neto < 0) {
    avisos.push('las deducciones superan el monto de la prestación');
  }

  return {
    employeeId: empleado.id,
    diasTrabajados,
    sueldo: 0,
    horasExtras: 0,
    otrosIngresos: 0,
    menosSueldo: 0,
    bruto: monto,
    ss,
    se,
    isr: 0,
    otrasDeducciones,
    deducciones,
    neto,
    ssPatronal,
    sePatronal,
    riesgosPatronal,
    decimoGenerado: 0,
    vacacionesGeneradas: 0,
    primaGenerada: 0,
    notas,
    avisos,
  };
}

/** Calcula la corrida entera y sus totales. */
export function calcularCorrida(
  empleados: EmpleadoCalc[],
  entradas: EntradaItem[],
  ctx: ContextoCorrida,
  tasas: Tasas,
): ResultadoCorrida {
  const porEmpleado = new Map(entradas.map((e) => [e.employeeId, e]));
  const items: CalculoItem[] = [];
  const omitidos: ResultadoCorrida['omitidos'] = [];
  const errores: ResultadoCorrida['errores'] = [];

  for (const empleado of empleados) {
    const entrada = porEmpleado.get(empleado.id) ?? { employeeId: empleado.id };
    const resultado = calcularItem(empleado, entrada, ctx, tasas);
    if ('error' in resultado) {
      errores.push({ employeeId: empleado.id, nombre: empleado.nombre, motivo: resultado.error });
      continue;
    }
    if ('omitido' in resultado) {
      omitidos.push({ employeeId: empleado.id, nombre: empleado.nombre, motivo: resultado.omitido });
      continue;
    }
    items.push(resultado);
  }

  const totales: TotalesCorrida = {
    bruto: sumarMontos(...items.map((i) => i.bruto)),
    deducciones: sumarMontos(...items.map((i) => i.ss + i.se + i.isr + i.otrasDeducciones)),
    neto: sumarMontos(...items.map((i) => i.neto)),
    patronal: sumarMontos(...items.map((i) => i.ssPatronal + i.sePatronal + i.riesgosPatronal)),
    decimoGenerado: sumarMontos(...items.map((i) => i.decimoGenerado)),
    vacacionesGeneradas: sumarMontos(...items.map((i) => i.vacacionesGeneradas)),
    primaGenerada: sumarMontos(...items.map((i) => i.primaGenerada)),
  };

  return { items, totales, omitidos, errores };
}

// ─── Asiento ─────────────────────────────────────────────────────────────────

/**
 * Cuentas que necesita el asiento. Se resuelven desde `Company` —incluidos los tres
 * pasivos del patrono, que sin configurar caen al pasivo del obrero—; las tres de
 * prestaciones "por pagar" caen a los códigos del catálogo (2.1.10, 2.1.11, 2.1.09)
 * si no hay una configurada, y `payroll-run.ts` avisa cuando eso pasa.
 */
export interface CuentasPlanilla {
  sueldo: string;
  horasExtras: string;
  decimo: string;
  vacaciones: string;
  ss: string;
  se: string;
  isr: string;
  otrasDeducciones: string;
  /** Pasivo del Seguro Social ante la CSS: recibe la retención Y el aporte patronal. */
  ssPatronal: string;
  sePatronal: string;
  /**
   * Pasivo de los riesgos profesionales del patrono. La CSS los cobra en el MISMO
   * pago que el Seguro Social, pero con el catálogo partido viven en su propia
   * subcuenta; sin configurar caen a la del Seguro Social del patrono.
   */
  riesgosPatronal: string;
  /** Las tres cuentas de GASTO del patrono, separadas para poder analizarlas. */
  ssPatronalGasto: string;
  sePatronalGasto: string;
  riesgosGasto: string;
  decimoPorPagar: string;
  vacacionesPorPagar: string;
  prestacionesPorPagar: string;
}

export interface LineaAsiento {
  accountId: string;
  debit: number;
  credit: number;
}

/**
 * Arma las líneas del asiento de un empleado.
 *
 * Cuadra POR CONSTRUCCIÓN: el crédito al banco es el `neto`, que ya es el residuo
 * de `bruto − deducciones`, así que la suma de débitos y la de créditos son la
 * misma expresión algebraica. No hace falta el lazo de "absorber el céntimo" que
 * necesita la carga por archivo, porque acá ningún monto viene de fuera.
 *
 * Es pura a propósito: la invariante de cuadre se prueba en un test, no en producción.
 */
/**
 * El crédito de las deducciones: **una cuenta por acreedor** y el resto a la genérica.
 *
 * Antes era una sola línea contra `planillaOtrasDeduccionesId` y el pasivo de cada
 * banco o mueblería quedaba revuelto en una cuenta: no se podía conciliar ni pagar por
 * separado. Se agrupa por cuenta —dos deducciones del mismo empleado al mismo banco son
 * una sola línea— y se suman los montos ya redondeados.
 *
 * El resto (lo que el contador teclea sin acreedor) es un RESIDUO, igual que el neto:
 * `otrasDeducciones − Σ aplicadas`. Esa es la garantía de que lo acreditado suma
 * exactamente el total y el asiento sigue cuadrando por construcción.
 */
function creditosDeducciones(item: CalculoItem, cuentas: CuentasPlanilla): LineaAsiento[] {
  const porCuenta = new Map<string, number>();
  const sumar = (accountId: string, monto: number) => {
    porCuenta.set(accountId, sumarMontos(porCuenta.get(accountId) ?? 0, monto));
  };

  for (const d of item.deducciones) {
    if (d.estado === 'APLICA' && d.monto > 0) sumar(d.cuentaId, d.monto);
  }

  const sinAcreedor = r2(item.otrasDeducciones - totalAplicado(item.deducciones));
  if (sinAcreedor > 0) sumar(cuentas.otrasDeducciones, sinAcreedor);

  return [...porCuenta]
    .filter(([, monto]) => monto > 0)
    .map(([accountId, credit]) => ({ accountId, debit: 0, credit }));
}

export function construirLineas(
  item: CalculoItem,
  tipo: TipoCorrida,
  cuentas: CuentasPlanilla,
  bancoId: string,
  provisionar: boolean,
): LineaAsiento[] {
  const lineas: LineaAsiento[] = [];
  const debe = (accountId: string, monto: number) => {
    if (monto > 0) lineas.push({ accountId, debit: monto, credit: 0 });
  };
  const haber = (accountId: string, monto: number) => {
    if (monto > 0) lineas.push({ accountId, debit: 0, credit: monto });
  };

  if (tipo === 'SUELDO') {
    debe(cuentas.sueldo, item.sueldo);
    debe(cuentas.horasExtras, item.horasExtras);
    // El bono y el viático no cotizan, pero son gasto de sueldos igual.
    debe(cuentas.sueldo, item.otrosIngresos);

    // Los aportes del patrono: gasto propio, no retención del empleado, y cada uno
    // a su cuenta — el gasto Y el pasivo. Los riesgos profesionales se le pagan a la
    // CSS en el mismo movimiento que el Seguro Social, pero eso es cosa del PAGO
    // (`payroll-css.ts`): acá cada concepto devenga en su propia subcuenta.
    debe(cuentas.ssPatronalGasto, item.ssPatronal);
    debe(cuentas.sePatronalGasto, item.sePatronal);
    debe(cuentas.riesgosGasto, item.riesgosPatronal);

    haber(cuentas.ss, item.ss);
    haber(cuentas.se, item.se);
    haber(cuentas.isr, item.isr);
    for (const linea of creditosDeducciones(item, cuentas)) lineas.push(linea);
    haber(cuentas.ssPatronal, item.ssPatronal);
    haber(cuentas.sePatronal, item.sePatronal);
    haber(cuentas.riesgosPatronal, item.riesgosPatronal);

    if (provisionar) {
      const provision = sumarMontos(
        item.decimoGenerado,
        item.vacacionesGeneradas,
        item.primaGenerada,
      );
      debe(cuentas.sueldo, provision);
      haber(cuentas.decimoPorPagar, item.decimoGenerado);
      haber(cuentas.vacacionesPorPagar, item.vacacionesGeneradas);
      haber(cuentas.prestacionesPorPagar, item.primaGenerada);
    }

    haber(bancoId, item.neto);
    return lineas;
  }

  // DECIMO y VACACIONES: se descarga el pasivo que se venía acumulando. El débito a
  // la cuenta de la prestación es exactamente lo que el dueño ya hacía a mano.
  debe(tipo === 'DECIMO' ? cuentas.decimo : cuentas.vacaciones, item.bruto);

  // El patrono cotiza también sobre la prestación. No toca el neto del empleado:
  // es gasto y pasivo de la empresa, en la misma cuantía.
  debe(cuentas.ssPatronalGasto, item.ssPatronal);
  debe(cuentas.sePatronalGasto, item.sePatronal);
  debe(cuentas.riesgosGasto, item.riesgosPatronal);
  haber(cuentas.ssPatronal, item.ssPatronal);
  haber(cuentas.sePatronal, item.sePatronal);
  haber(cuentas.riesgosPatronal, item.riesgosPatronal);

  haber(cuentas.ss, item.ss);
  haber(cuentas.se, item.se);
  // En una prestación la lista viene vacía: todo cae a la cuenta genérica, como antes.
  for (const linea of creditosDeducciones(item, cuentas)) lineas.push(linea);
  haber(bancoId, item.neto);
  return lineas;
}

/**
 * Funde las líneas de todos los empleados en UN solo asiento.
 *
 * Lo usan las corridas semanales. Con un asiento por empleado, 52 corridas al año
 * convierten la cola de revisión del contador en el cuello de botella del módulo:
 * treinta empleados serían 130 asientos al mes por una nómina que se aprueba de una
 * sola vez. La contrapartida es que el asiento deja de nombrar a una persona —el
 * detalle vive en los ítems de la corrida, que es donde se consulta—, y por eso las
 * quincenales y mensuales siguen con su asiento por empleado.
 *
 * Suma por CUENTA y no por concepto: si dos empleados cobran por bancos distintos,
 * el asiento consolidado lleva **un crédito por banco**. Fundirlos en una sola línea
 * dejaría el banco mal y el neto bien, que es la peor forma de fallar: el asiento
 * seguiría cuadrando y nadie lo notaría hasta conciliar.
 */
export function consolidarLineas(items: { lineas: LineaAsiento[] }[]): LineaAsiento[] {
  const porCuenta = new Map<string, LineaAsiento>();
  for (const item of items) {
    for (const linea of item.lineas) {
      const acumulada = porCuenta.get(linea.accountId) ?? { accountId: linea.accountId, debit: 0, credit: 0 };
      acumulada.debit = sumarMontos(acumulada.debit, linea.debit);
      acumulada.credit = sumarMontos(acumulada.credit, linea.credit);
      porCuenta.set(linea.accountId, acumulada);
    }
  }

  const lineas: LineaAsiento[] = [];
  for (const linea of porCuenta.values()) {
    // En la planilla el debe y el haber son cuentas distintas, así que una cuenta
    // nunca aparece en las dos columnas; si una mala configuración las juntara, se
    // netean en vez de emitir dos líneas de la misma cuenta en el mismo asiento.
    const neto = r2(linea.debit - linea.credit);
    if (neto > 0) lineas.push({ accountId: linea.accountId, debit: neto, credit: 0 });
    else if (neto < 0) lineas.push({ accountId: linea.accountId, debit: 0, credit: r2(-neto) });
  }
  return lineas;
}
