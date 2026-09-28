import {
  TABLA_ISR_PANAMA,
  TASAS_RIESGO_DEFAULT,
  type CuentasPlanilla,
  type Tasas,
  type TramoISR,
} from './payroll-calc';
import { loadCompanyAccounts, type CompanyAccount } from './account-resolver';

/**
 * Parámetros y cuentas del módulo de Planilla.
 *
 * Es la única fuente de las dos cosas:
 *  · `PLANILLA_FIELDS`, que antes vivía en `routes/config.ts` y ahora lo importa
 *    desde acá — así la pantalla de Configuración y el módulo no pueden discrepar
 *    sobre qué campos existen.
 *  · las tasas y la tabla del ISR, que viven en `PayrollSettings` y se crean
 *    perezosamente con los valores legales.
 */

// ─── Cuentas contables (Company) ─────────────────────────────────────────────

/** Cuenta por cada concepto del asiento. El campo en `Company` y la etiqueta legible. */
export const PLANILLA_FIELDS: { field: string; label: string }[] = [
  { field: 'planillaSueldoId', label: 'Sueldo' },
  { field: 'planillaHorasExtrasId', label: 'Horas Extras' },
  { field: 'planillaDecimoId', label: 'Décimo III' },
  { field: 'planillaVacacionesId', label: 'Vacaciones' },
  { field: 'planillaSSId', label: 'Seguro Social (SS)' },
  { field: 'planillaSEId', label: 'Seguro Educativo (SE)' },
  { field: 'planillaISRId', label: 'ISR' },
  { field: 'planillaBancoId', label: 'Neto a banco' },
  { field: 'planillaSSPatronalId', label: 'Seguro Social del patrono (por pagar)' },
  { field: 'planillaSEPatronalId', label: 'Seguro Educativo del patrono (por pagar)' },
  { field: 'planillaRiesgosPatronalId', label: 'Riesgos Profesionales del patrono (por pagar)' },
  { field: 'planillaPatronalGastoId', label: 'Gasto de aportes patronales (genérico)' },
  { field: 'planillaSSPatronalGastoId', label: 'Gasto de Seguro Social del patrono' },
  { field: 'planillaSEPatronalGastoId', label: 'Gasto de Seguro Educativo del patrono' },
  { field: 'planillaRiesgosProfesionalesId', label: 'Gasto de Riesgos Profesionales' },
  { field: 'planillaOtrasDeduccionesId', label: 'Otras deducciones (préstamos, embargos)' },
];

/** Cuentas del catálogo por las que caen las prestaciones por pagar. */
const CODIGO_DECIMO_POR_PAGAR = '2.1.10';
const CODIGO_VACACIONES_POR_PAGAR = '2.1.11';
const CODIGO_PRESTACIONES_POR_PAGAR = '2.1.09';

/**
 * Cuentas de gasto del patrono en el catálogo, para no obligar a configurarlas a
 * mano. Son las que el contador ya tiene en su plan.
 */
const CODIGO_GASTO_SS_PATRONO = '6.01.02.03';
const CODIGO_GASTO_SE_PATRONO = '6.01.02.02';
const CODIGO_GASTO_RIESGOS = '6.01.02.01';

export interface CuentaFaltante {
  clave: keyof CuentasPlanilla;
  etiqueta: string;
}

export interface ResolucionCuentas {
  cuentas: CuentasPlanilla;
  /**
   * Las cuentas TAL COMO ESTÁN CONFIGURADAS en `Company`, por nombre de campo:
   * `{ planillaSueldoId: 'id' | null, … }`.
   *
   * Es lo que come la pantalla de Parámetros, y por una razón que costó cara: sus
   * selectores ESCRIBEN esos campos, así que tienen que pre-seleccionarse con ellos.
   * Con `cuentas` —que va por concepto (`sueldo`, `ss`) y con los respaldos ya
   * aplicados— la comparación `cuentas['planillaSueldoId']` daba `undefined` siempre,
   * la pantalla mostraba TODOS los selectores vacíos y guardar escribía ese hueco
   * encima de la configuración: se perdían las cuentas que el contador no volvía a
   * elegir en cada guardado.
   */
  configuradas: Record<string, string | null>;
  /**
   * Cuentas sin resolver. Se devuelven con su CLAVE, no solo con la etiqueta:
   * cada tipo de corrida necesita unas distintas —una de Décimo no usa la cuenta
   * de Horas Extras— y quien ejecuta filtra por clave en vez de adivinar.
   */
  faltantes: CuentaFaltante[];
  /** Cosas que funcionan pero conviene mirar: una cuenta cayó a su respaldo. */
  avisos: string[];
}

