// Salud financiera: ratios, proyección de caja 3 meses y narrativa IA (fallback sin LLM).
// Patrón de servicio puro como services/tax-calendar.ts: funciones que reciben (prisma, companyId).
import OpenAI from 'openai';
import { calculateNextRun } from './recurring-processor';

// ── Tipos de respuesta ──
export interface SaludAlerta {
  tipo: 'LIQUIDEZ' | 'ENDEUDAMIENTO' | 'MARGEN' | 'DSO' | 'DPO' | 'FLUJO_NEGATIVO' | 'OBLIGACION_PROXIMA' | 'CXC_VENCIDA' | 'CXP_VENCIDA';
  severidad: 'info' | 'warning' | 'critical';
  mensaje: string;
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

export interface ProyeccionMes { month: string; label: string; entradas: number; salidas: number; saldoFinal: number; }

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
}

// ── Caché en memoria del proceso (PM2, proceso único). Se limpia al reiniciar la API.
// Bypass: GET /api/salud?refresh=1
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE = new Map<string, { payload: SaludPayload; ts: number }>();

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
  opts: { refresh?: boolean } = {},
): Promise<SaludPayload> {
  const cached = CACHE.get(companyId);
  if (!opts.refresh && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.payload;
  }
  const payload = await computeSalud(prisma, companyId);
  if (!payload.sinDatos) {
    payload.narrativa = await generateNarrativa(payload);
    payload.iaDisponible = payload.narrativa !== null;
  }
  CACHE.set(companyId, { payload, ts: Date.now() });
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

  let activoCorriente = 0, activoTotal = 0, pasivoCorriente = 0, pasivoTotal = 0, caja = 0, inventario = 0;
  for (const { code, type, balance } of byAccount.values()) {
    if (type === 'ACTIVO') {
      activoTotal += balance;
      if (/^1\.1\./.test(code)) activoCorriente += balance;
      if (code.startsWith('1.1.01')) caja += balance;
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

  // ── Proyección 3 meses ──
  const proyeccion = await computeProyeccion(prisma, companyId, caja, now);
  payload.proyeccion = proyeccion;

  // ── Score consolidado (semáforo por categoría + global) ──
  payload.score = computeScore(ratios, proyeccion);

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

async function computeProyeccion(prisma: any, companyId: string, caja: number, now: Date) {
  const plus90 = new Date(now.getTime() + 90 * 86400000);
  const buckets = new Map<string, { entradas: number; salidas: number }>();

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
    if (creditCode?.startsWith('1.1.01')) dir = 'entradas';
    else if (debitCode?.startsWith('1.1.01')) dir = 'salidas';
    else if (SALIDAS.includes(t.type)) dir = 'salidas';
    else if (ENTRADAS.includes(t.type)) dir = 'entradas';
    if (!dir) continue;

    let d = new Date(t.nextRunAt);
    let guard = 0;
    while (d <= plus90 && guard < 200) {
      guard++;
      if (d >= now) {
        const key = d.toISOString().slice(0, 7);
        const b = buckets.get(key) || { entradas: 0, salidas: 0 };
        b[dir] += t.amount || 0;
        buckets.set(key, b);
      }
      const next = calculateNextRun(t.frequency, t.dayOfMonth, t.dayOfWeek, d);
      if (next.getTime() <= d.getTime()) break; // defensa anti-loop
      d = next;
    }
  }

  // Obligaciones fiscales próximas 90 días
  const obligaciones = await prisma.taxObligation.findMany({
    where: { companyId, status: { in: ['PENDING', 'OVERDUE'] }, dueDate: { lte: plus90 } },
  });
  for (const o of obligaciones) {
    const key = new Date(o.dueDate).toISOString().slice(0, 7);
    const b = buckets.get(key) || { entradas: 0, salidas: 0 };
    b.salidas += o.estimatedAmount ?? o.actualAmount ?? 0;
    buckets.set(key, b);
  }

  // Armar 3 meses con saldo acumulado desde la caja actual
  const result: ProyeccionMes[] = [];
  let saldo = caja;
  for (let i = 0; i < 3; i++) {
    const m = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const key = m.toISOString().slice(0, 7);
    const b = buckets.get(key) || { entradas: 0, salidas: 0 };
    saldo = r2(saldo + r2(b.entradas) - r2(b.salidas));
    result.push({
      month: key,
      label: m.toLocaleDateString('es-PA', { month: 'long', year: 'numeric' }),
      entradas: r2(b.entradas),
      salidas: r2(b.salidas),
      saldoFinal: saldo,
    });
  }
  return result;
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
    proyeccionProximos3Meses: payload.proyeccion,
    alertasPorReglas: payload.alertas.map(a => `${a.severidad.toUpperCase()}: ${a.mensaje}`),
  };
  return JSON.stringify(resumen).slice(0, 4000);
}
