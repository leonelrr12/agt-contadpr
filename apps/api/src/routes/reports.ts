import { Router } from 'express';
import { buildDateFilter } from '../lib/date-filter';
import { getAnioFiscal, anioFiscalRange } from '../lib/fiscal-year';
import { exportReport } from '../services/export';
import type { ExportFormat } from '../services/export';

export const reportsRouter = Router();

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Totaliza filas del balance por cuenta de nivel 3 ("1.1.02.01" → "1.1.02"):
 * suma el débito/crédito del período y el saldo acumulado (con signo según su
 * naturaleza) de todas las subcuentas y usa el nombre del padre del catálogo.
 * La usa el export del balance cuando viene `?nivel=3` (mismo algoritmo que el
 * botón "📊 Nivel 3" de la pantalla de Informes).
 */
function rollupNivel3(rows: any[], namesByCode: Map<string, string>) {
  const grupos = new Map<string, any>();
  for (const c of rows) {
    const segs = String(c.account?.code || '').split('.').filter(Boolean);
    if (segs.length === 0) continue;
    const key = segs.slice(0, 3).join('.');
    const g = grupos.get(key) || { code: key, name: '', type: c.account?.type, totalDebit: 0, totalCredit: 0, saldo: 0 };
    g.totalDebit = r2(g.totalDebit + (c.totalDebit || 0));
    g.totalCredit = r2(g.totalCredit + (c.totalCredit || 0));
    g.saldo = r2(g.saldo + (c.balanceType === 'ACREEDOR' ? -(c.balance || 0) : (c.balance || 0)));
    if (!g.name && namesByCode.get(key)) g.name = namesByCode.get(key);
    if (!g.name && segs.length <= 3) g.name = c.account?.name || '';
    grupos.set(key, g);
  }
  return [...grupos.values()].map(g => ({
    account: { code: g.code, name: g.name || '(cuenta de nivel 3)', type: g.type },
    totalDebit: g.totalDebit,
    totalCredit: g.totalCredit,
    balance: Math.abs(g.saldo),
    balanceType: g.saldo >= 0 ? 'DEUDOR' : 'ACREEDOR',
  }));
}

/**
 * Reporte por proveedor de facturas DGI (declaración de rentas).
 * Agrupa transacciones por metadata.provider (patrón de journal.ts):
 * filtro contains en BD + parseo JSON en memoria.
 * source="pdf"/"ocr" → amount ya incluye ITBMS (subtotal = amount - itbms);
 * sin source (texto) → amount es neto (total = amount + itbms).
 */
async function buildProveedoresReport(prisma: any, companyId: string, startDate?: string, endDate?: string) {
  const where: Record<string, unknown> = {
    companyId,
    type: { notIn: ['VENTA', 'COBRO_CLIENTE'] }, // ventas guardan al CLIENTE en metadata.provider — este reporte es solo de compras
    metadata: { contains: 'provider' },
    journalEntry: { is: { status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false } },
  };
  // Sin filtro de fechas → año fiscal activo (consistente con los demás informes)
  const anioFiscal = await getAnioFiscal(prisma, companyId);
  const rango = anioFiscalRange(anioFiscal);
  const dateFilter = startDate || endDate
    ? buildDateFilter(startDate, endDate)
    : { gte: rango.start, lte: rango.end };
  if (dateFilter) where.date = dateFilter;

  const txs = await prisma.transaction.findMany({
    where,
    select: { id: true, date: true, amount: true, metadata: true, journalEntryId: true },
    orderBy: { date: 'asc' },
  });

  // Enriquecer con el Invoice/Bill vinculado al asiento: el metadata no siempre
  // tiene invoiceNumber/itbmsAmount (facturas viejas, imports), pero el auxiliar sí.
  const jeIds = [...new Set(txs.map((t: any) => t.journalEntryId).filter(Boolean))];
  const [invoices, bills] = await Promise.all([
    jeIds.length > 0 ? prisma.invoice.findMany({ where: { journalEntryId: { in: jeIds } }, select: { journalEntryId: true, number: true, itbms: true } }) : [],
    jeIds.length > 0 ? prisma.bill.findMany({ where: { journalEntryId: { in: jeIds } }, select: { journalEntryId: true, number: true, itbms: true } }) : [],
  ]);
  const auxByJe = new Map<string, { number: string | null; itbms: number }>();
  for (const i of invoices) auxByJe.set(i.journalEntryId, { number: i.number, itbms: i.itbms });
  for (const b of bills) if (!auxByJe.has(b.journalEntryId)) auxByJe.set(b.journalEntryId, { number: b.number, itbms: b.itbms });

  const proveedores = new Map<string, any>();
  for (const tx of txs) {
    let m: any = {};
    try { m = JSON.parse(tx.metadata); } catch {}
    if (!m.provider) continue;
    const ruc = m.ruc || null;
    const key = `${m.provider}|${ruc || ''}`;
    const p = proveedores.get(key) || {
      provider: m.provider, ruc, facturas: 0, subtotal: 0, itbms: 0, total: 0, detalle: [],
    };
    const aux = tx.journalEntryId ? auxByJe.get(tx.journalEntryId) : undefined;
    const itbmsMeta = Number(m.itbmsAmount) || 0;
    // Import del archivo maestro (import.ts): guarda el ITBMS en metadata.itbms
    // y su amount YA incluye el impuesto (neto + itbms). El chat/PDF guardan
    // metadata.itbmsAmount con amount neto. El Bill/Invoice del asiento queda
    // de respaldo (créditos).
    const itbmsImport = Number(m.itbms) || 0;
    const esImport = !m.source && itbmsImport > 0 && itbmsMeta === 0;
    const invoiceNumber = m.invoiceNumber || aux?.number || null;
    const amountTotal = Number(tx.amount) || 0;
    const itbms = r2(itbmsMeta > 0 ? itbmsMeta : (itbmsImport > 0 ? itbmsImport : (aux?.itbms || 0)));
    const amountIncluyeItbms = m.source || esImport;
    const subtotal = amountIncluyeItbms ? Math.round((amountTotal - itbms) * 100) / 100 : amountTotal;
    const total = amountIncluyeItbms ? amountTotal : Math.round((amountTotal + itbms) * 100) / 100;
    p.facturas++;
    p.subtotal = Math.round((p.subtotal + subtotal) * 100) / 100;
    p.itbms = Math.round((p.itbms + itbms) * 100) / 100;
    p.total = Math.round((p.total + total) * 100) / 100;
    p.detalle.push({
      transactionId: tx.id,
      invoiceNumber,
      date: tx.date,
      amount: subtotal,
      itbms,
      total,
    });
    proveedores.set(key, p);
  }

  const lista = Array.from(proveedores.values())
    .map((p: any) => ({ ...p, detalle: p.detalle.sort((a: any, b: any) => a.date - b.date) }))
    .sort((a: any, b: any) => a.provider.localeCompare(b.provider));

  const tot = lista.reduce((acc: any, p: any) => ({
    facturas: acc.facturas + p.facturas,
    subtotal: Math.round((acc.subtotal + p.subtotal) * 100) / 100,
    itbms: Math.round((acc.itbms + p.itbms) * 100) / 100,
    total: Math.round((acc.total + p.total) * 100) / 100,
  }), { facturas: 0, subtotal: 0, itbms: 0, total: 0 });

  return {
    periodo: { start: dateFilter?.gte || null, end: dateFilter?.lte || null, anioFiscal },
    totalProveedores: lista.length,
    ...tot,
    proveedores: lista,
  };
}

