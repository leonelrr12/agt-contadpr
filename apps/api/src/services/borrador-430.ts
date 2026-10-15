/**
 * Borrador del Formulario 430 (declaración mensual de ITBMS).
 *
 * Es un informe DE SOLO LECTURA: no crea asientos, no cambia estados y no escribe
 * nada. Existe para que el contador compare lo que dice el libro con el formulario
 * que va a presentar, antes de que el sistema se comprometa a contabilizar la
 * declaración (fase posterior, ver Tuning.md §4.1).
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 * `getSaldoITBMS` (tax-calendar.ts) trata TODO débito de `2.1.05` como crédito
 * fiscal. En el libro real los débitos de esa cuenta mezclan tres cosas distintas:
 * crédito fiscal de compras, PAGOS a la DGI (`PAGO_ITBMS`) y COMPENSACIONES del
 * crédito por retención (R52). Restar a lo bruto infla el crédito fiscal —en ODESA
 * los pagos a la DGI (2.524,77) son mayores que las compras (1.784,75)— y además
 * ese saldo se clampa con `Math.max(0, …)`, así que un período con saldo a favor
 * (justo el caso que la decisión D2 necesita ver) se reporta como cero.
 *
 * ── Principio rector ───────────────────────────────────────────────────────
 * El ITBMS NUNCA se deriva: se lee del movimiento de `2.1.05`. La base gravada sí
 * es heurística (se reconstruye de las contrapartidas del propio asiento). Si el
 * clasificador se equivoca en la base, el impuesto sigue bien; si se equivoca de
 * bucket, el cuadre contra el mayor lo delata (`cuadre`) y el asiento aparece en
 * `noClasificados` en vez de sumarse en silencio.
 */

import { r2 } from '../lib/money';
import { codigosEfectivo } from '../lib/cuentas-efectivo';
import { findRetencionAccount } from './retencion-itbms';
import { resolveEntryOrigin } from './entry-origin';
import type { EntryOrigin } from './entry-origin';

/** Tolerancia en dólares para comparar montos: medio centavo. */
const TOL = 0.005;

/**
 * Redondeo monetario FIRMADO: medio-arriba en magnitud (simétrico).
 *
 * No se usa `r2` a secas porque está calibrada para valores positivos (lo dice su
 * docblock, y es todo lo que maneja la planilla): con negativos `Math.round`
 * redondea hacia +∞ y `−34.125` saldría `−34.12` en vez de `−34.13`. Este informe
 * tiene negativos de verdad (anulaciones, notas de crédito, saldo a favor), así que
 * se conserva el epsilon de `r2` aplicándolo sobre el valor absoluto.
 */
export function r2s(n: number): number {
  const x = Number(n) || 0;
  return Math.sign(x) * r2(Math.abs(x));
}

/** Redondeo a 4 decimales para la tasa implícita (que no es dinero). */
const r4 = (n: number) => Math.round((Number(n) || 0) * 10000) / 10000;

export const MESES_430 = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export interface RangoMes {
  /** Primera medianoche LOCAL del mes. */
  start: Date;
  /** Primera medianoche LOCAL del mes siguiente (límite EXCLUSIVO). */
  endExclusive: Date;
  /** Último instante del mes (para mostrar). */
  end: Date;
  /** Día 15 del mes siguiente, mediodía local (vencimiento del 430). */
  vence: Date;
}

/**
 * Rango del mes en hora LOCAL del servidor, que es la convención de todo el repo
 * (`parseLocalDate` guarda a mediodía local).
 *
 * OJO: NO copiar el patrón de `estimateITBMS` (`new Date(year, month, 0)`), que da
 * la medianoche del ÚLTIMO día del mes: como los asientos viven a mediodía, todo lo
 * cargado el último día del mes queda fuera del informe. Con el límite exclusivo
 * del día 1 siguiente el mes entra completo, y también entran los reversos de
 * anulación, que se fechan con `new Date()` (cualquier hora del día).
 */
export function rangoMes(year: number, mes: number): RangoMes {
  const start = new Date(year, mes - 1, 1, 0, 0, 0, 0);
  const endExclusive = new Date(year, mes, 1, 0, 0, 0, 0);
  const end = new Date(endExclusive.getTime() - 1);
  const vence = new Date(year, mes, 15, 12, 0, 0);
  return { start, endExclusive, end, vence };
}

/** Fecha local en `YYYY-MM-DD` (sin pasar por UTC: el día no se corre). */
export function fechaLocalISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// ─────────────────────────── Resolución de cuentas ───────────────────────────

export interface Cuenta430 {
  id: string;
  code: string;
  name: string;
  origen: 'alias' | 'codigo' | 'alias+codigo';
}

export interface Contexto430 {
  porPagar: Cuenta430[];
  porPagarIds: Set<string>;
  retenido: Cuenta430 | null;
  retenidoIds: Set<string>;
  codigosEfectivo: Set<string>;
}

/**
 * Resuelve `2.1.05` por UNIÓN de alias y código. Los escritores no coinciden:
 * `getSaldoITBMS` y `entity-service` usan el código literal, mientras que
 * `facturas.ts`, los agentes, `retenciones.ts` e `inventario.ts` resuelven el alias
 * `itbms-por-pagar`. Elegir uno solo deja movimientos afuera en cuanto alguien
 * remapea el alias desde Administración → Cuentas.
 *
 * `1.1.07` se resuelve con `findRetencionAccount` (alias → código → nombre), que ya
 * tolera las cuentas creadas a mano sin alias y nunca lanza. Si no existe, las
 * compensaciones caen a «sin clasificar» en vez de romper el informe.
 */
