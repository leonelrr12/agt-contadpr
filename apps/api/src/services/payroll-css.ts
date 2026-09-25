import { parseLocalDate } from '../lib/dates';
import { r2, sumarMontos } from '../lib/money';
import { logAudit } from './audit-log';
import { valorarObligacion, marcarObligacionCumplida } from './tax-calendar';
import { resolverCuentasPlanilla, PLANILLA_FIELDS } from './payroll-parametros';

/**
 * El lado CSS de la planilla: cuánto se le debe, cuándo vence y cómo se paga.
 *
 * La obligación mensual del calendario fiscal ya existía (`TaxObligation` tipo CSS,
 * vence el día 5) pero se creaba **sin monto**: el calendario sabía que había que
 * pagar y no cuánto. Acá se le pone el número real, que sale de las corridas.
 *
 * Dos cosas que este módulo NO hace, a propósito:
 *  · **No modela la obligación mensual del ISR retenido.** El catálogo de
 *    obligaciones solo tiene ITBMS, CSS, el ISR anual, el Aviso y la Tasa Única, y
 *    `VENCIMIENTO_MENSUAL` solo define ITBMS y CSS. Inventar un tipo y una fecha de
 *    vencimiento sería peor que mostrar el monto retenido con su nota.
 *  · **No inventa filas del calendario.** El generador mantiene 3 meses de
 *    horizonte; si el período no está ahí, se dice, no se crea.
 */

/** Meses hacia atrás, en orden cronológico, como 'YYYY-MM'. */
export function ultimosMeses(n: number, ahora = new Date()): string[] {
  const meses: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return meses.reverse();
}

/**
 * Saldo de una cuenta de PASIVO: créditos − débitos, solo de asientos vigentes.
 *
 * Es lo que se acreditó al retener y al devengar el aporte patronal, menos lo que se
 * debitó al pagar.
 *
 * **Incluye los asientos en BORRADOR**, a diferencia de `getSaldoITBMS`, que exige
 * CONFIRMADO. Es deliberado: lo que se le debe a la CSS no depende de que el
 * contador haya pasado por la cola de revisión. Con el filtro de CONFIRMADO, el
 * módulo diría "no le debés nada" justo después de correr la planilla, que es
 * exactamente cuando más importa el número. Un asiento RECHAZADO sí se excluye —
 * ese nunca existió—, y una anulación se netea sola porque su reverso es un asiento
 * vigente más.
 */
export async function saldoCuentaPasivo(
  prisma: any,
  companyId: string,
  accountId: string | null,
  upTo?: Date,
): Promise<number> {
  if (!accountId) return 0;
  const agg = await prisma.journalLine.aggregate({
    _sum: { debit: true, credit: true },
    where: {
      accountId,
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        ...(upTo ? { date: { lte: upTo } } : {}),
      },
    },
  });
  return r2((agg._sum.credit || 0) - (agg._sum.debit || 0));
}

export interface MesCSS {
  periodo: string;
  etiqueta: string;
  /** Retención al empleado. */
  ss: number;
  se: number;
  isr: number;
  /** Aporte del patrono, separado por concepto. */
  ssPatronal: number;
  sePatronal: number;
  riesgosPatronal: number;
  /** Lo que va a la CSS: la retención, el aporte patronal y los riesgos. */
  totalSS: number;
  /** Lo que va al Seguro Educativo. */
  totalSE: number;
  /** Cuántos asientos de planilla generaron esos montos. */
  corridas: number;
  obligacion: {
    id: string;
    dueDate: Date;
    status: string;
    estimatedAmount: number | null;
    actualAmount: number | null;
  } | null;
}

export interface ResumenCSS {
  meses: MesCSS[];
  /**
   * Lo que se le debe a la CSS HOY, sumando TODOS los períodos — no solo los meses
   * que devuelve `meses` (que solo mira hacia atrás N meses). Si difieren, es que
   * quedó algo sin pagar de antes, y la respuesta lo dice en `avisos`.
   */
  saldo: { ss: number; se: number; isr: number; total: number; deMesesMostrados: number };
  cuentas: { ss: any; se: any; isr: any };
  avisos: string[];
}

const NOMBRE_MES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function etiquetaDe(periodo: string): string {
  const [anio, mes] = periodo.split('-').map(Number);
  return `${NOMBRE_MES[mes - 1]} ${anio}`;
}

