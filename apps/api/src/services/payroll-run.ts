import { parseLocalDate } from '../lib/dates';
import { r2, sumarMontos } from '../lib/money';
import { loadAccountFlags, blockedMessage } from './journal-guard';
import { anularAsiento } from './journal-annul';
import { logAudit } from './audit-log';
import {
  calcularCorrida,
  construirLineas,
  consolidarLineas,
  pagosDelMes as pagosDelMesDe,
  pagoNumeroEnElMes,
  diasEntre,
  DIA_PAGO_SEMANAL_DEFAULT,
  DIAS_DE_LA_SEMANA,
  DIAS_SEMANA,
  type CalculoItem,
  type ContextoCorrida,
  type CuentasPlanilla,
  type EntradaItem,
  type LineaAsiento,
  type Periodicidad,
  type TipoCorrida,
} from './payroll-calc';
import { empleadosParaCorrida, acumuladosDe } from './payroll-empleados';
import { aplicarAjustes, catalogoDe } from './payroll-acreedores';
import { avisosDeCatalogo, sePersiste, totalAplicado, type AjusteDeduccion } from './payroll-deducciones';
import {
  getOrCreateSettings,
  tasasDe,
  resolverCuentasPlanilla,
  type CuentaFaltante,
  type ResolucionCuentas,
} from './payroll-parametros';

/**
 * La corrida: arma el período, calcula, escribe los asientos y los anula.
 *
 * Tres decisiones que sostienen todo lo demás:
 *
 *  · **El período es la clave de idempotencia** (`@@unique(companyId, tipo, periodo)`).
 *    No hay dedupe por metadata como en la carga por archivo: dos corridas del mismo
 *    período chocan contra la base, y el segundo intento devuelve el id de la primera.
 *
 *  · **Una transacción por empleado, no una para la corrida entera.** El timeout
 *    interactivo de Prisma es de 5 segundos y no hay ni un `{timeout}` en el repo;
 *    con treinta empleados, una caída a mitad tiraría la planilla del mes completa.
 *    Así, lo que entró queda y lo que falló se reporta por empleado.
 *
 *  · **El servidor recalcula al ejecutar.** El grid de la pantalla manda los ajustes
 *    (horas extras, días, notas), no los montos: los montos los pone el motor.
 */

/**
 * El detalle por acreedor que se persiste con los ítems, ya congelado.
 *
 * Se guardan las que dejaron rastro —aplicada, saltada a mano, suspendida en
 * diciembre—; las terminadas y las desactivadas no, porque se derivan del catálogo y
 * llenarían la tabla de filas que no dicen nada. `monto > 0` sigue siendo la marca del
 * saldo: por eso lo demás va en 0 con su motivo.
 *
 * `cuotaNumero` lo lleva **solo la fila que CIERRA el mes**: los abonos intermedios de
 * un empleado quincenal o semanal son la misma cuota, y contarlos como cuotas distintas
 * le acortaría el plazo. Es el número de cuota, no el de pagos.
 */
function filasDeDeducciones(items: CalculoItem[], companyId: string, runId: string) {
  return items.flatMap((item) =>
    item.deducciones.filter(sePersiste).map((d) => ({
      companyId,
      runId,
      employeeId: item.employeeId,
      deduccionId: d.deduccionId,
      acreedor: d.acreedor,
      cuentaId: d.cuentaId,
      monto: d.monto,
      omitida: d.monto <= 0,
      motivoOmitida: d.monto <= 0 ? d.motivo : null,
      cuotaNumero: d.cierraCuota ? d.cuotaNumero : null,
    })),
  );
}

/**
 * Un ajuste de la corrida tal como llega de la pantalla: los mismos campos del ítem,
 * más los ajustes por deducción (saltar una cuota o cambiarle el monto). El motor no
 * ve este último: `previsualizarCorrida` lo funde con el catálogo y le pasa a
 * `calcularItem` las deducciones ya resueltas.
 */
export interface AjusteCorrida extends Omit<EntradaItem, 'deducciones'> {
  deducciones?: AjusteDeduccion[];
}

export interface OpcionesCorrida {
  tipo: TipoCorrida;
  periodicidad: Periodicidad;
  /** 'YYYY-MM-DD' */
  fechaDesde: string;
  fechaHasta: string;
  fechaPago: string;
  empleadoIds?: string[];
  ajustes?: AjusteCorrida[];
  notas?: string;
}

export interface ItemCorrida extends CalculoItem {
  nombre: string;
  cedula: string | null;
  bancoCuentaId: string | null;
  lineas: LineaAsiento[];
}

export interface PreviewCorrida {
  tipo: TipoCorrida;
  periodicidad: Periodicidad;
  periodo: string;
  periodoMensual: string;
  fechaDesde: string;
  fechaHasta: string;
  fechaPago: string;
  pagoNumero: number;
  pagosDelMes: number;
  /**
   * La corrida se contabiliza en UN asiento para todos los empleados (semanal) en
   * vez de uno por empleado. Ver `esConsolidada`.
   */
  consolidado: boolean;
  items: ItemCorrida[];
  totales: ReturnType<typeof calcularCorrida>['totales'];
  omitidos: ReturnType<typeof calcularCorrida>['omitidos'];
  /** Empleados que no se pudieron calcular. Si hay alguno, la corrida no se ejecuta. */
  errores: ReturnType<typeof calcularCorrida>['errores'];
  faltantes: CuentaFaltante[];
  avisos: string[];
  /** La corrida de ese período ya existe: se devuelve para poder enlazarla. */
  yaExiste: { id: string; status: string } | null;
}

// ─── Períodos ────────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * El período canónico, derivado —nunca aceptado del cliente—: si viniera de afuera,
 * dos peticiones con el mismo período escrito distinto esquivarían la clave única y
 * la nómina se pagaría dos veces.
 *
 * Lleva la granularidad dentro porque una empresa real mezcla gente quincenal,
 * mensual y semanal, y las tres cuotas del décimo comparten año.
 *
 * La SEMANAL se nombra por su PAGO (`2026-09-S3` = el tercer pago de septiembre) y
 * no por los días que cubre: es lo que la alinea con `periodoMensual` y con el
 * reparto del ISR, que también cuelgan de la fecha de pago. Y una corrida que cubre
 * dos semanas se paga junta —el prorrateo por séptimos la resuelve—, así que no hay
 * dos corridas por mes de pago y la clave sigue siendo única.
 */
