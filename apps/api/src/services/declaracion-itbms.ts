/**
 * Declaración mensual de ITBMS (Formulario 430) como DATO.
 *
 * Cierra las brechas 1, 2 y 3 de `Tuning.md` §4.1:
 *  · la declaración existe (renglones, número de formulario, fecha y estados),
 *  · la compensación del R52 se puede **revertir** (anular devuelve las retenciones),
 *  · el vínculo con el asiento es una **FK real** (`retencion_itbms.declaracionId` y
 *    `declaracion_itbms.asientoCompensacionId`), no el JSON de `metadata`.
 *
 * Principios que no se negocian:
 *  · **Es una FOTO, no un puntero.** Los renglones nacen del borrador y el contador
 *    los corrige; una vez presentada, la fila NO se recalcula nunca más. El borrador
 *    sigue moviéndose con el libro y la UI enseña los dos por separado.
 *  · **El renglón 52 tiene que cuadrar con lo que se aplica.** Presentar exige que el
 *    renglón declarado sea igual a la suma de las retenciones que se compensan en el
 *    mayor: si difieren, se dice cuánto y cómo arreglarlo (nada de descuadres mudos).
 *  · **Los asientos los revisa el contador.** La compensación nace BORRADOR (igual que
 *    el botón manual de hoy); el pago nace CONFIRMADO, porque es un pago ya hecho
 *    (misma forma que `pagarReembolso`).
 *  · **Nada se borra.** Anular crea el espejo con `anularAsiento` (fechado hoy) y
 *    devuelve el período a su estado anterior; el índice único parcial deja volver a
 *    declarar.
 */

import { AccountingAgent } from '@agt-contador/agents';
import { checkNotBlocked } from './journal-guard';
import { logAudit } from './audit-log';
import { parseLocalDate } from '../lib/dates';
import { loadCompanyAccounts, filterPayoutAccounts } from './account-resolver';
import { anularAsiento } from './journal-annul';
import { marcarObligacionCumplida, desmarcarObligacion } from './tax-calendar';
import { buildBorrador430, r2s, rangoMes } from './borrador-430';
import type { Borrador430 } from './borrador-430';

/** Tolerancia en dólares para comparar montos: medio centavo (la misma del borrador). */
export const TOL = 0.005;

// ───────────────────────────── Bloque puro ─────────────────────────────

export const ESTADOS_DECLARACION = ['BORRADOR', 'PRESENTADA', 'PAGADA', 'ANULADA'] as const;
export type EstadoDeclaracion = (typeof ESTADOS_DECLARACION)[number];

/** Renglones del formulario. `saldoAPagar` no va acá: se deriva de estos. */
export interface RenglonesDeclaracion {
  baseVentas: number;
  debitoFiscal: number;
  baseCompras: number;
  creditoFiscal: number;
  retencionAplicada: number;
  saldoAnterior: number;
}

/** Período `"YYYY-MM"`, el mismo formato de `TaxObligation.period`. */
export function periodoDe(year: number, mes: number): string {
  return `${year}-${String(mes).padStart(2, '0')}`;
}

export function parsePeriodo(period: string): { year: number; mes: number } {
  const [y, m] = String(period).split('-').map(Number);
  return { year: y, mes: m };
}

/** La tabla de estados, sola. Editar no es una transición: es una guarda. */
export function puedeTransicionar(desde: string, hasta: string): boolean {
  if (desde === hasta) return false;
  if (desde === 'BORRADOR') return hasta === 'PRESENTADA' || hasta === 'ANULADA';
  if (desde === 'PRESENTADA') return hasta === 'PAGADA' || hasta === 'ANULADA';
  if (desde === 'PAGADA') return hasta === 'ANULADA';
  return false; // ANULADA es terminal
}

/** Por qué no se puede editar en este estado (null = sí se puede). */
export function motivoNoEditable(estado: string): string | null {
  if (estado === 'BORRADOR') return null;
  if (estado === 'PRESENTADA') return 'Ya se presentó: los renglones quedaron congelados. Para corregir hay que anularla y volver a crearla.';
  if (estado === 'PAGADA') return 'La declaración ya está pagada: sus renglones son la foto de lo presentado.';
  return 'La declaración está anulada.';
}

