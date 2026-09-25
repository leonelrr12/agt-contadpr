import { r2, sumarMontos } from '../lib/money';
import { resolverCuentasPlanilla } from './payroll-parametros';

/**
 * Cuadre de la planilla: compara lo que las corridas dicen con lo que quedó en el
 * mayor, y muestra las diferencias. **No arregla nada** — es la doctrina del cuadre
 * de inventario: un cuadre que se auto-corrige esconde el error en vez de mostrarlo.
 *
 * Cuatro preguntas, que son las cuatro formas en que una nómina se descuadra:
 *
 *  1. **El neto.** ¿Lo que las corridas dicen que se pagó salió del banco?
 *  2. **Los pasivos.** ¿Lo que se devengó es lo que dice la cuenta por pagar? Como
 *     pagar solo puede bajarla, un saldo MAYOR que lo devengado es imposible sin que
 *     alguien haya tocado la cuenta por fuera del módulo.
 *  3. **Los asientos que no están vivos.** Un asiento rechazado o anulado no existe
 *     para el mayor, pero su corrida sigue contando para los acumulados.
 *  4. **Quién no cobró.** Empleados activos sin ninguna corrida en el período: el
 *     olvido más caro, porque no genera ningún error.
 */

export interface ComparacionPasivo {
  /** Lo que dice la cuenta por pagar. */
  mayor: number;
  /** Lo que el módulo devengó hasta la fecha. */
  devengado: number;
  /** Lo que se pagó: la diferencia, que nunca puede ser negativa. */
  pagado: number;
  diferencia: number;
}

export interface CuadrePlanilla {
  desde: string;
  hasta: string;
  corridas: { total: number; ejecutadas: number; anuladas: number; borrador: number };
  neto: { corridas: number; banco: number; diferencia: number };
  pasivos: { ss: ComparacionPasivo; se: ComparacionPasivo; isr: ComparacionPasivo };
  asientos: Record<string, number>;
  itemsProblematicos: { empleado: string; corrida: string; periodo: string; asiento: string; estado: string }[];
  sinCorrida: { id: string; nombre: string; tipoPago: string }[];
  avisos: string[];
}

/** Saldo de una cuenta de pasivo: créditos − débitos, sin RECHAZADO ni ANULADO. */
async function saldoPasivo(prisma: any, companyId: string, accountId: string | null, hasta: Date): Promise<number> {
  if (!accountId) return 0;
  const agg = await prisma.journalLine.aggregate({
    _sum: { debit: true, credit: true },
    where: {
      accountId,
      journalEntry: { companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] }, date: { lte: hasta } },
    },
  });
  return r2((agg._sum.credit || 0) - (agg._sum.debit || 0));
}

function comparar(mayor: number, devengado: number): ComparacionPasivo {
  return { mayor, devengado, pagado: r2(devengado - mayor), diferencia: r2(mayor - devengado) };
}

