/**
 * Deducciones de acreedores: el catálogo, el saldo de cada uno y su pago.
 *
 * Es el lado Prisma de `payroll-deducciones.ts` (el que decide, puro). Acá solo se
 * buscan los datos, se derivan los saldos y se registran los pagos.
 *
 * Tres cosas que este módulo NO hace, a propósito:
 *  · **No materializa el saldo.** Se deriva de las cuotas aplicadas de las corridas
 *    vivas, igual que los acumulados de décimo y vacaciones: anular una corrida
 *    devuelve la cuota sola y el saldo no puede quedar desfasado.
 *  · **No suma el saldo del mayor por empleado.** El pasivo de un acreedor puede
 *    venir de varios empleados (dos personas pagándole al mismo banco): el saldo por
 *    cuenta vive en el mayor y el del empleado en las cuotas. Sumarlos contaría dos
 *    veces.
 *  · **No crea cuentas contables.** La cuenta por pagar de cada acreedor la elige el
 *    contador del catálogo, como todas las del módulo.
 */

import { parseLocalDate } from '../lib/dates';
import { r2, sumarMontos } from '../lib/money';
import { logAudit } from './audit-log';
import { saldoCuentaPasivo } from './payroll-css';
import {
  avisosDeCatalogo,
  saldoPendienteDe,
  topeDeuda,
  type AjusteDeduccion,
  type DeduccionCalc,
} from './payroll-deducciones';
import type { LineaAsiento } from './payroll-calc';

/** Lo que se aplicó de una deducción: el total descontado y cuántas cuotas van. */
export interface AplicadoDeduccion {
  aplicado: number;
  cuotas: number;
}

/**
 * Lo aplicado por deducción, al corte, de corridas VIVAS.
 *
 * El SALDO suma todos los montos; las CUOTAS se cuentan por `cuotaNumero`, que solo
 * llevan las filas que CIERRAN su mes: un empleado quincenal paga la misma cuota en dos
 * abonos, y contarlos como dos cuotas le acortaría el plazo a la mitad. Una corrida
 * ANULADA no cuenta — por eso anular devuelve la cuota sin tocar el catálogo.
 */
export async function aplicadoDe(
  prisma: any,
  companyId: string,
  opts: { empleadoIds?: string[]; deduccionIds?: string[]; corte?: Date } = {},
): Promise<Map<string, AplicadoDeduccion>> {
  const filas = await prisma.payrollItemDeduction.findMany({
    where: {
      companyId,
      ...(opts.empleadoIds?.length ? { employeeId: { in: opts.empleadoIds } } : {}),
      ...(opts.deduccionIds?.length ? { deduccionId: { in: opts.deduccionIds } } : {}),
      run: {
        status: { not: 'ANULADA' },
        ...(opts.corte ? { fechaPago: { lte: opts.corte } } : {}),
      },
    },
    select: { deduccionId: true, monto: true, cuotaNumero: true },
  });

  const mapa = new Map<string, AplicadoDeduccion>();
  for (const fila of filas) {
    const acumulado = mapa.get(fila.deduccionId) ?? { aplicado: 0, cuotas: 0 };
    acumulado.aplicado = sumarMontos(acumulado.aplicado, fila.monto);
    if (fila.cuotaNumero != null) acumulado.cuotas += 1;
    mapa.set(fila.deduccionId, acumulado);
  }
  return mapa;
}

/**
 * Lo que ya se descontó por cada deducción en los pagos ANTERIORES del mismo mes.
 *
 * Es lo que necesita el pago que cierra el mes para tomar exactamente lo que falta de
 * la cuota (`cuota − lo ya descontado`), en vez de volver a cobrarla entera. Mismo
 * papel que `isrYaRetenidoEnElMes` en el reparto del ISR.
 */