export function periodoDe(
  tipo: TipoCorrida,
  periodicidad: Periodicidad,
  fechaDesde: Date,
  fechaPago: Date,
  diaPagoSemanal: number = DIA_PAGO_SEMANAL_DEFAULT,
): string {
  const anio = fechaDesde.getFullYear();
  const mes = String(fechaDesde.getMonth() + 1).padStart(2, '0');

  if (tipo === 'DECIMO') {
    // Tres cuotas: abril, agosto y diciembre. La cuota sale del mes de PAGO.
    const m = fechaPago.getMonth() + 1;
    const cuota = m <= 4 ? 1 : m <= 8 ? 2 : 3;
    return `${fechaPago.getFullYear()}-C${cuota}`;
  }
  if (tipo === 'VACACIONES') return ymd(fechaDesde);
  if (periodicidad === 'SEMANAL') {
    const mesPago = String(fechaPago.getMonth() + 1).padStart(2, '0');
    return `${fechaPago.getFullYear()}-${mesPago}-S${pagoNumeroEnElMes(fechaPago, diaPagoSemanal)}`;
  }
  if (periodicidad === 'QUINCENAL') return `${anio}-${mes}-Q${fechaDesde.getDate() <= 15 ? 1 : 2}`;
  return `${anio}-${mes}`;
}

/** Fin del período a partir del inicio, para no obligar a la pantalla a calcularlo. */
export function finDePeriodo(periodicidad: Periodicidad, fechaDesde: Date): Date {
  if (periodicidad === 'SEMANAL') {
    // Siete días contando el inicial: una semana que empieza el lunes cierra el domingo.
    return new Date(
      fechaDesde.getFullYear(),
      fechaDesde.getMonth(),
      fechaDesde.getDate() + DIAS_DE_LA_SEMANA - 1,
      12,
    );
  }
  if (periodicidad === 'QUINCENAL') {
    return fechaDesde.getDate() <= 15
      ? new Date(fechaDesde.getFullYear(), fechaDesde.getMonth(), 15, 12)
      : new Date(fechaDesde.getFullYear(), fechaDesde.getMonth() + 1, 0, 12);
  }
  return new Date(fechaDesde.getFullYear(), fechaDesde.getMonth() + 1, 0, 12);
}

/**
 * Qué pago del mes es: la quincena 1 o la 2, o el ordinal del día de pago semanal.
 *
 * El semanal sale de la fecha de PAGO (ver `pagoNumeroEnElMes`). La quincena sigue
 * saliendo del inicio del período, como salía antes de que existiera el semanal:
 * cambiarlo movería la retención de las corridas ya hechas sin que nadie lo pida.
 */
function pagoNumeroDe(
  periodicidad: Periodicidad,
  fechaDesde: Date,
  fechaPago: Date,
  diaPagoSemanal: number,
): number {
  if (periodicidad === 'SEMANAL') return pagoNumeroEnElMes(fechaPago, diaPagoSemanal);
  if (periodicidad !== 'QUINCENAL') return 1;
  return fechaDesde.getDate() <= 15 ? 1 : 2;
}

/** La corrida semanal se contabiliza en UN asiento; las demás, uno por empleado. */
export function esConsolidada(periodicidad: Periodicidad): boolean {
  return periodicidad === 'SEMANAL';
}

// ─── Cuentas y banco ─────────────────────────────────────────────────────────

/**
 * Cuenta de la que sale el neto, en cadena: la del empleado → la de planilla de la
 * empresa → el banco por defecto → `1.1.02.01`. Devuelve el aviso cuando no salió de
 * la primera, para que se vea que se está usando un respaldo.
 */
async function resolverBanco(
  prisma: any,
  companyId: string,
  empleado: { bancoCuentaId: string | null },
  cache: { company: any; porCodigo: Map<string, any> },
): Promise<{ accountId: string | null; aviso: string | null }> {
  if (empleado.bancoCuentaId) {
    const acc = await prisma.account.findFirst({
      where: { id: empleado.bancoCuentaId, companyId },
      select: { id: true, isActive: true },
    });
    if (acc) return { accountId: acc.id, aviso: null };
  }

  const c = cache.company;
  if (c?.planillaBancoId) return { accountId: c.planillaBancoId, aviso: 'el neto sale de la cuenta de banco configurada en Planilla' };
  if (c?.bancoDefaultId) return { accountId: c.bancoDefaultId, aviso: 'el neto sale del banco por defecto de la empresa' };
  const respaldo = cache.porCodigo.get('1.1.02.01');
  if (respaldo) return { accountId: respaldo.id, aviso: 'el neto sale de 1.1.02.01 por no haber banco configurado' };
  return { accountId: null, aviso: null };
}

/** Qué cuentas necesita realmente ESTA corrida, para no exigir las que no usa. */
function clavesNecesarias(
  tipo: TipoCorrida,
  items: CalculoItem[],
  provisionar: boolean,
): (keyof CuentasPlanilla)[] {
  if (tipo === 'DECIMO') return ['decimo', 'ss'];
  if (tipo === 'VACACIONES') return ['vacaciones'];

  const claves: (keyof CuentasPlanilla)[] = [
    'sueldo', 'ss', 'se', 'isr',
    'ssPatronal', 'sePatronal', 'riesgosPatronal',
    'ssPatronalGasto', 'sePatronalGasto', 'riesgosGasto',
  ];
  if (items.some((i) => i.horasExtras > 0)) claves.push('horasExtras');
  // La cuenta genérica de otras deducciones se exige solo por lo que NO tiene acreedor:
  // las deducciones del catálogo acreditan la cuenta de cada acreedor, que vive en su
  // propia fila y no se resuelve por configuración. Antes esto era "hay otras
  // deducciones → hace falta la cuenta"; ahora una corrida con SOLO préstamos de
  // acreedores no la necesita.
  if (items.some((i) => r2(i.otrasDeducciones - totalAplicado(i.deducciones)) > 0)) claves.push('otrasDeducciones');
  if (provisionar && items.some((i) => i.decimoGenerado + i.vacacionesGeneradas + i.primaGenerada > 0)) {
    claves.push('decimoPorPagar', 'vacacionesPorPagar', 'prestacionesPorPagar');
  }
  return claves;
}

/** Cuentas faltantes que esta corrida no puede suplir, con su etiqueta. */
function faltantesDe(resolucion: ResolucionCuentas, claves: (keyof CuentasPlanilla)[]): CuentaFaltante[] {
  return resolucion.faltantes.filter((f) => claves.includes(f.clave));
}