/** Primer día del mes SIGUIENTE al período: un 430 no se puede presentar antes de que cierre el mes. */
export function primerDiaDelMesSiguiente(year: number, mes: number): Date {
  return new Date(year, mes, 1, 12, 0, 0, 0);
}

/**
 * Renglones iniciales: del borrador a la declaración. PURO.
 *
 * El renglón 52 nace con lo **disponible** (retenciones con certificado sin aplicar),
 * que es lo que el contador pretendería aplicar; al presentar se reescribe con lo que
 * de verdad se compensa, y presentar exige que coincidan.
 */
export function renglonesDesdeBorrador(b: Borrador430): RenglonesDeclaracion {
  const monto = (id: string) => b.renglones.find((r) => r.id === id)?.monto ?? 0;
  return {
    baseVentas: r2s(b.bases.ventasGravadas),
    debitoFiscal: r2s(monto('debitoFiscal')),
    baseCompras: r2s(b.bases.comprasGravadas),
    creditoFiscal: r2s(monto('creditoFiscal')),
    retencionAplicada: r2s(monto('renglon52')),
    saldoAnterior: r2s(b.saldoAnterior.monto),
  };
}

/**
 * Liquidación declarada. PURA y firmada (`saldoAnterior` puede ser negativo: el saldo
 * a favor se arrastra, regla D2 del contador).
 */
export function liquidarDeclaracion(r: RenglonesDeclaracion): { saldoAPagar: number; saldoAFavor: boolean } {
  const saldoAPagar = r2s(
    r2s(r.debitoFiscal - r.creditoFiscal - r.retencionAplicada) + r2s(r.saldoAnterior),
  );
  return { saldoAPagar, saldoAFavor: saldoAPagar < -TOL };
}

export interface RetencionAplicable {
  id: string;
  fecha: Date;
  montoRetencion: number;
  numeroCertificado: string | null;
  cliente?: string;
}

/**
 * Aplicables: las RECIBIDAS (con certificado) anteriores al cierre del período. Es la
 * misma regla que `retenciones.disponibles` del borrador; incluye las de meses
 * anteriores sin aplicar, que es justo el crédito que se arrastra.
 */
export function retencionesAplicables<T extends RetencionAplicable>(rows: T[], endExclusive: Date): T[] {
  return rows.filter((r) => String((r as any).estado) === 'RECIBIDA' && new Date(r.fecha) < endExclusive);
}

/**
 * Mensaje accionable cuando el renglón 52 declarado no coincide con lo aplicable.
 * Devuelve `null` si cuadra.
 */
export function avisoR52(declarado: number, aplicable: number, pendienteCertificado: number): string | null {
  if (Math.abs(r2s(declarado) - r2s(aplicable)) <= TOL) return null;
  const cola = pendienteCertificado > TOL
    ? ` Quedan $${pendienteCertificado.toFixed(2)} en retenciones SIN certificado: regístralas en Informes → Retenciones ITBMS (📥) para poder aplicarlas.`
    : '';
  return `El renglón 52 declarado ($${declarado.toFixed(2)}) no coincide con las retenciones a aplicar ($${aplicable.toFixed(2)}). Corrige el renglón 52 a $${aplicable.toFixed(2)} o marca las retenciones que falten.${cola}`;
}

/** Asientos que la declaración puede haber creado, en el orden en que se revierten. */
export function asientosDe(dec: any): string[] {
  return [dec.asientoPagoId, dec.asientoCompensacionId].filter(Boolean) as string[];
}

// ─────────────────────────── Bloque con Prisma ───────────────────────────

const err = (msg: string, status: number) => Object.assign(new Error(msg), { status });

