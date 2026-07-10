import { Router } from 'express';

export const reportsRouter = Router();

reportsRouter.get('/balance-comprobacion', async (req, res) => {
  const { startDate, endDate } = req.query;

  const where: Record<string, unknown> = {
    journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' },
  };
  if (startDate || endDate) {
    where.journalEntry = { ...where.journalEntry as Record<string, unknown>, date: {} };
    if (startDate) (where.journalEntry as Record<string, unknown>).date = { ...(where.journalEntry as Record<string, unknown>).date as Record<string, unknown>, gte: new Date(startDate as string) };
    if (endDate) (where.journalEntry as Record<string, unknown>).date = { ...(where.journalEntry as Record<string, unknown>).date as Record<string, unknown>, lte: new Date(endDate as string) };
  }

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

  const result = Array.from(balanceMap.values()).map((b) => ({
    ...b,
    balance: Math.abs(b.totalDebit - b.totalCredit),
    balanceType: b.totalDebit > b.totalCredit ? 'DEUDOR' : 'ACREEDOR',
  }));

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
  const where: Record<string, unknown> = {
    journalEntry: { companyId: 'demo-company', status: 'CONFIRMADO' },
    account: { type: { in: ['INGRESO', 'GASTO', 'COSTO'] } },
  };

  if (startDate || endDate) {
    where.journalEntry = { ...where.journalEntry as Record<string, unknown>, date: {} };
    if (startDate) (where.journalEntry as Record<string, unknown>).date = { ...(where.journalEntry as Record<string, unknown>).date as Record<string, unknown>, gte: new Date(startDate as string) };
    if (endDate) (where.journalEntry as Record<string, unknown>).date = { ...(where.journalEntry as Record<string, unknown>).date as Record<string, unknown>, lte: new Date(endDate as string) };
  }

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