/**
 * ANEXOS-DGI: detalle por tercero de una CUENTA del catálogo (Anexo-DGI Fase F).
 * Sustituye al antiguo informe de Honorarios y convive con Por Proveedores: aquí
 * el eje es la cuenta (la que el usuario marcó con "Lleva Anexo"), no el proveedor.
 * - Filas: líneas de asiento que tocan la cuenta (por eso una cuenta de banco
 *   lista todo lo que la tocó) — se documenta en la UI.
 * - Las anulaciones no cuentan: journal.ts re-apunta la Transaction al asiento de
 *   reversión ("ANULACIÓN: …"), que hay que excluir explícitamente.
 */
async function buildAnexosDgiReport(
  prisma: any,
  companyId: string,
  opts: {
    cuenta: { id: string; code: string; name: string; requiresAnexo: boolean };
    startDate?: string;
    endDate?: string;
  },
) {
  const { cuenta, startDate, endDate } = opts;
  const accountId = cuenta.id;

  const where: Record<string, unknown> = {
    companyId,
    journalEntry: {
      is: {
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        isClosing: false,
        ...(accountId ? { lines: { some: { accountId } } } : {}),
        // Al anular, journal.ts re-apunta las Transactions al asiento de reversión
        NOT: { description: { startsWith: 'ANULACIÓN:' } },
      },
    },
  };
  // Sin filtro de fechas → año fiscal activo (consistente con los demás informes)
  const anioFiscal = await getAnioFiscal(prisma, companyId);
  const rango = anioFiscalRange(anioFiscal);
  const dateFilter = startDate || endDate
    ? buildDateFilter(startDate, endDate)
    : { gte: rango.start, lte: rango.end };
  if (dateFilter) where.date = dateFilter;

  const txs = await prisma.transaction.findMany({
    where,
    select: { id: true, date: true, amount: true, metadata: true, journalEntryId: true, type: true },
    orderBy: { date: 'asc' },
  });

  // Factura: metadata.invoiceNumber → nº del Invoice/Bill del asiento → metadata.reference
  const jeIds = [...new Set(txs.map((t: any) => t.journalEntryId).filter(Boolean))];
  const [invoices, bills] = await Promise.all([
    jeIds.length > 0 ? prisma.invoice.findMany({ where: { journalEntryId: { in: jeIds } }, select: { journalEntryId: true, number: true } }) : [],
    jeIds.length > 0 ? prisma.bill.findMany({ where: { journalEntryId: { in: jeIds } }, select: { journalEntryId: true, number: true } }) : [],
  ]);
  const auxByJe = new Map<string, string | null>();
  for (const i of invoices) auxByJe.set(i.journalEntryId, i.number);
  for (const b of bills) if (!auxByJe.has(b.journalEntryId)) auxByJe.set(b.journalEntryId, b.number);

  const terceros = new Map<string, any>();
  for (const tx of txs) {
    let m: any = {};
    try { m = JSON.parse(tx.metadata || '{}'); } catch {}
    // Tercero: el proveedor del chat/PDF/import o el nombre de la carga de honorarios
    const tercero = m.provider || m.nombre || null;
    if (!tercero) continue;
    const ruc = m.ruc || null;
    const factura = m.invoiceNumber || (tx.journalEntryId ? auxByJe.get(tx.journalEntryId) : null) || m.reference || null;
    const key = `${tercero}|${ruc || ''}`;
    const t = terceros.get(key) || { tercero, ruc, movimientos: 0, total: 0, detalle: [] };
    const monto = r2(tx.amount);
    t.movimientos++;
    t.total = r2(t.total + monto);
    t.detalle.push({
      transactionId: tx.id,
      fecha: tx.date,
      detalle: m.concepto || m.description || null,
      factura,
      monto,
    });
    terceros.set(key, t);
  }

  const lista = Array.from(terceros.values())
    .map((t: any) => ({ ...t, detalle: t.detalle.sort((a: any, b: any) => a.fecha - b.fecha) }))
    .sort((a: any, b: any) => a.tercero.localeCompare(b.tercero));

  const tot = lista.reduce((acc: any, t: any) => ({
    movimientos: acc.movimientos + t.movimientos,
    total: r2(acc.total + t.total),
  }), { movimientos: 0, total: 0 });

  return {
    reportKind: 'anexos-dgi' as const,   // discrimina la hoja/nombre en export.ts
    periodo: { start: dateFilter?.gte || null, end: dateFilter?.lte || null, anioFiscal },
    cuenta,
    totalTerceros: lista.length,
    ...tot,
    terceros: lista,
  };
}