/** Fila de declaración tal como la ve la UI (con la foto del borrador ya parseada). */
function declaracionJson(d: any, extra: Record<string, unknown> = {}): any {
  if (!d) return null;
  let borrador: any = null;
  try {
    borrador = d.borradorJson ? JSON.parse(d.borradorJson) : null;
  } catch {
    borrador = null; // una foto ilegible no puede tumbar la pantalla
  }
  return {
    id: d.id,
    period: d.period,
    year: d.year,
    mes: d.mes,
    estado: d.estado,
    renglones: {
      baseVentas: d.baseVentas,
      debitoFiscal: d.debitoFiscal,
      baseCompras: d.baseCompras,
      creditoFiscal: d.creditoFiscal,
      retencionAplicada: d.retencionAplicada,
      saldoAnterior: d.saldoAnterior,
    },
    saldoAPagar: d.saldoAPagar,
    saldoAFavor: d.saldoAFavor,
    numeroFormulario: d.numeroFormulario,
    fechaPresentacion: d.fechaPresentacion,
    presentadaAt: d.presentadaAt,
    montoPagado: d.montoPagado,
    fechaPago: d.fechaPago,
    anuladaAt: d.anuladaAt,
    motivoAnulacion: d.motivoAnulacion,
    notas: d.notas,
    borrador,
    ...extra,
  };
}

/** La declaración viva de un período (`null` si no hay; las anuladas no cuentan). */
export async function declaracionDelPeriodo(prisma: any, companyId: string, period: string) {
  return prisma.declaracionItbms.findFirst({
    where: { companyId, period, estado: { not: 'ANULADA' } },
  });
}

export async function listarDeclaraciones(prisma: any, companyId: string, opts: { year?: number; estado?: string } = {}) {
  const where: any = { companyId };
  if (opts.year) where.year = opts.year;
  if (opts.estado) where.estado = opts.estado;
  const rows = await prisma.declaracionItbms.findMany({ where, orderBy: [{ year: 'desc' }, { mes: 'desc' }] });
  return rows.map((r: any) => declaracionJson(r));
}

/** Detalle completo: la declaración, sus retenciones aplicadas y sus asientos. */
export async function declaracionConDetalle(prisma: any, companyId: string, id: string) {
  const d = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  if (!d) return null;
  const retenciones = await prisma.retentionItbms.findMany({
    where: { companyId, declaracionId: d.id },
    select: {
      id: true, fecha: true, montoRetencion: true, baseGravada: true, itbmsFacturado: true,
      numeroCertificado: true, estado: true, client: { select: { name: true } },
    },
    orderBy: { fecha: 'asc' },
  });
  const ids = asientosDe(d);
  const asientos = ids.length
    ? await prisma.journalEntry.findMany({
        where: { id: { in: ids } },
        select: { id: true, date: true, description: true, status: true, anuladoPorId: true },
      })
    : [];
  return declaracionJson(d, { retenciones, asientos });
}

/**
 * Retenciones del período para el modal de presentar: las aplicables (RECIBIDA, con
 * certificado, anteriores al cierre) y cuánto queda esperando certificado.
 */
export async function retencionesDelPeriodo(prisma: any, companyId: string, period: string) {
  const { year, mes } = parsePeriodo(period);
  const { endExclusive } = rangoMes(year, mes);
  const rows = await prisma.retentionItbms.findMany({
    where: { companyId, estado: { in: ['RECIBIDA', 'PENDIENTE'] }, fecha: { lt: endExclusive } },
    select: {
      id: true, fecha: true, montoRetencion: true, numeroCertificado: true, estado: true,
      baseGravada: true, itbmsFacturado: true, client: { select: { name: true } },
    },
    orderBy: { fecha: 'asc' },
  });
  const aplicables = retencionesAplicables(rows as any, endExclusive).map((r: any) => ({
    id: r.id, fecha: r.fecha, montoRetencion: r2s(r.montoRetencion),
    numeroCertificado: r.numeroCertificado, cliente: r.client?.name || '',
  }));
  const pendientes = (rows as any[]).filter((r) => r.estado === 'PENDIENTE');
  return {
    aplicables,
    totalAplicable: r2s(aplicables.reduce((s, r) => s + r.montoRetencion, 0)),
    pendienteCertificado: r2s(pendientes.reduce((s, r) => s + (r.montoRetencion || 0), 0)),
    registrosPendientes: pendientes.length,
  };
}