export async function descontadoEnElMesDe(
  prisma: any,
  companyId: string,
  opts: { empleadoIds: string[]; periodoMensual: string },
): Promise<Map<string, number>> {
  const mapa = new Map<string, number>();
  if (!opts.empleadoIds.length) return mapa;

  const filas = await prisma.payrollItemDeduction.findMany({
    where: {
      companyId,
      employeeId: { in: opts.empleadoIds },
      run: { periodoMensual: opts.periodoMensual, status: { not: 'ANULADA' } },
    },
    select: { employeeId: true, deduccionId: true, monto: true },
  });
  for (const f of filas) {
    const llave = `${f.employeeId}:${f.deduccionId}`;
    mapa.set(llave, sumarMontos(mapa.get(llave) ?? 0, f.monto));
  }
  return mapa;
}

/**
 * El catálogo de los empleados de una corrida, ya normalizado para el motor: con el
 * saldo que queda y las cuotas que van.
 *
 * Trae también las desactivadas y las terminadas: la pantalla las muestra con su
 * motivo (el contador tiene que poder ver por qué una deducción dejó de aparecer).
 */
export async function catalogoDe(
  prisma: any,
  companyId: string,
  opts: { empleadoIds: string[]; corte: Date; periodoMensual: string },
): Promise<Map<string, DeduccionCalc[]>> {
  const porEmpleado = new Map<string, DeduccionCalc[]>();
  if (!opts.empleadoIds.length) return porEmpleado;

  const filas = await prisma.payrollDeduction.findMany({
    where: { companyId, employeeId: { in: opts.empleadoIds } },
    orderBy: [{ acreedor: 'asc' }, { createdAt: 'asc' }],
  });
  if (!filas.length) return porEmpleado;

  const [aplicado, enElMes] = await Promise.all([
    aplicadoDe(prisma, companyId, {
      deduccionIds: filas.map((f: any) => f.id),
      corte: opts.corte,
    }),
    descontadoEnElMesDe(prisma, companyId, { empleadoIds: opts.empleadoIds, periodoMensual: opts.periodoMensual }),
  ]);

  for (const f of filas) {
    const hist = aplicado.get(f.id) ?? { aplicado: 0, cuotas: 0 };
    const calc: DeduccionCalc = {
      deduccionId: f.id,
      employeeId: f.employeeId,
      acreedor: f.acreedor,
      cuentaId: f.cuentaId,
      tipo: f.tipo === 'PORCENTAJE' ? 'PORCENTAJE' : 'FIJO',
      montoFijo: f.montoFijo,
      porcentaje: f.porcentaje,
      cuotas: f.cuotas,
      saldoPendiente: saldoPendienteDe(topeDeuda(f), hist.aplicado),
      cuotasAplicadas: hist.cuotas,
      yaDescontadoEnElMes: enElMes.get(`${f.employeeId}:${f.id}`) ?? 0,
      fechaInicio: f.fechaInicio,
      fechaFin: f.fechaFin,
      aplicaEnDiciembre: f.aplicaEnDiciembre,
      isActive: f.isActive,
    };
    const lista: DeduccionCalc[] = porEmpleado.get(f.employeeId) ?? [];
    lista.push(calc);
    porEmpleado.set(f.employeeId, lista);
  }
  return porEmpleado;
}

/**
 * Funde los ajustes del contador (saltar una cuota, cambiarle el monto) con el catálogo
 * precargado. Un ajuste de una deducción que ya no está en el catálogo se ignora: si el
 * contador la desactivó desde la otra pestaña, no puede resucitarla un formulario viejo.
 */
export function aplicarAjustes(
  catalogo: DeduccionCalc[],
  ajustes: AjusteDeduccion[] = [],
): DeduccionCalc[] {
  if (!ajustes.length) return catalogo;
  return catalogo.map((d) => {
    const ajuste = ajustes.find((a) => a.deduccionId === d.deduccionId);
    if (!ajuste) return d;
    return {
      ...d,
      omitida: ajuste.omitida ?? d.omitida,
      montoAjustado: ajuste.monto ?? d.montoAjustado ?? null,
    };
  });
}