/**
 * Lo que se le debe a la CSS, mes a mes, más el saldo vivo de los pasivos.
 *
 * Los montos salen de los ÍTEMS de las corridas (no de los totales de la corrida):
 * los totales guardan deducciones y aporte patronal sumados, y la planilla de la CSS
 * los pide separados.
 */
export async function resumenCSS(
  prisma: any,
  companyId: string,
  opts: { meses?: number; ahora?: Date } = {},
): Promise<ResumenCSS> {
  const periodos = ultimosMeses(opts.meses ?? 6, opts.ahora);
  const { cuentas, faltantes, avisos: avisosCuentas } = await resolverCuentasPlanilla(prisma, companyId);

  if (faltantes.some((f) => f.clave === 'ss' || f.clave === 'se')) {
    return {
      meses: [],
      saldo: { ss: 0, se: 0, isr: 0, total: 0, deMesesMostrados: 0 },
      cuentas: { ss: null, se: null, isr: null },
      avisos: ['Configura la cuenta de Seguro Social y de Seguro Educativo para ver el saldo adeudado.'],
    };
  }

  const items: any[] = await prisma.payrollItem.findMany({
    where: {
      companyId,
      run: { status: { not: 'ANULADA' }, periodoMensual: { in: periodos } },
    },
    select: {
      ss: true, se: true, isr: true, ssPatronal: true, sePatronal: true, riesgosPatronal: true,
      run: { select: { periodoMensual: true, id: true } },
    },
  });

  const porMes = new Map<string, MesCSS>();
  for (const periodo of periodos) {
    porMes.set(periodo, {
      periodo, etiqueta: etiquetaDe(periodo),
      ss: 0, se: 0, isr: 0, ssPatronal: 0, sePatronal: 0, riesgosPatronal: 0,
      totalSS: 0, totalSE: 0, corridas: 0, obligacion: null,
    });
  }

  const corridasPorMes = new Map<string, Set<string>>();
  for (const item of items) {
    const mes = porMes.get(item.run.periodoMensual);
    if (!mes) continue;
    mes.ss = sumarMontos(mes.ss, item.ss);
    mes.se = sumarMontos(mes.se, item.se);
    mes.isr = sumarMontos(mes.isr, item.isr);
    mes.ssPatronal = sumarMontos(mes.ssPatronal, item.ssPatronal);
    mes.sePatronal = sumarMontos(mes.sePatronal, item.sePatronal);
    mes.riesgosPatronal = sumarMontos(mes.riesgosPatronal, item.riesgosPatronal);
    const set = corridasPorMes.get(item.run.periodoMensual) ?? new Set<string>();
    set.add(item.run.id);
    corridasPorMes.set(item.run.periodoMensual, set);
  }
  for (const [periodo, set] of corridasPorMes) {
    const mes = porMes.get(periodo);
    if (mes) mes.corridas = set.size;
  }
  for (const mes of porMes.values()) {
    // A la CSS se le paga la retención, el aporte patronal y los riesgos juntos.
    mes.totalSS = sumarMontos(mes.ss, mes.ssPatronal, mes.riesgosPatronal);
    mes.totalSE = sumarMontos(mes.se, mes.sePatronal);
  }

  const obligaciones: any[] = await prisma.taxObligation.findMany({
    where: { companyId, type: 'CSS', period: { in: periodos } },
  });
  for (const o of obligaciones) {
    const mes = porMes.get(o.period);
    if (mes) {
      mes.obligacion = {
        id: o.id,
        dueDate: o.dueDate,
        status: o.status,
        estimatedAmount: o.estimatedAmount,
        actualAmount: o.actualAmount,
      };
    }
  }

  const [saldoSS, saldoSE, saldoISR] = await Promise.all([
    saldoCuentaPasivo(prisma, companyId, cuentas.ss),
    saldoCuentaPasivo(prisma, companyId, cuentas.se),
    saldoCuentaPasivo(prisma, companyId, cuentas.isr),
  ]);

  const avisos = [...avisosCuentas];
  const meses = [...porMes.values()];
  if (meses.every((m) => m.corridas === 0)) {
    avisos.push('Todavía no hay ninguna corrida de planilla en estos meses: los montos salen de las corridas.');
  }
  const sinObligacion = meses.filter((m) => m.corridas > 0 && !m.obligacion);
  if (sinObligacion.length > 0) {
    avisos.push(
      `El calendario fiscal no tiene la obligación CSS de ${sinObligacion.map((m) => m.etiqueta).join(', ')}: ` +
        'solo mantiene los últimos 3 meses. El monto adeudado se ve igual, pero sin fecha de vencimiento.',
    );
  }

  // El ISR retenido se paga en el MISMO movimiento que la CSS, así que se informa
  // junto con el resto y se registra desde el formulario de abajo. Lo que se mira es
  // el SALDO, no lo devengado: si se mirara lo devengado, el aviso seguiría diciendo
  // "pendiente" después de haberlo pagado.
  //
  // Lo que este módulo no puede hacer es marcar una obligación del calendario por él:
  // el catálogo solo tiene ITBMS, CSS, el ISR anual, el Aviso y la Tasa Única, y no
  // hay una mensual de retenciones. El pago queda registrado igual.
  if (saldoISR > 0.01) {
    avisos.push(
      `Hay ${saldoISR.toFixed(2)} de ISR retenido pendiente de pago. Se descarga en el mismo movimiento ` +
        'que el Seguro Social y el Seguro Educativo, desde el formulario de abajo.',
    );
  }

  // El saldo es de TODOS los períodos; los meses que se muestran son solo una
  // ventana hacia atrás. Cuando no coinciden hay algo sin pagar de antes, y eso el
  // contador tiene que verlo: es la deuda que se le escapa de la vista.
  //
  // Solo se avisa cuando el saldo es MAYOR que lo devengado en la ventana: eso
  // significa que hay algo sin pagar de antes. Cuando es menor, es que se pagó —que
  // es lo normal— y avisar de eso convertiría cada pago en una falsa alarma.
  const deMesesMostrados = sumarMontos(...meses.map((m) => m.totalSS));
  const deAntes = r2(saldoSS - deMesesMostrados);
  if (deAntes >= 0.01) {
    avisos.push(`Quedan ${deAntes.toFixed(2)} de Seguro Social sin pagar de períodos anteriores a los que se muestran.`);
  }

  return {
    meses,
    saldo: {
      ss: saldoSS,
      se: saldoSE,
      isr: saldoISR,
      total: sumarMontos(saldoSS, saldoSE),
      deMesesMostrados,
    },
    cuentas: { ss: cuentas.ss || null, se: cuentas.se || null, isr: cuentas.isr || null },
    avisos,
  };
}

