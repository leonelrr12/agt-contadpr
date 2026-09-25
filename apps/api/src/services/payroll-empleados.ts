import { parseLocalDate } from '../lib/dates';
import { r2, sumarMontos } from '../lib/money';

/**
 * Registro de empleados y acumulados del módulo de Planilla.
 *
 * Los acumulados (décimo, vacaciones, prima) NO se materializan en una tabla: se
 * calculan en lectura como
 *
 *     saldo = saldoInicial + Σ generado − Σ pagado
 *
 * donde lo generado son los `decimoGenerado` que cada corrida de sueldo congeló en
 * su ítem y lo pagado es el `bruto` de las corridas de la prestación. Materializar
 * el saldo obligaría a mantenerlo sincronizado con cada anulación; derivarlo hace
 * que no pueda mentir.
 */

export interface EmpleadoInput {
  cedula?: string | null;
  nss?: string | null;
  nombre: string;
  cargo?: string | null;
  sueldoBase: number;
  tipoPago: string;
  /** Clase de riesgo profesional (I…V). Sin clase, usa la tarifa general. */
  claseRiesgo?: string | null;
  fechaIngreso?: string | null;
  fechaSalida?: string | null;
  bancoCuentaId?: string | null;
  cuentaBanco?: string | null;
  decimoSaldoInicial?: number;
  vacacionesSaldoInicial?: number;
  primaSaldoInicial?: number;
  fechaSaldoInicial?: string | null;
  isActive?: boolean;
  notas?: string | null;
}

export interface Acumulado {
  inicial: number;
  generado: number;
  pagado: number;
  saldo: number;
}

export interface Acumulados {
  decimo: Acumulado;
  vacaciones: Acumulado;
  prima: Acumulado;
}

/** 'YYYY-MM-DD' → Date a mediodía local; vacío/null → null. */
function aFechaLocal(valor: string | null | undefined): Date | null {
  if (!valor) return null;
  return parseLocalDate(valor);
}

function textoOpcional(valor: string | null | undefined): string | null {
  const t = (valor ?? '').trim();
  return t === '' ? null : t;
}

/**
 * Acumulados de los empleados dados (o de todos, si no se pasan ids).
 *
 * Una sola consulta para todos: el histórico de planilla es chico (empleados ×
 * períodos), así que se agrega en memoria y se evita el `groupBy` por relación, que
 * no puede separar el bruto de una corrida de décimo del de una de vacaciones.
 */
export async function acumuladosDe(
  prisma: any,
  companyId: string,
  opts: { empleadoIds?: string[]; corte?: Date } = {},
): Promise<Map<string, Acumulados>> {
  const items: any[] = await prisma.payrollItem.findMany({
    where: {
      companyId,
      ...(opts.empleadoIds?.length ? { employeeId: { in: opts.empleadoIds } } : {}),
      run: {
        status: { not: 'ANULADA' },
        ...(opts.corte ? { fechaPago: { lte: opts.corte } } : {}),
      },
    },
    select: {
      employeeId: true,
      bruto: true,
      decimoGenerado: true,
      vacacionesGeneradas: true,
      primaGenerada: true,
      run: { select: { tipo: true } },
    },
  });

  const acumulados = new Map<string, Acumulados>();
  for (const item of items) {
    const acc = acumulados.get(item.employeeId) ?? vacios();
    acc.decimo.generado = sumarMontos(acc.decimo.generado, item.decimoGenerado);
    acc.vacaciones.generado = sumarMontos(acc.vacaciones.generado, item.vacacionesGeneradas);
    acc.prima.generado = sumarMontos(acc.prima.generado, item.primaGenerada);

    // Una corrida de una prestación PAGA lo acumulado: su bruto descarga el saldo.
    if (item.run?.tipo === 'DECIMO') acc.decimo.pagado = sumarMontos(acc.decimo.pagado, item.bruto);
    if (item.run?.tipo === 'VACACIONES') acc.vacaciones.pagado = sumarMontos(acc.vacaciones.pagado, item.bruto);

    acumulados.set(item.employeeId, acc);
  }

  // Los saldos iniciales viven en la ficha: se aplican acá, después de sumar el
  // histórico, para que un empleado sin corridas también tenga su acumulado.
  const empleados: any[] = await prisma.employee.findMany({
    where: { companyId, ...(opts.empleadoIds?.length ? { id: { in: opts.empleadoIds } } : {}) },
    select: {
      id: true,
      decimoSaldoInicial: true,
      vacacionesSaldoInicial: true,
      primaSaldoInicial: true,
    },
  });

  for (const emp of empleados) {
    const acc = acumulados.get(emp.id) ?? vacios();
    acc.decimo.inicial = r2(emp.decimoSaldoInicial);
    acc.vacaciones.inicial = r2(emp.vacacionesSaldoInicial);
    acc.prima.inicial = r2(emp.primaSaldoInicial);
    acumulados.set(emp.id, acc);
  }

  for (const acc of acumulados.values()) {
    for (const clave of ['decimo', 'vacaciones', 'prima'] as const) {
      acc[clave].saldo = r2(acc[clave].inicial + acc[clave].generado - acc[clave].pagado);
    }
  }
  return acumulados;
}