export async function resolverCuentas430(prisma: any, companyId: string): Promise<Contexto430> {
  const cuentas = await prisma.account.findMany({
    where: { companyId },
    select: { id: true, code: true, name: true, aliases: true },
  });

  const porPagar: Cuenta430[] = [];
  for (const a of cuentas) {
    const code = String(a.code || '').trim();
    const porAlias = (a.aliases || []).some((x: string) => String(x || '').trim().toLowerCase() === 'itbms-por-pagar');
    const porCodigo = code === '2.1.05' || code.startsWith('2.1.05.');
    if (!porAlias && !porCodigo) continue;
    porPagar.push({
      id: a.id,
      code,
      name: String(a.name || ''),
      origen: porAlias && porCodigo ? 'alias+codigo' : porAlias ? 'alias' : 'codigo',
    });
  }

  const ret = findRetencionAccount(cuentas as any);
  const retenido: Cuenta430 | null = ret
    ? { id: ret.id, code: String(ret.code || ''), name: String(ret.name || ''), origen: 'alias' }
    : null;

  return {
    porPagar,
    porPagarIds: new Set(porPagar.map((c) => c.id)),
    retenido,
    retenidoIds: new Set(retenido ? [retenido.id] : []),
    codigosEfectivo: await codigosEfectivo(prisma, companyId),
  };
}

// ───────────────────────────── Clasificación ─────────────────────────────

export interface Linea430 {
  accountId: string;
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
}

export type Bucket430 =
  | 'VENTA'
  | 'COMPRA'
  | 'NOTA_CREDITO_COMPRA'
  | 'PAGO_DGI'
  | 'COMPENSACION_R52'
  | 'AJUSTE'
  | 'NO_CLASIFICADO';

export interface Clasificacion430 {
  bucket: Bucket430;
  /** Débitos a `2.1.05` del asiento (ya redondeados y con signo de anulación). */
  debitoItbms: number;
  /** Créditos a `2.1.05` del asiento. */
  creditoItbms: number;
  /** Efecto firmado sobre el saldo de la cuenta: crédito − débito. */
  efectoSaldo: number;
  /** Base gravada reconstruida de contrapartidas, o `null` si no es derivable. */
  baseGravada: number | null;
  /** ITBMS / base, a 4 decimales (informativa). */
  tasaImplicita: number | null;
  confianza: 'ALTA' | 'MEDIA' | 'BAJA';
  motivo: string;
  avisos: string[];
  esAnulacion: boolean;
}

function suma(lineas: Linea430[], campo: 'debit' | 'credit'): number {
  let acc = 0;
  for (const l of lineas) acc += Number(l[campo]) || 0;
  return r2s(acc);
}

/** Tasa esperada del ITBMS en Panamá: 7 % general, 10 % licores/hoteles, 15 % tabaco. */
const TASAS_VALIDAS = [0.07, 0.1, 0.15];

function tasaAviso(tasa: number | null): string[] {
  if (tasa === null) return [];
  return TASAS_VALIDAS.some((t) => Math.abs(tasa - t) <= 0.002) ? [] : ['TASA_ATIPICA'];
}

/**
 * Etiqueta de tasa para el desglose: la NOMINAL cuando está dentro de la tolerancia.
 * La base reconstruida arrastra céntimos y sin esto el desglose de compras salía
 * partido en tramos de 6,99 % / 7,01 % / 7,04 % que no significan nada para el contador.
 */
function claveTasa(t: number | null): string {
  if (t === null) return 'sin-tasa';
  const nominal = TASAS_VALIDAS.find((v) => Math.abs(t - v) <= 0.002);
  return `${((nominal ?? t) * 100).toFixed(2)}%`;
}

function invertir(lineas: Linea430[]): Linea430[] {
  return lineas.map((l) => ({ ...l, debit: l.credit, credit: l.debit }));
}

/**
 * Clasifica un asiento según sus contrapartidas. Función PURA (sin Prisma, sin IO)
 * para poder probarla sola: es donde vive el riesgo del informe.
 *
 * Reglas, primera que matchea (ver el plan del 15-10-2026):
 *  R0  reverso de anulación (`ANULACIÓN:`) → se clasifica el asiento INVERTIDO y se
 *      niegan los montos. Sin esto el espejo de una venta cae en COMPRA (tiene un
 *      débito a `2.1.05` y otro débito) y el ITBMS de una venta anulada infla el
 *      crédito fiscal.
 *  R1  COMPENSACION_R52   débito 2.1.05 + crédito 1.1.07
 *  R2  PAGO_DGI           débito 2.1.05 + crédito a efectivo, sin débitos de base
 *  R3  VENTA              crédito 2.1.05 + crédito a INGRESO → débito fiscal
 *  R4  COMPRA             débito 2.1.05 + base GASTO/COSTO/ACTIVO (neta) → crédito fiscal
 *  R5  NOTA_CREDITO_COMPRA crédito 2.1.05 + créditos de base sin INGRESO
 *  R6  AJUSTE             movimiento contra cuentas de balance, fuera de la liquidación
 *  R7  NO_CLASIFICADO     lo demás: NO entra a ningún renglón y fuerza el descuadre
 */
