// Salud financiera: ratios, proyección de caja 3 meses y narrativa IA (fallback sin LLM).
// Patrón de servicio puro como services/tax-calendar.ts: funciones que reciben (prisma, companyId).
import OpenAI from 'openai';
import { codigosEfectivo } from '../lib/cuentas-efectivo';
import { getAnioFiscal } from '../lib/fiscal-year';
import { buildBudgetComparison, mesDeComparacion } from './budget-comparison';
import type { BudgetComparison } from './budget-comparison';
import { calculateNextRun } from './recurring-processor';
import { obligacionesProyectadas } from './tax-calendar';

// ── Tipos de respuesta ──
export interface SaludAlerta {
  tipo: 'LIQUIDEZ' | 'ENDEUDAMIENTO' | 'MARGEN' | 'DSO' | 'DPO' | 'FLUJO_NEGATIVO' | 'OBLIGACION_PROXIMA' | 'CXC_VENCIDA' | 'CXP_VENCIDA' | 'PRESUPUESTO';
  severidad: 'info' | 'warning' | 'critical';
  mensaje: string;
  /** Mes 'YYYY-MM' al que se refiere, cuando la alerta es de un mes concreto de la proyección. */
  mes?: string;
}

/** Horizontes de proyección ofrecidos por el panel. */
export type HorizonteMeses = 3 | 6 | 12;
/** El orden es el del selector del panel. */
export const HORIZONTES: readonly HorizonteMeses[] = [3, 6, 12];
const HORIZONTE_DEFECTO: HorizonteMeses = 3;
/** Se computa siempre a este horizonte y se recorta al pedido. */
const HORIZONTE_MAX: HorizonteMeses = 12;
/**
 * El score se mide siempre sobre los 3 primeros meses, aunque se pidan 12: es el
 * número de cabecera y no debe moverse porque el usuario cambie el rango de la
 * proyección. Es seguro porque los 3 primeros meses no dependen del horizonte.
 */
const MESES_SCORE = 3;

/** Normaliza el parámetro `meses`: cualquier valor que no sea 3/6/12 cae al default, sin error. */
export function normalizarMeses(raw: unknown): HorizonteMeses {
  const n = Number(raw);
  return n === 6 || n === 12 ? n : HORIZONTE_DEFECTO;
}

export interface Ratios {
  liquidez: number | null;
  pruebaAcida: number | null;
  capitalTrabajo: number | null;
  endeudamiento: number | null;
  deudaPatrimonio: number | null;
  margenNeto: number | null;
  margenBruto: number | null;
  roe: number | null;
  dso: number | null;
  dpo: number | null;
  deltas: { margenNeto: number | null; ingresos: number; gastos: number };
}

/** Score consolidado 0-100 por categoría + global con nivel. */
export interface ScoreSalud {
  liquidez: number;
  rentabilidad: number;
  endeudamiento: number;
  eficiencia: number;
  flujo: number;
  global: number;
  nivel: 'EXCELENTE' | 'BUENO' | 'REGULAR' | 'CRITICO';
}

export interface ProyeccionMes {
  month: string;
  label: string;
  entradas: number;
  salidas: number;
  saldoFinal: number;
  /** Cuánto de `salidas` son obligaciones fiscales (informativo). */
  fiscal: number;
  /** true = el fiscal de este mes se extrapoló: el calendario solo mantiene 3 meses en BD. */
  fiscalEstimado: boolean;
}

export interface Narrativa { resumen: string; alertas: string[]; recomendaciones: string[]; }

export interface SaludPayload {
  fecha: string;
  generadoA: string;
  sinDatos: boolean;
  ratios: Ratios | null;
  score: ScoreSalud | null;
  monthly: { month: string; ingresos: number; gastos: number; costos: number; neto: number }[];
  caja: { saldoActual: number };
  proyeccion: ProyeccionMes[];
  alertas: SaludAlerta[];
  narrativa: Narrativa | null;
  iaDisponible: boolean;
  /** Horizonte efectivamente devuelto en `proyeccion`. */
  horizonte: HorizonteMeses;
}

// ── Caché en memoria del proceso (PM2, proceso único). Se limpia al reiniciar la API.
// Bypass: GET /api/salud?refresh=1
const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  /** El payload se guarda SIEMPRE con la proyección al horizonte máximo; se recorta al responder. */
  payload: SaludPayload;
  /** Narrativa memoizada por horizonte: el texto nombra meses concretos, no es reusable entre rangos. */
  narrativas: Map<HorizonteMeses, Narrativa | null>;
  ts: number;
}
const CACHE = new Map<string, CacheEntry>();

