/**
 * Reembolsos a trabajadores: registro durable de las facturas que adelantan.
 *
 * El trabajador no tiene usuario — su identidad es el celular, y el vínculo
 * (`whatsapp_link.workerAccountId`) es lo que marca que sus gastos son
 * reembolsos y no gastos de la empresa.
 *
 * Qué se guarda y por qué:
 *  · la URL del CUTE y el XML oficial de la DGI, para poder listar o consultar
 *    cualquier factura después sin depender del visor de la DGI;
 *  · la clave de deduplicación, para que la MISMA factura no se reembolse dos
 *    veces la mande quien la mande;
 *  · el asiento que la registró, que es donde vive el estado contable.
 *
 * El monto a reembolsar sale del ASIENTO (suma de sus débitos), no de un campo
 * aparte: es el total que el trabajador pagó — neto + ITBMS — y así no hay dos
 * reglas de negocio que puedan divergir.
 */

import { createHash } from 'crypto';
import { parseLocalDate } from '../lib/dates';

/**
 * Tipos que se registran como FACTURA RECIBIDA: lo que la empresa compró o
 * gastó. Una venta o un cobro no es una factura recibida — y en el celular de un
 * trabajador, además, no tiene por qué entrar.
 */
export const TIPOS_FACTURA_RECIBIDA = new Set(['GASTO', 'COMPRA']);

export interface FacturaExtraida {
  /** Enlace del QR (CUTE). Null si la factura llegó como PDF suelto. */
  dgiUrl?: string | null;
  /** XML oficial de la DGI, tal como lo embebe el visor del CUTE. */
  dgiXml?: string | null;
  proveedor?: string | null;
  ruc?: string | null;
  numeroFactura?: string | null;
  /** 'YYYY-MM-DD' del extractor, o cualquier fecha parseable. */
  fecha?: string | null;
  total?: number | null;
  itbms?: number | null;
}

export type FacturaPendiente = FacturaExtraida;

/**
 * Clave de deduplicación de una factura.
 *
 * Prefiere los datos propios de la factura (RUC + número + fecha + total), que
 * sobreviven a que la DGI cambie el enlace; cae a la URL cuando falta alguno
 * (una factura sin número legible igual no puede entrar dos veces).
 * Devuelve null cuando no hay NADA con qué identificarla: sin clave no se
 * deduplica, y el unique de Postgres deja convivir varios NULL.
 */
export function buildDedupeKey(f: FacturaExtraida): string | null {
  const ruc = (f.ruc || '').replace(/\D/g, '');
  const numero = (f.numeroFactura || '').replace(/\D/g, '');
  const fecha = (f.fecha || '').trim();
  const total = f.total != null && Number.isFinite(Number(f.total)) ? Number(f.total).toFixed(2) : '';
  if (ruc && numero && fecha && total) return `F:${ruc}:${numero}:${fecha}:${total}`;
  if (f.dgiUrl) return `U:${createHash('sha256').update(f.dgiUrl).digest('hex').slice(0, 32)}`;
  return null;
}

/**
 * ¿Esta factura ya está reclamada en la empresa?
 *
 * NO cuenta como duplicado una factura cuyo asiento quedó RECHAZADO: el rechazo
 * la devuelve al mundo (mismo criterio que los cobros, cuyos efectos se
 * revierten al rechazar), así que el trabajador puede volver a mandarla.
 */
export async function buscarFacturaDuplicada(
  prisma: any,
  companyId: string | null | undefined,
  dedupeKey: string | null,
): Promise<any | null> {
  if (!companyId || !dedupeKey) return null;
  try {
    return await prisma.expenseClaim.findFirst({
      where: {
        companyId,
        dedupeKey,
        OR: [{ journalEntryId: null }, { journalEntry: { status: { not: 'RECHAZADO' } } }],
      },
      include: { worker: { select: { nombre: true } } },
    });
  } catch (err: any) {
    // La deduplicación es una RED, no el flujo: si la consulta falla, la factura
    // se sigue registrando y el índice único de la BD queda como último respaldo.
    // Tumbar la carga de una factura por esto sería peor que el duplicado.
    console.error('[Reembolsos] Error buscando duplicado:', err.message);
    return null;
  }
}