// ─── Previsualización ────────────────────────────────────────────────────────

/**
 * Calcula la corrida sin escribir nada. Es también el motor de la ejecución: el
 * ejecutar recalcula acá, así el preview y lo que se guarda no pueden discrepar.
 */
export async function previsualizarCorrida(
  prisma: any,
  companyId: string,
  opts: OpcionesCorrida,
): Promise<PreviewCorrida> {
  const fechaDesde = parseLocalDate(opts.fechaDesde);
  const fechaHasta = parseLocalDate(opts.fechaHasta);
  const fechaPago = parseLocalDate(opts.fechaPago);

  // Los parámetros van primero: el período semanal se nombra por su pago y el reparto
  // del ISR depende del día de pago configurado. Pedirlos en paralelo obligaría a
  // construir el período dos veces.
  const settings = await getOrCreateSettings(prisma, companyId);
  const diaPagoSemanal = settings.diaPagoSemanal ?? DIA_PAGO_SEMANAL_DEFAULT;

  const periodo = periodoDe(opts.tipo, opts.periodicidad, fechaDesde, fechaPago, diaPagoSemanal);
  const periodoMensual = `${fechaPago.getFullYear()}-${String(fechaPago.getMonth() + 1).padStart(2, '0')}`;
  const pagosDelMes = pagosDelMesDe(opts.periodicidad, fechaPago, diaPagoSemanal);
  const pagoNumero = pagoNumeroDe(opts.periodicidad, fechaDesde, fechaPago, diaPagoSemanal);
  const consolidado = esConsolidada(opts.periodicidad);

  const [resolucion, empleados, company, existente] = await Promise.all([
    resolverCuentasPlanilla(prisma, companyId),
    empleadosParaCorrida(prisma, companyId, {
      ids: opts.empleadoIds,
      // Una corrida de sueldo solo paga a quien cobra con ESA periodicidad; las de
      // prestaciones no filtran, porque el décimo y las vacaciones los cobran todos.
      tipoPago: opts.tipo === 'SUELDO' ? opts.periodicidad : null,
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { planillaBancoId: true, bancoDefaultId: true },
    }),
    // Una corrida ANULADA no ocupa el período: es historia. Por eso el filtro, que
    // es el mismo que impone el índice único parcial de la migración 0023.
    prisma.payrollRun.findFirst({ where: { companyId, tipo: opts.tipo, periodo, status: { not: 'ANULADA' } } }),
  ]);

  const tasas = tasasDe(settings);
  const avisos: string[] = [...resolucion.avisos];

  // ── Corridas de prestación: el monto sugerido es lo que se debe ──
  const ajustes = [...(opts.ajustes ?? [])];
  if (opts.tipo !== 'SUELDO') {
    // Se paga lo acumulado: saldo inicial + lo devengado − lo ya pagado. Es
    // exactamente para lo que sirve el acumulado, y evita que el contador tenga que
    // recalcular a mano cuánto le debe a cada quien.
    const acumulados = await acumuladosDe(prisma, companyId, {
      empleadoIds: empleados.map((e: any) => e.id),
      corte: fechaPago,
    });
    const clave = opts.tipo === 'DECIMO' ? 'decimo' : 'vacaciones';
    for (const emp of empleados) {
      const yaAjustado = ajustes.some((a) => a.employeeId === emp.id);
      if (yaAjustado) continue;
      const saldo = acumulados.get(emp.id)?.[clave as 'decimo' | 'vacaciones']?.saldo ?? 0;
      ajustes.push({ employeeId: emp.id, montoPrestacion: saldo });
    }
    const sinSaldo = empleados.filter(
      (e: any) => (acumulados.get(e.id)?.[clave as 'decimo' | 'vacaciones']?.saldo ?? 0) <= 0,
    );
    if (sinSaldo.length > 0) {
      avisos.push(
        `${sinSaldo.length} empleado(s) no tienen saldo acumulado de ${clave === 'decimo' ? 'décimo' : 'vacaciones'}: no entran en la corrida.`,
      );
    }
  }

  // ── Deducciones de acreedores: el catálogo se precarga solo ──
  //
  // Es el mismo gesto que las prestaciones de arriba: el contador no tiene que
  // acordarse de a quién le toca la cuota este período. El motor recibe las deducciones
  // YA resueltas —el saldo que queda y las cuotas que van— pero sin monto: el monto
  // depende de la base del período, y eso lo sabe `calcularItem`.
  const entradas: EntradaItem[] = ajustes.map((a) => ({ ...a, deducciones: undefined }));
  if (opts.tipo === 'SUELDO') {
    const catalogo = await catalogoDe(prisma, companyId, {
      empleadoIds: empleados.map((e: any) => e.id),
      corte: fechaPago,
      // Lo que ya se descontó este mes: el pago que cierra toma solo lo que falta.
      periodoMensual,
    });
    for (const emp of empleados) {
      const delCatalogo = catalogo.get(emp.id) ?? [];
      if (!delCatalogo.length) continue;
      const delContador = ajustes.find((a) => a.employeeId === emp.id)?.deducciones ?? [];
      const deducciones = aplicarAjustes(delCatalogo, delContador);
      const entrada = entradas.find((e) => e.employeeId === emp.id);
      if (entrada) entrada.deducciones = deducciones;
      else entradas.push({ employeeId: emp.id, deducciones });
      for (const d of deducciones) {
        const aviso = avisosDeCatalogo(d);
        if (aviso) avisos.push(`${emp.nombre} — ${d.acreedor}: ${aviso}`);
      }
    }
  }

  const ctx: ContextoCorrida = {
    tipo: opts.tipo,
    periodicidad: opts.periodicidad,
    fechaDesde,
    fechaHasta,
    fechaPago,
    pagoNumero,
    pagosDelMes,
    isrYaRetenidoPorEmpleado: await isrYaRetenidoEnElMes(prisma, companyId, opts.tipo, periodoMensual, empleados),
  };

  const calculo = calcularCorrida(empleados, entradas, ctx, tasas);

  // Días trabajados por empleado para poder prorratear sin que la pantalla lo calcule.
  // ── Avisos de la ficha de los empleados que SÍ entran ──
  // No bloquean: son cosas que faltan cargar y que van a molestar más tarde (al
  // presentar la planilla a la CSS, al prorratear, o al calcular una antigüedad).
  // Solo se avisa de quien entra en la corrida: llenar la pantalla con datos de
  // gente que no se está pagando es ruido.
  // El período semanal que no dura 7 días, o que se paga en un día que no es el
  // configurado, no es un error —el prorrateo por séptimos cobra exactamente los días
  // que sean— pero cambia la numeración del pago y con ella el reparto del ISR: si no
  // es el día de pago configurado, el ordinal del mes puede no ser el que se espera.
  if (opts.periodicidad === 'SEMANAL') {
    const dias = diasEntre(fechaDesde, fechaHasta);
    if (dias !== DIAS_DE_LA_SEMANA) {
      avisos.push(
        `El período semanal cubre ${dias} día(s) en vez de ${DIAS_DE_LA_SEMANA}: se paga por séptimos, ` +
          'así que los días trabajados mandan sobre el rótulo del período.',
      );
    }
    if (fechaPago.getDay() !== diaPagoSemanal) {
      avisos.push(
        `La fecha de pago no cae en ${DIAS_SEMANA[diaPagoSemanal]}: es el día configurado para pagar la semana, ` +
          `y de él sale qué pago del mes es este (${pagoNumero} de ${pagosDelMes}).`,
      );
    }
  }

  const entran = new Set(calculo.items.map((i) => i.employeeId));
  const sinNss = empleados.filter((e: any) => entran.has(e.id) && !e.nss);
  if (sinNss.length > 0) {
    avisos.push(`${sinNss.length} empleado(s) sin NSS: la planilla de la CSS (SIPE) lo pide.`);
  }
  const sinIngreso = empleados.filter((e: any) => entran.has(e.id) && !e.fechaIngreso);
  if (sinIngreso.length > 0) {
    avisos.push(
      `${sinIngreso.length} empleado(s) sin fecha de ingreso: sin ella no se puede prorratear un ingreso a mitad de período ni calcular antigüedad.`,
    );
  }

  // Asientos rechazados del MISMO mes: correr otra vez encima de una nómina que el
  // contador rechazó duplica el problema en vez de arreglarlo.
  if (opts.tipo === 'SUELDO') {
    const previos = await prisma.payrollItem.findMany({
      where: { companyId, run: { status: { not: 'ANULADA' }, periodoMensual }, journalEntryId: { not: null } },
      select: { journalEntryId: true },
    });
    const rechazados = previos.length
      ? await prisma.journalEntry.count({
          where: { id: { in: previos.map((p: any) => p.journalEntryId) }, status: 'RECHAZADO' },
        })
      : 0;
    if (rechazados > 0) {
      avisos.push(
        `Hay ${rechazados} asiento(s) RECHAZADO(s) en este mes: revisá la corrida anterior antes de correr otra vez.`,
      );
    }
  }

  const claves = clavesNecesarias(opts.tipo, calculo.items, tasas.provisionarPrestaciones);
  const faltantes = faltantesDe(resolucion, claves);
  if (faltantes.length > 0) {
    avisos.push(
      `Faltan cuentas por configurar: ${faltantes.map((f) => f.etiqueta).join(', ')}.`,
    );
  }

  const cache = {
    company,
    porCodigo: new Map<string, any>(),
  };
  const cuentasDeLaEmpresa = await prisma.account.findMany({
    where: { companyId, code: '1.1.02.01' },
    select: { id: true, code: true },
  });
  for (const a of cuentasDeLaEmpresa) cache.porCodigo.set(a.code, a);

  const items: ItemCorrida[] = [];
  const avisosBanco = new Map<string, number>();
  for (const calculoItem of calculo.items) {
    const empleado = empleados.find((e: any) => e.id === calculoItem.employeeId)!;
    const banco = await resolverBanco(prisma, companyId, empleado, cache);
    if (!banco.accountId) {
      avisos.push(`No hay cuenta de banco para ${empleado.nombre}: no se puede pagar su neto.`);
      continue;
    }
    // El aviso del banco es el MISMO para todos los que no tienen cuenta propia:
    // se cuenta y se emite una vez, no una por empleado. Treinta renglones iguales
    // tapan el aviso que sí es distinto.
    if (banco.aviso) avisosBanco.set(banco.aviso, (avisosBanco.get(banco.aviso) ?? 0) + 1);

    items.push({
      ...calculoItem,
      nombre: empleado.nombre,
      cedula: empleado.cedula ?? null,
      bancoCuentaId: banco.accountId,
      lineas: construirLineas(calculoItem, opts.tipo, resolucion.cuentas, banco.accountId, tasas.provisionarPrestaciones),
    });
  }

  for (const [mensaje, cuantos] of avisosBanco) {
    avisos.push(cuantos > 1 ? `En ${cuantos} empleados, ${mensaje}.` : `En 1 empleado, ${mensaje}.`);
  }

  return {
    tipo: opts.tipo,
    periodicidad: opts.periodicidad,
    periodo,
    periodoMensual,
    fechaDesde: opts.fechaDesde,
    fechaHasta: opts.fechaHasta,
    fechaPago: opts.fechaPago,
    pagoNumero,
    pagosDelMes,
    consolidado,
    items,
    totales: {
      bruto: sumarMontos(...items.map((i) => i.bruto)),
      deducciones: sumarMontos(...items.map((i) => i.ss + i.se + i.isr + i.otrasDeducciones)),
      neto: sumarMontos(...items.map((i) => i.neto)),
      patronal: sumarMontos(...items.map((i) => i.ssPatronal + i.sePatronal + i.riesgosPatronal)),
      decimoGenerado: sumarMontos(...items.map((i) => i.decimoGenerado)),
      vacacionesGeneradas: sumarMontos(...items.map((i) => i.vacacionesGeneradas)),
      primaGenerada: sumarMontos(...items.map((i) => i.primaGenerada)),
    },
    omitidos: calculo.omitidos,
    errores: calculo.errores,
    faltantes,
    // Un aviso por empleado ("el neto sale del banco por defecto") repetido treinta
    // veces tapa los que sí son distintos: se muestran una sola vez.
    avisos: [...new Set(avisos)],
    yaExiste: existente ? { id: existente.id, status: existente.status } : null,
  };
}