const r2 = (n: number) => Math.round(n * 100) / 100;
const fmtMoney = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getLLMClient(): OpenAI | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key, baseURL: 'https://api.deepseek.com' });
}

export async function getSaludFinanciera(
  prisma: any,
  companyId: string,
  opts: { refresh?: boolean; meses?: HorizonteMeses } = {},
): Promise<SaludPayload> {
  const meses = opts.meses ?? HORIZONTE_DEFECTO;

  let entry = CACHE.get(companyId);
  if (opts.refresh || !entry || Date.now() - entry.ts >= CACHE_TTL_MS) {
    entry = { payload: await computeSalud(prisma, companyId), narrativas: new Map(), ts: Date.now() };
    CACHE.set(companyId, entry);
  }

  // Un solo cálculo (y un solo entry de caché) sirve a los tres horizontes: se
  // recorta acá en vez de cachear por horizonte, que repetiría la consulta pesada
  // y —peor— movería el score al cambiar el selector.
  const proyeccion = entry.payload.proyeccion.slice(0, meses);
  const visibles = new Set(proyeccion.map(p => p.month));
  const payload: SaludPayload = {
    ...entry.payload,
    horizonte: meses,
    proyeccion,
    // Solo se recortan las alertas atadas a un mes de la proyección. Las de ratios,
    // fiscales y CxC/CxP no dependen del rango y se muestran siempre.
    alertas: entry.payload.alertas.filter(a => !a.mes || visibles.has(a.mes)),
    narrativa: null,
    iaDisponible: false,
  };

  if (!payload.sinDatos) {
    if (!entry.narrativas.has(meses)) {
      entry.narrativas.set(meses, await generateNarrativa(payload));
    }
    payload.narrativa = entry.narrativas.get(meses) ?? null;
    payload.iaDisponible = payload.narrativa !== null;
  }

  return payload;
}