export function clasificarAsiento430(
  lineas: Linea430[],
  ctx: Contexto430,
  opts: { descripcion?: string | null; transactionType?: string | null } = {},
): Clasificacion430 {
  const descripcion = String(opts.descripcion || '');
  const esAnulacion = descripcion.trim().toUpperCase().startsWith('ANULACIÓN:');
  const base = clasificarBase(esAnulacion ? invertir(lineas) : lineas, ctx, opts);

  if (!esAnulacion) return base;
  return {
    ...base,
    debitoItbms: r2s(-base.debitoItbms),
    creditoItbms: r2s(-base.creditoItbms),
    efectoSaldo: r2s(-base.efectoSaldo),
    baseGravada: base.baseGravada === null ? null : r2s(-base.baseGravada),
    esAnulacion: true,
    avisos: [...base.avisos, 'ANULACION'],
  };
}

function clasificarBase(
  lineas: Linea430[],
  ctx: Contexto430,
  opts: { descripcion?: string | null; transactionType?: string | null },
): Clasificacion430 {
  const esItbms = (l: Linea430) => ctx.porPagarIds.has(l.accountId);
  const itbms = lineas.filter(esItbms);
  const otras = lineas.filter((l) => !esItbms(l));

  const debitoItbms = suma(itbms, 'debit');
  const creditoItbms = suma(itbms, 'credit');
  const efectoSaldo = r2s(creditoItbms - debitoItbms);

  const esEfectivo = (l: Linea430) => ctx.codigosEfectivo.has(String(l.code));
  const esBase = (l: Linea430) => ['GASTO', 'COSTO', 'ACTIVO'].includes(String(l.type)) && !esEfectivo(l);

  const avisos: string[] = [];
  const mixto = debitoItbms > TOL && creditoItbms > TOL;
  if (mixto) avisos.push('ASIENTO_MIXTO');

  const debitosBase = suma(otras.filter(esBase), 'debit');
  const creditosBase = suma(otras.filter(esBase), 'credit');
  const creditosIngreso = suma(otras.filter((l) => l.type === 'INGRESO'), 'credit');
  const creditosEfectivo = suma(otras.filter(esEfectivo), 'credit');
  const creditosRetencion = suma(otras.filter((l) => ctx.retenidoIds.has(l.accountId)), 'credit');
  const debitosNoItbms = suma(otras, 'debit');
  const baseCompra = r2s(debitosBase - creditosBase);

  const txType = String(opts.transactionType || '').toUpperCase();

  const conBase = (
    bucket: Bucket430,
    baseGravada: number,
    itbmsDelHecho: number,
    confianza: 'ALTA' | 'MEDIA' | 'BAJA',
    motivo: string,
    extra: string[] = [],
  ): Clasificacion430 => {
    const tasa = baseGravada > TOL ? r4(Math.abs(itbmsDelHecho) / baseGravada) : null;
    const av = [...avisos, ...extra, ...tasaAviso(tasa)];
    return {
      bucket,
      debitoItbms,
      creditoItbms,
      efectoSaldo,
      baseGravada,
      tasaImplicita: tasa,
      confianza,
      motivo,
      avisos: av,
      esAnulacion: false,
    };
  };

  const sinBase = (
    bucket: Bucket430,
    confianza: 'ALTA' | 'MEDIA' | 'BAJA',
    motivo: string,
    extra: string[] = [],
  ): Clasificacion430 => ({
    bucket,
    debitoItbms,
    creditoItbms,
    efectoSaldo,
    baseGravada: null,
    tasaImplicita: null,
    confianza,
    motivo,
    avisos: [...avisos, ...extra],
    esAnulacion: false,
  });

  // ── Reglas del lado VENTA (acredita ITBMS) ──
  const rVenta = (): Clasificacion430 | null => {
    if (creditoItbms <= TOL || creditosIngreso <= TOL) return null;
    return conBase(
      'VENTA',
      creditosIngreso,
      creditoItbms,
      mixto ? 'BAJA' : 'ALTA',
      `acredita 2.1.05 (${creditoItbms.toFixed(2)}) con crédito a cuenta de INGRESO (${creditosIngreso.toFixed(2)})`,
    );
  };
  const rNotaCredito = (): Clasificacion430 | null => {
    if (creditoItbms <= TOL || creditosBase <= TOL) return null;
    if (creditosIngreso > TOL || debitoItbms > TOL) return null;
    return conBase(
      'NOTA_CREDITO_COMPRA',
      creditosBase,
      creditoItbms,
      'MEDIA',
      `acredita 2.1.05 (${creditoItbms.toFixed(2)}) contra créditos de gasto/costo (${creditosBase.toFixed(2)}): devolución a proveedor`,
    );
  };

  // ── Reglas del lado COMPRA / PAGO (debita ITBMS) ──
  const rCompensacion = (): Clasificacion430 | null => {
    if (debitoItbms <= TOL || creditosRetencion <= TOL) return null;
    const extra = Math.abs(debitoItbms - creditosRetencion) > TOL ? ['COMPENSACION_DESCUADRADA'] : [];
    return sinBase(
      'COMPENSACION_R52',
      'ALTA',
      `debita 2.1.05 (${debitoItbms.toFixed(2)}) contra el crédito por retención 1.1.07 (${creditosRetencion.toFixed(2)})`,
      extra,
    );
  };
  const rPago = (): Clasificacion430 | null => {
    if (debitoItbms <= TOL) return null;
    // Marca explícita del chat: gana sobre la forma del asiento.
    if (txType === 'PAGO_ITBMS') {
      const extra = creditosEfectivo <= TOL ? ['PAGO_SIN_CONTRAPARTIDA_EFECTIVO'] : [];
      return sinBase(
        'PAGO_DGI',
        extra.length ? 'MEDIA' : 'ALTA',
        `pago de ITBMS a la DGI (${debitoItbms.toFixed(2)})`,
        extra,
      );
    }
    if (Math.abs(debitosNoItbms) > TOL || creditosEfectivo <= TOL) return null;
    return sinBase(
      'PAGO_DGI',
      'MEDIA',
      `debita 2.1.05 (${debitoItbms.toFixed(2)}) contra efectivo (${creditosEfectivo.toFixed(2)}), sin líneas de gasto: pago a la DGI`,
      ['PAGO_SIN_MARCA'],
    );
  };
  const rCompra = (): Clasificacion430 | null => {
    if (debitoItbms <= TOL) return null;
    // Con base reconstruible gana sobre la forma de pago: un gasto pagado con banco
    // tiene crédito a efectivo y aun así es una compra.
    if (baseCompra > TOL) {
      const extra = creditosBase > TOL ? ['BASE_NETA_DE_CREDITOS'] : [];
      return conBase(
        'COMPRA',
        baseCompra,
        debitoItbms,
        mixto || extra.length ? 'MEDIA' : 'ALTA',
        `debita 2.1.05 (${debitoItbms.toFixed(2)}) con base de gasto/costo/activo (${baseCompra.toFixed(2)})`,
        extra,
      );
    }
    // Compra sin línea de base: el ITBMS se lee igual, la base no se inventa.
    if (txType === 'GASTO' || txType === 'COMPRA') {
      return sinBase(
        'COMPRA',
        'MEDIA',
        `debita 2.1.05 (${debitoItbms.toFixed(2)}) con marca de ${txType} pero sin línea de base`,
        ['BASE_NO_DERIVABLE'],
      );
    }
    return null;
  };

  // R6: movimiento contra cuentas de balance, sin gasto ni ingreso → ajuste.
  // Se mira el TIPO de la contrapartida, no «hay líneas de base»: una compensación
  // contra Clientes (ACTIVO) tiene crédito de base y aun así no es una compra.
  const rAjuste = (): Clasificacion430 | null => {
    const tieneGastoOCosto = otras.some((l) => ['GASTO', 'COSTO'].includes(String(l.type)) && l.debit > TOL);
    if (tieneGastoOCosto || creditosIngreso > TOL) return null;
    const contrapartidaBalance = otras.find(
      (l) =>
        ['ACTIVO', 'PASIVO', 'PATRIMONIO'].includes(String(l.type)) &&
        !esEfectivo(l) &&
        !ctx.retenidoIds.has(l.accountId) &&
        (l.debit > TOL || l.credit > TOL),
    );
    if (!contrapartidaBalance) return null;
    return sinBase(
      'AJUSTE',
      'BAJA',
      `movimiento a 2.1.05 contra ${contrapartidaBalance.code} ${contrapartidaBalance.name}: no es venta, compra ni pago`,
    );
  };

  // Con asiento mixto (debita y acredita 2.1.05 a la vez) manda el signo del neto.
  // El orden importa: la marca del chat (`PAGO_ITBMS`) y la base reconstruible van
  // ANTES que la forma de pago, para que un gasto pagado con banco no se lea como
  // pago a la DGI.
  const ventaPrimero = !mixto || efectoSaldo > 0;
  const orden = ventaPrimero
    ? [rVenta, rNotaCredito, rCompensacion, rCompra, rPago, rAjuste]
    : [rCompensacion, rCompra, rPago, rAjuste, rVenta, rNotaCredito];

  for (const regla of orden) {
    const r = regla();
    if (r) {
      if (mixto) {
        r.confianza = 'BAJA';
        if (!r.avisos.includes('CLASIFICACION_AMBIGUA')) r.avisos.push('CLASIFICACION_AMBIGUA');
      }
      return r;
    }
  }

  // R7: no se pudo clasificar. Se dice QUÉ contrapartidas tenía, no se adivina.
  const contrapartidas = otras
    .filter((l) => l.debit > TOL || l.credit > TOL)
    .map((l) => `${l.code} ${l.name}`.trim())
    .slice(0, 4)
    .join(', ');
  return sinBase(
    'NO_CLASIFICADO',
    'BAJA',
    `movimiento a 2.1.05 (${efectoSaldo.toFixed(2)}) que no es venta, compra, pago ni compensación${contrapartidas ? `; contrapartidas: ${contrapartidas}` : ''}`,
  );
}

