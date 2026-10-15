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
 * Vencimiento a MEDIODÍA local, la convención de fechas de solo día del repo
 * (`lib/dates.ts`, `parseLocalDate`): las columnas son `timestamp` y la UI las pinta
 * con la hora del navegador.
 *
 * A medianoche, en verano (el servidor corre en Nueva York, EDT), el instante cae a
 * las 23:00 del día anterior en Panamá: un ITBMS que vence el 15 de agosto se veía
 * **14/08** en pantalla y la obligación pasaba a OVERDUE la noche anterior (en
 * invierno las dos zonas coinciden y el bug no se notaba).
 */
function vencimientoAlMediodia(y: number, mesIndex: number, dia: number): Date {
  return new Date(y, mesIndex, dia, 12, 0, 0, 0);
}

/** Medianoche LOCAL de hoy: el corte de «el día del vencimiento ya pasó». */
function inicioDeHoy(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Último instante del día de un vencimiento: mientras no pase, el día cuenta. */
function finDelDia(fecha: Date): Date {
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate() + 1);
}

/** El mismo día de una fecha, pero a mediodía local (normaliza los datos viejos). */
function alMediodia(fecha: Date): Date {
  return new Date(fecha.getFullYear(), fecha.getMonth(), fecha.getDate(), 12, 0, 0, 0);
}

/**
 * Genera las obligaciones fiscales pendientes para los próximos N meses.
 *
 * `now` es inyectable para poder probar los bordes del calendario (el día del
 * vencimiento, el 31 de marzo del ISR) sin depender de la fecha en que corra el test.
 */