async function computeSalud(prisma: any, companyId: string): Promise<SaludPayload> {
  const now = new Date();
  const start6 = new Date(now.getFullYear(), now.getMonth() - 5, 1); // 1er día de hace 5 meses = 6 meses de ventana
  const jan1 = new Date(now.getFullYear(), 0, 1);

  // Pasada principal: TODO el libro (sin ventana) — balance, caja y ratios son acumulativos.
  // La ventana de 6 meses solo aplica al chart mensual (ver abajo).
  const lines = await prisma.journalLine.findMany({
    where: {
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
      },
    },
    include: { account: true, journalEntry: { select: { date: true } } },
  });

  const payload: SaludPayload = {
    fecha: now.toISOString().split('T')[0],
    generadoA: now.toISOString(),
    sinDatos: lines.length === 0,
    ratios: null,
    score: null,
    monthly: [],
    caja: { saldoActual: 0 },
    proyeccion: [],
    alertas: [],
    narrativa: null,
    iaDisponible: false,
    horizonte: HORIZONTE_DEFECTO, // getSaludFinanciera lo sobreescribe con el pedido
  };
  if (payload.sinDatos) return payload;

  // Balances por cuenta (debit - credit) con lógica de signos de balance-general
  const byAccount = new Map<string, { code: string; type: string; balance: number }>();
  for (const l of lines) {
    const a = l.account;
    if (!a) continue;
    const cur = byAccount.get(a.id) || { code: a.code, type: a.type, balance: 0 };
    cur.balance += (l.debit || 0) - (l.credit || 0);
    byAccount.set(a.id, cur);
  }

  // Efectivo = Caja 1.1.01 + Bancos 1.1.02 + alias (lib/cuentas-efectivo.ts, el
  // mismo criterio del flujo de caja). Antes era solo el prefijo '1.1.01', y en
  // producción esa cuenta está vacía: el saldo arrancaba en 0 y la proyección mentía.
  const codigosCaja = await codigosEfectivo(prisma, companyId);

  let activoCorriente = 0, activoTotal = 0, pasivoCorriente = 0, pasivoTotal = 0, caja = 0, inventario = 0;
  for (const { code, type, balance } of byAccount.values()) {
    if (type === 'ACTIVO') {
      activoTotal += balance;
      if (/^1\.1\./.test(code)) activoCorriente += balance;
      if (codigosCaja.has(code)) caja += balance;
      if (code.startsWith('1.1.04')) inventario += balance;
    } else if (type === 'PASIVO') {
      pasivoTotal += -balance; // saldo acreedor → pasivo positivo
      if (/^2\.1\./.test(code)) pasivoCorriente += -balance;
    }
  }
  // Patrimonio por la ecuación: Activos = Pasivos + Patrimonio (robusto ante
  // resultados flotando o cerrados — el cierre anual ya los traslada a 3.03)
  const patrimonio = activoTotal - pasivoTotal;

  // P&L YTD (desde 1 de enero) para margen, DSO y DPO — derivado del mismo set
  let ingresosYTD = 0, costosYTD = 0, gastosCostosYTD = 0;
  for (const l of lines) {
    if (new Date(l.journalEntry.date) < jan1) continue;
    if (l.account.type === 'INGRESO') ingresosYTD += (l.credit || 0) - (l.debit || 0);
    else if (l.account.type === 'COSTO') { const v = (l.debit || 0) - (l.credit || 0); costosYTD += v; gastosCostosYTD += v; }
    else if (l.account.type === 'GASTO') gastosCostosYTD += (l.debit || 0) - (l.credit || 0);
  }

  // CxC / CxP pendientes (patrón clients.ts/suppliers.ts)
  const cxcAgg = await prisma.invoice.aggregate({
    _sum: { total: true },
    where: { companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] } },
  });
  const cxpAgg = await prisma.bill.aggregate({
    _sum: { total: true },
    where: { companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] } },
  });
  const cxc = cxcAgg._sum.total || 0;
  const cxp = cxpAgg._sum.total || 0;
  const diasYTD = Math.max(1, Math.floor((now.getTime() - jan1.getTime()) / 86400000));

  const utilidadYTD = ingresosYTD - gastosCostosYTD;
  const ratios: Ratios = {
    liquidez: pasivoCorriente > 0 ? r2(activoCorriente / pasivoCorriente) : null,
    pruebaAcida: pasivoCorriente > 0 ? r2((activoCorriente - inventario) / pasivoCorriente) : null,
    capitalTrabajo: r2(activoCorriente - pasivoCorriente),
    endeudamiento: activoTotal > 0 ? r2((pasivoTotal / activoTotal) * 100) : null,
    deudaPatrimonio: patrimonio > 0 ? r2(pasivoTotal / patrimonio) : null,
    margenNeto: ingresosYTD > 0 ? r2((utilidadYTD / ingresosYTD) * 100) : null,
    margenBruto: ingresosYTD > 0 ? r2(((ingresosYTD - costosYTD) / ingresosYTD) * 100) : null,
    roe: patrimonio > 0 ? r2((utilidadYTD / patrimonio) * 100) : null,
    // DSO/DPO con tope de 365 días: si CxC/CxP es acumulada pero el YTD es
    // ínfimo (año recién iniciado), el ratio sería absurdo → null.
    dso: ingresosYTD > 0 ? Math.min(365, Math.round((cxc / ingresosYTD) * diasYTD)) : null,
    dpo: gastosCostosYTD > 0 ? Math.min(365, Math.round((cxp / gastosCostosYTD) * diasYTD)) : null,
    deltas: { margenNeto: null, ingresos: 0, gastos: 0 },
  };

  // Monthly 6 meses (bucketing del dashboard de reports.ts)
  const monthlyMap = new Map<string, { ingresos: number; gastos: number; costos: number; neto: number }>();
  const monthKey = (d: Date) => d.toISOString().slice(0, 7);
  for (let i = 0; i < 6; i++) {
    const m = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1);
    monthlyMap.set(monthKey(m), { ingresos: 0, gastos: 0, costos: 0, neto: 0 });
  }
  for (const l of lines) {
    const d = new Date(l.journalEntry.date);
    if (d < start6) continue; // solo la ventana de 6 meses alimenta el chart mensual
    const key = monthKey(d);
    const b = monthlyMap.get(key);
    if (!b) continue;
    if (l.account.type === 'INGRESO') { const v = (l.credit || 0) - (l.debit || 0); b.ingresos += v; b.neto += v; }
    else if (l.account.type === 'GASTO') { const v = (l.debit || 0) - (l.credit || 0); b.gastos += v; b.neto -= v; }
    else if (l.account.type === 'COSTO') { const v = (l.debit || 0) - (l.credit || 0); b.costos += v; b.neto -= v; }
  }
  payload.monthly = [...monthlyMap.entries()].map(([month, b]) => ({
    month,
    ingresos: r2(b.ingresos), gastos: r2(b.gastos), costos: r2(b.costos), neto: r2(b.neto),
  }));

  // Deltas: mes actual vs mes anterior
  const curMonth = payload.monthly[5], prevMonth = payload.monthly[4];
  if (curMonth && prevMonth) {
    const margenCur = curMonth.ingresos > 0 ? (curMonth.neto / curMonth.ingresos) * 100 : null;
    const margenPrev = prevMonth.ingresos > 0 ? (prevMonth.neto / prevMonth.ingresos) * 100 : null;
    ratios.deltas = {
      ingresos: r2(curMonth.ingresos - prevMonth.ingresos),
      gastos: r2(curMonth.gastos - prevMonth.gastos),
      margenNeto: margenCur != null && margenPrev != null ? r2(margenCur - margenPrev) : null,
    };
  }
  payload.ratios = ratios;
  payload.caja = { saldoActual: r2(caja) };

  // ── Proyección de caja ──
  // Siempre al horizonte máximo: los 3 primeros meses son idénticos a los de una
  // proyección a 3, así que getSaludFinanciera puede recortar sin recalcular.
  const proyeccion = await computeProyeccion(prisma, companyId, { caja, codigosCaja, meses: HORIZONTE_MAX }, now);
  payload.proyeccion = proyeccion;

  // ── Score consolidado (semáforo por categoría + global) ──
  // Sobre los 3 primeros meses siempre: el score es el número de cabecera y no debe
  // moverse porque el usuario cambie el rango de la proyección.
  payload.score = computeScore(ratios, proyeccion.slice(0, MESES_SCORE));

  // ── Alertas por reglas (sin LLM) ──
  payload.alertas = await computeAlertas(prisma, companyId, ratios, proyeccion);

  return payload;
}