/**
 * Resuelve las cuentas del asiento de planilla.
 *
 * Los aportes del patrono y las prestaciones por pagar tienen respaldo —el pasivo
 * del patrono puede ser el mismo que el de la retención cuando la empresa todavía no
 * partió su catálogo, y las cuentas 2.1.09/2.1.10/2.1.11 ya están en el plan— pero
 * **nunca se inventa una cuenta**: si no hay ni configuración ni respaldo, queda en
 * `faltantes` y la corrida se rechaza diciendo cuál falta. Es la doctrina de
 * `cuentasInventarioEnUso`.
 *
 * El respaldo importa para el pago: `payroll-css.ts` debita las MISMAS cuentas que
 * acá se resuelven, así que mientras el respaldo exista, la cuenta que recibe el
 * crédito del devengo es la que se descarga al pagar.
 */
export async function resolverCuentasPlanilla(
  prisma: any,
  companyId: string,
): Promise<ResolucionCuentas> {
  const [company, accounts] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: Object.fromEntries(PLANILLA_FIELDS.map((f) => [f.field, true])),
    }),
    loadCompanyAccounts(prisma, companyId),
  ]);

  const porCodigo = new Map<string, CompanyAccount>(accounts.map((a) => [a.code, a]));
  const campo = (f: string): string | null => (company as any)?.[f] || null;

  const faltantes: CuentaFaltante[] = [];
  const avisos: string[] = [];

  /** La cuenta configurada; si no, el respaldo (avisando); si no, falta. */
  function cuenta(
    clave: keyof CuentasPlanilla,
    etiqueta: string,
    configurada: string | null,
    respaldo?: string | null,
    motivoRespaldo?: string,
  ): string {
    if (configurada) return configurada;
    if (respaldo) {
      if (motivoRespaldo) avisos.push(motivoRespaldo);
      return respaldo;
    }
    faltantes.push({ clave, etiqueta });
    return '';
  }

  const sueldo = cuenta('sueldo', 'Sueldo', campo('planillaSueldoId'));
  const horasExtras = cuenta('horasExtras', 'Horas Extras', campo('planillaHorasExtrasId'), sueldo);
  const ss = cuenta('ss', 'Seguro Social (SS)', campo('planillaSSId'));
  const se = cuenta('se', 'Seguro Educativo (SE)', campo('planillaSEId'));
  const isr = cuenta('isr', 'ISR', campo('planillaISRId'));

  // El pasivo del patrono puede ser el MISMO de la retención, y cuando lo es no hay
  // nada que avisar: a la CSS se le paga todo junto, en un solo pago, y así el
  // pasivo netea a cero con ese pago. Con el catálogo partido cada concepto tiene su
  // subcuenta, y el pago descarga las tres — una por una, con su monto— porque si no
  // las subcuentas se acreditarían para siempre. (El GASTO va separado siempre: ver
  // `gastoPatronal`.)
  const ssPatronal = cuenta('ssPatronal', 'Seguro Social del patrono', campo('planillaSSPatronalId'), ss);
  const sePatronal = cuenta('sePatronal', 'Seguro Educativo del patrono', campo('planillaSEPatronalId'), se);
  // Los riesgos caen al pasivo del Seguro Social —es el mismo pago a la CSS— y no
  // faltan nunca que el SS esté: sin cuenta propia, el par crédito/débito sigue
  // cayendo en la misma cuenta que antes.
  const riesgosPatronal = cuenta(
    'riesgosPatronal',
    'Riesgos Profesionales del patrono',
    campo('planillaRiesgosPatronalId'),
    ssPatronal || null,
  );
  /**
   * Una de las tres cuentas de gasto del patrono, en cadena: la configurada → la del
   * catálogo por código → la genérica de aportes patronales → Sueldos (avisando).
   *
   * El código entra en la cadena porque el contador ya tiene 6.01.02.01/.02/.03 en su
   * plan: sin eso habría que configurar tres selectores para que el módulo empiece a
   * separar el gasto, y hasta entonces seguiría todo mezclado en una sola cuenta.
   */
  const gastoPatronal = (
    clave: keyof CuentasPlanilla,
    etiqueta: string,
    campoNombre: string,
    codigo: string,
  ): string => {
    const configurada = campo(campoNombre);
    if (configurada) return configurada;
    const delCatalogo = porCodigo.get(codigo)?.id;
    if (delCatalogo) return delCatalogo;
    const generica = campo('planillaPatronalGastoId');
    if (generica) {
      avisos.push(`El gasto de ${etiqueta} está cayendo en la cuenta genérica de aportes patronales.`);
      return generica;
    }
    if (sueldo) {
      avisos.push(`El gasto de ${etiqueta} está cayendo en la cuenta de Sueldos: asígnale su cuenta en Configuración.`);
      return sueldo;
    }
    faltantes.push({ clave, etiqueta });
    return '';
  };

  const ssPatronalGasto = gastoPatronal('ssPatronalGasto', 'Seguro Social del patrono', 'planillaSSPatronalGastoId', CODIGO_GASTO_SS_PATRONO);
  const sePatronalGasto = gastoPatronal('sePatronalGasto', 'Seguro Educativo del patrono', 'planillaSEPatronalGastoId', CODIGO_GASTO_SE_PATRONO);
  const riesgosGasto = gastoPatronal('riesgosGasto', 'Riesgos Profesionales', 'planillaRiesgosProfesionalesId', CODIGO_GASTO_RIESGOS);

  const porCodigoOFalta = (
    clave: keyof CuentasPlanilla,
    etiqueta: string,
    codigo: string,
  ): string => cuenta(clave, `${etiqueta} (${codigo})`, porCodigo.get(codigo)?.id ?? null);

  const cuentas: CuentasPlanilla = {
    sueldo,
    horasExtras,
    decimo: cuenta('decimo', 'Décimo III', campo('planillaDecimoId')),
    vacaciones: cuenta('vacaciones', 'Vacaciones', campo('planillaVacacionesId')),
    ss,
    se,
    isr,
    // Sin respaldo a propósito: desviar un préstamo a otra cuenta en silencio
    // descuadraría el pasivo del empleado. Si hay otras deducciones y no hay
    // cuenta, la corrida se rechaza.
    otrasDeducciones: campo('planillaOtrasDeduccionesId') || '',
    ssPatronal,
    sePatronal,
    riesgosPatronal,
    ssPatronalGasto,
    sePatronalGasto,
    riesgosGasto,
    decimoPorPagar: porCodigoOFalta('decimoPorPagar', 'Décimo por Pagar', CODIGO_DECIMO_POR_PAGAR),
    vacacionesPorPagar: porCodigoOFalta('vacacionesPorPagar', 'Vacaciones por Pagar', CODIGO_VACACIONES_POR_PAGAR),
    prestacionesPorPagar: porCodigoOFalta('prestacionesPorPagar', 'Prestaciones por Pagar', CODIGO_PRESTACIONES_POR_PAGAR),
  };

  const configuradas = Object.fromEntries(PLANILLA_FIELDS.map((f) => [f.field, campo(f.field)]));

  return { cuentas, configuradas, faltantes, avisos };
}