/**
 * Valoriza la obligación CSS del período con el monto real de las corridas.
 * No crea nada: si el período no está en el calendario, lo dice.
 */
export async function valorarCSS(prisma: any, companyId: string, periodo: string): Promise<{ actualizada: boolean; monto: number; motivo?: string }> {
  const items: any[] = await prisma.payrollItem.findMany({
    where: { companyId, run: { status: { not: 'ANULADA' }, periodoMensual: periodo } },
    select: { ss: true, ssPatronal: true, riesgosPatronal: true },
  });
  const monto = sumarMontos(...items.map((i) => i.ss + i.ssPatronal + i.riesgosPatronal));
  const res = await valorarObligacion(prisma, companyId, 'CSS', periodo, monto);
  return { ...res, monto };
}

// ─── Pago ────────────────────────────────────────────────────────────────────

export interface DatosPagoCSS {
  periodo: string;
  fecha: string;
  bancoCuentaId: string;
  montoSS: number;
  montoSE?: number;
  /**
   * ISR retenido a los empleados. Se registra acá, en el mismo movimiento que la
   * CSS, porque así se paga en la práctica: la liquidación del mes descarga las
   * cuatro cuentas por pagar de una vez y la CxP del Seguro Social queda en cero.
   */
  montoISR?: number;
  referencia?: string;
  notas?: string;
  /** Marca la obligación del calendario como cumplida (por defecto, sí). */
  marcarPagada?: boolean;
}

export interface ResultadoPagoCSS {
  journalEntryId: string;
  total: number;
  obligacionMarcada: boolean;
}