/** Suma de los débitos del asiento = lo que costó el gasto (neto + ITBMS). */
function totalDelAsiento(journalEntry: any): number {
  const lines: any[] = journalEntry?.lines || [];
  const total = lines.reduce((acc, l) => acc + (Number(l.debit) || 0), 0);
  return Math.round(total * 100) / 100;
}

/** Fecha del asiento si es 'YYYY-MM-DD'; si no, la del propio asiento. */
function fechaFactura(factura: FacturaExtraida, journalEntry: any): Date {
  const raw = (factura.fecha || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = parseLocalDate(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return journalEntry?.date ? new Date(journalEntry.date) : new Date();
}

export interface RegistroFactura {
  companyId: string;
  /** Null = factura de la empresa: se archiva, no se reembolsa. */
  workerId: string | null;
  journalEntry: any;
  tipo?: string | null;
  factura: FacturaExtraida | null;
}

/**
 * Registra una factura RECIBIDA después de confirmar su asiento: con trabajador
 * es además un reembolso, sin él es una factura de la empresa que se archiva con
 * su URL del CUTE y su XML.
 *
 * Nunca lanza por datos faltantes: la factura puede llegar sin RUC ni número
 * legibles y aun así hay que registrarla. Solo devuelve `creado: false` con el
 * motivo, para que el llamador decida qué decir.
 */
export async function registrarFacturaRecibida(
  prisma: any,
  { companyId, workerId, journalEntry, tipo, factura }: RegistroFactura,
): Promise<{ creado: boolean; motivo?: string; claim?: any; duplicado?: any }> {
  if (!journalEntry?.id) return { creado: false, motivo: 'sin asiento' };
  if (tipo && !TIPOS_FACTURA_RECIBIDA.has(tipo)) return { creado: false, motivo: `tipo ${tipo}` };

  const f: FacturaExtraida = factura || {};
  const dedupeKey = buildDedupeKey(f);

  // El unique de la BD es el respaldo; acá se avisa con nombre y fecha en vez de
  // dejar reventar el P2002.
  const duplicado = await buscarFacturaDuplicada(prisma, companyId, dedupeKey);
  if (duplicado) return { creado: false, motivo: 'duplicada', duplicado };

  try {
    const claim = await prisma.expenseClaim.create({
      data: {
        companyId,
        workerId,
        dgiUrl: f.dgiUrl || null,
        dgiXml: f.dgiXml || null,
        proveedor: f.proveedor || null,
        rucEmisor: f.ruc || null,
        numeroFactura: f.numeroFactura || null,
        fecha: fechaFactura(f, journalEntry),
        total: totalDelAsiento(journalEntry),
        itbms: Number(f.itbms) || 0,
        dedupeKey,
        journalEntryId: journalEntry.id,
        status: 'PENDIENTE',
      },
    });
    return { creado: true, claim };
  } catch (e: any) {
    // P2002 = carrera con otro mensaje del mismo trabajador. La factura ya está
    // registrada: se trata como duplicada, no como error.
    if (e?.code === 'P2002') {
      const existente = await buscarFacturaDuplicada(prisma, companyId, dedupeKey);
      return { creado: false, motivo: 'duplicada', duplicado: existente };
    }
    throw e;
  }
}

/** Saldo pendiente de reembolso de un trabajador (lo que /viaticos responde). */
export async function saldoPendiente(prisma: any, companyId: string, workerId: string): Promise<number> {
  const agg = await prisma.expenseClaim.aggregate({
    where: {
      companyId,
      workerId,
      status: 'PENDIENTE',
      OR: [{ journalEntryId: null }, { journalEntry: { status: { not: 'RECHAZADO' } } }],
    },
    _sum: { total: true },
  });
  return Math.round((agg._sum.total || 0) * 100) / 100;
}

/**
 * Cuenta por pagar al trabajador: alias `reembolsos-empleados` o, si la empresa
 * no lo tiene configurado, el código estándar. Mismo criterio que el motor
 * contable, para que el pago caiga donde cayó el gasto.
 */
async function cuentaReembolso(prisma: any, companyId: string): Promise<{ id: string; code: string; name: string }> {
  const porAlias = await prisma.account.findFirst({
    where: { companyId, aliases: { has: 'reembolsos-empleados' } },
    select: { id: true, code: true, name: true },
  });
  if (porAlias) return porAlias;
  const porCodigo = await prisma.account.findFirst({
    where: { companyId, code: '2.1.02.02' },
    select: { id: true, code: true, name: true },
  });
  if (porCodigo) return porCodigo;
  throw Object.assign(
    new Error('La empresa no tiene la cuenta 2.1.02.02 Reembolsos Empleados por Pagar. Créala en Administración → Cuentas para poder pagar reembolsos.'),
    { status: 400 },
  );
}

export interface PagoReembolsoInput {
  companyId: string;
  workerId: string;
  claimIds: string[];
  cuentaBancoId: string;
  /** 'YYYY-MM-DD' */
  fecha: string;
  userId: string;
  notas?: string | null;
}

/**
 * Paga un reembolso: agrupa las facturas elegidas en UN pago y UN asiento.
 *
 *   DR 2.1.02.02 Reembolsos Empleados por Pagar   (baja el pasivo)
 *   CR cuenta bancaria                            (sale el dinero)
 *
 * Tres decisiones que sostienen esto:
 *  · **El pago aprueba**: los asientos de las facturas que todavía están en
 *    BORRADOR se confirman acá, con el mismo `reviewedById` que firma el pago.
 *    El dueño lo pidió así ("aprueba el mismo que paga") y el acto es humano y
 *    explícito sobre montos que se están viendo en pantalla.
 *  · **El asiento del pago nace CONFIRMADO**, no en borrador: es la consecuencia
 *    de un clic deliberado, y dejar el gasto confirmado con el pago pendiente
 *    descuadraría el pasivo hasta que alguien se acordara de mirarlo.
 *  · **El anti-duplicado es la BD, no el código**: el `updateMany` condicionado
 *    a `status: PENDIENTE` dentro de la transacción hace que dos clics
 *    simultáneos no puedan pagar dos veces — el segundo actualiza 0 filas y
 *    todo el pago se revierte.
 */
export async function pagarReembolso(prisma: any, input: PagoReembolsoInput): Promise<any> {
  const { companyId, workerId, claimIds, cuentaBancoId, fecha, userId, notas } = input;
  if (!claimIds?.length) throw Object.assign(new Error('No hay facturas seleccionadas'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) throw Object.assign(new Error('Fecha inválida'), { status: 400 });

  const trabajador = await prisma.workerAccount.findFirst({ where: { id: workerId, companyId } });
  if (!trabajador) throw Object.assign(new Error('Trabajador no encontrado'), { status: 404 });

  const pasivo = await cuentaReembolso(prisma, companyId);
  const banco = await prisma.account.findFirst({ where: { id: cuentaBancoId, companyId }, select: { id: true, code: true, name: true } });
  if (!banco) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 400 });

  const claims = await prisma.expenseClaim.findMany({
    where: { id: { in: claimIds }, companyId, workerId },
    include: { journalEntry: { select: { id: true, status: true } } },
  });
  if (claims.length !== claimIds.length) {
    throw Object.assign(new Error('Alguna de las facturas seleccionadas no es de este trabajador'), { status: 400 });
  }
  const yaPagadas = claims.filter((c: any) => c.status !== 'PENDIENTE');
  if (yaPagadas.length) {
    throw Object.assign(new Error(`Ya hay ${yaPagadas.length} factura(s) pagada(s) en la selección. Actualiza la pantalla.`), { status: 409 });
  }
  const sinAsiento = claims.filter((c: any) => !c.journalEntryId || c.journalEntry?.status === 'RECHAZADO');
  if (sinAsiento.length) {
    throw Object.assign(new Error(`Hay ${sinAsiento.length} factura(s) sin asiento válido: no se pueden reembolsar.`), { status: 400 });
  }

  const total = Math.round(claims.reduce((acc: number, c: any) => acc + Number(c.total || 0), 0) * 100) / 100;
  const fechaPago = parseLocalDate(fecha);
  const porConfirmar = claims.filter((c: any) => c.journalEntry?.status === 'BORRADOR').map((c: any) => c.journalEntryId);

  return prisma.$transaction(async (tx: any) => {
    // 1. El pago aprueba las facturas que seguían en borrador
    if (porConfirmar.length) {
      await tx.journalEntry.updateMany({
        where: { id: { in: porConfirmar }, companyId, status: 'BORRADOR' },
        data: { status: 'CONFIRMADO', reviewedById: userId, reviewedAt: new Date(), reviewNotes: 'Aprobado al pagar el reembolso' },
      });
    }

    // 2. El asiento del pago
    const asiento = await tx.journalEntry.create({
      data: {
        date: fechaPago,
        description: `Reembolso a ${trabajador.nombre} — ${claims.length} factura(s)`,
        status: 'CONFIRMADO',
        companyId,
        createdById: userId,
        reviewedById: userId,
        reviewedAt: new Date(),
        lines: {
          create: [
            { accountId: pasivo.id, debit: total, credit: 0 },
            { accountId: banco.id, debit: 0, credit: total },
          ],
        },
      },
      include: { lines: { include: { account: true } } },
    });

    // 3. El pago
    const reembolso = await tx.reimbursement.create({
      data: { companyId, workerId, monto: total, fecha: fechaPago, journalEntryId: asiento.id, paidById: userId, notas: notas || null },
    });

    // 4. Las facturas quedan pagadas — y ACÁ está el candado: si otro proceso ya
    //    las marcó, el conteo no cuadra y toda la transacción se revierte.
    const marcadas = await tx.expenseClaim.updateMany({
      where: { id: { in: claimIds }, companyId, status: 'PENDIENTE' },
      data: { status: 'PAGADO', reimbursementId: reembolso.id },
    });
    if (marcadas.count !== claimIds.length) {
      throw Object.assign(new Error('El reembolso cambió mientras lo pagabas: no se pagó nada. Actualiza y reintenta.'), { status: 409 });
    }

    return { reembolso, asiento, total, facturas: claims.length, aprobadas: porConfirmar.length };
  });
}

/** Texto del aviso de duplicado, con quién y cuándo la registró. */
export function avisoDuplicado(duplicado: any): string {
  if (!duplicado) return '⚠️ Esa factura ya estaba registrada. No se registra dos veces.';
  const fecha = duplicado.createdAt ? new Date(duplicado.createdAt).toLocaleDateString('es-PA') : '';
  // Factura de la empresa: no hay a quién reembolsar, solo se avisa que ya está.
  if (!duplicado.workerId) {
    return `⚠️ Esa factura ya está registrada como factura de la empresa${fecha ? ` el ${fecha}` : ''}. No se registra dos veces.`;
  }
  const quien = duplicado.worker?.nombre || 'otro trabajador';
  const estado = duplicado.status === 'PAGADO' ? 'ya fue reembolsada' : 'está pendiente de reembolso';
  return `⚠️ Esa factura ya está registrada por *${quien}*${fecha ? ` el ${fecha}` : ''} y ${estado}. No se puede reembolsar dos veces.`;
}