reportsRouter.get('/proveedores', async (req, res) => {
  const { startDate, endDate, accountId } = req.query;

  // Anexos-DGI por cuenta: la cuenta debe ser de la empresa (404 si no)
  if (accountId) {
    const cuentaInfo = await req.prisma.account.findFirst({
      where: { id: String(accountId), companyId: req.user!.companyId },
      select: { id: true, code: true, name: true, requiresAnexo: true },
    });
    if (!cuentaInfo) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
    const report = await buildAnexosDgiReport(req.prisma, req.user!.companyId, {
      cuenta: cuentaInfo,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
    });
    res.json(report);
    return;
  }

  const report = await buildProveedoresReport(req.prisma, req.user!.companyId, startDate as string | undefined, endDate as string | undefined);
  res.json(report);
});

/**
 * Balance de comprobación con doble dimensión:
 * - Débito/Crédito: SOLO movimientos del período analizado (startDate..endDate,
 *   o el año fiscal activo si no hay filtro — derivado del último asiento).
 * - Saldo: ACUMULADO de toda la vida hasta endDate (o hasta hoy sin filtro).
 * Incluye asientos de cierre (isClosing): es lo que vacía las cuentas de
 * resultado al iniciar un año nuevo y traslada la utilidad a 3.03.
 */
reportsRouter.get('/balance-comprobacion', async (req, res) => {
  const { startDate, endDate } = req.query;

  // Período del reporte: con filtro de fechas usa las fechas; sin filtro,
  // el año fiscal activo (último asiento) — consistente con diario/resultados.
  const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
  const rango = anioFiscalRange(anioFiscal);
  const periodo = {
    start: startDate ? new Date(`${startDate}T00:00:00.000Z`) : rango.start,
    end: endDate ? new Date(`${endDate}T23:59:59.999Z`) : rango.end,
    anioFiscal,
  };

  // 1) Movimientos del período (débito/crédito) — INCLUYE cierres del período
  const movGrouped = await req.prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: {
      journalEntry: {
        companyId: req.user!.companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        date: { gte: periodo.start, lte: periodo.end },
      },
    },
  });

  // 2) Saldo acumulado hasta el final del período — INCLUYE cierres
  const saldoGrouped = await req.prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: {
      journalEntry: {
        companyId: req.user!.companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        date: { lte: periodo.end },
      },
    },
  });

  const accountIds = [...new Set([...movGrouped.map((g: any) => g.accountId), ...saldoGrouped.map((g: any) => g.accountId)])];
  const accounts = await req.prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, code: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a: any) => [a.id, a]));
  const movMap = new Map(movGrouped.map((g: any) => [g.accountId, g]));
  const saldoMap = new Map(saldoGrouped.map((g: any) => [g.accountId, g]));

  const result = accountIds
    .map((id) => {
      const a = byId.get(id);
      if (!a) return null;
      const mov = movMap.get(id);
      const sal = saldoMap.get(id);
      const totalDebit = Math.round((mov?._sum.debit || 0) * 100) / 100;
      const totalCredit = Math.round((mov?._sum.credit || 0) * 100) / 100;
      const rawBalance = (sal?._sum.debit || 0) - (sal?._sum.credit || 0);
      const balance = Math.round(Math.abs(rawBalance) * 100) / 100;
      return {
        account: { code: a.code, name: a.name, type: a.type },
        totalDebit,
        totalCredit,
        balance,
        balanceType: rawBalance > 0 ? 'DEUDOR' : 'ACREEDOR',
      };
    })
    .filter(Boolean)
    .sort((a: any, b: any) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true }));

  res.json({ periodo: { start: periodo.start, end: periodo.end, anioFiscal }, cuentas: result });
});