// ───────────────────────────── Informe ─────────────────────────────

export interface Borrador430Opciones {
  year: number;
  mes: number;
}

export interface Renglon430 {
  id: string;
  etiqueta: string;
  monto: number;
  signo: 1 | -1;
  asientos: number;
  detalle?: string;
}

export interface Detalle430 {
  journalEntryId: string;
  fecha: string;
  descripcion: string;
  status: string;
  clasificacion: Bucket430;
  motivo: string;
  confianza: 'ALTA' | 'MEDIA' | 'BAJA';
  debitoItbms: number;
  creditoItbms: number;
  efectoSaldo: number;
  baseGravada: number | null;
  tasaImplicita: number | null;
  esAnulacion: boolean;
  avisos: string[];
  origen: EntryOrigin | null;
}

export interface Aviso430 {
  nivel: 'error' | 'warn' | 'info';
  codigo: string;
  mensaje: string;
}

export interface Borrador430 {
  periodo: {
    year: number;
    mes: number;
    label: string;
    start: string;
    end: string;
    vence: string;
    anioFiscal: number;
  };
  cuentas: {
    porPagar: Cuenta430[];
    retenidoTerceros: Cuenta430 | null;
  };
  incluyeBorradores: boolean;
  /** Literal a propósito: este documento NO es una declaración presentada. */
  esDeclaracion: false;
  renglones: Renglon430[];
  bases: {
    ventasGravadas: number;
    comprasGravadas: number;
    ventasPorTasa: Record<string, number>;
    comprasPorTasa: Record<string, number>;
    ventasSinBaseDerivable: number;
    comprasSinBaseDerivable: number;
    nota: string;
  };
  liquidacion: {
    debitoFiscal: number;
    creditoFiscal: number;
    sinRetenciones: number;
    renglon52: number;
    aPagarMes: number;
    saldoAnterior: number;
    pagosDelMes: number;
    compensacionesDelMes: number;
    totalAPagar: number;
    saldoAFavor: boolean;
    /**
     * Regla confirmada por el contador (15-10-2026): el saldo a favor NO se pide en
     * devolución, **se arrastra al mes siguiente**. El informe ya la aplica —el mes
     * siguiente lo recibe como `saldoAnterior`— y la deja dicha en los datos para
     * cuando se construya la declaración (decisión D2 de `Tuning.md` §4.1).
     */
    reglaSaldoAFavor: 'ARRASTRE';
    diferenciaVsMayor: number;
  };
  saldoAnterior: { monto: number; al: string; saldoAFavor: boolean };
  retenciones: {
    delMes: number;
    registrosDelMes: number;
    disponibles: number;
    aplicadasAcumuladas: number;
    pendienteCertificado: number;
    detalle: Array<{
      id: string;
      fecha: string;
      cliente: string;
      numeroCertificado: string | null;
      estado: string;
      baseGravada: number;
      itbmsFacturado: number;
      montoRetencion: number;
    }>;
  };
  detalle: Detalle430[];
  noClasificados: Detalle430[];
  cuadre: {
    movimientoLibroMes: number;
    sumaDeBuckets: number;
    diferencia: number;
    saldoAnteriorContado: number;
    saldoFinalContado: number;
    saldoFinalRecalculado: number;
    ajustesExcluidos: number;
    lineas: number;
    asientos: number;
    lineasNoClasificadas: number;
    asientosBorrador: number;
    cuadra: boolean;
    criterio: string;
    noIncluidos: { isClosing: number };
  };
  avisos: Aviso430[];
}

