import { Router } from 'express';
import { buildDateFilter } from '../lib/date-filter';
import { exportReport } from '../services/export';
import type { ExportFormat } from '../services/export';

export const reportsRouter = Router();

reportsRouter.get('/balance-comprobacion', async (req, res) => {
  const { startDate, endDate } = req.query;

  const journalEntry: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: 'CONFIRMADO',
  };
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) journalEntry.date = dateFilter;

  const where = { journalEntry };

  const lines = await req.prisma.journalLine.findMany({
    where,
    include: { account: true },
  });

  const balanceMap = new Map<string, { account: { code: string; name: string; type: string }; totalDebit: number; totalCredit: number }>();

  for (const line of lines) {
    const key = line.accountId;
    const existing = balanceMap.get(key) || {
      account: { code: line.account.code, name: line.account.name, type: line.account.type },
      totalDebit: 0,
      totalCredit: 0,
    };
    existing.totalDebit += line.debit;
    existing.totalCredit += line.credit;
    balanceMap.set(key, existing);
  }

  const result = Array.from(balanceMap.values())
    .map((b) => ({
      ...b,
      balance: Math.abs(b.totalDebit - b.totalCredit),
      balanceType: b.totalDebit > b.totalCredit ? 'DEUDOR' : 'ACREEDOR',
    }))
    .sort((a, b) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true }));

  res.json(result);
});

reportsRouter.get('/balance-general', async (req, res) => {
  const lines = await req.prisma.journalLine.findMany({
    where: { journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' } },
    include: { account: true },
  });

  let totalActivos = 0;
  let totalPasivos = 0;
  let totalPatrimonio = 0;

  const accountBalances = new Map<string, { account: { code: string; name: string; type: string }; balance: number }>();

  for (const line of lines) {
    const key = line.accountId;
    const existing = accountBalances.get(key) || {
      account: { code: line.account.code, name: line.account.name, type: line.account.type },
      balance: 0,
    };
    existing.balance += line.debit - line.credit;
    accountBalances.set(key, existing);
  }

  for (const [, value] of accountBalances) {
    const bal = value.balance;
    if (bal !== 0) {
      switch (value.account.type) {
        case 'ACTIVO': totalActivos += bal; break;
        case 'PASIVO': totalPasivos += bal; break;
        case 'PATRIMONIO': totalPatrimonio += bal; break;
      }
    }
  }

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
    status: 'CONFIRMADO',
  };
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) journalEntry.date = dateFilter;

  const where: Record<string, unknown> = {
    journalEntry,
    account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
  };

  const lines = await req.prisma.journalLine.findMany({
    where,
    include: { account: true },
  });

  let totalIngresos = 0;
  let totalGastos = 0;
  let totalCostos = 0;
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
      journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' },
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
  const lines = await req.prisma.journalLine.findMany({
    where: {
      journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' },
      account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
    },
    include: { account: true, journalEntry: { select: { date: true, description: true } } },
    orderBy: { journalEntry: { date: 'asc' } },
  });

  const monthlyMap = new Map<string, { ingresos: number; gastos: number; costos: number }>();
  const gastosPorCategoria: Record<string, number> = {};
  const ingresosPorCategoria: Record<string, number> = {};
  let totalIngresos = 0;
  let totalGastos = 0;
  let totalCostos = 0;

  for (const line of lines) {
    const month = line.journalEntry.date.toISOString().slice(0, 7);
    if (!monthlyMap.has(month)) monthlyMap.set(month, { ingresos: 0, gastos: 0, costos: 0 });
    const m = monthlyMap.get(month)!;

    if (line.account.type === 'INGRESO') {
      const amount = line.credit - line.debit;
      totalIngresos += amount;
      m.ingresos += amount;
      const cat = line.account.name;
      ingresosPorCategoria[cat] = (ingresosPorCategoria[cat] || 0) + amount;
    } else if (line.account.type === 'GASTO') {
      const amount = line.debit - line.credit;
      totalGastos += amount;
      m.gastos += amount;
      const cat = line.account.name;
      gastosPorCategoria[cat] = (gastosPorCategoria[cat] || 0) + amount;
    } else if (line.account.type === 'COSTO') {
      const amount = line.debit - line.credit;
      totalCostos += amount;
      m.costos += amount;
    }
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
        const journalEntry: Record<string, unknown> = {
          companyId: req.user!.companyId,
          status: 'CONFIRMADO',
        };
        const dateFilter = buildDateFilter(startDate as string, endDate as string);
        if (dateFilter) journalEntry.date = dateFilter;
        const lines = await req.prisma.journalLine.findMany({
          where: { journalEntry },
          include: { account: true },
        });
        const balanceMap = new Map<string, any>();
        for (const line of lines) {
          const existing = balanceMap.get(line.accountId) || {
            account: { code: line.account.code, name: line.account.name, type: line.account.type },
            totalDebit: 0, totalCredit: 0,
          };
          existing.totalDebit += line.debit;
          existing.totalCredit += line.credit;
          balanceMap.set(line.accountId, existing);
        }
        data = (Array.from(balanceMap.values()) as any[])
          .map((b: any) => ({
            ...b,
            balance: Math.abs(b.totalDebit - b.totalCredit),
            balanceType: b.totalDebit > b.totalCredit ? 'DEUDOR' : 'ACREEDOR',
          }))
          .sort((a: any, b: any) => a.account.code.localeCompare(b.account.code, undefined, { numeric: true })) as unknown as Record<string, unknown>;
        break;
      }

      case 'balance-general': {
        const lines = await req.prisma.journalLine.findMany({
          where: { journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' } },
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
          status: 'CONFIRMADO',
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
            journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' },
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
        const where: Record<string, unknown> = { companyId: 'demo-company' };
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

      default:
        res.status(400).json({
          error: 'Tipo de reporte no soportado',
          tipos: ['balance-comprobacion', 'balance-general', 'estado-resultados', 'flujo-caja', 'diario'],
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