export interface DeduccionListada {
  id: string;
  employeeId: string;
  empleado: string;
  acreedor: string;
  cuentaId: string;
  cuenta: { code: string; name: string } | null;
  tipo: string;
  montoFijo: number | null;
  porcentaje: number | null;
  cuotas: number | null;
  montoTotal: number | null;
  saldoInicial: number | null;
  fechaInicio: Date | null;
  fechaFin: Date | null;
  aplicaEnDiciembre: boolean;
  isActive: boolean;
  notas: string | null;
  /** Derivados: lo que ya se descontó y lo que queda. */
  aplicado: number;
  cuotasAplicadas: number;
  saldoPendiente: number | null;
  /** Estimación de la próxima cuota con el sueldo base (la pantalla la muestra con "≈"). */
  cuotaEstimada: number | null;
  aviso: string;
}

/** El catálogo para la pantalla, con el saldo derivado de cada fila. */
export async function listarDeducciones(
  prisma: any,
  companyId: string,
  opts: { empleadoId?: string; incluirInactivas?: boolean } = {},
): Promise<DeduccionListada[]> {
  const filas = await prisma.payrollDeduction.findMany({
    where: {
      companyId,
      ...(opts.empleadoId ? { employeeId: opts.empleadoId } : {}),
      ...(opts.incluirInactivas ? {} : { isActive: true }),
    },
    include: {
      employee: { select: { nombre: true, sueldoBase: true } },
      cuenta: { select: { code: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }],
  });
  if (!filas.length) return [];

  const aplicado = await aplicadoDe(prisma, companyId, { deduccionIds: filas.map((f: any) => f.id) });

  return filas.map((f: any) => {
    const hist = aplicado.get(f.id) ?? { aplicado: 0, cuotas: 0 };
    const saldoPendiente = saldoPendienteDe(topeDeuda(f), hist.aplicado);
    const calc: DeduccionCalc = {
      deduccionId: f.id,
      employeeId: f.employeeId,
      acreedor: f.acreedor,
      cuentaId: f.cuentaId,
      tipo: f.tipo === 'PORCENTAJE' ? 'PORCENTAJE' : 'FIJO',
      montoFijo: f.montoFijo,
      porcentaje: f.porcentaje,
      cuotas: f.cuotas,
      saldoPendiente,
      cuotasAplicadas: hist.cuotas,
      fechaInicio: f.fechaInicio,
      fechaFin: f.fechaFin,
      aplicaEnDiciembre: f.aplicaEnDiciembre,
      isActive: f.isActive,
    };
    // La estimación es sobre el sueldo base MENSUAL: sirve para ver el orden de
    // magnitud en la tabla, no para anticipar la cuota de una quincena.
    const estimada =
      f.tipo === 'PORCENTAJE'
        ? r2((f.employee?.sueldoBase ?? 0) * (f.porcentaje ?? 0))
        : r2(f.montoFijo ?? 0);
    return {
      id: f.id,
      employeeId: f.employeeId,
      empleado: f.employee?.nombre ?? '',
      acreedor: f.acreedor,
      cuentaId: f.cuentaId,
      cuenta: f.cuenta ? { code: f.cuenta.code, name: f.cuenta.name } : null,
      tipo: calc.tipo,
      montoFijo: f.montoFijo,
      porcentaje: f.porcentaje,
      cuotas: f.cuotas,
      montoTotal: f.montoTotal,
      saldoInicial: f.saldoInicial,
      fechaInicio: f.fechaInicio,
      fechaFin: f.fechaFin,
      aplicaEnDiciembre: f.aplicaEnDiciembre,
      isActive: f.isActive,
      notas: f.notas,
      aplicado: hist.aplicado,
      cuotasAplicadas: hist.cuotas,
      saldoPendiente,
      cuotaEstimada: saldoPendiente == null ? estimada : Math.min(estimada, r2(saldoPendiente)),
      aviso: avisosDeCatalogo(calc),
    };
  });
}

export interface AcreedorResumen {
  cuentaId: string;
  code: string;
  name: string;
  /** Lo que la planilla retuvo para este acreedor (Σ de las cuotas aplicadas). */
  devengado: number;
  /** Lo que se le pagó por esta cuenta (Σ de los débitos del mayor). */
  pagado: number;
  /** Lo que se le debe hoy: Σ crédito − Σ débito, como `saldoCuentaPasivo`. */
  saldo: number;
  /** Las deducciones que acreditan esta cuenta, con el nombre que tenían al descontar. */
  deducciones: { deduccionId: string; acreedor: string; empleado: string }[];
  empleados: string[];
  /** Se llena cuando el mayor y la planilla no cuentan lo mismo. */
  aviso: string;
}

/**
 * Los acreedores con su saldo, agrupados por CUENTA.
 *
 * Por cuenta y no por deducción: dos empleados pueden deberle al mismo banco y lo que
 * se paga es la cuenta. El `devengado` sale de las cuotas (lo que la planilla retuvo) y
 * el `saldo` del mayor (lo que de verdad se debe); si no coinciden es que alguien movió
 * la cuenta a mano, y el aviso lo dice en vez de mostrar un número que nadie puede
 * explicar.
 */
export async function resumenAcreedores(prisma: any, companyId: string): Promise<AcreedorResumen[]> {
  const filas = await prisma.payrollItemDeduction.findMany({
    where: { companyId, run: { status: { not: 'ANULADA' } } },
    select: {
      cuentaId: true,
      acreedor: true,
      monto: true,
      employeeId: true,
      deduccionId: true,
      employee: { select: { nombre: true } },
    },
  });
  if (!filas.length) return [];

  const porCuenta = new Map<
    string,
    { devengado: number; empleados: Set<string>; deducciones: Map<string, { deduccionId: string; acreedor: string; empleado: string }> }
  >();
  for (const f of filas) {
    const acc =
      porCuenta.get(f.cuentaId) ??
      { devengado: 0, empleados: new Set<string>(), deducciones: new Map<string, { deduccionId: string; acreedor: string; empleado: string }>() };
    acc.devengado = sumarMontos(acc.devengado, f.monto);
    const empleado = f.employee?.nombre ?? '';
    acc.empleados.add(empleado);
    // El nombre del acreedor viaja CONGELADO en la fila: el de hoy es el que se usó
    // al descontar, aunque el catálogo lo haya renombrado después.
    acc.deducciones.set(f.deduccionId, { deduccionId: f.deduccionId, acreedor: f.acreedor, empleado });
    porCuenta.set(f.cuentaId, acc);
  }

  const ids = [...porCuenta.keys()];
  const [cuentas, movimientos] = await Promise.all([
    prisma.account.findMany({ where: { id: { in: ids }, companyId }, select: { id: true, code: true, name: true } }),
    // Mismo filtro que `saldoCuentaPasivo`: incluye BORRADOR (lo que se debe no depende
    // de que el contador haya aprobado el asiento) y excluye RECHAZADO y ANULADO.
    prisma.journalLine.groupBy({
      by: ['accountId'],
      where: { accountId: { in: ids }, journalEntry: { companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] } } },
      _sum: { debit: true, credit: true },
    }),
  ]);

  const nombreCuenta = new Map(cuentas.map((c: any) => [c.id, c]));
  const movs = new Map(movimientos.map((m: any) => [m.accountId, m]));

  return ids
    .map((cuentaId: string) => {
      const cuenta: any = nombreCuenta.get(cuentaId);
      const acc = porCuenta.get(cuentaId)!;
      const mov: any = movs.get(cuentaId);
      const devengado = r2(acc.devengado);
      const pagado = r2(mov?._sum.debit || 0);
      const saldo = r2((mov?._sum.credit || 0) - (mov?._sum.debit || 0));
      const cuadra = Math.abs(saldo - r2(devengado - pagado)) <= 0.01;
      return {
        cuentaId,
        code: cuenta?.code ?? '',
        name: cuenta?.name ?? '(cuenta eliminada)',
        devengado,
        pagado,
        saldo,
        deducciones: [...acc.deducciones.values()],
        empleados: [...acc.empleados].filter(Boolean).sort(),
        aviso: cuadra
          ? ''
          : `el mayor no cuadra con la planilla: se retuvo ${devengado.toFixed(2)} y el saldo de la cuenta es ${saldo.toFixed(2)} (hay movimientos que no vienen de planilla)`,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

/**
 * Las líneas del pago: se debita la cuenta del acreedor y se acredita el banco.
 *
 * Pura a propósito: el reparto se prueba en un test, no en producción.
 */
export function lineasPagoAcreedor(cuentaId: string, monto: number, bancoId: string): LineaAsiento[] {
  return [
    { accountId: cuentaId, debit: r2(monto), credit: 0 },
    { accountId: bancoId, debit: 0, credit: r2(monto) },
  ];
}

export interface DatosPagoAcreedor {
  cuentaId: string;
  fecha: string;
  bancoCuentaId: string;
  monto: number;
  /** Nombre del acreedor para la descripción; si falta se usa el de la cuenta. */
  acreedor?: string;
  referencia?: string;
  notas?: string;
  /** Pagar más de lo que se debe se puede (un ajuste, un anticipo), pero se confirma. */
  confirmarExceso?: boolean;
}

export interface ResultadoPagoAcreedor {
  journalEntryId: string;
  monto: number;
  saldoAntes: number;
  cuenta: { id: string; code: string; name: string };
}

/**
 * Registra el pago a un acreedor: debita SU cuenta por pagar y acredita el banco.
 *
 * El asiento nace en BORRADOR y lo aprueba el contador como cualquier otro. Las dos
 * guardias son las mismas del pago a la CSS: la cuenta tiene que ser de la empresa y el
 * banco tiene que ser un banco (1.1.02.*) — acreditar contra un ingreso cerraría el
 * pasivo y dejaría el banco mal.
 *
 * La guardia contra el pago repetido es el SALDO: si ya se pagó, no queda nada que
 * deber y cualquier monto exige confirmación explícita. Es más débil que la del pago a
 * la CSS (allá la constancia es la obligación del calendario), pero acá no hay
 * obligación: el saldo del mayor es el único hecho.
 */
export async function registrarPagoAcreedor(
  prisma: any,
  companyId: string,
  userId: string,
  datos: DatosPagoAcreedor,
): Promise<ResultadoPagoAcreedor> {
  const monto = r2(datos.monto || 0);
  if (monto <= 0) {
    throw Object.assign(new Error('El pago tiene que tener un monto mayor que cero.'), { status: 400 });
  }

  const cuenta = await prisma.account.findFirst({
    where: { id: datos.cuentaId, companyId },
    select: { id: true, code: true, name: true, isBlocked: true },
  });
  if (!cuenta) {
    throw Object.assign(new Error('La cuenta del acreedor no existe en esta empresa.'), { status: 400 });
  }
  if (cuenta.isBlocked) {
    throw Object.assign(
      new Error(`La cuenta "${cuenta.code} ${cuenta.name}" está bloqueada: no admite movimientos nuevos.`),
      { status: 400 },
    );
  }

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

  const saldoAntes = await saldoCuentaPasivo(prisma, companyId, cuenta.id);
  if (monto > r2(saldoAntes + 0.01) && !datos.confirmarExceso) {
    throw Object.assign(
      new Error(
        `Estás pagando ${monto.toFixed(2)} contra un saldo de ${saldoAntes.toFixed(2)} ` +
          `en "${cuenta.code} ${cuenta.name}".\n\n` +
          'Si el pago es correcto —un anticipo, un ajuste, o el saldo está mal—, confirmá y se registra igual.',
      ),
      { status: 409 },
    );
  }

  const acreedor = datos.acreedor?.trim() || cuenta.name;
  const asiento = await prisma.journalEntry.create({
    data: {
      date: parseLocalDate(datos.fecha),
      description: `Pago a ${acreedor} (${cuenta.code})${datos.referencia ? ` — ${datos.referencia}` : ''}`,
      status: 'BORRADOR',
      companyId,
      createdById: userId,
      lines: { create: lineasPagoAcreedor(cuenta.id, monto, banco.id) },
    },
  });

  await logAudit(prisma, {
    userId,
    action: 'PLANILLA_PAGO_ACREEDOR',
    entity: 'JournalEntry',
    entityId: asiento.id,
    after: {
      cuentaId: cuenta.id,
      cuenta: cuenta.code,
      monto,
      saldoAntes,
      banco: banco.code,
      referencia: datos.referencia ?? null,
      ...(datos.notas ? { notas: datos.notas } : {}),
    },
  });

  return { journalEntryId: asiento.id, monto, saldoAntes, cuenta };
}
