import { Router } from 'express';
import { buildDateFilter } from '../lib/date-filter';
import { exportReport } from '../services/export';
import type { ExportFormat } from '../services/export';

export const reportsRouter = Router();

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
    metadata: { contains: 'provider' },
    journalEntry: { is: { status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false } },
  };
  const dateFilter = buildDateFilter(startDate, endDate);
  if (dateFilter) where.date = dateFilter;

  const txs = await prisma.transaction.findMany({
    where,
    select: { id: true, date: true, amount: true, metadata: true },
    orderBy: { date: 'asc' },
  });

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
    const hasItbms = Number(m.itbmsAmount) > 0;
    const amountTotal = Number(tx.amount) || 0;
    const itbms = hasItbms ? Math.round(Number(m.itbmsAmount) * 100) / 100 : 0;
    const subtotal = m.source ? Math.round((amountTotal - itbms) * 100) / 100 : amountTotal;
    const total = m.source ? amountTotal : Math.round((amountTotal + itbms) * 100) / 100;
    p.facturas++;
    p.subtotal = Math.round((p.subtotal + subtotal) * 100) / 100;
    p.itbms = Math.round((p.itbms + itbms) * 100) / 100;
    p.total = Math.round((p.total + total) * 100) / 100;
    p.detalle.push({
      transactionId: tx.id,
      invoiceNumber: m.invoiceNumber || null,
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
    periodo: { startDate: startDate || null, endDate: endDate || null },
    totalProveedores: lista.length,
    ...tot,
    proveedores: lista,
  };
}

reportsRouter.get('/proveedores', async (req, res) => {
  const { startDate, endDate } = req.query;
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

  // Año fiscal activo: año del último asiento no anulado (el cierre NO cuenta
  // para derivarlo — es del año anterior). Si no hay movimientos, año actual.
  const lastEntry = await req.prisma.journalEntry.findFirst({
    where: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
    orderBy: { date: 'desc' },
    select: { date: true },
  });
  const anioFiscal = lastEntry ? lastEntry.date.getFullYear() : new Date().getFullYear();

  const periodo = {
    start: startDate ? new Date(`${startDate}T00:00:00.000Z`) : new Date(`${anioFiscal}-01-01T00:00:00.000Z`),
    end: endDate ? new Date(`${endDate}T23:59:59.999Z`) : new Date(`${anioFiscal}-12-31T23:59:59.999Z`),
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

reportsRouter.get('/balance-general', async (req, res) => {
  // Agregación en BD (GROUP BY accountId); la lógica de signos queda en JS por cuenta
  const grouped = await req.prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: {
      journalEntry: {
        companyId: req.user!.companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        // INCLUYE asientos de cierre: el patrimonio debe reflejar la utilidad
        // del ejercicio en 3.03 y los resultados vacíos al iniciar un año nuevo.
      },
    },
  });

  const accounts = await req.prisma.account.findMany({
    where: { id: { in: grouped.map(g => g.accountId) } },
    select: { id: true, type: true },
  });
  const byId = new Map(accounts.map(a => [a.id, a]));

  let totalActivos = 0;
  let totalPasivos = 0;
  let totalPatrimonio = 0;

  for (const g of grouped) {
    const type = byId.get(g.accountId)?.type;
    const rawBal = (g._sum.debit || 0) - (g._sum.credit || 0); // debit - credit
    if (rawBal !== 0 && type) {
      switch (type) {
        case 'ACTIVO':
          totalActivos += rawBal;
          break;
        case 'PASIVO':
        case 'PATRIMONIO':
          // PASIVO y PATRIMONIO tienen naturaleza crédito: credit - debit
          totalPasivos += -rawBal;
          break;
        case 'INGRESO':
          // INGRESOS también son naturaleza crédito, van al patrimonio
          totalPatrimonio += -rawBal;
          break;
        case 'GASTO':
        case 'COSTO':
          // GASTOS y COSTOS reducen el patrimonio
          totalPatrimonio -= rawBal;
          break;
      }
    }
  }

  // Ajuste: Activos - Pasivos - Patrimonio = 0 → Activos = Pasivos + Patrimonio
  totalPasivos = Math.abs(totalPasivos);
  totalPatrimonio = totalActivos - totalPasivos;

  res.json({
    activos: { total: totalActivos },
    pasivos: { total: totalPasivos },
    patrimonio: { total: totalPatrimonio },
    ecuacion: totalActivos === totalPasivos + totalPatrimonio ? 'BALANCEADA' : 'DESBALANCEADA',
  });
});

reportsRouter.get('/estado-resultados', async (req, res) => {
  const { startDate, endDate } = req.query;
  const journalEntry: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false,
  };
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
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
    ingresos: { detalle: ingresos, total: totalIngresos },
    costos: { detalle: costos, total: totalCostos },
    gananciaBruta: totalIngresos - totalCostos,
    gastos: { detalle: gastos, total: totalGastos },
    utilidadNeta: totalIngresos - totalCostos - totalGastos,
  });
});

