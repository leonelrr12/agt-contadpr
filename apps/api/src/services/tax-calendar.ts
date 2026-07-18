/**
 * Servicio de Calendario Fiscal Panameño.
 * Genera obligaciones fiscales automáticamente y calcula estimados de ITBMS.
 */

interface ObligationDef {
  type: string;
  period: string;
  label: string;
  dueDate: Date;
  frequency: 'monthly' | 'annual' | 'quarterly';
}

/**
 * Genera las obligaciones fiscales pendientes para los próximos N meses.
 */
export async function generateUpcomingObligations(
  prisma: any,
  companyId: string,
): Promise<number> {
  const now = new Date();
  const obligations: ObligationDef[] = [];

  // ── Mensuales: próximos 3 meses ──
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthName = d.toLocaleDateString('es-PA', { month: 'long' });
    const year = d.getFullYear();

    // ITBMS — vence el día 15 del mes siguiente
    const itbmsDue = new Date(d.getFullYear(), d.getMonth() + 1, 15);
    if (itbmsDue >= now) {
      obligations.push({
        type: 'ITBMS',
        period,
        label: `Declaración ITBMS ${monthName} ${year}`,
        dueDate: itbmsDue,
        frequency: 'monthly',
      });
    }

    // CSS — vence el día 5 del mes siguiente
    const cssDue = new Date(d.getFullYear(), d.getMonth() + 1, 5);
    if (cssDue >= now) {
      obligations.push({
        type: 'CSS',
        period,
        label: `Cuota CSS ${monthName} ${year}`,
        dueDate: cssDue,
        frequency: 'monthly',
      });
    }
  }

  // ── Anuales ──
  const currentYear = now.getFullYear();

  // Aviso de Operación — vence marzo 31
  const avisoDue = new Date(currentYear, 2, 31); // Marzo 31
  if (now.getMonth() < 3 || (now.getMonth() === 2 && now.getDate() <= 31)) {
    obligations.push({
      type: 'AVISO',
      period: String(currentYear),
      label: `Aviso de Operación ${currentYear}`,
      dueDate: avisoDue,
      frequency: 'annual',
    });
  }

  // ISR — vence marzo 31
  const isrDue = new Date(currentYear, 2, 31);
  if (now < isrDue || now.getFullYear() < currentYear) {
    obligations.push({
      type: 'ISR',
      period: String(currentYear),
      label: `Declaración de Renta ISR ${currentYear}`,
      dueDate: isrDue,
      frequency: 'annual',
    });
  }

  // ── Insertar o actualizar ──
  let created = 0;
  for (const obl of obligations) {
    const existing = await prisma.taxObligation.findFirst({
      where: { companyId, type: obl.type, period: obl.period },
    });
    if (!existing) {
      // Calcular estimado para ITBMS
      let estimatedAmount: number | null = null;
      if (obl.type === 'ITBMS') {
        estimatedAmount = await estimateITBMS(prisma, companyId, obl.period);
      }

      await prisma.taxObligation.create({
        data: {
          companyId,
          type: obl.type,
          period: obl.period,
          label: obl.label,
          dueDate: obl.dueDate,
          estimatedAmount,
        },
      });
      created++;
    }
  }

  // ── Marcar vencidas ──
  await prisma.taxObligation.updateMany({
    where: {
      companyId,
      status: 'PENDING',
      dueDate: { lt: now },
    },
    data: { status: 'OVERDUE' },
  });

  return created;
}

/**
 * Calcula el ITBMS estimado para un período mensual basado en transacciones registradas.
 */
async function estimateITBMS(prisma: any, companyId: string, period: string): Promise<number> {
  const [year, month] = period.split('-').map(Number);
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0);

  // ITBMS por pagar = ITBMS de ventas - ITBMS de compras
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: '2.1.05' }, // ITBMS por Pagar
      journalEntry: {
        companyId,
        status: 'CONFIRMADO',
        date: { gte: startDate, lte: endDate },
      },
    },
  });

  // Débito a ITBMS = ITBMS de compras (crédito fiscal)
  // Crédito a ITBMS = ITBMS de ventas (débito fiscal)
  let itbmsVentas = 0;
  let itbmsCompras = 0;
  for (const line of lines) {
    if (line.credit > 0) itbmsVentas += line.credit;
    if (line.debit > 0) itbmsCompras += line.debit;
  }

  const neto = itbmsVentas - itbmsCompras;
  return Math.max(0, Math.round(neto * 100) / 100);
}

/**
 * Obtiene el resumen del calendario fiscal: próximas obligaciones + estadísticas.
 */
export async function getTaxCalendarSummary(prisma: any, companyId: string) {
  const now = new Date();
  const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const upcoming = await prisma.taxObligation.findMany({
    where: {
      companyId,
      dueDate: { gte: now, lte: thirtyDays },
      status: { not: 'COMPLETED' },
    },
    orderBy: { dueDate: 'asc' },
  });

  const overdue = await prisma.taxObligation.findMany({
    where: {
      companyId,
      status: 'OVERDUE',
    },
    orderBy: { dueDate: 'asc' },
  });

  const completed = await prisma.taxObligation.count({
    where: { companyId, status: 'COMPLETED' },
  });

  const total = await prisma.taxObligation.count({
    where: { companyId },
  });

  return {
    upcoming,
    overdue,
    stats: { completed, total, upcoming: upcoming.length, overdue: overdue.length },
    nextDeadline: upcoming.length > 0 ? upcoming[0] : null,
  };
}