/**
 * Balance General: estado ACUMULADO (no de período) con el detalle por cuenta.
 * - `endDate` actúa de corte (líneas con fecha <= corte); sin él, todo el histórico.
 * - `startDate` se ignora a propósito: un balance es "a fecha", no de rango. Reflejarlo
 *   en la cabecera haría creer que los saldos son del período.
 * - "Ganancia del periodo" es el resultado NO CERRADO al corte. En el caso normal
 *   (ejercicios anteriores cerrados, el actual abierto) coincide al centavo con la
 *   Utilidad Neta del Estado de Resultados; si quedan años sin cerrar, acumula los de
 *   esos años, y con el ejercicio ya cerrado vale 0 porque la utilidad ya vive en 3.03.
 * Única fuente de cálculo: la usan el GET /balance-general y el export (antes cada
 * uno recalculaba con signos distintos y los números no coincidían).
 */
async function buildBalanceGeneral(prisma: any, companyId: string, endDate?: string) {
  // `|| await` cubre una fecha inválida o un query param repetido (?a=1&a=2 → array)
  const anioFiscal = (endDate && Number(String(endDate).slice(0, 4))) || (await getAnioFiscal(prisma, companyId));
  const corte = buildDateFilter(undefined, endDate);

  // UN solo groupBy con el MISMO filtro para todos los tipos de cuenta. Por partida
  // doble Σ(débito−crédito) = 0 en cualquier ventana, así que la ecuación del balance
  // sale sola y no hay que forzarla. Incluye asientos de cierre: el cierre salda las
  // cuentas de resultado contra 3.03 y ambos lados entran en la misma ventana (si se
  // excluyera, el cierre acreditaría 3.03 sin revertir los resultados → doble conteo).
  const grouped = await prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: {
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        ...(corte ? { date: corte } : {}),
      },
    },
  });

  const accounts = await prisma.account.findMany({
    where: { companyId, id: { in: grouped.map((g: any) => g.accountId) } },
    select: { id: true, code: true, name: true, type: true },
  });
  const byId = new Map(accounts.map((a: any) => [a.id, a]));

  const activos: any[] = [];
  const pasivos: any[] = [];
  const capital: any[] = [];
  // Acumuladores SIN redondear: el descuadre mide los datos reales, no el ruido de
  // redondeo de las filas que se pintan.
  let rawActivos = 0, rawPasivos = 0, rawCapital = 0, gananciaPeriodo = 0;

  for (const g of grouped) {
    const acc: any = byId.get(g.accountId);
    if (!acc) continue;
    const raw = (g._sum.debit || 0) - (g._sum.credit || 0);
    // Cada saldo se presenta en su naturaleza: ACTIVO deudor (débito−crédito) y
    // PASIVO/PATRIMONIO acreedor (crédito−débito). Los saldos contra-naturaleza
    // (p. ej. Depreciación Acumulada, o una pérdida en 3.03) salen en negativo.
    switch (acc.type) {
      case 'ACTIVO':
        rawActivos += raw;
        if (r2(raw) !== 0) activos.push({ code: acc.code, name: acc.name, saldo: r2(raw) });
        break;
      case 'PASIVO':
        rawPasivos += -raw;
        if (r2(-raw) !== 0) pasivos.push({ code: acc.code, name: acc.name, saldo: r2(-raw) });
        break;
      case 'PATRIMONIO':
        rawCapital += -raw;
        if (r2(-raw) !== 0) capital.push({ code: acc.code, name: acc.name, saldo: r2(-raw) });
        break;
      // Las cuentas de resultado no van al balance: su saldo no cerrado entra como
      // "Ganancia del periodo" (misma aritmética que la Utilidad Neta del Estado de
      // Resultados: ingresos − costos − gastos, en naturaleza acreedora).
      case 'INGRESO':
        gananciaPeriodo += -raw;
        break;
      case 'GASTO':
      case 'COSTO':
        gananciaPeriodo -= raw;
        break;
    }
  }
  gananciaPeriodo = r2(gananciaPeriodo);

  const porCodigo = (a: any, b: any) => a.code.localeCompare(b.code, undefined, { numeric: true });
  activos.sort(porCodigo); pasivos.sort(porCodigo); capital.sort(porCodigo);

  // Los totales suman las filas ya redondeadas para que la columna cuadre a la vista;
  // el descuadre se mide aparte sobre los acumuladores crudos.
  const totalActivos = r2(activos.reduce((s, a) => s + a.saldo, 0));
  const totalPasivos = r2(pasivos.reduce((s, a) => s + a.saldo, 0));
  const totalCuentas = r2(capital.reduce((s, a) => s + a.saldo, 0));
  const totalCapital = r2(totalCuentas + gananciaPeriodo);
  const pasivoCapital = r2(totalPasivos + totalCapital);
  // Comprobación real (antes se forzaba el patrimonio a Activos − Pasivos, así que
  // salía BALANCEADA siempre): aquí solo descuadra si hay asientos desbalanceados
  // o líneas huérfanas de cuentas borradas.
  const diferencia = r2(rawActivos - rawPasivos - (rawCapital + gananciaPeriodo));

  return {
    periodo: { start: null, end: corte?.lte ?? null, anioFiscal, acumulado: true },
    activos: { detalle: activos, total: totalActivos },
    pasivos: { detalle: pasivos, total: totalPasivos },
    capital: { detalle: capital, totalCuentas, gananciaPeriodo, total: totalCapital },
    ecuacion: { ok: diferencia === 0, pasivoCapital, diferencia },
  };
}