/**
 * Score consolidado 0-100 por categoría (semáforo para el dueño/financista).
 * Valores faltantes → 50 (neutral, no penaliza).
 */
function computeScore(ratios: Ratios, proyeccion: ProyeccionMes[]): ScoreSalud {
  const s = (v: number | null, umbrales: number[]): number => {
    if (v == null) return 50;
    if (v >= umbrales[0]) return 100;
    if (v >= umbrales[1]) return 75;
    if (v >= umbrales[2]) return 50;
    return umbrales[3] !== undefined && v < umbrales[3] ? 0 : 25;
  };
  // Nota: para endeudamiento "menor es mejor" — se invierte con -v
  const sInv = (v: number | null, umbrales: number[]): number =>
    v == null ? 50 : s(-v, umbrales.map(u => -u));

  const liquidez = Math.round(s(ratios.liquidez, [2, 1.5, 1]) * 0.6 + s(ratios.pruebaAcida, [1.2, 1, 0.8]) * 0.4);
  const rentabilidad = Math.round(s(ratios.margenNeto, [15, 10, 5, 0]) * 0.7 + s(ratios.margenBruto, [40, 30, 20, 10]) * 0.3);
  const endeudamiento = Math.round(sInv(ratios.endeudamiento, [30, 50, 70]) * 0.6 + sInv(ratios.deudaPatrimonio, [0.5, 1, 1.5]) * 0.4);
  const eficiencia = Math.round(s(ratios.dso, [30, 60, 90]) * 0.5 + s(ratios.dpo, [30, 60, 90]) * 0.5);

  // Flujo: saldos proyectados negativos o caja actual negativa penalizan fuerte
  let flujo = 75;
  if (proyeccion.some(p => p.saldoFinal < 0)) flujo = 25;
  if (proyeccion[0]?.saldoFinal < 0) flujo = 0;
  if (proyeccion.length && proyeccion[proyeccion.length - 1].saldoFinal < proyeccion[0].saldoFinal) flujo = Math.min(flujo, 50);

  const global = Math.round((liquidez + rentabilidad + endeudamiento + eficiencia + flujo) / 5);
  const nivel: ScoreSalud['nivel'] = global >= 80 ? 'EXCELENTE' : global >= 60 ? 'BUENO' : global >= 40 ? 'REGULAR' : 'CRITICO';
  return { liquidez, rentabilidad, endeudamiento, eficiencia, flujo, global, nivel };
}

/** Clave 'YYYY-MM' en hora LOCAL: las fechas del proyecto son de solo día. */
const mesKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

/**
 * Proyección de caja a `meses` meses: recurrentes activas + obligaciones fiscales,
 * con saldo acumulado desde el efectivo actual.
 *
 * Los meses se indexan por mes natural y el saldo es un acumulado desde `caja`, así
 * que los 3 primeros meses NO dependen del horizonte pedido. De eso depende que el
 * caché pueda guardar una sola proyección a 12 y recortarla (ver getSaludFinanciera).
 */