// ─── Parámetros de cálculo (PayrollSettings) ─────────────────────────────────

export interface PayrollSettingsRow {
  ssObrero: number;
  seObrero: number;
  ssPatronal: number;
  sePatronal: number;
  riesgosProfesionales: number;
  ssObreroDecimo: number;
  seObreroDecimo: number;
  ssPatronalDecimo: number;
  factorDecimo: number;
  factorVacaciones: number;
  factorPrima: number;
  tablaISR: string;
  riesgosPorClase: string;
  provisionarPrestaciones: boolean;
  /** Día de la semana del pago semanal (0 = domingo). Ver el modelo en el esquema. */
  diaPagoSemanal: number;
}

/**
 * Tarifa de riesgos por clase de riesgo.
 *
 * `"{}"` (el default de la columna) significa "usar la del código", que solo trae la
 * clase I. Una clase ausente del mapa NO cae a cero: el motor rechaza la fila de ese
 * empleado, porque un cero silencioso subvalúa el pasivo del patrono sin que nadie
 * lo note.
 */
export function parseRiesgosPorClase(raw: string): Record<string, number> {
  const texto = (raw || '').trim();
  if (!texto || texto === '{}') return { ...TASAS_RIESGO_DEFAULT };

  let parsed: unknown;
  try {
    parsed = JSON.parse(texto);
  } catch {
    throw new Error('Las tarifas de riesgos por clase no son JSON válido. Corregilas en Parámetros → Riesgos Profesionales.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Las tarifas de riesgos por clase tienen que ser un objeto { "I": 0.01 }.');
  }

  const tarifas: Record<string, number> = {};
  for (const [clase, valor] of Object.entries(parsed as Record<string, unknown>)) {
    // Una clase con valor vacío se OMITE en vez de guardarse en cero: el hueco tiene
    // que llegar al motor como hueco, no como una tarifa del 0%.
    if (valor === null || valor === undefined || valor === '') continue;
    const tasa = Number(valor);
    if (!Number.isFinite(tasa) || tasa < 0 || tasa > 1) {
      throw new Error(`La tarifa de la clase ${clase} tiene que estar entre 0 y 1 (llegó ${valor}).`);
    }
    tarifas[clase] = tasa;
  }
  return tarifas;
}

