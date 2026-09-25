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
 */

import { r2, sumarMontos } from '../lib/money';

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
export type Periodicidad = 'QUINCENAL' | 'MENSUAL' | 'ANUAL' | 'EVENTUAL';
export type TipoPago = 'QUINCENAL' | 'MENSUAL';

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
  bruto: number;
  ss: number;
  se: number;
  isr: number;
  otrasDeducciones: number;
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

/** Cuántos pagos tiene un mes según la periodicidad de la corrida. */
export function pagosDelMes(periodicidad: Periodicidad): number {
  return periodicidad === 'QUINCENAL' ? 2 : 1;
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

  const otrasDeducciones = r2(entrada.otrasDeducciones ?? 0);
  const notas = entrada.notas;

  // ── Corridas de SUELDO: el caso completo ──
  if (ctx.tipo === 'SUELDO') {
    // R1 — el sueldo base es MENSUAL, así que el prorrateo va contra los días del
    // MES, no los del período: una quincena de 15 días sobre un mes de 31 cobra
    // 15/31 y la siguiente 16/31, y entre las dos suman el mes exacto.
    const sueldo = r2((empleado.sueldoBase * diasTrabajados) / diasDelMes(ctx.fechaHasta));
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
      avisos.push('las deducciones superan el bruto: el neto a pagar queda en negativo');
    }

    return {
      employeeId: empleado.id,
      diasTrabajados,
      sueldo,
      horasExtras,
      otrosIngresos,
      bruto,
      ss,
      se,
      isr,
      otrasDeducciones,
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
    bruto: monto,
    ss,
    se,
    isr: 0,
    otrasDeducciones,
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
 * Cuentas que necesita el asiento. Se resuelven desde `Company`; las tres de
 * "por pagar" caen a los códigos del catálogo (2.1.10, 2.1.11, 2.1.09) si no hay
 * una configurada, y `payroll-run.ts` avisa cuando eso pasa.
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
    // a su cuenta. Los riesgos profesionales comparten el PASIVO del Seguro Social
    // —a la CSS se le paga todo junto— pero no su gasto.
    debe(cuentas.ssPatronalGasto, item.ssPatronal);
    debe(cuentas.sePatronalGasto, item.sePatronal);
    debe(cuentas.riesgosGasto, item.riesgosPatronal);

    haber(cuentas.ss, item.ss);
    haber(cuentas.se, item.se);
    haber(cuentas.isr, item.isr);
    haber(cuentas.otrasDeducciones, item.otrasDeducciones);
    haber(cuentas.ssPatronal, sumarMontos(item.ssPatronal, item.riesgosPatronal));
    haber(cuentas.sePatronal, item.sePatronal);

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
  haber(cuentas.ssPatronal, sumarMontos(item.ssPatronal, item.riesgosPatronal));
  haber(cuentas.sePatronal, item.sePatronal);

  haber(cuentas.ss, item.ss);
  haber(cuentas.se, item.se);
  haber(cuentas.otrasDeducciones, item.otrasDeducciones);
  haber(bancoId, item.neto);
  return lineas;
}