export async function computeProyeccion(
  prisma: any,
  companyId: string,
  opts: { caja: number; codigosCaja: Set<string>; meses?: HorizonteMeses },
  now: Date = new Date(),
): Promise<ProyeccionMes[]> {
  const meses = opts.meses ?? HORIZONTE_DEFECTO;
  // 30 días por mes: con meses=3 da exactamente el plus90 de siempre, así que el
  // default del panel no se mueve. Se acepta que el último mes quede parcialmente
  // cubierto a cambio de no alterar las cifras que ya están en producción.
  const fin = new Date(now.getTime() + 30 * meses * 86400000);

  type Bucket = { entradas: number; salidas: number; fiscal: number; fiscalEstimado: boolean };
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string): Bucket => {
    let b = buckets.get(key);
    if (!b) {
      b = { entradas: 0, salidas: 0, fiscal: 0, fiscalEstimado: false };
      buckets.set(key, b);
    }
    return b;
  };

  // Recurrentes activas
  const templates = await prisma.recurringTemplate.findMany({ where: { companyId, isActive: true } });
  const accounts = await prisma.account.findMany({ where: { companyId }, select: { id: true, code: true } });
  const codeById = new Map<string, string>(accounts.map((a: any) => [a.id, a.code] as [string, string]));
  const SALIDAS = ['GASTO', 'COMPRA', 'PAGO_PROVEEDOR'];
  const ENTRADAS = ['INGRESO', 'VENTA', 'COBRO_CLIENTE'];

  for (const t of templates) {
    let dir: 'entradas' | 'salidas' | null = null;
    const creditCode = t.creditAccountId ? codeById.get(t.creditAccountId) : undefined;
    const debitCode = t.debitAccountId ? codeById.get(t.debitAccountId) : undefined;
    // El efectivo manda sobre el tipo: una plantilla que cobra en un banco es una
    // entrada aunque su `type` diga otra cosa (mismo criterio que el saldo de caja).
    if (creditCode && opts.codigosCaja.has(creditCode)) dir = 'entradas';
    else if (debitCode && opts.codigosCaja.has(debitCode)) dir = 'salidas';
    else if (SALIDAS.includes(t.type)) dir = 'salidas';
    else if (ENTRADAS.includes(t.type)) dir = 'entradas';
    if (!dir) continue;

    let d = new Date(t.nextRunAt);
    let guard = 0;
    // El guard tiene que escalar con el horizonte: 12 meses de una recurrente diaria
    // son ~365 ocurrencias y un tope fijo de 200 las cortaría EN SILENCIO (meses en
    // cero sin avisar). Se cubre además el arranque desde un `nextRunAt` atrasado,
    // cuyas ocurrencias ya pasadas consumen iteraciones antes de llegar a hoy.
    const guardMax = Math.max(200, Math.ceil((fin.getTime() - d.getTime()) / 86400000) + 10);
    while (d <= fin && guard < guardMax) {
      guard++;
      if (d >= now) {
        bucket(mesKey(d))[dir] += t.amount || 0;
      }
      const next = calculateNextRun(t.frequency, t.dayOfMonth, t.dayOfWeek, d);
      if (next.getTime() <= d.getTime()) break; // defensa anti-loop
      d = next;
    }
  }

  // Obligaciones fiscales del horizonte: las reales de BD más las estimadas de los
  // meses que el calendario todavía no cubre (services/tax-calendar.ts).
  const obligaciones = await obligacionesProyectadas(prisma, companyId, { now, meses });
  for (const o of obligaciones) {
    const b = bucket(mesKey(new Date(o.dueDate)));
    b.salidas += o.amount;
    b.fiscal += o.amount;
    if (o.estimado) b.fiscalEstimado = true;
  }

  // Armar los meses con saldo acumulado desde el efectivo actual
  const result: ProyeccionMes[] = [];
  let saldo = opts.caja;
  for (let i = 0; i < meses; i++) {
    const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = mesKey(m);
    const b = buckets.get(key);
    saldo = r2(saldo + r2(b?.entradas || 0) - r2(b?.salidas || 0));
    result.push({
      month: key,
      label: m.toLocaleDateString('es-PA', { month: 'long', year: 'numeric' }),
      entradas: r2(b?.entradas || 0),
      salidas: r2(b?.salidas || 0),
      saldoFinal: saldo,
      fiscal: r2(b?.fiscal || 0),
      fiscalEstimado: b?.fiscalEstimado || false,
    });
  }
  return result;
}

// ── Alertas de desviación de presupuesto ──

/** Tope de alertas de presupuesto: por encima de esto el panel deja de ser legible. */
const MAX_ALERTAS_PRESUPUESTO = 8;