reportsRouter.get('/flujo-caja', async (req, res) => {
  const lines = await req.prisma.journalLine.findMany({
    where: {
      journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
      account: { code: { startsWith: '1.1.01' } },
    },
    include: { journalEntry: { select: { date: true, description: true } } },
    orderBy: { journalEntry: { date: 'asc' } },
  });

  let saldo = 0;
  const movimientos = lines.map((l) => {
    saldo += l.debit - l.credit;
    return {
      date: l.journalEntry.date,
      description: l.journalEntry.description,
      debit: l.debit,
      credit: l.credit,
      saldo,
    };
  });

  res.json({ movimientos, saldoActual: saldo });
});

reportsRouter.get('/dashboard', async (req, res) => {
  const baseWhere = {
    journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
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

  // Mensual agregado en BD (GROUP BY mes + tipo) — parametrizado, sin interpolación de usuario
  const monthlyRows: any[] = await req.prisma.$queryRaw`
    SELECT to_char(je.date, 'YYYY-MM') AS month, a.type,
           SUM(l.debit) AS deb, SUM(l.credit) AS cred
    FROM "JournalLine" l
    JOIN "JournalEntry" je ON l."journalEntryId" = je.id
    JOIN "Account" a ON l."accountId" = a.id
    WHERE je."companyId" = ${req.user!.companyId}
      AND je.status NOT IN ('RECHAZADO', 'ANULADO') AND je."isClosing" = false
      AND a.type IN ('INGRESO', 'GASTO', 'COSTO')
    GROUP BY 1, 2
    ORDER BY 1
  `;

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
  const { startDate, endDate } = req.query;

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
        data = result.sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true })) as unknown as Record<string, unknown>;
        break;
      }

      case 'balance-general': {
        const lines = await req.prisma.journalLine.findMany({
          where: { journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] } } },
          include: { account: true },
        });
        let totalActivos = 0, totalPasivos = 0, totalPatrimonio = 0;
        const accountBalances = new Map<string, number>();
        for (const line of lines) {
          const bal = (accountBalances.get(line.accountId) || 0) + line.debit - line.credit;
          accountBalances.set(line.accountId, bal);
        }
        for (const [accountId, bal] of accountBalances) {
          if (bal === 0) continue;
          // Buscar el tipo de cuenta desde las líneas originales (más eficiente: guardar en el map)
          const line = lines.find((l) => l.accountId === accountId);
          if (!line) continue;
          switch (line.account.type) {
            case 'ACTIVO': totalActivos += bal; break;
            case 'PASIVO': totalPasivos += bal; break;
            case 'PATRIMONIO': totalPatrimonio += bal; break;
          }
        }
        data = {
          activos: { total: totalActivos },
          pasivos: { total: totalPasivos },
          patrimonio: { total: totalPatrimonio },
          ecuacion: totalActivos === totalPasivos + totalPatrimonio ? 'BALANCEADA' : 'DESBALANCEADA',
        };
        break;
      }

      case 'estado-resultados': {
        const journalEntry: Record<string, unknown> = {
          companyId: req.user!.companyId,
          status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false,
        };
        const dateFilter = buildDateFilter(startDate as string, endDate as string);
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
        const lines = await req.prisma.journalLine.findMany({
          where: {
            journalEntry: { companyId: req.user!.companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, isClosing: false },
            account: { code: { startsWith: '1.1.01' } },
          },
          include: { journalEntry: { select: { date: true, description: true } } },
          orderBy: { journalEntry: { date: 'asc' } },
        });
        let saldo = 0;
        const movimientos = lines.map((l) => {
          saldo += l.debit - l.credit;
          return { date: l.journalEntry.date, description: l.journalEntry.description, debit: l.debit, credit: l.credit, saldo };
        });
        data = { movimientos, saldoActual: saldo };
        break;
      }

      case 'diario': {
        const where: Record<string, unknown> = { companyId: req.user!.companyId, isClosing: false };
        const statusParam = req.query.status as string;
        if (statusParam) where.status = statusParam;
        const dateFilter = buildDateFilter(startDate as string, endDate as string);
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