/**
 * ISR ya retenido a cada empleado en ESTE mes, para que la última corrida pueda
 * cerrarlo exacto. Sin esto, dos quincenas de un mes que no parte en dos mitades
 * iguales dejan el mes con un céntimo de más o de menos.
 */
async function isrYaRetenidoEnElMes(
  prisma: any,
  companyId: string,
  tipo: TipoCorrida,
  periodoMensual: string,
  empleados: { id: string }[],
): Promise<Record<string, number>> {
  if (tipo !== 'SUELDO' || empleados.length === 0) return {};

  const filas: any[] = await prisma.payrollItem.groupBy({
    by: ['employeeId'],
    where: {
      companyId,
      employeeId: { in: empleados.map((e) => e.id) },
      run: { status: { not: 'ANULADA' }, tipo: 'SUELDO', periodoMensual },
    },
    _sum: { isr: true },
  });

  const mapa: Record<string, number> = {};
  for (const f of filas) mapa[f.employeeId] = r2(f._sum.isr || 0);
  return mapa;
}

// ─── Ejecución ───────────────────────────────────────────────────────────────

export interface ResultadoEjecucion {
  runId: string;
  periodo: string;
  creados: number;
  totales: PreviewCorrida['totales'];
  errores: { empleado: string; motivo: string }[];
  entryIds: string[];
}