/**
 * Comparativa real vs presupuesto del año fiscal en curso, hasta el mes actual.
 *
 * El `mes` se pasa explícitamente y no se deja el default: sin él la comparativa
 * mide el real de enero a hoy contra el presupuesto de los DOCE meses, y en
 * septiembre cualquier empresa que no vaya justa al plan anual saldría en rojo.
 *
 * Devuelve null si la empresa no tiene presupuesto cargado — así el panel responde
 * exactamente igual que antes de esta funcionalidad, sin pagar la consulta.
 */
async function leerComparativaPresupuesto(prisma: any, companyId: string): Promise<BudgetComparison | null> {
  const conPresupuesto = await prisma.budget.count({ where: { companyId, amount: { gt: 0 } } });
  if (!conPresupuesto) return null;
  const anio = await getAnioFiscal(prisma, companyId);
  const mes = mesDeComparacion(anio);
  if (mes < 1) return null; // año fiscal todavía no empezado: no hay nada que comparar
  return buildBudgetComparison(prisma, companyId, { year: anio, mes, tipos: 'resultado' });
}

/**
 * Traduce el semáforo de la comparativa en alertas.
 *
 * Solo se alerta sobre cuentas CON presupuesto (`budget > 0`): un gasto sin
 * presupuesto ya sale rojo en la grilla de la pestaña Presupuesto, pero como alerta
 * inundaría el panel y no es una desviación sino un hueco de captura.
 *
 * Las reglas del semáforo (5% / 15%, materialidad de 25 USD, "favorable nunca
 * rojo") NO se reimplementan: son las de services/budget-comparison.ts.
 * Pura, para poder probarla sin BD.
 */
export function alertasDeComparativa(cmp: BudgetComparison): SaludAlerta[] {
  const out: SaludAlerta[] = [];

  /** Una fila es alerta si tiene presupuesto y el semáforo la marcó. */
  const esAlerta = (f: any) => f && f.budget > 0 && (f.semaforo === 'rojo' || f.semaforo === 'ambar');

  /**
   * "…(un 70% peor de lo previsto)". Se usa favorable/desfavorable y no el signo:
   * gastar de menos y cobrar de más son ambos favorables, y el signo de la
   * variación es el contrario en cada caso.
   */
  const mensaje = (nombre: string, f: any) => {
    const pct = f.variacionPct == null ? '' : ` (un ${Math.abs(f.variacionPct)}% ${f.direccion === 'favorable' ? 'mejor' : 'peor'} de lo previsto)`;
    return `Presupuesto: ${nombre} lleva ${fmtMoney(f.real)} contra ${fmtMoney(f.budget)} presupuestados${pct}.`;
  };
  const push = (nombre: string, f: any, severidad: SaludAlerta['severidad']) =>
    out.push({ tipo: 'PRESUPUESTO', severidad, mensaje: mensaje(nombre, f) });

  const totales = cmp.totales as Record<string, any>;

  // 1. El resultado del período: la desviación que más importa.
  const neta = totales?.utilidadNeta;
  if (esAlerta(neta)) push('la utilidad del período', neta, neta.semaforo === 'rojo' ? 'critical' : 'warning');

  // 2. Ingresos y gastos: solo cuando van en contra.
  for (const [clave, nombre] of [['ingresos', 'los ingresos'], ['gastos', 'los gastos']] as const) {
    const t = totales?.[clave];
    if (esAlerta(t) && t.semaforo === 'rojo' && t.direccion === 'desfavorable') push(nombre, t, 'critical');
  }

  // 3. Categorías, de mayor a menor desvío absoluto para que las que importan
  //    entren antes de que se agote el tope.
  const cats = ((cmp.categorias || []) as any[])
    .filter((c) => esAlerta(c) && c.direccion)
    .sort((a, b) => Math.abs(b.variacion) - Math.abs(a.variacion));

  cats.filter((c) => c.semaforo === 'rojo' && c.direccion === 'desfavorable').slice(0, 3)
    .forEach((c) => push(c.categoriaName, c, 'critical'));
  cats.filter((c) => c.semaforo === 'ambar' && c.direccion === 'desfavorable').slice(0, 2)
    .forEach((c) => push(c.categoriaName, c, 'warning'));

  // 4. Desviarse ahorrando no es un problema de gasto, es de presupuestación:
  //    una sola alerta informativa, la mayor.
  const holgado = cats.find((c) => c.semaforo === 'ambar' && c.direccion === 'favorable');
  if (holgado) {
    out.push({
      tipo: 'PRESUPUESTO',
      severidad: 'info',
      mensaje: `Presupuesto: ${holgado.categoriaName} cerró un ${Math.abs(holgado.variacionPct ?? 0)}% mejor de lo previsto — puede que el presupuesto haya quedado corto.`,
    });
  }

  return out.slice(0, MAX_ALERTAS_PRESUPUESTO);
}