/**
 * Registra el pago a la CSS: debita los pasivos y acredita el banco.
 *
 * El asiento nace en BORRADOR, como todo en el sistema: quien lo aprueba es el
 * contador. Si se pidió marcar la obligación como cumplida y no existe la fila del
 * período, `obligacionMarcada` vuelve en false — el pago se registró igual.
 */
export async function registrarPagoCSS(
  prisma: any,
  companyId: string,
  userId: string,
  datos: DatosPagoCSS,
): Promise<ResultadoPagoCSS> {
  const montoSS = r2(datos.montoSS || 0);
  const montoSE = r2(datos.montoSE || 0);
  const montoISR = r2(datos.montoISR || 0);
  const total = sumarMontos(montoSS, montoSE, montoISR);

  if (total <= 0) {
    throw Object.assign(new Error('El pago tiene que tener un monto mayor que cero.'), { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(datos.periodo)) {
    throw Object.assign(new Error('El período debe venir como AAAA-MM.'), { status: 400 });
  }

  const { cuentas, faltantes } = await resolverCuentasPlanilla(prisma, companyId);
  const necesita: string[] = ['ss'];
  if (montoSE > 0) necesita.push('se');
  if (montoISR > 0) necesita.push('isr');
  const sinCuenta = faltantes.filter((f) => necesita.includes(f.clave));
  if (sinCuenta.length > 0) {
    throw Object.assign(
      new Error(`Configura la cuenta de ${sinCuenta.map((f) => f.etiqueta).join(', ')} antes de registrar el pago.`),
      { status: 400 },
    );
  }

  // El banco tiene que ser de la empresa Y ser una cuenta de pago: acreditar el pago
  // de la CSS contra, digamos, un ingreso, dejaría el pasivo cerrado y el banco mal.
  const banco = await prisma.account.findFirst({
    where: { id: datos.bancoCuentaId, companyId },
    select: { id: true, code: true, name: true },
  });
  if (!banco) {
    throw Object.assign(new Error('La cuenta bancaria no existe en esta empresa.'), { status: 400 });
  }
  if (!banco.code.startsWith('1.1.02')) {
    throw Object.assign(
      new Error(`"${banco.code} ${banco.name}" no es una cuenta de banco (1.1.02.*).`),
      { status: 400 },
    );
  }

  const lineas = [
    ...(montoSS > 0 ? [{ accountId: cuentas.ss, debit: montoSS, credit: 0 }] : []),
    ...(montoSE > 0 ? [{ accountId: cuentas.se, debit: montoSE, credit: 0 }] : []),
    ...(montoISR > 0 ? [{ accountId: cuentas.isr, debit: montoISR, credit: 0 }] : []),
    { accountId: banco.id, debit: 0, credit: total },
  ];

  // La descripción nombra lo que realmente se está pagando: un mes con ISR no es
  // "un pago a la CSS", y quien lea el diario tiene que poder saberlo sin abrirlo.
  const concepto = ['CSS', ...(montoISR > 0 ? ['ISR'] : [])].join(' + ');
  const periodo = datos.periodo;
  const asiento = await prisma.journalEntry.create({
    data: {
      date: parseLocalDate(datos.fecha),
      description: `Pago ${concepto} ${etiquetaDe(periodo)}${datos.referencia ? ` — ${datos.referencia}` : ''}`,
      status: 'BORRADOR',
      companyId,
      createdById: userId,
      lines: { create: lineas },
    },
  });

  const marcar = datos.marcarPagada !== false;
  const obligacionMarcada = marcar
    ? await marcarObligacionCumplida(prisma, companyId, 'CSS', periodo, montoSS, datos.notas)
    : false;

  await logAudit(prisma, {
    userId,
    action: 'PLANILLA_PAGO_CSS',
    entity: 'JournalEntry',
    entityId: asiento.id,
    after: { periodo, montoSS, montoSE, montoISR, total, banco: banco.code, obligacionMarcada },
  });

  return { journalEntryId: asiento.id, total, obligacionMarcada };
}

/** Etiqueta del período para la descripción del asiento. Exportada para la UI. */
export const etiquetaPeriodo = etiquetaDe;

/** Los mismos campos de cuenta que Administración → Configuración. */
export const CAMPOS_CUENTA_CSS = PLANILLA_FIELDS.filter((f) =>
  ['planillaSSId', 'planillaSEId', 'planillaISRId'].includes(f.field),
);