/**
 * Crea la declaración del período con los renglones del borrador. No crea asientos ni
 * toca retenciones: es una foto declarativa hasta que se presente.
 */
export async function crearDeclaracion(
  prisma: any,
  input: { companyId: string; userId: string; year: number; mes: number; anioFiscal: number; notas?: string | null },
) {
  const { companyId, userId, year, mes, anioFiscal } = input;
  const period = periodoDe(year, mes);

  const viva = await declaracionDelPeriodo(prisma, companyId, period);
  if (viva) throw err(`Ya hay una declaración de ${period} en estado ${viva.estado} (N° ${viva.numeroFormulario || 'sin número'}). Anúlala antes de crear otra.`, 409);

  const borrador = await buildBorrador430(prisma, companyId, { year, mes }, anioFiscal);
  if (borrador.avisos.some((a) => a.codigo === 'SIN_CUENTA_ITBMS')) {
    throw err('No se encontró la cuenta de ITBMS por Pagar en el catálogo de esta empresa: sin esa cuenta no se puede declarar.', 400);
  }

  const renglones = renglonesDesdeBorrador(borrador);
  const { saldoAPagar, saldoAFavor } = liquidarDeclaracion(renglones);

  const creada = await prisma.declaracionItbms.create({
    data: {
      companyId,
      period,
      year,
      mes,
      estado: 'BORRADOR',
      ...renglones,
      saldoAPagar,
      saldoAFavor,
      notas: input.notas ?? null,
      borradorJson: JSON.stringify({
        renglones: borrador.renglones,
        bases: borrador.bases,
        liquidacion: borrador.liquidacion,
        cuadre: { cuadra: borrador.cuadre.cuadra, movimientoLibroMes: borrador.cuadre.movimientoLibroMes },
        retenciones: {
          disponibles: borrador.retenciones.disponibles,
          pendienteCertificado: borrador.retenciones.pendienteCertificado,
        },
        avisos: borrador.avisos,
      }),
    },
  });

  await logAudit(prisma, {
    userId,
    action: 'DECLARACION_CREATED',
    entity: 'DeclaracionItbms',
    entityId: creada.id,
    after: { period, saldoAPagar, saldoAFavor },
  });

  return declaracionJson(creada);
}

/** Corrige los renglones. Solo en BORRADOR: presentada es una foto. */
export async function editarDeclaracion(
  prisma: any,
  input: { companyId: string; userId: string; id: string; renglones: Partial<RenglonesDeclaracion>; notas?: string | null },
) {
  const { companyId, userId, id } = input;
  const d = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  if (!d) throw err('Declaración no encontrada.', 404);
  const noEditable = motivoNoEditable(d.estado);
  if (noEditable) throw err(noEditable, 409);

  const campos: (keyof RenglonesDeclaracion)[] = [
    'baseVentas', 'debitoFiscal', 'baseCompras', 'creditoFiscal', 'retencionAplicada', 'saldoAnterior',
  ];
  const siguiente: RenglonesDeclaracion = {
    baseVentas: d.baseVentas, debitoFiscal: d.debitoFiscal, baseCompras: d.baseCompras,
    creditoFiscal: d.creditoFiscal, retencionAplicada: d.retencionAplicada, saldoAnterior: d.saldoAnterior,
  };
  let tocado = false;
  for (const c of campos) {
    const v = (input.renglones as any)[c];
    if (v === undefined) continue;
    if (!Number.isFinite(Number(v))) throw err(`El renglón ${c} no es un número válido.`, 400);
    siguiente[c] = r2s(Number(v));
    tocado = true;
  }
  const notas = input.notas === undefined ? d.notas : input.notas;
  if (!tocado && notas === d.notas) throw err('No hay nada que actualizar.', 400);

  // El candado del estado: si mientras tanto alguien la presentó, esto no entra.
  const { saldoAPagar, saldoAFavor } = liquidarDeclaracion(siguiente);
  const r = await prisma.declaracionItbms.updateMany({
    where: { id, companyId, estado: 'BORRADOR' },
    data: { ...siguiente, saldoAPagar, saldoAFavor, notas },
  });
  if (r.count !== 1) throw err('La declaración cambió mientras la editabas: recárgala.', 409);

  const actualizada = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  await logAudit(prisma, {
    userId,
    action: 'DECLARACION_UPDATED',
    entity: 'DeclaracionItbms',
    entityId: id,
    before: { ...siguiente, saldoAPagar: d.saldoAPagar },
    after: { renglones: siguiente, saldoAPagar },
  });
  return declaracionJson(actualizada);
}