async function computeAlertas(prisma: any, companyId: string, ratios: Ratios, proyeccion: ProyeccionMes[]): Promise<SaludAlerta[]> {
  const alertas: SaludAlerta[] = [];

  if (ratios.liquidez != null) {
    if (ratios.liquidez < 1) alertas.push({ tipo: 'LIQUIDEZ', severidad: 'critical', mensaje: `Liquidez corriente de ${ratios.liquidez}: tienes menos de $1 disponible por cada $1 de deuda a corto plazo.` });
    else if (ratios.liquidez < 1.5) alertas.push({ tipo: 'LIQUIDEZ', severidad: 'warning', mensaje: `Liquidez corriente de ${ratios.liquidez}: margen ajustado ante imprevistos.` });
  }
  if (ratios.pruebaAcida != null && ratios.pruebaAcida < 1) {
    alertas.push({ tipo: 'LIQUIDEZ', severidad: ratios.pruebaAcida < 0.8 ? 'critical' : 'warning', mensaje: `Prueba ácida de ${ratios.pruebaAcida}: sin contar inventario, no cubres tu deuda de corto plazo.` });
  }
  if (ratios.capitalTrabajo != null && ratios.capitalTrabajo < 0) {
    alertas.push({ tipo: 'LIQUIDEZ', severidad: 'critical', mensaje: `Capital de trabajo NEGATIVO (${fmtMoney(ratios.capitalTrabajo)}): los pasivos corrientes superan a los activos corrientes.` });
  }
  if (ratios.roe != null && ratios.roe < 0) {
    alertas.push({ tipo: 'MARGEN', severidad: 'warning', mensaje: `ROE de ${ratios.roe}%: la rentabilidad sobre el patrimonio es negativa este año.` });
  }
  if (ratios.endeudamiento != null) {
    if (ratios.endeudamiento > 70) alertas.push({ tipo: 'ENDEUDAMIENTO', severidad: 'critical', mensaje: `Endeudamiento del ${ratios.endeudamiento}%: la deuda supera el 70% de los activos.` });
    else if (ratios.endeudamiento > 50) alertas.push({ tipo: 'ENDEUDAMIENTO', severidad: 'warning', mensaje: `Endeudamiento del ${ratios.endeudamiento}%: vigila el crecimiento de la deuda.` });
  }
  if (ratios.margenNeto != null) {
    if (ratios.margenNeto < 0) alertas.push({ tipo: 'MARGEN', severidad: 'critical', mensaje: `Margen neto de ${ratios.margenNeto}%: estás operando en pérdida este año.` });
    else if (ratios.margenNeto < 5) alertas.push({ tipo: 'MARGEN', severidad: 'warning', mensaje: `Margen neto de ${ratios.margenNeto}%: rentabilidad baja.` });
  }
  if (ratios.dso != null && ratios.dso > 60) alertas.push({ tipo: 'DSO', severidad: ratios.dso > 90 ? 'critical' : 'warning', mensaje: `Tardas ${ratios.dso} días en cobrar a tus clientes.` });
  if (ratios.dpo != null && ratios.dpo > 90) alertas.push({ tipo: 'DPO', severidad: 'warning', mensaje: `Tardas ${ratios.dpo} días en pagar a proveedores; podrías estar acumulando intereses o tensionando relaciones.` });

  proyeccion.forEach((p, i) => {
    if (p.saldoFinal < 0) {
      alertas.push({
        tipo: 'FLUJO_NEGATIVO',
        severidad: i === 0 ? 'critical' : 'warning',
        mensaje: `Proyección: tu caja quedaría en ${fmtMoney(p.saldoFinal)} en ${p.label}.`,
        mes: p.month, // permite recortar la alerta si el usuario pide un horizonte más corto
      });
    }
  });

  // Obligaciones fiscales: vencidas o a ≤15 días
  const soon = new Date(Date.now() + 15 * 86400000);
  const obligaciones = await prisma.taxObligation.findMany({
    where: { companyId, status: { in: ['PENDING', 'OVERDUE'] }, dueDate: { lte: soon } },
  });
  for (const o of obligaciones) {
    const monto = o.estimatedAmount ?? o.actualAmount ?? 0;
    const label = `${o.type} (${new Date(o.dueDate).toLocaleDateString('es-PA')})`;
    alertas.push({
      tipo: 'OBLIGACION_PROXIMA',
      severidad: o.status === 'OVERDUE' ? 'critical' : 'warning',
      mensaje: o.status === 'OVERDUE'
        ? `Obligación fiscal VENCIDA: ${label}${monto ? ` — ${fmtMoney(monto)}` : ''}.`
        : `Obligación fiscal próxima: ${label}${monto ? ` — ${fmtMoney(monto)}` : ''}.`,
    });
  }

  // Facturas vencidas CxC / CxP
  const vencCxc = await prisma.invoice.aggregate({
    _count: { _all: true }, _sum: { total: true },
    where: { companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] }, dueDate: { lt: new Date() } },
  });
  if (vencCxc._count._all > 0) {
    alertas.push({ tipo: 'CXC_VENCIDA', severidad: 'warning', mensaje: `${vencCxc._count._all} factura(s) por cobrar vencidas por ${fmtMoney(vencCxc._sum.total || 0)}.` });
  }
  const vencCxp = await prisma.bill.aggregate({
    _count: { _all: true }, _sum: { total: true },
    where: { companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] }, dueDate: { lt: new Date() } },
  });
  if (vencCxp._count._all > 0) {
    alertas.push({ tipo: 'CXP_VENCIDA', severidad: 'warning', mensaje: `${vencCxp._count._all} factura(s) por pagar vencidas por ${fmtMoney(vencCxp._sum.total || 0)}.` });
  }

  // Desviaciones de presupuesto, al final para no reordenar las alertas de siempre.
  // En su propio try/catch a propósito: un fallo del comparativo no debe tumbar el
  // panel de salud entero — se pierden las alertas de presupuesto, nada más.
  try {
    const comparativa = await leerComparativaPresupuesto(prisma, companyId);
    if (comparativa) alertas.push(...alertasDeComparativa(comparativa));
  } catch (err: any) {
    console.error('[Salud] Presupuesto:', err?.message);
  }

  return alertas;
}