/** Descripción del asiento cuando la corrida entera va en un solo asiento. */
function descripcionConsolidada(tipo: TipoCorrida, cuantos: number, periodo: string): string {
  const quienes = `${cuantos} empleado${cuantos === 1 ? '' : 's'}`;
  if (tipo === 'DECIMO') return `Décimo III de ${quienes} — ${periodo}`;
  if (tipo === 'VACACIONES') return `Vacaciones de ${quienes} — ${periodo}`;
  return `Planilla de ${quienes} — ${periodo}`;
}

/**
 * Ejecuta la corrida: crea la fila, los asientos BORRADOR con su Transaction y los
 * ítems con los montos congelados.
 *
 * Las corridas semanales van en UN asiento para toda la nómina (`consolidado`); las
 * demás, uno por empleado. En el camino consolidado no hay errores por empleado
 * posible: el asiento es uno, así que entra entero o no entra — y por eso las cuentas
 * bloqueadas se verifican ANTES de crear la corrida, para no dejar una corrida
 * vacía ocupando el período.
 */
export async function ejecutarCorrida(
  prisma: any,
  companyId: string,
  userId: string,
  opts: OpcionesCorrida,
): Promise<ResultadoEjecucion> {
  const preview = await previsualizarCorrida(prisma, companyId, opts);

  if (preview.yaExiste) {
    throw Object.assign(
      new Error(
        `Ya existe una corrida de ${preview.tipo} para el período ${preview.periodo} (estado ${preview.yaExiste.status}). Anúlala antes de rehacerla.`,
      ),
      { status: 409, runId: preview.yaExiste.id },
    );
  }
  if (preview.faltantes.length > 0) {
    throw Object.assign(
      new Error(`Configura la cuenta de ${preview.faltantes.map((f) => f.etiqueta).join(', ')} antes de ejecutar.`),
      { status: 400 },
    );
  }
  // Un empleado que no se pudo calcular NO se saltea en silencio: se frena la
  // corrida entera. Pagar una nómina a la que le falta alguien no se nota hasta que
  // esa persona reclama, y para entonces el asiento ya está en el diario.
  if (preview.errores.length > 0) {
    throw Object.assign(
      new Error(
        `No se puede ejecutar la corrida: ${preview.errores.map((e) => `${e.nombre} — ${e.motivo}`).join(' · ')}`,
      ),
      { status: 400, errores: preview.errores },
    );
  }
  if (preview.items.length === 0) {
    throw Object.assign(new Error('La corrida no tiene ningún empleado con monto a pagar.'), { status: 400 });
  }

  const fechaPago = parseLocalDate(opts.fechaPago);
  const fechaDesde = parseLocalDate(opts.fechaDesde);
  const fechaHasta = parseLocalDate(opts.fechaHasta);

  // Cuentas bloqueadas: una consulta por corrida, reusada empleado a empleado.
  const accountFlags = await loadAccountFlags(prisma, companyId);

  const lineasConsolidadas = preview.consolidado ? consolidarLineas(preview.items) : null;
  if (lineasConsolidadas) {
    const bloqueada = blockedMessage(accountFlags, lineasConsolidadas.map((l) => l.accountId));
    if (bloqueada) {
      throw Object.assign(
        new Error(`No se puede ejecutar la corrida: ${bloqueada}`),
        { status: 400 },
      );
    }
  }

  let run: any;
  try {
    run = await prisma.payrollRun.create({
      data: {
        companyId,
        tipo: preview.tipo,
        periodicidad: preview.periodicidad,
        periodo: preview.periodo,
        periodoMensual: preview.periodoMensual,
        fechaDesde,
        fechaHasta,
        fechaPago,
        status: 'BORRADOR',
        consolidado: preview.consolidado,
        createdById: userId,
        notas: opts.notas ?? null,
      },
    });
  } catch (e: any) {
    // La comprobación de arriba no alcanza: dos ejecuciones simultáneas del mismo
    // período pasan las dos por el `findFirst` y choca la clave única. El choque es
    // el que manda — es la garantía real contra pagar dos veces.
    if (e?.code === 'P2002') {
      const previa = await prisma.payrollRun.findFirst({
        where: { companyId, tipo: preview.tipo, periodo: preview.periodo, status: { not: 'ANULADA' } },
        select: { id: true, status: true },
      });
      throw Object.assign(
        new Error(
          `Ya existe una corrida de ${preview.tipo} para el período ${preview.periodo} (estado ${previa?.status ?? 'desconocido'}). Anúlala antes de rehacerla.`,
        ),
        { status: 409, runId: previa?.id },
      );
    }
    throw e;
  }

  const errores: { empleado: string; motivo: string }[] = [];
  const entryIds: string[] = [];
  const totales = {
    bruto: 0, deducciones: 0, neto: 0, patronal: 0,
    decimoGenerado: 0, vacacionesGeneradas: 0, primaGenerada: 0,
  };

  const acumularTotales = (item: CalculoItem) => {
    totales.bruto = sumarMontos(totales.bruto, item.bruto);
    totales.deducciones = sumarMontos(totales.deducciones, item.ss + item.se + item.isr + item.otrasDeducciones);
    totales.neto = sumarMontos(totales.neto, item.neto);
    totales.patronal = sumarMontos(totales.patronal, item.ssPatronal + item.sePatronal + item.riesgosPatronal);
    totales.decimoGenerado = sumarMontos(totales.decimoGenerado, item.decimoGenerado);
    totales.vacacionesGeneradas = sumarMontos(totales.vacacionesGeneradas, item.vacacionesGeneradas);
    totales.primaGenerada = sumarMontos(totales.primaGenerada, item.primaGenerada);
  };

  // ── Camino consolidado: un asiento para toda la nómina ──
  if (lineasConsolidadas) {
    const descripcion = descripcionConsolidada(preview.tipo, preview.items.length, preview.periodo);
    try {
      const je = await prisma.$transaction(async (tx: any) => {
        const asiento = await tx.journalEntry.create({
          data: {
            date: fechaPago,
            description: descripcion,
            status: 'BORRADOR',
            companyId,
            createdById: userId,
            lines: { create: lineasConsolidadas },
          },
        });

        await tx.transaction.create({
          data: {
            type: 'PLANILLA',
            // El bruto de la nómina entera: es lo que la Transaction representa, y el
            // asiento —con el aporte del patrono adentro— vale más, igual que en el
            // camino por empleado.
            amount: preview.totales.bruto,
            description: descripcion,
            concept:
              preview.tipo === 'DECIMO' ? 'Décimo III' : preview.tipo === 'VACACIONES' ? 'Vacaciones' : 'Planilla',
            paymentMethod: null,
            date: fechaPago,
            companyId,
            createdById: userId,
            journalEntryId: asiento.id,
            // El detalle por empleado NO viaja acá: vive en los ítems de la corrida,
            // que es donde se consulta (`runId` es la llave). Meter treinta fichas en
            // un JSON sería un dato que nadie lee y que sí puede quedar desfasado.
            metadata: JSON.stringify({
              source: 'planilla',
              origen: 'MODULO',
              runId: run.id,
              tipo: preview.tipo,
              periodo: preview.periodo,
              quincena: opts.fechaPago,
              empleados: preview.items.length,
              consolidado: true,
              bruto: preview.totales.bruto,
              deducciones: preview.totales.deducciones,
              neto: preview.totales.neto,
              patronal: preview.totales.patronal,
            }),
          },
        });

        // Un solo INSERT para los treinta ítems: la transacción tiene 5 segundos.
        await tx.payrollItem.createMany({
          data: preview.items.map((item) => ({
            companyId,
            runId: run.id,
            employeeId: item.employeeId,
            diasTrabajados: item.diasTrabajados,
            sueldo: item.sueldo,
            horasExtras: item.horasExtras,
            otrosIngresos: item.otrosIngresos,
            menosSueldo: item.menosSueldo,
            bruto: item.bruto,
            ss: item.ss,
            se: item.se,
            isr: item.isr,
            otrasDeducciones: item.otrasDeducciones,
            neto: item.neto,
            ssPatronal: item.ssPatronal,
            sePatronal: item.sePatronal,
            riesgosPatronal: item.riesgosPatronal,
            decimoGenerado: item.decimoGenerado,
            vacacionesGeneradas: item.vacacionesGeneradas,
            primaGenerada: item.primaGenerada,
            journalEntryId: asiento.id,
            notas: item.notas ?? null,
          })),
        });

        // El detalle por acreedor, en el MISMO insert de lote: un round trip más por
        // empleado no cabe en la transacción de 5 segundos.
        await tx.payrollItemDeduction.createMany({
          data: filasDeDeducciones(preview.items, companyId, run.id),
        });

        return asiento;
      });

      entryIds.push(je.id);
      for (const item of preview.items) acumularTotales(item);
    } catch (e: any) {
      // El asiento es uno: o entra entero o no entra. No hay "la mitad de la nómina".
      errores.push({
        empleado: descripcionConsolidada(preview.tipo, preview.items.length, preview.periodo),
        motivo: (e?.message || 'Error desconocido').slice(0, 300),
      });
    }
  }

  // ── Camino por empleado: un asiento BORRADOR cada uno ──
  const itemsPorEmpleado = lineasConsolidadas ? [] : preview.items;
  for (const item of itemsPorEmpleado) {
    const bloqueada = blockedMessage(accountFlags, item.lineas.map((l) => l.accountId));
    if (bloqueada) {
      errores.push({ empleado: item.nombre, motivo: bloqueada });
      continue;
    }

    const descripcion =
      preview.tipo === 'DECIMO'
        ? `Décimo III de ${item.nombre} — ${preview.periodo}`
        : preview.tipo === 'VACACIONES'
          ? `Vacaciones de ${item.nombre} — ${preview.periodo}`
          : `Planilla de ${item.nombre} — ${preview.periodo}`;

    try {
      const je = await prisma.$transaction(async (tx: any) => {
        const asiento = await tx.journalEntry.create({
          data: {
            date: fechaPago,
            description: descripcion,
            status: 'BORRADOR',
            companyId,
            createdById: userId,
            lines: { create: item.lineas },
          },
        });

        await tx.transaction.create({
          data: {
            type: 'PLANILLA',
            amount: item.bruto,
            description: descripcion,
            concept: preview.tipo === 'DECIMO' ? 'Décimo III' : preview.tipo === 'VACACIONES' ? 'Vacaciones' : 'Planilla',
            paymentMethod: null,
            date: fechaPago,
            companyId,
            createdById: userId,
            journalEntryId: asiento.id,
            // Sin `provider` a propósito: la planilla no es una compra a proveedor y
            // no debe aparecer en el Informe Por Proveedores. `source` sigue siendo
            // 'planilla' para no romper ese informe ni el origen 🧮 del diario.
            metadata: JSON.stringify({
              source: 'planilla',
              origen: 'MODULO',
              runId: run.id,
              tipo: preview.tipo,
              periodo: preview.periodo,
              quincena: opts.fechaPago,
              employee: item.nombre,
              employeeId: item.employeeId,
              cedula: item.cedula,
              salario: item.sueldo,
              horasExtras: item.horasExtras,
              otrosIngresos: item.otrosIngresos,
            menosSueldo: item.menosSueldo,
              ss: item.ss,
              se: item.se,
              isr: item.isr,
              otrasDeducciones: item.otrasDeducciones,
              neto: item.neto,
              ssPatronal: item.ssPatronal,
              sePatronal: item.sePatronal,
              riesgosPatronal: item.riesgosPatronal,
            }),
          },
        });

        await tx.payrollItem.create({
          data: {
            companyId,
            runId: run.id,
            employeeId: item.employeeId,
            diasTrabajados: item.diasTrabajados,
            sueldo: item.sueldo,
            horasExtras: item.horasExtras,
            otrosIngresos: item.otrosIngresos,
            menosSueldo: item.menosSueldo,
            bruto: item.bruto,
            ss: item.ss,
            se: item.se,
            isr: item.isr,
            otrasDeducciones: item.otrasDeducciones,
            neto: item.neto,
            ssPatronal: item.ssPatronal,
            sePatronal: item.sePatronal,
            riesgosPatronal: item.riesgosPatronal,
            decimoGenerado: item.decimoGenerado,
            vacacionesGeneradas: item.vacacionesGeneradas,
            primaGenerada: item.primaGenerada,
            journalEntryId: asiento.id,
            notas: item.notas ?? null,
          },
        });

        // El detalle por acreedor, dentro de la MISMA transacción del ítem: si el
        // empleado falla, no puede quedar la constancia de una cuota que no se descontó.
        await tx.payrollItemDeduction.createMany({
          data: filasDeDeducciones([item], companyId, run.id),
        });

        return asiento;
      });

      entryIds.push(je.id);
      acumularTotales(item);
    } catch (e: any) {
      errores.push({ empleado: item.nombre, motivo: (e?.message || 'Error desconocido').slice(0, 300) });
    }
  }

  // Los totales se congelan con lo que REALMENTE entró: si tres empleados fallaron,
  // la corrida no puede decir que pagó por ellos.
  const actualizada = await prisma.payrollRun.update({
    where: { id: run.id },
    data: {
      status: entryIds.length > 0 ? 'EJECUTADA' : 'BORRADOR',
      totalBruto: totales.bruto,
      totalDeducciones: totales.deducciones,
      totalNeto: totales.neto,
      totalPatronal: totales.patronal,
      totalDecimoGenerado: totales.decimoGenerado,
      totalVacacionesGeneradas: totales.vacacionesGeneradas,
      totalPrimaGenerada: totales.primaGenerada,
      asientosCount: entryIds.length,
    },
  });

  await logAudit(prisma, {
    userId,
    action: 'PLANILLA_CORRIDA_EJECUTADA',
    entity: 'PayrollRun',
    entityId: run.id,
    after: { periodo: preview.periodo, tipo: preview.tipo, asientos: entryIds.length, neto: totales.neto },
  });

  return {
    runId: actualizada.id,
    periodo: preview.periodo,
    creados: entryIds.length,
    totales,
    errores,
    entryIds,
  };
}