reportsRouter.get('/balance-general', async (req, res) => {
  const { endDate } = req.query;
  const report = await buildBalanceGeneral(req.prisma, req.user!.companyId, endDate as string | undefined);
  res.json(report);
});

reportsRouter.get('/estado-resultados', async (req, res) => {
  const { startDate, endDate } = req.query;
  const journalEntry: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false,
  };
  // Sin filtro de fechas → año fiscal activo (consistente con el balance)
  const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
  const rango = anioFiscalRange(anioFiscal);
  const dateFilter = startDate || endDate
    ? buildDateFilter(startDate as string, endDate as string)
    : { gte: rango.start, lte: rango.end };
  if (dateFilter) journalEntry.date = dateFilter;

  const where: Record<string, unknown> = {
    journalEntry,
    account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
  };

  // Agregación en BD (GROUP BY accountId)
  const grouped = await req.prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where,
  });

  const accounts = await req.prisma.account.findMany({
    where: { id: { in: grouped.map(g => g.accountId) } },
    select: { id: true, name: true, type: true },
  });
  const byId = new Map(accounts.map(a => [a.id, a]));

  let totalIngresos = 0;
  let totalGastos = 0;
  let totalCostos = 0;
  const ingresos: Record<string, number> = {};
  const gastos: Record<string, number> = {};
  const costos: Record<string, number> = {};

  for (const g of grouped) {
    const acc = byId.get(g.accountId);
    if (!acc) continue;
    const amount = (g._sum.credit || 0) - (g._sum.debit || 0);
    switch (acc.type) {
      case 'INGRESO':
        totalIngresos += amount;
        ingresos[acc.name] = (ingresos[acc.name] || 0) + amount;
        break;
      case 'GASTO':
        totalGastos += Math.abs(amount);
        gastos[acc.name] = (gastos[acc.name] || 0) + Math.abs(amount);
        break;
      case 'COSTO':
        totalCostos += Math.abs(amount);
        costos[acc.name] = (costos[acc.name] || 0) + Math.abs(amount);
        break;
    }
  }

  res.json({
    periodo: { start: rango.start, end: rango.end, anioFiscal },
    ingresos: { detalle: ingresos, total: totalIngresos },
    costos: { detalle: costos, total: totalCostos },
    gananciaBruta: totalIngresos - totalCostos,
    gastos: { detalle: gastos, total: totalGastos },
    utilidadNeta: totalIngresos - totalCostos - totalGastos,
  });
});

/**
 * Cuentas de efectivo de la empresa: el rango clásico del catálogo (Caja 1.1.01,
 * Bancos 1.1.02) o cualquiera marcada con alias de efectivo — mismo criterio que
 * ya usa admin.js para el selector de bancos. Los descendientes entran por prefijo
 * de código, así que marcar el padre alcanza para arrastrar sus subcuentas.
 */
async function cuentasEfectivo(prisma: any, companyId: string) {
  const CASH_CODES = ['1.1.01', '1.1.02'];
  const esAliasEfectivo = (a: string) => {
    const s = String(a || '').trim().toLowerCase();
    return s === 'caja' || s === 'banco' || s === 'efectivo' || s.startsWith('banco-');
  };

  const accs = await prisma.account.findMany({
    where: { companyId, type: 'ACTIVO' },
    select: { code: true, name: true, aliases: true },
    orderBy: { code: 'asc' },
  });
  const esRaiz = (a: any) =>
    CASH_CODES.some(c => a.code === c || String(a.code).startsWith(`${c}.`)) ||
    (a.aliases || []).some(esAliasEfectivo);

  const raices = accs.filter(esRaiz);
  return accs
    .filter((a: any) => raices.some((r: any) => a.code === r.code || String(a.code).startsWith(`${r.code}.`)))
    .map((a: any) => ({ code: a.code, name: a.name }));
}