function vacios(): Acumulados {
  const cero = (): Acumulado => ({ inicial: 0, generado: 0, pagado: 0, saldo: 0 });
  return { decimo: cero(), vacaciones: cero(), prima: cero() };
}

/** Lista de empleados con su acumulado vigente. */
export async function listarEmpleados(
  prisma: any,
  companyId: string,
  opts: { q?: string; incluirInactivos?: boolean; corte?: Date } = {},
) {
  const empleados = await prisma.employee.findMany({
    where: {
      companyId,
      ...(opts.incluirInactivos ? {} : { isActive: true }),
      ...(opts.q
        ? {
            OR: [
              { nombre: { contains: opts.q, mode: 'insensitive' } },
              { cedula: { contains: opts.q, mode: 'insensitive' } },
              { cargo: { contains: opts.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ isActive: 'desc' }, { nombre: 'asc' }],
  });

  const acumulados = await acumuladosDe(prisma, companyId, {
    empleadoIds: empleados.map((e: any) => e.id),
    corte: opts.corte,
  });

  return empleados.map((e: any) => ({ ...e, acumulados: acumulados.get(e.id) ?? vacios() }));
}

/** Ficha completa: el empleado, sus acumulados y sus últimas corridas. */
export async function obtenerEmpleado(prisma: any, companyId: string, id: string) {
  // findFirst con companyId, nunca findUnique por id: el aislamiento entre empresas
  // no puede depender de que el id sea imposible de adivinar.
  const empleado = await prisma.employee.findFirst({ where: { id, companyId } });
  if (!empleado) return null;

  const [acumulados, items] = await Promise.all([
    acumuladosDe(prisma, companyId, { empleadoIds: [id] }),
    prisma.payrollItem.findMany({
      where: { companyId, employeeId: id },
      include: { run: { select: { id: true, tipo: true, periodo: true, status: true, fechaPago: true } } },
      orderBy: { createdAt: 'desc' },
      take: 24,
    }),
  ]);

  return { ...empleado, acumulados: acumulados.get(id) ?? vacios(), items };
}

/** Mensaje en español para la cédula repetida (P2002), o null si no lo es. */
function errorCedulaDuplicada(e: any): string | null {
  if (e?.code !== 'P2002') return null;
  const target = String(e?.meta?.target ?? '');
  if (!target.includes('cedula')) return null;
  return 'Ya existe un empleado con esa cédula en esta empresa.';
}

export async function crearEmpleado(prisma: any, companyId: string, data: EmpleadoInput) {
  try {
    return await prisma.employee.create({
      data: {
        companyId,
        cedula: textoOpcional(data.cedula),
        nss: textoOpcional(data.nss),
        nombre: data.nombre.trim(),
        cargo: textoOpcional(data.cargo),
        sueldoBase: r2(data.sueldoBase),
        tipoPago: data.tipoPago,
        claseRiesgo: textoOpcional(data.claseRiesgo),
        fechaIngreso: aFechaLocal(data.fechaIngreso),
        fechaSalida: aFechaLocal(data.fechaSalida),
        bancoCuentaId: data.bancoCuentaId || null,
        cuentaBanco: textoOpcional(data.cuentaBanco),
        decimoSaldoInicial: r2(data.decimoSaldoInicial ?? 0),
        vacacionesSaldoInicial: r2(data.vacacionesSaldoInicial ?? 0),
        primaSaldoInicial: r2(data.primaSaldoInicial ?? 0),
        fechaSaldoInicial: aFechaLocal(data.fechaSaldoInicial),
        notas: textoOpcional(data.notas),
      },
    });
  } catch (e: any) {
    const mensaje = errorCedulaDuplicada(e);
    if (mensaje) throw Object.assign(new Error(mensaje), { status: 409 });
    throw e;
  }
}

/**
 * Actualiza la ficha. Los campos ausentes no se tocan; `null` explícito limpia.
 * Los empleados NO se borran: `isActive: false` es la baja.
 */
export async function actualizarEmpleado(
  prisma: any,
  companyId: string,
  id: string,
  data: Partial<EmpleadoInput>,
) {
  const actual = await prisma.employee.findFirst({ where: { id, companyId }, select: { id: true } });
  if (!actual) return null;

  const cambios: Record<string, unknown> = {};
  const setTexto = (campo: string, valor: string | null | undefined) => {
    if (valor !== undefined) cambios[campo] = textoOpcional(valor);
  };
  const setFecha = (campo: string, valor: string | null | undefined) => {
    if (valor !== undefined) cambios[campo] = aFechaLocal(valor);
  };

  if (data.nombre !== undefined) cambios.nombre = data.nombre.trim();
  setTexto('cedula', data.cedula);
  setTexto('nss', data.nss);
  setTexto('cargo', data.cargo);
  setTexto('cuentaBanco', data.cuentaBanco);
  setTexto('notas', data.notas);
  setTexto('claseRiesgo', data.claseRiesgo);
  setFecha('fechaIngreso', data.fechaIngreso);
  setFecha('fechaSalida', data.fechaSalida);
  setFecha('fechaSaldoInicial', data.fechaSaldoInicial);

  if (data.sueldoBase !== undefined) cambios.sueldoBase = r2(data.sueldoBase);
  if (data.tipoPago !== undefined) cambios.tipoPago = data.tipoPago;
  if (data.bancoCuentaId !== undefined) cambios.bancoCuentaId = data.bancoCuentaId || null;
  if (data.isActive !== undefined) cambios.isActive = !!data.isActive;
  if (data.decimoSaldoInicial !== undefined) cambios.decimoSaldoInicial = r2(data.decimoSaldoInicial);
  if (data.vacacionesSaldoInicial !== undefined) cambios.vacacionesSaldoInicial = r2(data.vacacionesSaldoInicial);
  if (data.primaSaldoInicial !== undefined) cambios.primaSaldoInicial = r2(data.primaSaldoInicial);

  if (Object.keys(cambios).length === 0) return actual;

  try {
    return await prisma.employee.update({ where: { id }, data: cambios });
  } catch (e: any) {
    const mensaje = errorCedulaDuplicada(e);
    if (mensaje) throw Object.assign(new Error(mensaje), { status: 409 });
    throw e;
  }
}

/**
 * Empleados que entran en una corrida: activos y del tipo de pago que corresponde.
 *
 * El filtro por `tipoPago` no es cosmético: sin él, una corrida quincenal se lleva
 * también a quien cobra mensual y lo paga dos veces al mes. En las corridas de
 * prestaciones (décimo, vacaciones) no se filtra: las cobran los dos.
 */
export async function empleadosParaCorrida(
  prisma: any,
  companyId: string,
  opts: { ids?: string[]; tipoPago?: string | null } = {},
) {
  const filas: any[] = await prisma.employee.findMany({
    where: {
      companyId,
      isActive: true,
      ...(opts.ids?.length ? { id: { in: opts.ids } } : {}),
      ...(opts.tipoPago ? { tipoPago: opts.tipoPago } : {}),
    },
    orderBy: { nombre: 'asc' },
    select: {
      id: true,
      nombre: true,
      cedula: true,
      nss: true,
      sueldoBase: true,
      tipoPago: true,
      claseRiesgo: true,
      fechaIngreso: true,
      fechaSalida: true,
      bancoCuentaId: true,
    },
  });
  return filas;
}