/**
 * Devuelve la fila de parámetros de la empresa, creándola con los valores legales
 * si no existe. Se crea perezosamente porque un módulo que no puede calcular hasta
 * que alguien abra y guarde una pantalla está roto.
 */
export async function getOrCreateSettings(prisma: any, companyId: string): Promise<PayrollSettingsRow> {
  return prisma.payrollSettings.upsert({
    where: { companyId },
    update: {},
    create: { companyId },
  });
}

/**
 * Parsea la tabla del ISR guardada. `"[]"` —el default de la columna— significa
 * "usar la tabla legal del código": así los valores por defecto viven en un solo
 * sitio y la BD solo guarda lo que alguien cambió a propósito.
 *
 * Una tabla con forma inválida NO se ignora en silencio: calcular el impuesto con
 * la tabla legal y no decirlo sería peor que fallar.
 */
export function parseTablaISR(raw: string): TramoISR[] {
  const texto = (raw || '').trim();
  if (!texto || texto === '[]') return TABLA_ISR_PANAMA;

  let parsed: unknown;
  try {
    parsed = JSON.parse(texto);
  } catch {
    throw new Error('La tabla del ISR guardada no es JSON válido. Corrígela en Parámetros → ISR.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('La tabla del ISR guardada está vacía o no es una lista de tramos.');
  }

  const tramos = parsed.map((t: any, i: number): TramoISR => {
    const desde = Number(t?.desde);
    const tasa = Number(t?.tasa);
    const hasta = t?.hasta === null || t?.hasta === undefined ? null : Number(t.hasta);
    if (!Number.isFinite(desde) || !Number.isFinite(tasa) || (hasta !== null && !Number.isFinite(hasta))) {
      throw new Error(`El tramo ${i + 1} de la tabla del ISR tiene valores no numéricos.`);
    }
    if (tasa < 0 || tasa > 1) {
      throw new Error(`El tramo ${i + 1} de la tabla del ISR tiene una tasa fuera de 0–1.`);
    }
    return { desde, hasta, tasa };
  });

  for (let i = 1; i < tramos.length; i++) {
    if (tramos[i].desde < tramos[i - 1].desde) {
      throw new Error('Los tramos de la tabla del ISR tienen que venir ordenados de menor a mayor.');
    }
  }
  return tramos;
}

/** Traduce la fila de parámetros a lo que come el motor puro. */
export function tasasDe(settings: PayrollSettingsRow): Tasas {
  return {
    ssObrero: settings.ssObrero,
    seObrero: settings.seObrero,
    ssPatronal: settings.ssPatronal,
    sePatronal: settings.sePatronal,
    riesgosProfesionales: settings.riesgosProfesionales,
    riesgosPorClase: parseRiesgosPorClase(settings.riesgosPorClase),
    ssObreroDecimo: settings.ssObreroDecimo,
    seObreroDecimo: settings.seObreroDecimo,
    ssPatronalDecimo: settings.ssPatronalDecimo,
    factorDecimo: settings.factorDecimo,
    factorVacaciones: settings.factorVacaciones,
    factorPrima: settings.factorPrima,
    tablaISR: parseTablaISR(settings.tablaISR),
    provisionarPrestaciones: settings.provisionarPrestaciones,
  };
}