/**
 * Presenta la declaración: guarda el número y la fecha, aplica el R52 que se
 * seleccione (asiento D 2.1.05 / C 1.1.07), pasa esas retenciones a APLICADA y
 * completa la obligación del calendario. Todo en una transacción, con candado de
 * estado contra el doble clic.
 */
export async function presentarDeclaracion(
  prisma: any,
  input: {
    companyId: string; userId: string; id: string;
    numeroFormulario: string; fechaPresentacion?: string; retencionIds?: string[];
  },
) {
  const { companyId, userId, id } = input;
  const d = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  if (!d) throw err('Declaración no encontrada.', 404);
  if (d.estado !== 'BORRADOR') {
    throw err(
      d.estado === 'ANULADA'
        ? 'La declaración está anulada.'
        : `La declaración ya está ${d.estado.toLowerCase()}${d.numeroFormulario ? ` (Form. N° ${d.numeroFormulario})` : ''}.`,
      409,
    );
  }

  const numero = String(input.numeroFormulario || '').trim();
  if (!numero) throw err('El número de formulario es obligatorio para presentar.', 400);

  const { year, mes } = parsePeriodo(d.period);
  const fechaPresentacion = input.fechaPresentacion ? parseLocalDate(input.fechaPresentacion) : new Date();
  const minimo = primerDiaDelMesSiguiente(year, mes);
  if (fechaPresentacion < minimo) {
    throw err(`El 430 de ${d.period} no se puede presentar antes de que cierre el mes (${minimo.getDate()}/${minimo.getMonth() + 1}/${minimo.getFullYear()}).`, 400);
  }

  // ── Retenciones a aplicar ──
  const delPeriodo = await retencionesDelPeriodo(prisma, companyId, d.period);
  const candidatas = delPeriodo.aplicables;
  let seleccionadas = candidatas;
  if (input.retencionIds) {
    const pedidas = new Set(input.retencionIds.map(String));
    seleccionadas = candidatas.filter((r) => pedidas.has(r.id));
    if (seleccionadas.length !== pedidas.size) {
      const faltan = input.retencionIds.filter((rid) => !candidatas.some((c) => c.id === rid));
      throw err(
        `Hay ${faltan.length} retención(es) que no se pueden aplicar: solo entran las RECIBIDAS con certificado y anteriores al cierre del período. Regístralas en Informes → Retenciones ITBMS (📥) y reintenta.`,
        400,
      );
    }
  }
  const totalAplicado = r2s(seleccionadas.reduce((s, r) => s + r2s(r.montoRetencion), 0));

  const aviso = avisoR52(d.retencionAplicada, totalAplicado, delPeriodo.pendienteCertificado);
  if (aviso) throw err(aviso, 400);

  const resultado = await prisma.$transaction(async (tx: any) => {
    let asientoId: string | null = null;
    if (totalAplicado > TOL) {
      const agent = new AccountingAgent(tx, companyId);
      await agent.init();
      let porPagarId: string;
      let retenidoId: string;
      try {
        porPagarId = agent.resolveAlias('itbms-por-pagar');
      } catch {
        throw err('No se encontró la cuenta ITBMS por Pagar (alias itbms-por-pagar) en el catálogo.', 400);
      }
      try {
        retenidoId = agent.resolveAlias('itbms-retenido-terceros');
      } catch {
        throw err('No se encontró la cuenta "ITBMS Retenido por Terceros" (alias itbms-retenido-terceros) en el catálogo.', 400);
      }
      const blocked = await checkNotBlocked(tx, companyId, [porPagarId, retenidoId]);
      if (blocked) throw err(blocked, 400);

      const etiqueta = `${MESES[d.mes - 1]} ${d.year}`;
      const desc = `Compensación R52 al presentar la declaración 430 ${etiqueta} — retenciones sufridas $${totalAplicado.toFixed(2)} (Form. N° ${numero})`;
      const je = await tx.journalEntry.create({
        data: {
          date: new Date(), // la corrección entra en el mes en que se hace, no reescribe el declarado
          description: desc,
          status: 'BORRADOR', // igual que el botón manual de compensar: lo aprueba el contador
          companyId,
          createdById: userId,
          lines: {
            create: [
              { accountId: porPagarId, debit: totalAplicado, credit: 0 },
              { accountId: retenidoId, debit: 0, credit: totalAplicado },
            ],
          },
        },
      });
      asientoId = je.id;
      await tx.transaction.create({
        data: {
          type: 'PAGO_ITBMS',
          amount: totalAplicado,
          description: desc,
          concept: 'Compensación R52',
          paymentMethod: 'CREDITO',
          date: new Date(),
          companyId,
          createdById: userId,
          journalEntryId: je.id,
          metadata: JSON.stringify({
            source: 'declaracion-430',
            declaracionId: id,
            retentionIds: seleccionadas.map((r) => r.id),
          }),
        },
      });

      // Candado: solo las que siguen RECIBIDAS pasan a APLICADA. Si alguien las tocó
      // entre la lectura y acá, el conteo no da y se cae toda la transacción.
      const marcadas = await tx.retentionItbms.updateMany({
        where: { id: { in: seleccionadas.map((r) => r.id) }, companyId, estado: 'RECIBIDA' },
        data: { estado: 'APLICADA', declaracionId: id },
      });
      if (marcadas.count !== seleccionadas.length) {
        throw err('Alguna retención cambió de estado mientras presentabas: recarga y reintenta.', 409);
      }
    }

    const obligacionMarcada = await marcarObligacionCumplida(
      tx,
      companyId,
      'ITBMS',
      d.period,
      d.saldoAPagar,
      `Declaración 430 N° ${numero} del ${fechaPresentacion.getDate()}/${fechaPresentacion.getMonth() + 1}/${fechaPresentacion.getFullYear()}`,
    );

    const upd = await tx.declaracionItbms.updateMany({
      where: { id, companyId, estado: 'BORRADOR' },
      data: {
        estado: 'PRESENTADA',
        numeroFormulario: numero,
        fechaPresentacion,
        presentadaAt: new Date(),
        presentadaPorId: userId,
        asientoCompensacionId: asientoId,
        obligacionMarcada: Boolean(obligacionMarcada),
        retencionAplicada: totalAplicado,
      },
    });
    if (upd.count !== 1) throw err('La declaración cambió mientras la presentabas: recarga y reintenta.', 409);

    return { asientoId, obligacionMarcada: Boolean(obligacionMarcada) };
  });

  await logAudit(prisma, {
    userId,
    action: 'DECLARACION_PRESENTED',
    entity: 'DeclaracionItbms',
    entityId: id,
    after: { numeroFormulario: numero, totalAplicado, asientoCompensacionId: resultado.asientoId },
  });

  const declaracion = await declaracionConDetalle(prisma, companyId, id);
  return {
    declaracion,
    asientoCompensacion: resultado.asientoId ? { id: resultado.asientoId, total: totalAplicado } : null,
    retencionesAplicadas: seleccionadas.length,
    totalAplicado,
    pendienteCertificado: delPeriodo.pendienteCertificado,
    obligacionMarcada: resultado.obligacionMarcada,
    avisos: totalAplicado <= TOL && delPeriodo.pendienteCertificado > TOL
      ? [`No se aplicó nada al renglón 52: hay $${delPeriodo.pendienteCertificado.toFixed(2)} en retenciones esperando certificado. Registrar el certificado (Informes → Retenciones ITBMS) permite aplicarlas en una próxima declaración.`]
      : [],
  };
}