// ─── Anulación ───────────────────────────────────────────────────────────────

/**
 * Anula la corrida entera: un reverso por asiento, fechado hoy.
 *
 * El original SIGUE contando en su período — así funciona `anularAsiento` en todo el
 * sistema. La corrida pasa a ANULADA y sus ítems salen de los acumulados por la
 * relación (`run.status != ANULADA`), sin borrar nada.
 */
export async function anularCorrida(
  prisma: any,
  companyId: string,
  userId: string,
  runId: string,
  motivo: string,
): Promise<{ anulados: number; errores: { empleado: string; motivo: string }[] }> {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId },
    include: { items: { include: { employee: { select: { nombre: true } } } } },
  });
  if (!run) throw Object.assign(new Error('Corrida no encontrada'), { status: 404 });
  if (run.status === 'ANULADA') {
    throw Object.assign(new Error('La corrida ya está anulada'), { status: 400 });
  }

  const errores: { empleado: string; motivo: string }[] = [];
  let anulados = 0;

  // Los asientos SIN repetir: en una corrida consolidada todos los ítems apuntan al
  // mismo asiento, y anularlo una vez por ítem crearía treinta reversos del mismo
  // asiento — treinta veces la reversión, con el balance cuadrando igual.
  const asientos = new Map<string, string>();
  for (const item of run.items) {
    if (item.journalEntryId && !asientos.has(item.journalEntryId)) {
      asientos.set(item.journalEntryId, item.employee?.nombre ?? item.employeeId);
    }
  }

  for (const [asientoId, etiqueta] of asientos) {
    try {
      await prisma.$transaction(async (tx: any) => {
        await anularAsiento(tx, companyId, userId, asientoId);
      });
      anulados++;
    } catch (e: any) {
      errores.push({
        empleado: run.consolidado ? `Corrida ${run.periodo}` : etiqueta,
        motivo: e?.message || 'Error al anular',
      });
    }
  }

  await prisma.payrollRun.update({
    where: { id: runId },
    data: { status: 'ANULADA', motivoAnulacion: motivo },
  });

  await logAudit(prisma, {
    userId,
    action: 'PLANILLA_CORRIDA_ANULADA',
    entity: 'PayrollRun',
    entityId: runId,
    after: { periodo: run.periodo, tipo: run.tipo, motivo, anulados },
  });

  return { anulados, errores };
}