export async function cuadrePlanilla(
  prisma: any,
  companyId: string,
  opts: { desde: string; hasta: string },
): Promise<CuadrePlanilla> {
  const { cuentas } = await resolverCuentasPlanilla(prisma, companyId);
  const desde = new Date(`${opts.desde}T12:00:00`);
  const hasta = new Date(`${opts.hasta}T12:00:00`);

  const corridas: any[] = await prisma.payrollRun.findMany({
    where: { companyId, fechaPago: { gte: desde, lte: hasta } },
    orderBy: { fechaPago: 'asc' },
  });
  const idsVivas = corridas.filter((c) => c.status !== 'ANULADA').map((c) => c.id);

  // Los ítems de la VENTANA: sirven para el neto y para los asientos.
  const items: any[] = idsVivas.length
    ? await prisma.payrollItem.findMany({
        where: { companyId, runId: { in: idsVivas } },
        include: { employee: { select: { nombre: true } }, run: { select: { periodo: true, tipo: true } } },
      })
    : [];

  // Los ítems HISTÓRICOS: el pasivo del mayor acumula desde siempre, así que
  // compararlo contra la ventana daría una diferencia inventada por el corte.
  const historicos: any[] = await prisma.payrollItem.findMany({
    where: { companyId, run: { status: { not: 'ANULADA' }, fechaPago: { lte: hasta } } },
    select: { ss: true, ssPatronal: true, riesgosPatronal: true, se: true, sePatronal: true, isr: true },
  });

  // ── 1. El neto: lo que dicen las corridas vs lo que salió del banco ──
  const netoCorridas = sumarMontos(...items.map((i) => i.neto));

  const bancos: any[] = await prisma.account.findMany({
    where: { companyId, code: { startsWith: '1.1.02' } },
    select: { id: true },
  });
  const idsBancos = bancos.map((b) => b.id);

  const asientoIds = items.map((i) => i.journalEntryId).filter(Boolean);
  let netoBanco = 0;
  if (asientoIds.length && idsBancos.length) {
    const agg = await prisma.journalLine.aggregate({
      _sum: { debit: true, credit: true },
      where: {
        accountId: { in: idsBancos },
        journalEntryId: { in: asientoIds },
        // El reverso de una anulación no es parte del pago original: es la
        // corrección. Los asientos que no están vivos se reportan aparte.
        journalEntry: { status: { notIn: ['RECHAZADO'] } },
      },
    });
    // `crédito − débito`: el banco es un ACTIVO, así que pagar lo ACREDITA. Con el
    // signo al revés la diferencia salía del doble del neto, que es justo lo que
    // este cuadre tiene que estar mirando.
    netoBanco = r2((agg._sum.credit || 0) - (agg._sum.debit || 0));
  }

  // ── 2. Los pasivos ──
  const devSS = sumarMontos(...historicos.map((i) => i.ss + i.ssPatronal + i.riesgosPatronal));
  const devSE = sumarMontos(...historicos.map((i) => i.se + i.sePatronal));
  const devISR = sumarMontos(...historicos.map((i) => i.isr));

  const [ssMayor, seMayor, isrMayor] = await Promise.all([
    saldoPasivo(prisma, companyId, cuentas.ss, hasta),
    saldoPasivo(prisma, companyId, cuentas.se, hasta),
    saldoPasivo(prisma, companyId, cuentas.isr, hasta),
  ]);

  // ── 3. Los asientos que no están vivos ──
  const estados: Record<string, number> = {};
  const itemsProblematicos: CuadrePlanilla['itemsProblematicos'] = [];
  if (asientoIds.length) {
    const asientos: any[] = await prisma.journalEntry.findMany({
      where: { id: { in: asientoIds } },
      select: { id: true, status: true, anuladoPorId: true },
    });
    const porId = new Map(asientos.map((a) => [a.id, a]));
    for (const item of items) {
      const a = porId.get(item.journalEntryId);
      const estado = !a ? 'SIN_ASIENTO' : a.anuladoPorId ? 'ANULADO' : a.status;
      estados[estado] = (estados[estado] ?? 0) + 1;
      if (estado === 'RECHAZADO' || estado === 'ANULADO' || estado === 'SIN_ASIENTO') {
        itemsProblematicos.push({
          empleado: item.employee?.nombre ?? '—',
          corrida: item.run?.tipo ?? '—',
          periodo: item.run?.periodo ?? '—',
          asiento: item.journalEntryId ?? '—',
          estado,
        });
      }
    }
  }

  // ── 4. Quién no cobró ──
  const activos: any[] = await prisma.employee.findMany({
    where: { companyId, isActive: true },
    select: { id: true, nombre: true, tipoPago: true },
  });
  const conCorrida = new Set(items.map((i) => i.employeeId));
  const sinCorrida = activos.filter((e) => !conCorrida.has(e.id));

  // ── Avisos ──
  const avisos: string[] = [];
  const difNeto = r2(netoCorridas - netoBanco);
  if (Math.abs(difNeto) >= 0.01) {
    avisos.push(
      `El neto de las corridas del período (${netoCorridas.toFixed(2)}) no coincide con lo debitado a los bancos (${netoBanco.toFixed(2)}): ` +
        `${Math.abs(difNeto).toFixed(2)} de diferencia. Suele ser un asiento rechazado o editado a mano.`,
    );
  }
  for (const [etiqueta, mayor, devengado] of [
    ['Seguro Social', ssMayor, devSS],
    ['Seguro Educativo', seMayor, devSE],
    ['ISR', isrMayor, devISR],
  ] as const) {
    // Pagar solo puede bajar la cuenta, así que un saldo mayor que lo devengado
    // solo se explica con un crédito metido por fuera del módulo.
    if (mayor > devengado + 0.01) {
      avisos.push(
        `${etiqueta}: la cuenta por pagar tiene ${mayor.toFixed(2)} y el módulo devengó ${devengado.toFixed(2)} hasta la fecha. ` +
          'Hay algo acreditado en esa cuenta que no salió de la planilla.',
      );
    } else if (mayor < -0.01) {
      avisos.push(`${etiqueta}: la cuenta por pagar quedó en negativo (${mayor.toFixed(2)}). Se pagó más de lo que se devengó.`);
    }
  }
  if (itemsProblematicos.length > 0) {
    avisos.push(
      `${itemsProblematicos.length} asiento(s) de planilla rechazados o anulados: su corrida sigue contando para los acumulados.`,
    );
  }
  if (sinCorrida.length > 0) {
    avisos.push(`${sinCorrida.length} empleado(s) activos sin ninguna corrida en el período.`);
  }

  return {
    desde: opts.desde,
    hasta: opts.hasta,
    corridas: {
      total: corridas.length,
      ejecutadas: corridas.filter((c) => c.status === 'EJECUTADA').length,
      anuladas: corridas.filter((c) => c.status === 'ANULADA').length,
      borrador: corridas.filter((c) => c.status === 'BORRADOR').length,
    },
    neto: { corridas: netoCorridas, banco: netoBanco, diferencia: difNeto },
    pasivos: {
      ss: comparar(ssMayor, devSS),
      se: comparar(seMayor, devSE),
      isr: comparar(isrMayor, devISR),
    },
    asientos: estados,
    itemsProblematicos,
    sinCorrida,
    avisos,
  };
}
