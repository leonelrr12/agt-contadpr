/**
 * Cierre de año fiscal — asiento de cierre automático.
 * Vacía las cuentas de resultado (INGRESO/COSTO/GASTO) del año a la cuenta
 * 3.03 "Utilidad del Ejercicio" (crédito si ganancia, débito si pérdida).
 * El asiento nace CONFIRMADO y marcado isClosing (excluido de reportes).
 */

export interface YearBalances {
  year: string;
  totalIngresos: number;
  totalCostos: number;
  totalGastos: number;
  utilidadNeta: number;
  pendientesRevision: number; // asientos BORRADOR del período (no se incluyen en el cierre)
  saldosInvertidos: { code: string; name: string; type: string; saldo: number }[]; // cuentas con saldo contrario a su naturaleza
  lineas: { accountId: string; code: string; name: string; type: string; debit: number; credit: number }[];
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

/** Saldos de las cuentas de resultado del año (excluyendo asientos de cierre). */
export async function computeYearBalances(prisma: any, companyId: string, year: string): Promise<YearBalances> {
  const periodWhere = {
    companyId,
    date: {
      gte: new Date(`${year}-01-01T00:00:00.000Z`),
      lte: new Date(`${year}-12-31T23:59:59.999Z`),
    },
    // Solo asientos APROBADOS: los BORRADOR pendientes de revisión no forman
    // parte del resultado cerrado (podrían rechazarse/corregirse después).
    status: 'CONFIRMADO',
    isClosing: false,
  };

  const grouped = await prisma.journalLine.groupBy({
    by: ['accountId'],
    _sum: { debit: true, credit: true },
    where: { journalEntry: periodWhere, account: { type: { in: ['INGRESO', 'COSTO', 'GASTO'] } } },
  });

  // Asientos pendientes de revisión en el período (BORRADOR) — no cuentan en el cierre
  const pendientesRevision = await prisma.journalEntry.count({
    where: {
      companyId,
      date: {
        gte: new Date(`${year}-01-01T00:00:00.000Z`),
        lte: new Date(`${year}-12-31T23:59:59.999Z`),
      },
      status: 'BORRADOR',
      isClosing: false,
    },
  });

  if (grouped.length === 0) {
    return { year, totalIngresos: 0, totalCostos: 0, totalGastos: 0, utilidadNeta: 0, pendientesRevision, saldosInvertidos: [], lineas: [] };
  }

  const accounts = await prisma.account.findMany({
    where: { companyId, id: { in: grouped.map((g: any) => g.accountId) } },
    select: { id: true, code: true, name: true, type: true },
  });
  const accMap = new Map(accounts.map((a: any) => [a.id, a]));

  let totalIngresos = 0, totalCostos = 0, totalGastos = 0;
  const lineas: YearBalances['lineas'] = [];
  const saldosInvertidos: YearBalances['saldosInvertidos'] = [];

  for (const g of grouped) {
    const acc: any = accMap.get(g.accountId);
    if (!acc) continue;
    const debit = Number(g._sum.debit) || 0;
    const credit = Number(g._sum.credit) || 0;
    if (acc.type === 'INGRESO') {
      // Saldo normal (acreedor): credit - debit > 0 → débito en el cierre.
      // Saldo anómalo (deudor, asientos mal registrados): se salda con crédito,
      // REDUCE los ingresos y se ALERTA — la cuenta debe quedar en cero.
      const saldo = r2(credit - debit);
      if (saldo > 0) {
        totalIngresos = r2(totalIngresos + saldo);
        lineas.push({ accountId: acc.id, code: acc.code, name: acc.name, type: acc.type, debit: saldo, credit: 0 });
      } else if (saldo < 0) {
        const abs = Math.abs(saldo);
        totalIngresos = r2(totalIngresos - abs);
        lineas.push({ accountId: acc.id, code: acc.code, name: acc.name, type: acc.type, debit: 0, credit: abs });
        saldosInvertidos.push({ code: acc.code, name: acc.name, type: acc.type, saldo });
      }
    } else {
      // COSTO/GASTO (incluye 5.01.x): saldo normal (deudor) → crédito en el cierre.
      // Saldo anómalo (acreedor): se salda con débito, REDUCE el gasto y se ALERTA.
      const saldo = r2(debit - credit);
      if (saldo > 0) {
        if (acc.type === 'COSTO') totalCostos = r2(totalCostos + saldo);
        else totalGastos = r2(totalGastos + saldo);
        lineas.push({ accountId: acc.id, code: acc.code, name: acc.name, type: acc.type, debit: 0, credit: saldo });
      } else if (saldo < 0) {
        const abs = Math.abs(saldo);
        if (acc.type === 'COSTO') totalCostos = r2(totalCostos - abs);
        else totalGastos = r2(totalGastos - abs);
        lineas.push({ accountId: acc.id, code: acc.code, name: acc.name, type: acc.type, debit: abs, credit: 0 });
        saldosInvertidos.push({ code: acc.code, name: acc.name, type: acc.type, saldo });
      }
    }
  }

  const utilidadNeta = r2(totalIngresos - totalCostos - totalGastos);
  return { year, totalIngresos, totalCostos, totalGastos, utilidadNeta, pendientesRevision, saldosInvertidos, lineas };
}

/**
 * Cierra el año fiscal: crea el asiento de cierre en transacción atómica.
 * Guardia anti-duplicado: un asiento isClosing+period ACTIVO bloquea;
 * un asiento ANULADO permite re-cerrar. El índice único parcial es el backstop.
 */
export async function closeYear(
  prisma: any,
  companyId: string,
  userId: string,
  year: string,
): Promise<{ entry: any; balances: YearBalances }> {
  // Guardia anti-duplicado amigable — el más reciente (puede haber un ANULADO previo)
  const existing = await prisma.journalEntry.findFirst({
    where: { companyId, period: year, isClosing: true },
    orderBy: { createdAt: 'desc' },
  });
  if (existing && existing.status !== 'ANULADO') {
    throw Object.assign(
      new Error(`El año ${year} ya fue cerrado (asiento ${existing.id.slice(0, 8)}). Anula el asiento de cierre para volver a cerrar.`),
      { status: 400 },
    );
  }

  const balances = await computeYearBalances(prisma, companyId, year);
  if (balances.lineas.length === 0 && balances.utilidadNeta === 0) {
    throw Object.assign(new Error(`No hay movimientos de resultados en ${year}.`), { status: 400 });
  }

  // Cuenta destino: 3.03 Utilidad del Ejercicio (PATRIMONIO)
  const utilidadAccount = await prisma.account.findFirst({
    where: { companyId, code: '3.03', type: 'PATRIMONIO' },
  });
  if (!utilidadAccount) {
    throw Object.assign(new Error('No existe la cuenta 3.03 Utilidad del Ejercicio en el plan de cuentas.'), { status: 400 });
  }

  const lines = [...balances.lineas];
  if (balances.utilidadNeta > 0) {
    lines.push({ accountId: utilidadAccount.id, code: '3.03', name: utilidadAccount.name, type: 'PATRIMONIO', debit: 0, credit: balances.utilidadNeta });
  } else if (balances.utilidadNeta < 0) {
    lines.push({ accountId: utilidadAccount.id, code: '3.03', name: utilidadAccount.name, type: 'PATRIMONIO', debit: Math.abs(balances.utilidadNeta), credit: 0 });
  }

  try {
    const entry = await prisma.$transaction(async (tx: any) => {
      const je = await tx.journalEntry.create({
        data: {
          date: new Date(Number(year), 11, 31, 12, 0, 0), // 31-dic mediodía local
          description: `Cierre de año fiscal ${year}`,
          status: 'CONFIRMADO',
          companyId,
          createdById: userId,
          period: year,
          isClosing: true,
          lines: {
            create: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit })),
          },
        },
        include: { lines: { include: { account: true } } },
      });
      await tx.subscription.updateMany({
        where: { companyId, status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] } },
        data: { movementsUsed: { increment: 1 } },
      });
      return je;
    });
    return { entry, balances };
  } catch (e: any) {
    // Race: dos cierres concurrentes — el índice único parcial lo bloquea
    if (e.code === 'P2002') {
      throw Object.assign(new Error(`El año ${year} ya fue cerrado (solicitud concurrente).`), { status: 400 });
    }
    throw e;
  }
}