/**
 * Registra el pago de la declaración: asiento D 2.1.05 / C banco, CONFIRMADO (es un
 * pago ya hecho, misma forma que el pago de un reembolso).
 */
export async function pagarDeclaracion(
  prisma: any,
  input: { companyId: string; userId: string; id: string; cuentaBancoId: string; monto?: number; fecha?: string },
) {
  const { companyId, userId, id } = input;
  const d = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  if (!d) throw err('Declaración no encontrada.', 404);
  if (d.estado !== 'PRESENTADA') {
    throw err(
      d.estado === 'BORRADOR'
        ? 'La declaración todavía no se ha presentado: no hay nada que pagar.'
        : d.estado === 'PAGADA'
          ? `La declaración ya está pagada${d.fechaPago ? ` (${new Date(d.fechaPago).getDate()}/${new Date(d.fechaPago).getMonth() + 1}/${new Date(d.fechaPago).getFullYear()})` : ''}.`
          : 'La declaración está anulada.',
      409,
    );
  }
  if (d.saldoAPagar <= TOL) {
    throw err(`Esta declaración no tiene nada que pagar (saldo ${d.saldoAPagar.toFixed(2)}): un saldo a favor se arrastra al mes siguiente, no se paga.`, 400);
  }

  const monto = r2s(input.monto === undefined ? d.saldoAPagar : Number(input.monto));
  if (!(monto > TOL)) throw err('El monto del pago tiene que ser mayor que cero.', 400);
  const fecha = input.fecha ? parseLocalDate(input.fecha) : new Date();

  const cuentas = await loadCompanyAccounts(prisma, companyId);
  const cuenta = (cuentas as any[]).find((c) => c.id === input.cuentaBancoId);
  if (!cuenta) throw err('La cuenta de banco no existe en esta empresa.', 400);
  if (!filterPayoutAccounts(cuentas as any).some((c: any) => c.id === cuenta.id)) {
    throw err('La cuenta elegida no es una cuenta de banco o caja del catálogo.', 400);
  }

  const resultado = await prisma.$transaction(async (tx: any) => {
    const agent = new AccountingAgent(tx, companyId);
    await agent.init();
    let porPagarId: string;
    try {
      porPagarId = agent.resolveAlias('itbms-por-pagar');
    } catch {
      throw err('No se encontró la cuenta ITBMS por Pagar (alias itbms-por-pagar) en el catálogo.', 400);
    }
    const blocked = await checkNotBlocked(tx, companyId, [porPagarId, cuenta.id]);
    if (blocked) throw err(blocked, 400);

    const etiqueta = `${MESES[d.mes - 1]} ${d.year}`;
    const desc = `Pago de ITBMS ${etiqueta} — declaración 430 N° ${d.numeroFormulario || ''}`.trim();
    const je = await tx.journalEntry.create({
      data: {
        date: fecha,
        description: desc,
        status: 'CONFIRMADO',
        companyId,
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date(),
        lines: {
          create: [
            { accountId: porPagarId, debit: monto, credit: 0 },
            { accountId: cuenta.id, debit: 0, credit: monto },
          ],
        },
      },
    });
    await tx.transaction.create({
      data: {
        type: 'PAGO_ITBMS',
        amount: monto,
        description: desc,
        concept: 'Pago ITBMS declaración 430',
        paymentMethod: 'TRANSFERENCIA',
        date: fecha,
        companyId,
        createdById: userId,
        journalEntryId: je.id,
        metadata: JSON.stringify({ source: 'declaracion-430-pago', declaracionId: id }),
      },
    });

    const upd = await tx.declaracionItbms.updateMany({
      where: { id, companyId, estado: 'PRESENTADA' },
      data: { estado: 'PAGADA', montoPagado: monto, fechaPago: fecha, asientoPagoId: je.id },
    });
    if (upd.count !== 1) throw err('La declaración cambió mientras registrabas el pago: recarga y reintenta.', 409);

    // El monto real pagado es el dato que alimenta la proyección de caja.
    if (d.obligacionMarcada) {
      await tx.taxObligation.updateMany({
        where: { companyId, type: 'ITBMS', period: d.period },
        data: { actualAmount: monto, completedAt: new Date(), status: 'COMPLETED' },
      });
    }
    return { journalEntryId: je.id };
  });

  await logAudit(prisma, {
    userId,
    action: 'DECLARACION_PAID',
    entity: 'DeclaracionItbms',
    entityId: id,
    after: { monto, fecha, journalEntryId: resultado.journalEntryId },
  });

  const declaracion = await declaracionConDetalle(prisma, companyId, id);
  return { declaracion, journalEntryId: resultado.journalEntryId, monto };
}