/**
 * Flujo de efectivo con saldo corrido (libro de caja: no clasifica
 * operación/inversión/financiación, solo muestra entradas y salidas).
 * Con `startDate`, el saldo corrido arranca en `saldoInicial` (movimientos
 * anteriores al rango) para que no parezca que la empresa empezó en cero.
 * Única fuente de cálculo: la usan el GET /flujo-caja y el export.
 */
async function buildFlujoCaja(prisma: any, companyId: string, startDate?: string, endDate?: string) {
  const cuentas = await cuentasEfectivo(prisma, companyId);
  const codigos = cuentas.map((c: any) => c.code);
  const rango = buildDateFilter(startDate, endDate);
  const baseWhere: any = {
    journalEntry: {
      companyId,
      status: { notIn: ['RECHAZADO', 'ANULADO'] },
      isClosing: false,
    },
    account: { code: { in: codigos } },
  };
  if (!codigos.length) {
    return { periodo: { start: rango?.gte ?? null, end: rango?.lte ?? null }, cuentas, saldoInicial: 0, movimientos: [], saldoActual: 0 };
  }

  let saldo = 0;
  if (rango?.gte) {
    const prev = await prisma.journalLine.aggregate({
      _sum: { debit: true, credit: true },
      where: { ...baseWhere, journalEntry: { ...baseWhere.journalEntry, date: { lt: rango.gte } } },
    });
    saldo = r2((prev._sum.debit || 0) - (prev._sum.credit || 0));
  }
  const saldoInicial = saldo;

  const lines = await prisma.journalLine.findMany({
    where: { ...baseWhere, ...(rango ? { journalEntry: { ...baseWhere.journalEntry, date: rango } } : {}) },
    include: {
      journalEntry: { select: { date: true, description: true } },
      account: { select: { code: true, name: true } },
    },
    // `id` como desempate: dos líneas del mismo día pueden venir en cualquier orden
    // entre ejecuciones y el saldo corrido bailaría.
    orderBy: [{ journalEntry: { date: 'asc' } }, { id: 'asc' }],
  });

  let totalDebit = 0, totalCredit = 0;
  const movimientos = lines.map((l: any) => {
    saldo = r2(saldo + l.debit - l.credit);
    totalDebit += l.debit;
    totalCredit += l.credit;
    return {
      date: l.journalEntry.date,
      description: l.journalEntry.description,
      account: { code: l.account.code, name: l.account.name },
      debit: r2(l.debit),
      credit: r2(l.credit),
      saldo,
    };
  });

  return {
    periodo: { start: rango?.gte ?? null, end: rango?.lte ?? null },
    cuentas,
    saldoInicial,
    movimientos,
    totalDebit: r2(totalDebit),
    totalCredit: r2(totalCredit),
    saldoActual: saldo,
  };
}

reportsRouter.get('/flujo-caja', async (req, res) => {
  const { startDate, endDate } = req.query;
  const report = await buildFlujoCaja(req.prisma, req.user!.companyId, startDate as string | undefined, endDate as string | undefined);
  res.json(report);
});