// ─── Revisión en bloque ──────────────────────────────────────────────────────

/**
 * Aprueba o rechaza los asientos de la corrida de una vez.
 *
 * Repite la MISMA transición que `POST /journal/:id/review` —BORRADOR → CONFIRMADO
 * o RECHAZADO, con `reviewedById`/`reviewedAt`— pero no la importa: ese handler
 * además revierte facturas, cobros y retenciones, que la planilla no tiene. Lo que
 * comparten es la regla, y la regla es una línea.
 */
export async function revisarCorrida(
  prisma: any,
  companyId: string,
  userId: string,
  runId: string,
  accion: 'aprobar' | 'rechazar',
  notes?: string,
): Promise<{ revisados: number; omitidos: { empleado: string; motivo: string }[] }> {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId },
    include: { items: { include: { employee: { select: { nombre: true } } } } },
  });
  if (!run) throw Object.assign(new Error('Corrida no encontrada'), { status: 404 });
  if (run.status === 'ANULADA') {
    throw Object.assign(new Error('La corrida está anulada: sus asientos ya se revirtieron'), { status: 400 });
  }

  const nuevoEstado = accion === 'aprobar' ? 'CONFIRMADO' : 'RECHAZADO';
  const omitidos: { empleado: string; motivo: string }[] = [];
  let revisados = 0;

  // Los asientos SIN repetir: en una corrida consolidada hay UNO para toda la
  // nómina, y contarlo una vez por empleado diría que se revisaron treinta.
  const idsAsientos = [...new Set(run.items.map((i: any) => i.journalEntryId).filter(Boolean))] as string[];
  const etiqueta = (nombre: string | null) => (run.consolidado ? `Corrida ${run.periodo}` : nombre ?? '—');

  for (const idAsiento of idsAsientos) {
    const asiento = await prisma.journalEntry.findFirst({
      where: { id: idAsiento, companyId },
      select: { id: true, status: true },
    });
    if (!asiento) continue;
    if (asiento.status !== 'BORRADOR') {
      omitidos.push({
        empleado: etiqueta(run.items.find((i: any) => i.journalEntryId === idAsiento)?.employee?.nombre),
        motivo: `El asiento ya está en ${asiento.status}`,
      });
      continue;
    }
    await prisma.journalEntry.update({
      where: { id: asiento.id },
      data: { status: nuevoEstado, reviewedById: userId, reviewedAt: new Date(), reviewNotes: notes || null },
    });
    revisados++;
  }

  await logAudit(prisma, {
    userId,
    action: `PLANILLA_CORRIDA_${accion === 'aprobar' ? 'APROBADA' : 'RECHAZADA'}`,
    entity: 'PayrollRun',
    entityId: runId,
    after: { revisados, omitidos: omitidos.length },
  });

  return { revisados, omitidos };
}