/**
 * Anula la declaración: revierte los asientos que creó (espejo fechado hoy), devuelve
 * las retenciones a RECIBIDA y la obligación del período a pendiente. El período queda
 * libre para volver a declarar (índice único parcial).
 */
export async function anularDeclaracion(
  prisma: any,
  input: { companyId: string; userId: string; id: string; motivo: string },
) {
  const { companyId, userId, id } = input;
  const motivo = String(input.motivo || '').trim();
  if (motivo.length < 3) throw err('Explica el motivo de la anulación.', 400);

  const d = await prisma.declaracionItbms.findFirst({ where: { id, companyId } });
  if (!d) throw err('Declaración no encontrada.', 404);
  if (d.estado === 'ANULADA') throw err('La declaración ya está anulada.', 409);

  const resultado = await prisma.$transaction(async (tx: any) => {
    const asientosAnulados: Array<{ originalId: string; reversalId: string }> = [];
    const saltados: string[] = [];
    for (const asientoId of asientosDe(d)) {
      const je = await tx.journalEntry.findFirst({ where: { id: asientoId, companyId }, select: { id: true, anuladoPorId: true, status: true } });
      // Si el contador ya lo anuló a mano desde el Diario, no se rompe: se reporta.
      if (!je || je.anuladoPorId || je.status === 'ANULADO') {
        if (je) saltados.push(je.id);
        continue;
      }
      const r = await anularAsiento(tx, companyId, userId, asientoId);
      asientosAnulados.push({ originalId: asientoId, reversalId: r.reversal.id });
    }

    // Las retenciones vuelven a RECIBIDA. Se escribe directo porque `canTransition`
    // del PATCH las tiene como terminales a propósito: el único que puede revertir una
    // APLICADA es la anulación de la declaración que la aplicó, y eso pasa acá.
    const devueltas = await tx.retentionItbms.updateMany({
      where: { companyId, declaracionId: id, estado: 'APLICADA' },
      data: { estado: 'RECIBIDA', declaracionId: null },
    });

    let obligacionDevuelta = false;
    if (d.obligacionMarcada) {
      obligacionDevuelta = await desmarcarObligacion(tx, companyId, 'ITBMS', d.period);
    }

    const upd = await tx.declaracionItbms.updateMany({
      where: { id, companyId, estado: { not: 'ANULADA' } },
      data: { estado: 'ANULADA', anuladaAt: new Date(), anuladaPorId: userId, motivoAnulacion: motivo },
    });
    if (upd.count !== 1) throw err('La declaración cambió mientras la anulabas: recarga y reintenta.', 409);

    return { asientosAnulados, saltados, retencionesDevueltas: devueltas.count, obligacionDevuelta };
  });

  await logAudit(prisma, {
    userId,
    action: 'DECLARACION_ANNULED',
    entity: 'DeclaracionItbms',
    entityId: id,
    before: { estado: d.estado, numeroFormulario: d.numeroFormulario },
    after: { estado: 'ANULADA', motivo, ...resultado },
  });

  const declaracion = await declaracionConDetalle(prisma, companyId, id);
  return { declaracion, ...resultado };
}

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