reportsRouter.get('/dashboard', async (req, res) => {
  const { startDate, endDate } = req.query;
  const journalEntry: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false,
  };
  // El dashboard respeta el filtro de fechas del panel
  // Sin filtro de fechas → año fiscal activo (consistente con el balance)
  const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
  const rango = anioFiscalRange(anioFiscal);
  const dateFilter = startDate || endDate
    ? buildDateFilter(startDate as string, endDate as string)
    : { gte: rango.start, lte: rango.end };
  if (dateFilter) journalEntry.date = dateFilter;

  const baseWhere = {
    journalEntry,
    account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
  };

  // Totales y top-8 por cuenta en BD (GROUP BY accountId)
  const grouped = await req.prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: baseWhere,
  });

  const accounts = await req.prisma.account.findMany({
    where: { id: { in: grouped.map(g => g.accountId) } },
    select: { id: true, name: true, type: true },
  });
  const byId = new Map(accounts.map(a => [a.id, a]));

  const gastosPorCategoria: Record<string, number> = {};
  const ingresosPorCategoria: Record<string, number> = {};
  let totalIngresos = 0;
  let totalGastos = 0;
  let totalCostos = 0;

  for (const g of grouped) {
    const acc = byId.get(g.accountId);
    if (!acc) continue;
    if (acc.type === 'INGRESO') {
      const amount = (g._sum.credit || 0) - (g._sum.debit || 0);
      totalIngresos += amount;
      ingresosPorCategoria[acc.name] = (ingresosPorCategoria[acc.name] || 0) + amount;
    } else if (acc.type === 'GASTO') {
      const amount = (g._sum.debit || 0) - (g._sum.credit || 0);
      totalGastos += amount;
      gastosPorCategoria[acc.name] = (gastosPorCategoria[acc.name] || 0) + amount;
    } else if (acc.type === 'COSTO') {
      totalCostos += (g._sum.debit || 0) - (g._sum.credit || 0);
    }
  }

  // Mensual agregado en BD (GROUP BY mes + tipo).
  // Las fechas del filtro ya fueron validadas por buildDateFilter (Date válidos).
  let dateSql = '';
  if (dateFilter) {
    const gte = (dateFilter as any).gte.toISOString();
    const lte = (dateFilter as any).lte.toISOString();
    dateSql = `AND je.date >= '${gte}' AND je.date <= '${lte}'`;
  }
  const monthlyRows: any[] = await req.prisma.$queryRawUnsafe(`
    SELECT to_char(je.date, 'YYYY-MM') AS month, a.type,
           SUM(l.debit) AS deb, SUM(l.credit) AS cred
    FROM "JournalLine" l
    JOIN "JournalEntry" je ON l."journalEntryId" = je.id
    JOIN "Account" a ON l."accountId" = a.id
    WHERE je."companyId" = '${req.user!.companyId}'
      AND je.status NOT IN ('RECHAZADO', 'ANULADO') AND je."isClosing" = false
      AND a.type IN ('INGRESO', 'GASTO', 'COSTO')
      ${dateSql}
    GROUP BY 1, 2
    ORDER BY 1
  `);

  const monthlyMap = new Map<string, { ingresos: number; gastos: number; costos: number }>();
  for (const row of monthlyRows) {
    const m = monthlyMap.get(row.month) || { ingresos: 0, gastos: 0, costos: 0 };
    const amount = Number(row.cred) - Number(row.deb);
    if (row.type === 'INGRESO') m.ingresos += amount;
    else if (row.type === 'GASTO') m.gastos += Math.abs(amount);
    else if (row.type === 'COSTO') m.costos += Math.abs(amount);
    monthlyMap.set(row.month, m);
  }

  const monthly = Array.from(monthlyMap.entries()).map(([month, data]) => ({
    month,
    ingresos: Math.round(data.ingresos * 100) / 100,
    gastos: Math.round(data.gastos * 100) / 100,
    costos: Math.round(data.costos * 100) / 100,
    neto: Math.round((data.ingresos - data.gastos - data.costos) * 100) / 100,
  }));

  const topGastos = Object.entries(gastosPorCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([nombre, total]) => ({ nombre, total: Math.round(total * 100) / 100 }));

  const topIngresos = Object.entries(ingresosPorCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([nombre, total]) => ({ nombre, total: Math.round(total * 100) / 100 }));

  const utilidadNeta = totalIngresos - totalGastos - totalCostos;

  res.json({
    periodo: { start: rango.start, end: rango.end, anioFiscal },
    monthly,
    resumen: {
      totalIngresos: Math.round(totalIngresos * 100) / 100,
      totalGastos: Math.round(totalGastos * 100) / 100,
      totalCostos: Math.round(totalCostos * 100) / 100,
      utilidadNeta: Math.round(utilidadNeta * 100) / 100,
      meses: monthly.length,
    },
    topGastos,
    topIngresos,
  });
});