// ─── Consulta y export ───────────────────────────────────────────────────────

/**
 * Estado de los asientos de un conjunto de ítems.
 *
 * `PayrollItem.journalEntryId` es un campo suelto, NO una relación de Prisma —igual
 * que en `InventoryMovement`—, así que el estado hay que ir a buscarlo aparte. Se
 * hace en una sola consulta para todos los ítems, no una por empleado.
 */
async function estadosDeAsientos(prisma: any, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const asientos: any[] = await prisma.journalEntry.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true },
  });
  return new Map(asientos.map((a) => [a.id, a.status]));
}

/** Historial de corridas con el resumen del estado de sus asientos. */
export async function listarCorridas(prisma: any, companyId: string, opts: { limit?: number } = {}) {
  const corridas: any[] = await prisma.payrollRun.findMany({
    where: { companyId },
    orderBy: [{ fechaPago: 'desc' }, { createdAt: 'desc' }],
    take: opts.limit ?? 50,
    include: { _count: { select: { items: true } } },
  });

  // La corrida dice EJECUTADA cuando los asientos existen, pero quién los aprobó lo
  // dice el diario. Se resume acá para que la pantalla no pida los asientos uno por uno.
  const items: any[] = await prisma.payrollItem.findMany({
    where: { companyId, runId: { in: corridas.map((c) => c.id) }, journalEntryId: { not: null } },
    select: { runId: true, journalEntryId: true },
  });
  const estados = await estadosDeAsientos(prisma, items.map((i) => i.journalEntryId));

  // Se cuentan ASIENTOS, no empleados: en una corrida consolidada treinta ítems
  // apuntan al mismo asiento, y decir "30 en BORRADOR" cuando hay uno solo es la
  // clase de número que después alguien reconcilia contra el diario y no cierra.
  const conteoPorRun = new Map<string, Record<string, number>>();
  const vistos = new Set<string>();
  for (const item of items) {
    const llave = `${item.runId}:${item.journalEntryId}`;
    if (vistos.has(llave)) continue;
    vistos.add(llave);

    const conteo = conteoPorRun.get(item.runId) ?? {};
    const estado = estados.get(item.journalEntryId) ?? 'SIN_ASIENTO';
    conteo[estado] = (conteo[estado] ?? 0) + 1;
    conteoPorRun.set(item.runId, conteo);
  }

  return corridas.map((run) => ({
    ...run,
    empleados: run._count.items,
    asientos: conteoPorRun.get(run.id) ?? {},
  }));
}

/** Detalle de una corrida con sus ítems y el estado de cada asiento. */
export async function obtenerCorrida(prisma: any, companyId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, companyId },
    include: {
      items: {
        include: { employee: { select: { id: true, nombre: true, cedula: true, tipoPago: true } } },
      },
      // El desglose CONGELADO de las deducciones: cuelga de la CORRIDA —no del ítem,
      // porque el camino consolidado usa `createMany`— y acá se reparte por empleado.
      // El historial no se reinterpreta con el catálogo de hoy.
      deducciones: { orderBy: { acreedor: 'asc' } },
    },
  });
  if (!run) return null;
  const { deducciones, ...cabecera } = run;

  const estados = await estadosDeAsientos(
    prisma,
    run.items.map((i: any) => i.journalEntryId).filter(Boolean),
  );

  return {
    ...cabecera,
    items: run.items
      .map((i: any) => ({
        ...i,
        asientoStatus: i.journalEntryId ? (estados.get(i.journalEntryId) ?? null) : null,
        deducciones: deducciones.filter((d: any) => d.employeeId === i.employeeId),
      }))
      .sort((a: any, b: any) => (a.employee?.nombre ?? '').localeCompare(b.employee?.nombre ?? '')),
  };
}

/**
 * CSV con las columnas del archivo viejo, para que el flujo de aguas abajo del
 * contador —presentar la planilla a la CSS— siga funcionando igual.
 */
export function corridaACSV(run: any): string {
  const headers = [
    'QUINCENA', 'NOMBRE', 'CEDULA', 'SUELDO', 'HORAS EXTRAS', 'DECIMO',
    'VACACIONES', 'SS', 'SE', 'ISR', 'TOPAL A PAGAR',
  ];
  const fecha = new Date(run.fechaPago);
  const quincena = `${String(fecha.getDate()).padStart(2, '0')}/${fecha.getMonth() + 1}/${String(fecha.getFullYear()).slice(2)}`;

  const n = (v: number) => (v ? v.toFixed(2) : '');
  const filas = run.items.map((i: any) => {
    // Cada tipo de corrida llena SU columna: un pago de décimo no lleva sueldo.
    const sueldo = run.tipo === 'SUELDO' ? i.sueldo : 0;
    const decimo = run.tipo === 'DECIMO' ? i.bruto : 0;
    const vacaciones = run.tipo === 'VACACIONES' ? i.bruto : 0;
    return [
      quincena,
      i.employee?.nombre ?? '',
      i.employee?.cedula ?? '',
      n(sueldo + i.otrosIngresos),
      n(i.horasExtras),
      n(decimo),
      n(vacaciones),
      n(i.ss),
      n(i.se),
      n(i.isr),
      n(i.neto),
    ].map((c) => (String(c).includes(',') || String(c).includes('"') ? `"${String(c).replace(/"/g, '""')}"` : c));
  });

  return [headers.join(','), ...filas.map((f: string[]) => f.join(','))].join('\r\n') + '\r\n';
}