export async function generateUpcomingObligations(
  prisma: any,
  companyId: string,
  now: Date = new Date(),
): Promise<number> {
  const obligations: ObligationDef[] = [];

  // ── Mensuales: próximos 3 meses ──
  for (let i = 0; i < MESES_GENERADOS; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const monthName = d.toLocaleDateString('es-PA', { month: 'long' });
    const year = d.getFullYear();

    // ITBMS — vence el día 15 del mes siguiente
    const itbmsDue = vencimientoAlMediodia(d.getFullYear(), d.getMonth() + 1, 15);
    if (finDelDia(itbmsDue) > now) {
      obligations.push({
        type: 'ITBMS',
        period,
        label: `Declaración ITBMS ${monthName} ${year}`,
        dueDate: itbmsDue,
        frequency: 'monthly',
      });
    }

    // CSS — vence el día 5 del mes siguiente
    const cssDue = vencimientoAlMediodia(d.getFullYear(), d.getMonth() + 1, 5);
    if (finDelDia(cssDue) > now) {
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
  const avisoDue = vencimientoAlMediodia(currentYear, 2, 31); // Marzo 31
  if (finDelDia(avisoDue) > now) {
    obligations.push({
      type: 'AVISO',
      period: String(currentYear),
      label: `Aviso de Operación ${currentYear}`,
      dueDate: avisoDue,
      frequency: 'annual',
    });
  }

  // ISR — vence marzo 31
  const isrDue = vencimientoAlMediodia(currentYear, 2, 31);
  if (finDelDia(isrDue) > now) {
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
      // El estimado de las filas que ya existen se refresca al final, en una sola
      // pasada que cubre también las que quedaron fuera de la ventana: el saldo de
      // 2.1.05 cambia con cada asiento y el estimado viejo queda obsoleto.
      if (existing) continue;
      await prisma.taxObligation.create({
        data: {
          companyId,
          type: obl.type,
          period: obl.period,
          label: obl.label,
          dueDate: obl.dueDate,
          estimatedAmount: await estimateITBMS(prisma, companyId, obl.period),
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
  // El corte es el INICIO DEL DÍA, no la hora: una obligación que vence hoy sigue
  // vigente hasta que el día termina. Con `lt: now` y el vencimiento a medianoche, el
  // día del vencimiento ya contaba como vencido (y en verano, desde la noche anterior).
  await prisma.taxObligation.updateMany({
    where: {
      companyId,
      status: 'PENDING',
      dueDate: { lt: inicioDeHoy(now) },
    },
    data: { status: 'OVERDUE' },
  });

  // Y al revés: una obligación marcada vencida cuyo día todavía no pasó vuelve a
  // PENDING. Es la corrección de las filas que quedaron mal marcadas con el criterio
  // viejo (el 15-10-2026 había 9 vencidas así en producción) y deja el estado
  // cuadrando solo en cada corrida.
  await prisma.taxObligation.updateMany({
    where: {
      companyId,
      status: 'OVERDUE',
      dueDate: { gte: inicioDeHoy(now) },
    },
    data: { status: 'PENDING' },
  });

  // ── Refrescar los estimados de ITBMS que quedaron FUERA de la ventana ──
  //
  // El estimado de ITBMS es el saldo acumulado de 2.1.05 hasta el cierre del período,
  // y ese saldo cambia con cada asiento. Las filas vencidas —o de un mes que ya salió
  // de la ventana de 3— se quedaban con el número del día en que se crearon: en
  // Empresa Demo, julio y agosto seguían diciendo 382,25 y 380,57 con la empresa sin
  // un solo asiento (28-09). Las abiertas (PENDING y OVERDUE) siguen a los libros;
  // una COMPLETED no se toca —eso ya es historia— y un monto real tampoco: eso es lo
  // declarado.
  const abiertas: any[] = await prisma.taxObligation.findMany({
    where: { companyId, type: 'ITBMS', status: { in: ['PENDING', 'OVERDUE'] }, actualAmount: null },
    select: { id: true, period: true, estimatedAmount: true },
  });
  for (const obl of abiertas) {
    const estimatedAmount = await estimateITBMS(prisma, companyId, obl.period);
    if (obl.estimatedAmount !== estimatedAmount) {
      await prisma.taxObligation.update({ where: { id: obl.id }, data: { estimatedAmount } });
    }
  }

  // ── Normalizar los vencimientos guardados a medianoche ──
  //
  // Hasta el 15-10-2026 los vencimientos se guardaban a medianoche del servidor, y en
  // verano (EDT) eso cae a las 23:00 del día anterior en Panamá: un ITBMS del 15-ago
  // se veía 14/08. Se pasan a MEDIODÍA sin mover el día —la convención del repo— y la
  // corrida los arregla sola, sin SQL a mano. Idempotente: a la segunda no cambia nada.
  const pendientesDeHora: any[] = await prisma.taxObligation.findMany({
    where: { companyId },
    select: { id: true, dueDate: true },
  });
  for (const o of pendientesDeHora) {
    const mediodia = alMediodia(new Date(o.dueDate));
    if (mediodia.getTime() === new Date(o.dueDate).getTime()) continue;
    await prisma.taxObligation.update({ where: { id: o.id }, data: { dueDate: mediodia } });
  }

  return created;
}

/**
 * Calcula el ITBMS estimado para un período mensual basado en transacciones registradas.
 */
/**
 * Saldo acumulado pendiente de la cuenta 2.1.05 (ITBMS por Pagar):
 * créditos (ventas) - débitos (compras y pagos parciales a DGI), hasta la fecha dada.
 * Refleja lo realmente adeudado, incluyendo períodos anteriores sin declarar.
 *
 * Cuenta los MISMOS asientos que los informes: todo menos RECHAZADO y ANULADO. Exigir
 * CONFIRMADO dejaba el número en cero en una empresa con la contabilidad cargada y
 * sin aprobar —ODESA tenía 819 asientos en BORRADOR y el calendario le decía que no
 * debía ITBMS—, y contradecía al resto del sistema: el saldo de la CSS en Planilla
 * incluye los borradores a propósito, porque **lo que se debe no depende de que el
 * contador haya pasado por la cola de revisión**.
 */
export async function getSaldoITBMS(prisma: any, companyId: string, upTo?: Date): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: '2.1.05' }, // ITBMS por Pagar
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
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

/** Estimado de ITBMS de un período (`YYYY-MM`). Exportada para el test de regresión
 *  del corte del mes: el bug del último día no se ve sin ejercitar el rango. */
export async function estimateITBMS(prisma: any, companyId: string, period: string): Promise<number> {
  const [year, month] = period.split('-').map(Number);
  // El corte es el ÚLTIMO INSTANTE del mes en hora local, no la medianoche del último
  // día: los asientos se guardan a mediodía local (`parseLocalDate`), así que
  // `new Date(year, month, 0)` dejaba FUERA todo lo cargado el último día del mes (y el
  // reverso de una anulación, que se fecha con `new Date()`, a cualquier hora).
  const endDate = new Date(new Date(year, month, 1).getTime() - 1);
  return getSaldoITBMS(prisma, companyId, endDate);
}

/**
 * Le pone monto a una obligación que todavía no lo tiene, sin crear filas.
 *
 * Es la misma regla que el recálculo del ITBMS de arriba: **solo si está PENDING y
 * no tiene monto real**. Una vez que el contador registró lo que efectivamente
 * pagó (`actualAmount`), el estimado deja de importar y no se le pasa por encima.
 *
 * No crea la fila si no existe —el generador mantiene un horizonte de 3 meses y
 * inventar obligaciones fuera de él llenaría la tabla de períodos que nadie pidió—;
 * devuelve el motivo para que quien llama pueda decirlo en pantalla.
 */
export async function valorarObligacion(
  prisma: any,
  companyId: string,
  type: string,
  period: string,
  monto: number,
): Promise<{ actualizada: boolean; motivo?: string }> {
  const obligacion = await prisma.taxObligation.findFirst({
    where: { companyId, type, period },
  });

  if (!obligacion) {
    return { actualizada: false, motivo: 'El período todavía no está en el calendario fiscal.' };
  }
  if (obligacion.status !== 'PENDING') {
    return { actualizada: false, motivo: `La obligación ya está en estado ${obligacion.status}.` };
  }
  if (obligacion.actualAmount != null) {
    return { actualizada: false, motivo: 'La obligación ya tiene un monto real registrado.' };
  }
  if (obligacion.estimatedAmount === monto) {
    return { actualizada: false, motivo: 'El monto ya estaba al día.' };
  }

  await prisma.taxObligation.update({
    where: { id: obligacion.id },
    data: { estimatedAmount: monto },
  });
  return { actualizada: true };
}

/** Marca una obligación como cumplida, con el monto que efectivamente se pagó. */
export async function marcarObligacionCumplida(
  prisma: any,
  companyId: string,
  type: string,
  period: string,
  monto: number,
  notas?: string,
): Promise<boolean> {
  const obligacion = await prisma.taxObligation.findFirst({ where: { companyId, type, period } });
  if (!obligacion) return false;

  await prisma.taxObligation.update({
    where: { id: obligacion.id },
    data: {
      status: 'COMPLETED',
      actualAmount: monto,
      completedAt: new Date(),
      ...(notas ? { notes: notas } : {}),
    },
  });
  return true;
}

/**
 * Contracara de `marcarObligacionCumplida`: devuelve la obligación a pendiente y le
 * borra el monto real (el «↩ Desmarcar» del calendario hace lo mismo a mano). La usa
 * la anulación de una declaración 430, que tiene que deshacer lo que hizo al presentar.
 *
 * El estado se recalcula por fecha —vencida si el día del vencimiento ya pasó— con el
 * mismo criterio del generador, para no dejarla en un estado que no le toca.
 */
export async function desmarcarObligacion(
  prisma: any,
  companyId: string,
  type: string,
  period: string,
): Promise<boolean> {
  const obligacion = await prisma.taxObligation.findFirst({ where: { companyId, type, period } });
  if (!obligacion) return false;

  const hoy = new Date();
  const vencida = new Date(obligacion.dueDate) < new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  await prisma.taxObligation.update({
    where: { id: obligacion.id },
    data: {
      status: vencida ? 'OVERDUE' : 'PENDING',
      actualAmount: null,
      completedAt: null,
      notes: null,
    },
  });
  return true;
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
 * calendario no cubre.
 *
 * La línea es CONTINUA: todo mes del horizonte que no tenga una obligación
 * VALORADA recibe una estimación, no solo los que quedan más allá de los
 * MESES_GENERADOS que el generador mantiene. Importa por dos motivos que se dan
 * juntos en producción: hay meses sin fila ninguna, y hay meses con fila pero en
 * cero (`estimateITBMS` las crea en 0 hasta que hay movimiento en 2.1.05). Dejar
 * cualquiera de los dos en cero no es prudente: es esconder un pago que va a
 * ocurrir, y hace que el saldo proyectado salga optimista.
 *
 * Se extrapola SIN escribir en BD: la cadencia es determinista (el día sale de la
 * última ocurrencia conocida) y el monto es el último conocido del tipo.
 *
 * No se extiende el generador a 12 meses a propósito: `estimateITBMS` calcula el
 * saldo de 2.1.05 hasta el fin del período, y para un período futuro ese saldo es
 * el de HOY — repetiría el mismo ITBMS doce veces y además llenaría de filas
 * PENDING la BD de producción.
 *
 * Un tipo sin ningún monto conocido no se extrapola: hoy CSS, ISR y Aviso se crean
 * sin monto, y ponerles una cifra sería peor que dejarlos en cero.
 */
export async function obligacionesProyectadas(
  prisma: any,
  companyId: string,
  opts: { now: Date; meses: number },
): Promise<ObligacionProyectada[]> {
  const fin = new Date(opts.now.getTime() + 30 * opts.meses * 86400000);

  const filas: any[] = await prisma.taxObligation.findMany({ where: { companyId } });
  const montoDe = (o: any) => o.actualAmount ?? o.estimatedAmount ?? 0;

  // Ancla por tipo: la ocurrencia más reciente CON monto. Da el importe y el día.
  const anclas = new Map<string, { amount: number; dia: number; dueDate: Date }>();
  for (const o of filas) {
    const monto = montoDe(o);
    if (monto <= 0 || !(o.type in VENCIMIENTO_MENSUAL)) continue;
    const fecha = new Date(o.dueDate);
    const previa = anclas.get(o.type);
    if (!previa || fecha > previa.dueDate) {
      anclas.set(o.type, { amount: monto, dia: fecha.getDate(), dueDate: fecha });
    }
  }

  // Filas vivas dentro del horizonte (una COMPLETED ya se pagó), por tipo|período.
  const vivas = new Map<string, { type: string; period: string; dueDate: Date; monto: number }>();
  for (const o of filas) {
    if (!['PENDING', 'OVERDUE'].includes(o.status)) continue;
    const due = new Date(o.dueDate);
    if (due > fin) continue;
    vivas.set(`${o.type}|${o.period}`, { type: o.type, period: o.period, dueDate: due, monto: montoDe(o) });
  }

  const result: ObligacionProyectada[] = [];

  // 1) Las filas valoradas son dato, y valen por sí mismas.
  for (const v of vivas.values()) {
    if (v.monto > 0) result.push({ type: v.type, period: v.period, dueDate: v.dueDate, amount: v.monto, estimado: false });
  }

  const estimar = (type: string, period: string, dueDate: Date) => {
    const ancla = anclas.get(type);
    if (!ancla) return; // sin un monto conocido no se inventa una cifra
    result.push({ type, period, dueDate, amount: ancla.amount, estimado: true });
  };

  // 2) Filas creadas pero SIN valorar. El generador las crea en cuanto entra el
  //    período, y `estimateITBMS` las deja en 0 si todavía no hay movimiento en
  //    2.1.05 — o sea que una fila en cero no es información, es un hueco con
  //    fecha. Se estiman con el último monto conocido, conservando su vencimiento.
  for (const v of vivas.values()) {
    if (v.monto === 0) estimar(v.type, v.period, v.dueDate);
  }

  // 3) Períodos sin ninguna fila. Se recorre desde el mes en curso: todos vencen el
  //    mes siguiente, así que ninguno cae en el pasado. Los anteriores no se
  //    rellenan a propósito — su vencimiento ya pasó y no consta que se pagaran.
  for (let i = 0; i < opts.meses; i++) {
    const m = new Date(opts.now.getFullYear(), opts.now.getMonth() + i, 1);
    const period = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`;
    for (const [type, ancla] of anclas) {
      if (vivas.has(`${type}|${period}`)) continue;
      const ultimoDia = new Date(m.getFullYear(), m.getMonth() + 2, 0).getDate();
      const dueDate = vencimientoAlMediodia(m.getFullYear(), m.getMonth() + 1, Math.min(ancla.dia, ultimoDia));
      if (dueDate > fin) continue;
      estimar(type, period, dueDate);
    }
  }

  return result;
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
      // Desde el inicio del día: una obligación que vence hoy se sigue viendo en el
      // panel después del mediodía (con `gte: now` desaparecía a la hora del vencimiento).
      dueDate: { gte: inicioDeHoy(now), lte: thirtyDays },
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