// ── Exportación de reportes ──
reportsRouter.get('/export/:type', async (req, res) => {
  const { type } = req.params;
  const format: ExportFormat = (req.query.format as string) === 'csv' ? 'csv' : 'xlsx';
  const { startDate, endDate, nivel, accountId } = req.query;

  try {
    let data: Record<string, unknown>;

    switch (type) {
      case 'balance-comprobacion': {
        // Misma doble dimensión que el GET: débito/crédito del período,
        // saldo acumulado hasta el final — incluyendo asientos de cierre.
        const lastEntry = await req.prisma.journalEntry.findFirst({
          where: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
          orderBy: { date: 'desc' },
          select: { date: true },
        });
        const anioFiscal = lastEntry ? lastEntry.date.getFullYear() : new Date().getFullYear();
        const pStart = startDate ? new Date(`${startDate}T00:00:00.000Z`) : new Date(`${anioFiscal}-01-01T00:00:00.000Z`);
        const pEnd = endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date(`${anioFiscal}-12-31T23:59:59.999Z`);

        const [movLines, saldoLines] = await Promise.all([
          req.prisma.journalLine.findMany({
            where: { journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, date: { gte: pStart, lte: pEnd } } },
            include: { account: true },
          }),
          req.prisma.journalLine.findMany({
            where: { journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, date: { lte: pEnd } } },
            include: { account: true },
          }),
        ]);
        const saldoMap = new Map<string, number>();
        for (const l of saldoLines) saldoMap.set(l.accountId, (saldoMap.get(l.accountId) || 0) + l.debit - l.credit);
        const movMap = new Map<string, { d: number; c: number }>();
        for (const l of movLines) {
          const e = movMap.get(l.accountId) || { d: 0, c: 0 };
          e.d += l.debit; e.c += l.credit;
          movMap.set(l.accountId, e);
        }
        const seen = new Set<string>();
        const result: any[] = [];
        for (const l of [...saldoLines, ...movLines]) {
          if (seen.has(l.accountId)) continue;
          seen.add(l.accountId);
          const m = movMap.get(l.accountId) || { d: 0, c: 0 };
          const rawBal = saldoMap.get(l.accountId) || 0;
          result.push({
            account: { code: l.account.code, name: l.account.name, type: l.account.type },
            totalDebit: Math.round(m.d * 100) / 100,
            totalCredit: Math.round(m.c * 100) / 100,
            balance: Math.round(Math.abs(rawBal) * 100) / 100,
            balanceType: rawBal > 0 ? 'DEUDOR' : 'ACREEDOR',
          });
        }
        // ?nivel=3 → el archivo exportado sale totalizado por cuenta de nivel 3
        // (mismo modo que el botón "📊 Nivel 3" de la pantalla)
        let out = result;
        if (String(nivel) === '3') {
          const accs = await req.prisma.account.findMany({
            where: { companyId: req.user!.companyId },
            select: { code: true, name: true },
          });
          out = rollupNivel3(result, new Map(accs.map((a: any) => [a.code, a.name])));
        }
        data = out.sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true })) as unknown as Record<string, unknown>;
        break;
      }

      case 'balance-general': {
        // Mismo cálculo que la pantalla (buildBalanceGeneral): antes el export
        // sumaba con otros signos y el archivo no coincidía con el GET.
        data = await buildBalanceGeneral(req.prisma, req.user!.companyId, endDate as string | undefined);
        break;
      }

      case 'estado-resultados': {
        const journalEntry: Record<string, unknown> = {
          companyId: req.user!.companyId,
          status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false,
        };
        // Sin filtro de fechas → año fiscal activo
        const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
        const rango = anioFiscalRange(anioFiscal);
        const dateFilter = startDate || endDate
          ? buildDateFilter(startDate as string, endDate as string)
          : { gte: rango.start, lte: rango.end };
        if (dateFilter) journalEntry.date = dateFilter;
        const lines = await req.prisma.journalLine.findMany({
          where: {
            journalEntry,
            account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
          },
          include: { account: true },
        });
        let totalIngresos = 0, totalGastos = 0, totalCostos = 0;
        const ingresos: Record<string, number> = {};
        const gastos: Record<string, number> = {};
        const costos: Record<string, number> = {};
        for (const line of lines) {
          const amount = line.credit - line.debit;
          switch (line.account.type) {
            case 'INGRESO':
              totalIngresos += amount;
              ingresos[line.account.name] = (ingresos[line.account.name] || 0) + amount;
              break;
            case 'GASTO':
              totalGastos += Math.abs(amount);
              gastos[line.account.name] = (gastos[line.account.name] || 0) + Math.abs(amount);
              break;
            case 'COSTO':
              totalCostos += Math.abs(amount);
              costos[line.account.name] = (costos[line.account.name] || 0) + Math.abs(amount);
              break;
          }
        }
        data = {
          ingresos: { detalle: ingresos, total: totalIngresos },
          costos: { detalle: costos, total: totalCostos },
          gananciaBruta: totalIngresos - totalCostos,
          gastos: { detalle: gastos, total: totalGastos },
          utilidadNeta: totalIngresos - totalCostos - totalGastos,
        };
        break;
      }

      case 'flujo-caja': {
        data = await buildFlujoCaja(req.prisma, req.user!.companyId, startDate as string | undefined, endDate as string | undefined);
        break;
      }

      case 'diario': {
        const where: Record<string, unknown> = { companyId: req.user!.companyId, isClosing: false };
        const statusParam = req.query.status as string;
        if (statusParam) where.status = statusParam;
        // Sin filtro de fechas → año fiscal activo
        const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
        const rango = anioFiscalRange(anioFiscal);
        const dateFilter = startDate || endDate
          ? buildDateFilter(startDate as string, endDate as string)
          : { gte: rango.start, lte: rango.end };
        if (dateFilter) where.date = dateFilter;
        const entries = await req.prisma.journalEntry.findMany({
          where,
          include: {
            lines: { include: { account: true } },
            createdBy: { select: { name: true } },
          },
          orderBy: { date: 'desc' },
        });
        data = { entries };
        break;
      }

      case 'proveedores': {
        // Con accountId → Anexos-DGI por cuenta (mismo path y misma pestaña)
        if (accountId) {
          const cuentaInfo = await req.prisma.account.findFirst({
            where: { id: String(accountId), companyId: req.user!.companyId },
            select: { id: true, code: true, name: true, requiresAnexo: true },
          });
          if (!cuentaInfo) { res.status(404).json({ error: 'Cuenta no encontrada' }); return; }
          data = await buildAnexosDgiReport(req.prisma, req.user!.companyId, {
            cuenta: cuentaInfo,
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
          });
          break;
        }
        data = await buildProveedoresReport(req.prisma, req.user!.companyId, startDate as string | undefined, endDate as string | undefined);
        break;
      }

      default:
        res.status(400).json({
          error: 'Tipo de reporte no soportado',
          tipos: ['balance-comprobacion', 'balance-general', 'estado-resultados', 'flujo-caja', 'diario', 'proveedores'],
        });
        return;
    }

    const { buffer, contentType, filename } = await exportReport(format, type, data);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
  } catch (error: any) {
    console.error('[Export] Error:', error);
    res.status(500).json({ error: 'Error al generar el reporte', detail: error?.message });
  }
});