// ── Narrativa IA (DeepSeek) — cualquier fallo devuelve null y el panel degrada ──
async function generateNarrativa(payload: SaludPayload): Promise<Narrativa | null> {
  const client = getLLMClient();
  if (!client) return null;
  try {
    const input = buildNarrativaInput(payload);
    const completion = await client.chat.completions.create({
      model: 'deepseek-chat',
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Eres un analista financiero sénior para pequeñas empresas en Panamá. Recibes un resumen JSON de la salud financiera de una empresa y debes explicarla en lenguaje natural. Reglas: habla en español, tono claro y profesional; explica POR QUÉ cambiaron los números cuando haya deltas (mes actual vs anterior); sé específico con montos, porcentajes y meses reales del resumen; NO inventes datos que no estén en el resumen. Devuelve SOLO JSON válido con esta estructura: {"resumen": "párrafo de 2-4 frases con el estado general y las razones de los cambios", "alertas": ["una frase cada una"], "recomendaciones": ["recomendaciones concretas y accionables hoy"]}. Máximo 4 alertas y 4 recomendaciones.',
        },
        { role: 'user', content: input },
      ],
    });
    const text = completion.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(text);
    if (typeof parsed.resumen !== 'string') return null;
    return {
      resumen: parsed.resumen,
      alertas: Array.isArray(parsed.alertas) ? parsed.alertas.slice(0, 4).map(String) : [],
      recomendaciones: Array.isArray(parsed.recomendaciones) ? parsed.recomendaciones.slice(0, 4).map(String) : [],
    };
  } catch (err: any) {
    console.error('[SaludIA] Error generando narrativa:', err?.message);
    return null;
  }
}

function buildNarrativaInput(payload: SaludPayload): string {
  const resumen = {
    fecha: payload.fecha,
    ratios: payload.ratios,
    cajaActual: payload.caja.saldoActual,
    deltasMesActual: payload.ratios?.deltas,
    ingresosYGastosUltimos6Meses: payload.monthly.map(m => ({ mes: m.month, ingresos: m.ingresos, gastos: m.gastos, neto: m.neto })),
    // La clave lleva el horizonte y el array va con los campos de siempre: así, con
    // meses=3, el prompt es exactamente el mismo que antes de esta funcionalidad.
    [`proyeccionProximos${payload.horizonte}Meses`]: payload.proyeccion.map(p => ({
      month: p.month, label: p.label, entradas: p.entradas, salidas: p.salidas, saldoFinal: p.saldoFinal,
    })),
    alertasPorReglas: payload.alertas.map(a => `${a.severidad.toUpperCase()}: ${a.mensaje}`),
  };
  return JSON.stringify(resumen).slice(0, 4000);
}
