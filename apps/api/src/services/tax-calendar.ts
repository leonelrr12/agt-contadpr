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

/** Meses de obligaciones mensuales que este servicio mantiene en BD (ver generateUpcomingObligations). */
export const MESES_GENERADOS = 3;

/** Día del mes siguiente al período en que vence cada obligación mensual. Fuente única. */
const VENCIMIENTO_MENSUAL: Record<string, number> = { ITBMS: 15, CSS: 5 };

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
  for (let i = 0; i < MESES_GENERADOS; i++) {
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
    if (obl.type === 'ITBMS') {
      // Recalcular el estimado siempre (si no hay monto real) — el saldo pendiente
      // de 2.1.05 cambia con cada asiento; el estimado viejo queda obsoleto.
      const estimatedAmount = await estimateITBMS(prisma, companyId, obl.period);
      if (existing) {
        if (existing.status === 'PENDING' && existing.actualAmount == null && existing.estimatedAmount !== estimatedAmount) {
          await prisma.taxObligation.update({
            where: { id: existing.id },
            data: { estimatedAmount },
          });
        }
        continue;
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
      continue;
    }

    if (!existing) {
      await prisma.taxObligation.create({
        data: {
          companyId,
          type: obl.type,
          period: obl.period,
          label: obl.label,
          dueDate: obl.dueDate,
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
/**
 * Saldo acumulado pendiente de la cuenta 2.1.05 (ITBMS por Pagar):
 * créditos (ventas) - débitos (compras y pagos parciales a DGI), hasta la fecha dada.
 * Refleja lo realmente adeudado, incluyendo períodos anteriores sin declarar.
 */
export async function getSaldoITBMS(prisma: any, companyId: string, upTo?: Date): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: '2.1.05' }, // ITBMS por Pagar
      journalEntry: {
        companyId,
        status: 'CONFIRMADO',
        ...(upTo ? { date: { lte: upTo } } : {}),
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

async function estimateITBMS(prisma: any, companyId: string, period: string): Promise<number> {
  const [year, month] = period.split('-').map(Number);
  const endDate = new Date(year, month, 0);
  return getSaldoITBMS(prisma, companyId, endDate);
}

export interface ObligacionProyectada {
  type: string;
  period: string;
  dueDate: Date;
  amount: number;
  /** true = extrapolada (este período todavía no está en BD). Nunca presentarla como dato. */
  estimado: boolean;
}

/**
 * Obligaciones fiscales que entran en una proyección de caja: las reales que ya
 * están en BD dentro del horizonte, más las estimadas de los meses que el
 * calendario todavía no cubre.
 *
 * `generateUpcomingObligations` solo mantiene MESES_GENERADOS meses en BD, así que
 * proyectar a 6 o 12 sin esto mostraría cero impuestos en la mitad de la línea de
 * tiempo — y el saldo saldría optimista. Se extrapola SIN escribir en BD: la
 * cadencia es determinista (día 15 el ITBMS, día 5 el CSS, ambos del mes siguiente
 * al período), y el monto es el último conocido del tipo.
 *
 * No se extiende el generador a 12 meses a propósito: `estimateITBMS` calcula el
 * saldo de 2.1.05 hasta el fin del período, y para un período futuro ese saldo es
 * el de HOY — repetiría el mismo ITBMS doce veces y además llenaría de filas
 * PENDING la BD de producción.
 *
 * Un tipo sin ningún monto conocido no se extrapola: hoy CSS, ISR y Aviso se crean
 * sin monto, e inventarles una cifra sería peor que dejarlos en cero.
 */
export async function obligacionesProyectadas(
  prisma: any,
  companyId: string,
  opts: { now: Date; meses: number },
): Promise<ObligacionProyectada[]> {
  const fin = new Date(opts.now.getTime() + 30 * opts.meses * 86400000);

  const filas: any[] = await prisma.taxObligation.findMany({ where: { companyId } });

  // Reales: las pendientes que vencen dentro del horizonte. Una COMPLETED ya se pagó.
  const reales: ObligacionProyectada[] = filas
    .filter(o => ['PENDING', 'OVERDUE'].includes(o.status) && new Date(o.dueDate) <= fin)
    .map(o => ({
      type: o.type,
      period: o.period,
      dueDate: new Date(o.dueDate),
      amount: o.estimatedAmount ?? o.actualAmount ?? 0,
      estimado: false,
    }));

  // Ancla por tipo: la ocurrencia más reciente CON monto. Da el importe y el día.
  const anclas = new Map<string, { amount: number; dia: number; dueDate: Date }>();
  for (const o of filas) {
    const monto = o.actualAmount ?? o.estimatedAmount ?? 0;
    if (monto <= 0 || !(o.type in VENCIMIENTO_MENSUAL)) continue;
    const fecha = new Date(o.dueDate);
    const previa = anclas.get(o.type);
    if (!previa || fecha > previa.dueDate) {
      anclas.set(o.type, { amount: monto, dia: fecha.getDate(), dueDate: fecha });
    }
  }

  const yaEsta = new Set(reales.map(o => `${o.type}|${o.period}`));
  const estimadas: ObligacionProyectada[] = [];
  for (let i = MESES_GENERADOS; i < opts.meses; i++) {
    const m = new Date(opts.now.getFullYear(), opts.now.getMonth() + i, 1);
    const period = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    for (const [type, ancla] of anclas) {
      if (yaEsta.has(`${type}|${period}`)) continue;
      const ultimoDia = new Date(m.getFullYear(), m.getMonth() + 2, 0).getDate();
      const dueDate = new Date(m.getFullYear(), m.getMonth() + 1, Math.min(ancla.dia, ultimoDia));
      if (dueDate > fin) continue;
      estimadas.push({ type, period, dueDate, amount: ancla.amount, estimado: true });
    }
  }

  return [...reales, ...estimadas];
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
    saldoITBMS: await getSaldoITBMS(prisma, companyId),
    stats: { completed, total, upcoming: upcoming.length, overdue: overdue.length },
    nextDeadline: upcoming.length > 0 ? upcoming[0] : null,
  };
}