/**
 * Construye el borrador del 430 para un mes. Solo lectura.
 *
 * `anioFiscal` se recibe ya resuelto por la ruta (`getAnioFiscal`) para no repetir
 * la consulta dentro del servicio.
 */
export async function buildBorrador430(
  prisma: any,
  companyId: string,
  opciones: Borrador430Opciones,
  anioFiscal: number,
): Promise<Borrador430> {
  const { year, mes } = opciones;
  const { start, endExclusive, end, vence } = rangoMes(year, mes);
  const ctx = await resolverCuentas430(prisma, companyId);
  const ids = [...ctx.porPagarIds];

  const avisos: Aviso430[] = [];
  const filtroAsiento = {
    companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] },
    isClosing: false,
  };

  // 1) Líneas de 2.1.05 del mes → asientos del informe.
  const lineasMes: Array<{ journalEntryId: string; debit: number; credit: number }> = ids.length
    ? await prisma.journalLine.findMany({
        where: { accountId: { in: ids }, journalEntry: { ...filtroAsiento, date: { gte: start, lt: endExclusive } } },
        select: { journalEntryId: true, debit: true, credit: true },
      })
    : [];

  const entryIds = [...new Set(lineasMes.map((l) => l.journalEntryId))];
  const movimientoLibroMes = r2s(
    lineasMes.reduce((s, l) => s + (r2s(l.credit) - r2s(l.debit)), 0),
  );

  // 2) Asientos completos (para clasificar contra sus contrapartidas), su Transaction
  //    (marca de tipo), los saldos de arrastre/cierre y las retenciones.
  const [entries, txs, prevAgg, finAgg, cierreLineas, retenciones] = await Promise.all([
    entryIds.length
      ? prisma.journalEntry.findMany({
          where: { id: { in: entryIds } },
          include: { lines: { include: { account: { select: { id: true, code: true, name: true, type: true } } } } },
          orderBy: { date: 'asc' },
        })
      : [],
    entryIds.length
      ? prisma.transaction.findMany({
          where: { journalEntryId: { in: entryIds } },
          select: { journalEntryId: true, type: true },
        })
      : [],
    ids.length
      ? prisma.journalLine.aggregate({
          _sum: { debit: true, credit: true },
          where: { accountId: { in: ids }, journalEntry: { ...filtroAsiento, date: { lt: start } } },
        })
      : null,
    ids.length
      ? prisma.journalLine.aggregate({
          _sum: { debit: true, credit: true },
          where: { accountId: { in: ids }, journalEntry: { ...filtroAsiento, date: { lt: endExclusive } } },
        })
      : null,
    ids.length
      ? prisma.journalLine.count({
          where: { accountId: { in: ids }, journalEntry: { companyId, isClosing: true, date: { gte: start, lt: endExclusive } } },
        })
      : 0,
    prisma.retentionItbms.findMany({
      where: { companyId },
      select: {
        id: true,
        fecha: true,
        estado: true,
        montoRetencion: true,
        baseGravada: true,
        itbmsFacturado: true,
        numeroCertificado: true,
        client: { select: { name: true } },
      },
      orderBy: { fecha: 'asc' },
    }),
  ]);

  if (ids.length === 0) {
    avisos.push({
      nivel: 'error',
      codigo: 'SIN_CUENTA_ITBMS',
      mensaje: 'No se encontró la cuenta ITBMS por Pagar (código 2.1.05 o alias itbms-por-pagar) en el catálogo de esta empresa: el informe no puede calcular nada.',
    });
  }
  if (!ctx.retenido) {
    avisos.push({
      nivel: 'warn',
      codigo: 'CUENTA_RETENCION_NO_RESUELTA',
      mensaje: 'No se encontró la cuenta de ITBMS Retenido por Terceros (1.1.07): las compensaciones del renglón 52 quedarán sin clasificar.',
    });
  }
  if (cierreLineas > 0) {
    avisos.push({
      nivel: 'warn',
      codigo: 'CIERRE_EN_2.1.05',
      mensaje: `Hay ${cierreLineas} línea(s) de asientos de cierre de año en la cuenta de ITBMS de este mes; se excluyen del informe (el cierre no debe tocar esa cuenta).`,
    });
  }

  const tipoPorAsiento = new Map<string, string>();
  for (const t of txs) {
    if (t.journalEntryId && !tipoPorAsiento.has(t.journalEntryId)) tipoPorAsiento.set(t.journalEntryId, String(t.type || ''));
  }

  // 3) Clasificación asiento por asiento.
  const detalle: Detalle430[] = [];
  const noClasificados: Detalle430[] = [];
  let debitoFiscal = 0;
  let creditoFiscal = 0;
  let notasCreditoCompra = 0;
  let pagosDgi = 0;
  let compensacionesR52 = 0;
  let ajustes = 0;
  let noClasificadoMonto = 0;
  let lineasNoClasificadas = 0;
  let asientosConItbms = 0;
  let asientosBorrador = 0;
  let asientosVenta = 0;
  let asientosCompra = 0;
  let asientosPago = 0;
  let asientosCompensacion = 0;
  let asientosAjuste = 0;
  let ventasSinBaseDerivable = 0;
  let comprasSinBaseDerivable = 0;
  let ventasGravadas = 0;
  let comprasGravadas = 0;
  const ventasPorTasa = new Map<string, number>();
  const comprasPorTasa = new Map<string, number>();
  const avisosDetalle = new Set<string>();
  const reversiones: string[] = [];

  for (const e of entries) {
    const lineas: Linea430[] = (e.lines || []).map((l: any) => ({
      accountId: l.accountId,
      code: String(l.account?.code || ''),
      name: String(l.account?.name || ''),
      type: String(l.account?.type || ''),
      debit: r2s(l.debit),
      credit: r2s(l.credit),
    }));
    if (!lineas.some((l) => ctx.porPagarIds.has(l.accountId))) continue;

    const c = clasificarAsiento430(lineas, ctx, {
      descripcion: e.description,
      transactionType: tipoPorAsiento.get(e.id) || null,
    });

    asientosConItbms++;
    if (e.status === 'BORRADOR') asientosBorrador++;
    for (const a of c.avisos) avisosDetalle.add(a);
    if (c.esAnulacion) reversiones.push(e.id);

    let origen: EntryOrigin | null = null;
    try {
      origen = await resolveEntryOrigin(prisma, companyId, e);
    } catch {
      origen = null; // el origen es informativo: nunca tumba el informe
    }

    const fila: Detalle430 = {
      journalEntryId: e.id,
      fecha: fechaLocalISO(e.date),
      descripcion: String(e.description || ''),
      status: String(e.status || ''),
      clasificacion: c.bucket,
      motivo: c.motivo,
      confianza: c.confianza,
      debitoItbms: c.debitoItbms,
      creditoItbms: c.creditoItbms,
      efectoSaldo: c.efectoSaldo,
      baseGravada: c.baseGravada,
      tasaImplicita: c.tasaImplicita,
      esAnulacion: c.esAnulacion,
      avisos: c.avisos,
      origen,
    };
    detalle.push(fila);

    switch (c.bucket) {
      case 'VENTA': {
        asientosVenta++;
        debitoFiscal = r2s(debitoFiscal + c.creditoItbms);
        if (c.baseGravada === null) ventasSinBaseDerivable++;
        else {
          ventasGravadas = r2s(ventasGravadas + c.baseGravada);
          const k = claveTasa(c.tasaImplicita);
          ventasPorTasa.set(k, r2s((ventasPorTasa.get(k) || 0) + c.baseGravada));
        }
        break;
      }
      case 'COMPRA': {
        asientosCompra++;
        creditoFiscal = r2s(creditoFiscal + c.debitoItbms);
        if (c.baseGravada === null) comprasSinBaseDerivable++;
        else {
          comprasGravadas = r2s(comprasGravadas + c.baseGravada);
          const k = claveTasa(c.tasaImplicita);
          comprasPorTasa.set(k, r2s((comprasPorTasa.get(k) || 0) + c.baseGravada));
        }
        break;
      }
      case 'NOTA_CREDITO_COMPRA': {
        asientosCompra++;
        notasCreditoCompra = r2s(notasCreditoCompra + c.creditoItbms);
        if (c.baseGravada === null) comprasSinBaseDerivable++;
        else comprasGravadas = r2s(comprasGravadas - c.baseGravada);
        break;
      }
      case 'PAGO_DGI': {
        asientosPago++;
        pagosDgi = r2s(pagosDgi + c.debitoItbms);
        break;
      }
      case 'COMPENSACION_R52': {
        asientosCompensacion++;
        compensacionesR52 = r2s(compensacionesR52 + c.debitoItbms);
        break;
      }
      case 'AJUSTE': {
        asientosAjuste++;
        ajustes = r2s(ajustes + c.efectoSaldo);
        break;
      }
      default: {
        noClasificadoMonto = r2s(noClasificadoMonto + c.efectoSaldo);
        lineasNoClasificadas += (e.lines || []).filter((l: any) => ctx.porPagarIds.has(l.accountId)).length;
        noClasificados.push(fila);
        break;
      }
    }
  }

  // 4) Saldos y cuadre. El cuadre compara DOS caminos independientes al mismo
  //    número: el movimiento del mes leído línea a línea contra el arrastre
  //    agregado por separado (date < inicio / date < fin del mes).
  const saldoAnteriorContado = r2s(
    (Number(prevAgg?._sum?.credit) || 0) - (Number(prevAgg?._sum?.debit) || 0),
  );
  const saldoFinalContado = r2s(
    (Number(finAgg?._sum?.credit) || 0) - (Number(finAgg?._sum?.debit) || 0),
  );
  const saldoFinalRecalculado = r2s(saldoAnteriorContado + movimientoLibroMes);
  const sumaDeBuckets = r2s(
    detalle.reduce((s, d) => s + d.efectoSaldo, 0),
  );
  const diferencia = r2s(sumaDeBuckets - movimientoLibroMes);
  const diferenciaSaldos = r2s(saldoFinalRecalculado - saldoFinalContado);
  const cuadra =
    Math.abs(diferencia) <= TOL && Math.abs(diferenciaSaldos) <= TOL && noClasificados.length === 0;

  // 5) Retenciones (crédito del renglón 52). Misma semántica que `resumen-r52`:
  //    RECIBIDA = con certificado y sin compensar (lo aplicable); APLICADA ya está
  //    en el mayor como débito a 2.1.05, así que restarla otra vez sería contarla dos veces.
  const retEnMes = retenciones.filter(
    (r: any) => String(r.estado) !== 'ANULADA' && r.fecha >= start && r.fecha < endExclusive,
  );
  const retDisponibles = retenciones.filter((r: any) => String(r.estado) === 'RECIBIDA' && r.fecha < endExclusive);
  const retPendientes = retenciones.filter((r: any) => String(r.estado) === 'PENDIENTE' && r.fecha < endExclusive);
  const retAplicadas = retenciones.filter((r: any) => String(r.estado) === 'APLICADA');

  const delMes = r2s(retEnMes.reduce((s: number, r: any) => s + (Number(r.montoRetencion) || 0), 0));
  const disponibles = r2s(retDisponibles.reduce((s: number, r: any) => s + (Number(r.montoRetencion) || 0), 0));
  const pendienteCertificado = r2s(retPendientes.reduce((s: number, r: any) => s + (Number(r.montoRetencion) || 0), 0));
  const aplicadasAcumuladas = r2s(retAplicadas.reduce((s: number, r: any) => s + (Number(r.montoRetencion) || 0), 0));

  // 6) Liquidación. Todo sobre valores ya redondeados a céntimos: cuadra por construcción.
  const creditoFiscalNeto = r2s(creditoFiscal - notasCreditoCompra);
  const sinRetenciones = r2s(debitoFiscal - creditoFiscalNeto);
  const aPagarMes = r2s(sinRetenciones - disponibles);
  const totalAPagar = r2s(r2s(saldoAnteriorContado + aPagarMes) - r2s(pagosDgi + compensacionesR52));
  const diferenciaVsMayor = r2s(totalAPagar - r2s(saldoFinalContado - disponibles));

  if (asientosBorrador > 0) {
    avisos.push({
      nivel: 'warn',
      codigo: 'BORRADORES_INCLUIDOS',
      mensaje: `${asientosBorrador} de ${asientosConItbms} asientos con ITBMS están en BORRADOR (sin aprobar). El ITBMS que se debe no depende de que el contador haya pasado por la cola, pero este borrador no es una declaración.`,
    });
  }
  if (noClasificados.length > 0) {
    avisos.push({
      nivel: 'error',
      codigo: 'SIN_CLASIFICAR',
      mensaje: `${noClasificados.length} asiento(s) con movimiento en la cuenta de ITBMS no se pudieron clasificar (${noClasificadoMonto.toFixed(2)} de efecto en el saldo). No entran en ningún renglón: revísalos antes de usar el borrador.`,
    });
  }
  if (ventasSinBaseDerivable + comprasSinBaseDerivable > 0) {
    avisos.push({
      nivel: 'warn',
      codigo: 'BASE_NO_DERIVABLE',
      mensaje: `${ventasSinBaseDerivable + comprasSinBaseDerivable} asiento(s) tienen ITBMS pero su base gravada no se pudo reconstruir del asiento (se muestra «—», no cero). El impuesto sí está contado.`,
    });
  }
  if (avisosDetalle.has('ASIENTO_MIXTO')) {
    avisos.push({
      nivel: 'warn',
      codigo: 'ASIENTO_MIXTO',
      mensaje: 'Hay asientos que debitan y acreditan la cuenta de ITBMS a la vez: se clasificaron por el neto, revisa su detalle.',
    });
  }
  if (avisosDetalle.has('TASA_ATIPICA')) {
    avisos.push({
      nivel: 'info',
      codigo: 'TASA_ATIPICA',
      mensaje: 'Hay asientos cuya tasa implícita (ITBMS / base) no es 7 %, 10 % ni 15 %: puede ser una base mal reconstruida o una tasa distinta.',
    });
  }
  if (avisosDetalle.has('ANULACION')) {
    avisos.push({
      nivel: 'info',
      codigo: 'ANULACIONES',
      mensaje: 'Este mes incluye reversos de anulación (fechados el día de la corrección). El asiento original sigue contando en su propio mes; el reverso lo netea desde este.',
    });
  }
  if (reversiones.length > 0) {
    const originales = await prisma.journalEntry.findMany({
      where: { anuladoPorId: { in: reversiones } },
      select: { id: true, date: true },
    });
    const deOtroMes = originales.filter((o: any) => o.date < start);
    if (deOtroMes.length > 0) {
      avisos.push({
        nivel: 'warn',
        codigo: 'ANULACION_DE_OTRO_MES',
        mensaje: `${deOtroMes.length} reverso(s) de este mes anulan asientos de meses anteriores: el mes anterior no se reescribe, la corrección entra aquí.`,
      });
    }
  }

  const renglones: Renglon430[] = [
    { id: 'debitoFiscal', etiqueta: 'Débito fiscal (ITBMS de ventas)', monto: debitoFiscal, signo: 1, asientos: asientosVenta },
    { id: 'creditoFiscal', etiqueta: 'Crédito fiscal (ITBMS de compras y gastos)', monto: creditoFiscalNeto, signo: -1, asientos: asientosCompra },
    { id: 'renglon52', etiqueta: 'Retenciones sufridas por aplicar (R52)', monto: disponibles, signo: -1, asientos: retDisponibles.length },
    { id: 'pagosDgi', etiqueta: 'Pagos a la DGI ya registrados', monto: pagosDgi, signo: -1, asientos: asientosPago },
    { id: 'compensacionesR52', etiqueta: 'Compensaciones R52 ya contabilizadas', monto: compensacionesR52, signo: -1, asientos: asientosCompensacion },
    { id: 'ajustes', etiqueta: 'Ajustes de la cuenta de ITBMS (fuera de la liquidación)', monto: ajustes, signo: 1, asientos: asientosAjuste },
    { id: 'noClasificado', etiqueta: 'Movimientos sin clasificar', monto: noClasificadoMonto, signo: 1, asientos: noClasificados.length },
  ];

  const porTasaAObjeto = (m: Map<string, number>) => Object.fromEntries([...m.entries()].sort());

  return {
    periodo: {
      year,
      mes,
      label: `${MESES_430[mes - 1]} ${year}`,
      start: fechaLocalISO(start),
      end: fechaLocalISO(end),
      vence: fechaLocalISO(vence),
      anioFiscal,
    },
    cuentas: { porPagar: ctx.porPagar, retenidoTerceros: ctx.retenido },
    incluyeBorradores: asientosBorrador > 0,
    esDeclaracion: false,
    renglones,
    bases: {
      ventasGravadas,
      comprasGravadas,
      ventasPorTasa: porTasaAObjeto(ventasPorTasa),
      comprasPorTasa: porTasaAObjeto(comprasPorTasa),
      ventasSinBaseDerivable,
      comprasSinBaseDerivable,
      nota: 'Solo movimientos que pasaron por la cuenta de ITBMS. Las ventas exentas no aparecen aquí porque no tocan esa cuenta: «base» es base GRAVADA, no venta total.',
    },
    liquidacion: {
      debitoFiscal,
      creditoFiscal: creditoFiscalNeto,
      sinRetenciones,
      renglon52: disponibles,
      aPagarMes,
      saldoAnterior: saldoAnteriorContado,
      pagosDelMes: pagosDgi,
      compensacionesDelMes: compensacionesR52,
      totalAPagar,
      saldoAFavor: totalAPagar < -TOL,
      reglaSaldoAFavor: 'ARRASTRE',
      diferenciaVsMayor,
    },
    saldoAnterior: {
      monto: saldoAnteriorContado,
      al: fechaLocalISO(start),
      saldoAFavor: saldoAnteriorContado < -TOL,
    },
    retenciones: {
      delMes,
      registrosDelMes: retEnMes.length,
      disponibles,
      aplicadasAcumuladas,
      pendienteCertificado,
      detalle: retEnMes.map((r: any) => ({
        id: r.id,
        fecha: fechaLocalISO(r.fecha),
        cliente: String(r.client?.name || ''),
        numeroCertificado: r.numeroCertificado || null,
        estado: String(r.estado || ''),
        baseGravada: r2s(r.baseGravada),
        itbmsFacturado: r2s(r.itbmsFacturado),
        montoRetencion: r2s(r.montoRetencion),
      })),
    },
    detalle,
    noClasificados,
    cuadre: {
      movimientoLibroMes,
      sumaDeBuckets,
      diferencia,
      saldoAnteriorContado,
      saldoFinalContado,
      saldoFinalRecalculado,
      ajustesExcluidos: ajustes,
      lineas: lineasMes.length,
      asientos: asientosConItbms,
      lineasNoClasificadas,
      asientosBorrador,
      cuadra,
      criterio:
        'Asientos sin RECHAZADO/ANULADO, sin cierre de año, del mes en hora local. Incluye BORRADOR (decisión del 15-10-2026). El cuadre compara el movimiento del mes con el arrastre agregado por separado; los ajustes de balance quedan fuera de la liquidación a propósito.',
      noIncluidos: { isClosing: cierreLineas },
    },
    avisos,
  };
}
