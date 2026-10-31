import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { buildDateFilter } from '../lib/date-filter';
import { parseLocalDate } from '../lib/dates';
import { getAnioFiscal, anioFiscalRange } from '../lib/fiscal-year';
import { logAudit } from '../services/audit-log';
import { syncEntityFromEntry } from '../services/entity-service';
import { anularAsiento } from '../services/journal-annul';
import { crearTransaccionReversion } from '../services/reversion-transaction';
import { resolveEntryOrigin } from '../services/entry-origin';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { checkNotBlocked } from '../services/journal-guard';
import {
  createJournalEntrySchema,
  reviewJournalSchema,
  updateJournalStatusSchema,
  updateJournalEntrySchema,
} from '../validation/schemas';

export const journalRouter = Router();

type CuentaAsiento = {
  id: string;
  code: string;
  name: string;
  type: string;
  requiresAnexo: boolean;
};

type TerceroAsiento = {
  provider: string | null;
  ruc: string | null;
  reference: string | null;
};

/** Cuentas únicas de las líneas, con lo necesario para validar Anexo y tercero. */
async function cuentasDeLineas(prisma: any, companyId: string, lines: any[]): Promise<CuentaAsiento[]> {
  const ids = [...new Set((lines || []).map((l: any) => l.accountId).filter(Boolean))];
  if (!ids.length) return [];
  const rows = await prisma.account.findMany({
    where: { id: { in: ids }, companyId },
    select: { id: true, code: true, name: true, type: true, requiresAnexo: true },
  });
  // Prisma ya filtra por `in`; el filtro en memoria evita que un stub (o un
  // catálogo devuelto de más) cuele una cuenta Anexo que no está en las líneas.
  const byId = new Map((rows || []).map((c: CuentaAsiento) => [c.id, c]));
  return ids.map((id: string) => byId.get(id)).filter(Boolean) as CuentaAsiento[];
}

function leerTercero(body: any): TerceroAsiento {
  const texto = (v: any) => String(v ?? '').trim() || null;
  return {
    provider: texto(body.provider),
    ruc: texto(body.ruc),
    reference: texto(body.reference ?? body.invoiceNumber),
  };
}

/** Crédito = CxC al DEBE (venta a crédito) o CxP al HABER (compra a crédito). */
function esCreditoAsiento(cuentas: CuentaAsiento[], lines: any[]): boolean {
  const byId = new Map(cuentas.map((c) => [c.id, c]));
  return (lines || []).some((l: any) => {
    const c = byId.get(l.accountId);
    return (c?.code === '1.1.03.01' && (l.debit || 0) > 0) ||
      (c?.code === '2.1.01' && (l.credit || 0) > 0);
  });
}

function tipoDeAsiento(cuentas: CuentaAsiento[], lines: any[]): string {
  const byId = new Map(cuentas.map((c) => [c.id, c]));
  const con = (pred: (c: CuentaAsiento | undefined, l: any) => boolean) =>
    (lines || []).some((l: any) => pred(byId.get(l.accountId), l));
  const hasIngreso = con((c) => !!c?.code?.startsWith('4.'));
  const cxcDebit = con((c, l) => c?.code === '1.1.03.01' && (l.debit || 0) > 0);
  const cxcCredit = con((c, l) => c?.code === '1.1.03.01' && (l.credit || 0) > 0);
  const cxpCredit = con((c, l) => c?.code === '2.1.01' && (l.credit || 0) > 0);
  const cxpDebit = con((c, l) => c?.code === '2.1.01' && (l.debit || 0) > 0);
  if (hasIngreso || cxcDebit) return 'VENTA';
  if (cxpCredit) return 'COMPRA';
  if (cxcCredit) return 'COBRO_CLIENTE';
  if (cxpDebit) return 'PAGO_PROVEEDOR';
  return 'GASTO';
}

/** ¿El asiento toca una cuenta donde el tercero tiene sentido? (Anexo, resultado o CxC/CxP). */
function cuentaDeTercero(cuentas: CuentaAsiento[]): boolean {
  return cuentas.some(
    (c) =>
      c.requiresAnexo ||
      ['INGRESO', 'GASTO', 'COSTO'].includes(c.type) ||
      ['1.1.03.01', '2.1.01'].includes(c.code),
  );
}

/** Anexo: la cuenta exige Nombre y RUC; en crédito, también Nº de factura. */
function faltaTerceroAnexo(cuentas: CuentaAsiento[], lines: any[], tercero: TerceroAsiento): string | null {
  const anexo = cuentas.find((c) => c.requiresAnexo);
  if (!anexo) return null;
  const missing: string[] = [];
  if (!tercero.provider) missing.push('Nombre del tercero');
  if (!tercero.ruc) missing.push('RUC/Cédula');
  if (esCreditoAsiento(cuentas, lines) && !tercero.reference) {
    missing.push('Nº de factura (obligatorio en crédito)');
  }
  if (!missing.length) return null;
  return `📎 La cuenta ${anexo.code} — ${anexo.name} lleva Anexo DGI: faltan ${missing.join(', ')}.`;
}

/** Metadata que leen el sync, el Anexo y el visor del asiento. */
function datosTerceroAsiento(tercero: TerceroAsiento) {
  return {
    provider: tercero.provider,
    ruc: tercero.ruc,
    reference: tercero.reference,
    invoiceNumber: tercero.reference,
    fiscalSource: 'MANUAL',
    source: 'asiento-manual',
  };
}

/** El reverso tiene que espejar las cuentas y montos del original. */
function lineasInversas(original: any[], nuevas: any[]): boolean {
  const porCuenta = (ls: any[]) => {
    const m = new Map<string, { d: number; c: number }>();
    for (const l of ls || []) {
      const k = String(l.accountId);
      const x = m.get(k) || { d: 0, c: 0 };
      x.d += Number(l.debit) || 0;
      x.c += Number(l.credit) || 0;
      m.set(k, x);
    }
    return m;
  };
  const a = porCuenta(original);
  const b = porCuenta(nuevas);
  if (a.size === 0 || a.size !== b.size) return false;
  for (const [cuenta, x] of a) {
    const y = b.get(cuenta);
    if (!y) return false;
    if (Math.abs(x.d - y.c) > 0.01 || Math.abs(x.c - y.d) > 0.01) return false;
  }
  return true;
}

journalRouter.get('/pendientes', async (req, res) => {
  const { startDate, endDate } = req.query;
  const where: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: 'BORRADOR',
    isClosing: false,
    // Anular NO cambia el estado del original (sigue contando en su período, lo
    // netea su reverso): `anuladoPorId` es la seña de que ya se corrigió. Sin este
    // filtro, todo BORRADOR anulado —una corrida de planilla re-hecha— reaparece
    // en la cola de revisión como si siguiera vivo.
    anuladoPorId: null,
  };
  // Pendientes de revisión: SIN límite de año fiscal (abarcan todos los períodos)
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) where.date = dateFilter;

  const entries = await req.prisma.journalEntry.findMany({
    where,
    include: {
      lines: { include: { account: true } },
      createdBy: { select: { name: true, email: true } },
      transactions: { select: { metadata: true }, take: 1 },
      // El canal por el que entró la factura, cuando la registró una: es lo que
      // deja ver de un vistazo que este borrador lo cargó el buzón de correo.
      expenseClaim: { select: { origen: true } },
    },
    orderBy: { date: 'asc' },
  });
  const result = entries.map(e => {
    let provider = null;
    try { const m = JSON.parse(e.transactions?.[0]?.metadata || '{}'); provider = m.provider || null; } catch {}
    const { expenseClaim, ...resto } = e as any;
    return { ...resto, provider, origen: expenseClaim?.origen || null };
  });
  res.json(result);
});

journalRouter.post('/:id/review', requireRole('admin', 'contador', 'superadmin'), validate(reviewJournalSchema), async (req, res) => {
  const { action, notes } = req.body;

  try {
    const result = await req.prisma.$transaction(async (tx) => {
      const entry = await tx.journalEntry.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
      });
      if (!entry) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });

      if (entry.status !== 'BORRADOR') {
        throw Object.assign(
          new Error(`Solo se pueden revisar asientos en BORRADOR. Estado actual: ${entry.status}`),
          { status: 400 },
        );
      }

      const newStatus = action === 'aprobar' ? 'CONFIRMADO' : 'RECHAZADO';

      const updated = await tx.journalEntry.update({
        where: { id: entry.id },
        data: {
          status: newStatus,
          reviewedById: req.user!.userId,
          reviewedAt: new Date(),
          reviewNotes: notes || null,
        },
        include: {
          lines: { include: { account: true } },
          createdBy: { select: { name: true } },
          reviewedBy: { select: { name: true } },
        },
      });

      // Si se rechaza, marcar Invoice/Bill como RECHAZADA para que no aparezca en auxiliar
      if (newStatus === 'RECHAZADO') {
        await tx.invoice.updateMany({
          where: { journalEntryId: entry.id },
          data: { status: 'RECHAZADA' },
        });
        await tx.bill.updateMany({
          where: { journalEntryId: entry.id },
          data: { status: 'RECHAZADA' },
        });

        // Reembolsos: el reclamo se cae con el asiento. Dejarlo sería peor que
        // perderlo — la factura quedaría como pendiente de pago Y el índice de
        // deduplicación le impediría al trabajador volver a mandarla corregida.
        await tx.expenseClaim.deleteMany({ where: { journalEntryId: entry.id } });

        // Cobros: el asiento es provisional — al rechazarlo se REVIERTEN sus
        // efectos sobre la factura (InvoicePayment, retención y paidAmount),
        // para que CxC vuelva al estado real y la carga pueda rehacerse.
        // (El JE del cobro no referencia la factura: la referencia es del JE
        // de VENTA; por eso hay que revertir explícitamente por payments.)
        const cobroPayments = await tx.invoicePayment.findMany({
          where: { journalEntryId: entry.id },
          select: { id: true, invoiceId: true },
        });
        if (cobroPayments.length > 0) {
          await tx.retentionItbms.deleteMany({
            where: { invoicePaymentId: { in: cobroPayments.map(p => p.id) } },
          });
          await tx.invoicePayment.deleteMany({ where: { journalEntryId: entry.id } });
          const invoiceIds = [...new Set(cobroPayments.map(p => p.invoiceId))];
          for (const invId of invoiceIds) {
            const inv = await tx.invoice.findUnique({ where: { id: invId } });
            if (!inv) continue;
            const restantes = await tx.invoicePayment.aggregate({
              where: { invoiceId: invId },
              _sum: { amount: true, retentionAmount: true },
            });
            const aplicado = Math.round(((restantes._sum.amount || 0) + (restantes._sum.retentionAmount || 0)) * 100) / 100;
            const saldo = Math.round((inv.total - aplicado) * 100) / 100;
            const quedaPagada = saldo <= 0.01;
            await tx.invoice.update({
              where: { id: invId },
              data: {
                paidAmount: aplicado,
                status: quedaPagada ? 'PAGADA' : 'PENDIENTE',
                paidAt: quedaPagada ? (inv.paidAt ?? new Date()) : null,
              },
            });
          }
        }
      }

      return { updated, previousStatus: entry.status };
    });

    // Audit log
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: result.updated.status === 'CONFIRMADO' ? 'JOURNAL_APPROVED' : 'JOURNAL_REJECTED',
      entity: 'JournalEntry',
      entityId: req.params.id,
      before: { status: result.previousStatus },
      after: { status: result.updated.status, notes: notes || null },
    });

    res.json(result.updated);
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

journalRouter.get('/', async (req, res) => {
  const { startDate, endDate, status, provider: providerFilter, page: pageStr, pageSize: pageSizeStr } = req.query;
  const where: Record<string, unknown> = { companyId: req.user!.companyId, isClosing: false };
  if (status) where.status = status;
  // Sin filtro de fechas → año fiscal activo (consistente con el balance)
  const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
  const rango = anioFiscalRange(anioFiscal);
  const dateFilter = startDate || endDate
    ? buildDateFilter(startDate as string, endDate as string)
    : { gte: rango.start, lte: rango.end };
  if (dateFilter) where.date = dateFilter;

  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr as string) || 50));

  // Filtro de proveedor en BD: busca el substring en el metadata JSON de la transacción
  // (antes se filtraba en JS tras cargar TODO el libro; now con contains insensitive)
  if (providerFilter) {
    where.transactions = { some: { metadata: { contains: String(providerFilter), mode: 'insensitive' } } };
  }

  // Paginación real en BD: count + skip/take (antes se cargaba todo y se paginaba en memoria)
  const [total, entries] = await Promise.all([
    req.prisma.journalEntry.count({ where }),
    req.prisma.journalEntry.findMany({
      where,
      include: {
        lines: { include: { account: true } },
        createdBy: { select: { name: true } },
        transactions: { select: { metadata: true, concept: true } },
      },
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const enriched = entries.map((e: any) => {
    const tx = e.transactions?.[0];
    let provider: string | null = null;
    if (tx?.metadata) {
      try { const m = JSON.parse(tx.metadata); provider = m.provider || null; } catch { }
    }
    return { ...e, provider };
  });

  const totalPages = Math.ceil(total / pageSize);

  res.json({
    periodo: { start: rango.start, end: rango.end, anioFiscal },
    entries: enriched, total, page, pageSize, totalPages,
  });
});

journalRouter.get('/:id', async (req, res) => {
  const entry = await req.prisma.journalEntry.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: {
      lines: { include: { account: true } },
      createdBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
      // Concepto con que se clasificó el movimiento: la descripción del asiento
      // lleva el detalle original, así que el visor muestra aquí a qué concepto
      // (cuenta) fue. `take: 1` porque un asiento tiene a lo sumo una.
      transactions: { select: { type: true, concept: true, metadata: true }, take: 1 },
    },
  });
  if (!entry) { res.status(404).json({ error: 'Journal entry not found' }); return; }
  // Tercero del asiento (Anexo/venta/compra) para prellenar el modal de edición.
  let tercero: { provider: string | null; ruc: string | null; reference: string | null } | null = null;
  const tx = entry.transactions?.[0];
  if (tx?.metadata) {
    try {
      const m = JSON.parse(tx.metadata);
      tercero = {
        provider: m.provider || m.nombre || null,
        ruc: m.ruc || null,
        reference: m.invoiceNumber || m.reference || null,
      };
    } catch { /* metadata corrupta: el modal abre sin tercero */ }
  }
  // `origin`: de dónde salió el asiento (factura, cobro, importación, manual…).
  // Lo consume el visor "Asiento original" del auxiliar de cuenta. La metadata
  // cruda no se devuelve: el frontend solo necesita el tercero ya resumido.
  const origin = await resolveEntryOrigin(req.prisma, req.user!.companyId, entry);
  const transactions = (entry.transactions || []).map(({ metadata, ...t }: any) => t);
  res.json({ ...entry, transactions, origin, tercero });
});

journalRouter.post('/', requireQuota, validate(createJournalEntrySchema), async (req, res) => {
  const { date, description, lines, provider, ruc, reference, reversalOf } = req.body;
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;
  const totalDebit = lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    res.status(400).json({ error: `Debit (${totalDebit}) != Credit (${totalCredit})` });
    return;
  }

  // 0 = 0 cuadra pero no es un asiento (p. ej. una copia guardada sin montos)
  if (Math.round(totalDebit * 100) === 0) {
    res.status(400).json({ error: 'El asiento no puede quedar en cero: asigna montos a las líneas' });
    return;
  }

  const blocked = await checkNotBlocked(req.prisma, companyId, lines.map((l: { accountId: string }) => l.accountId));
  if (blocked) { res.status(400).json({ error: blocked }); return; }

  let cuentas: CuentaAsiento[] = [];
  try {
    cuentas = await cuentasDeLineas(req.prisma, companyId, lines);
  } catch (e) {
    res.status(500).json({ error: 'No se pudieron cargar las cuentas del asiento' });
    return;
  }
  const tercero = leerTercero({ provider, ruc, reference });
  // El reverso de una corrección es un espejo del original: no es un alta nueva
  // de tercero y no debe exigir Nombre/RUC aunque toque una cuenta con Anexo.
  const faltaTercero = reversalOf ? null : faltaTerceroAnexo(cuentas, lines, tercero);
  if (faltaTercero) { res.status(400).json({ error: faltaTercero }); return; }
  const conTercero = !reversalOf && cuentaDeTercero(cuentas) && !!(tercero.provider || tercero.ruc);
  const tipo = tipoDeAsiento(cuentas, lines);
  const esCredito = esCreditoAsiento(cuentas, lines);

  // El asiento y su Transaction (la fuente de metadata que lee el sync) nacen
  // juntos: si falla una de las dos, no queda un asiento sin tercero.
  let entry: any;
  try {
    entry = await req.prisma.$transaction(async (tx: any) => {
      if (reversalOf) {
        const original = await tx.journalEntry.findFirst({
          where: { id: reversalOf, companyId },
          select: {
            id: true,
            lines: { select: { accountId: true, debit: true, credit: true } },
          },
        });
        if (!original) {
          throw Object.assign(new Error('El asiento original del reverso no existe'), { status: 400 });
        }
        if (!lineasInversas(original.lines, lines)) {
          throw Object.assign(
            new Error('El reverso no coincide con las cuentas y montos del asiento original'),
            { status: 400 },
          );
        }
      }

      const created = await tx.journalEntry.create({
        data: {
          date: parseLocalDate(date),
          description,
          companyId,
          createdById: userId,
          lines: {
            create: lines.map((l: { accountId: string; debit?: number; credit?: number }) => ({
              accountId: l.accountId,
              debit: l.debit || 0,
              credit: l.credit || 0,
            })),
          },
        },
        include: { lines: { include: { account: true } } },
      });

      if (reversalOf) {
        // La Transaction del reverso nace con el importe NEGATIVO del original
        // y su misma metadata, para que Anexos/Proveedores neteen la corrección.
        await crearTransaccionReversion(tx, {
          companyId,
          userId,
          journalEntryId: created.id,
          originalJournalEntryId: reversalOf,
          description,
          date: parseLocalDate(date),
          source: 'reversion',
        });
      } else if (conTercero) {
        await tx.transaction.create({
          data: {
            type: tipo,
            amount: Math.round(totalDebit * 100) / 100,
            description,
            concept: description,
            paymentMethod: esCredito ? 'CREDITO' : null,
            date: parseLocalDate(date),
            companyId,
            createdById: userId,
            journalEntryId: created.id,
            metadata: JSON.stringify(datosTerceroAsiento(tercero)),
          },
        });
      }
      return created;
    });
  } catch (e: any) {
    res.status(e?.status || 500).json({ error: e?.message || 'No se pudo crear el asiento' });
    return;
  }

  // Crear/actualizar el maestro (cliente en ventas, proveedor en compras/gastos)
  if (conTercero) {
    try {
      await syncEntityFromEntry(req.prisma, companyId, entry);
    } catch (e) { /* el asiento ya quedó; el sync no debe tumbar la creación */ }
  }

  // Contar como movimiento (asiento contable creado)
  await incrementUsage(req);

  await logAudit(req.prisma, {
    userId: req.user!.userId,
    action: 'JOURNAL_CREATED',
    entity: 'JournalEntry',
    entityId: entry.id,
    after: { description, date, lineCount: lines.length },
  });

  res.status(201).json(entry);
});

journalRouter.patch('/:id/status', validate(updateJournalStatusSchema), async (req, res) => {
  const { status } = req.body;
  const allowedTransitions: Record<string, string[]> = {
    BORRADOR: ['RECHAZADO'],    // solo el creador puede re-enviar tras corrección (future)
    RECHAZADO: ['BORRADOR'],     // re-envío tras correcciones
  };

  const entry = await req.prisma.journalEntry.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!entry) { res.status(404).json({ error: 'Asiento no encontrado' }); return; }

  const allowed = allowedTransitions[entry.status];
  if (!allowed || !allowed.includes(status)) {
    res.status(400).json({
      error: `Transición no válida: ${entry.status} → ${status}. Use el endpoint /review para aprobar/rechazar.`,
    });
    return;
  }

  const updated = await req.prisma.journalEntry.update({
    where: { id: req.params.id },
    data: { status },
    include: { lines: { include: { account: true } }, createdBy: { select: { name: true } } },
  });

  // Si se reenvía (RECHAZADO → BORRADOR), reactivar Invoice/Bill
  if (status === 'BORRADOR' && entry.status === 'RECHAZADO') {
    await req.prisma.invoice.updateMany({
      where: { journalEntryId: req.params.id, status: 'RECHAZADA' },
      data: { status: 'PENDIENTE' },
    });
    await req.prisma.bill.updateMany({
      where: { journalEntryId: req.params.id, status: 'RECHAZADA' },
      data: { status: 'PENDIENTE' },
    });
  }

  res.json(updated);
});

journalRouter.post('/:id/anular', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const entryId = req.params.id;

  try {
    // El cuerpo vive en services/journal-annul.ts: es la fuente única y la que fija
    // la semántica de "anular no reescribe la historia" (ver el comentario del servicio).
    const result = await req.prisma.$transaction((tx: any) =>
      anularAsiento(tx, req.user!.companyId, req.user!.userId, entryId));

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'JOURNAL_ANNULED',
      entity: 'JournalEntry',
      entityId: entryId,
      after: { anuladoPorId: result.reversal.id },
    });

    res.json(result);
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// PUT /:id — Editar un asiento BORRADOR (solo admin)
journalRouter.put('/:id', requireRole('admin', 'superadmin'), validate(updateJournalEntrySchema), async (req, res) => {
  const { date, description, lines, provider, ruc, reference } = req.body;
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  // Editar un borrador con cuenta bloqueada se rechaza (anular sí se permite)
  const blocked = await checkNotBlocked(req.prisma, companyId, lines.map((l: { accountId: string }) => l.accountId));
  if (blocked) { res.status(400).json({ error: blocked }); return; }

  try {
    const cuentas = await cuentasDeLineas(req.prisma, companyId, lines);
    const tercero = leerTercero({ provider, ruc, reference });
    const faltaTercero = faltaTerceroAnexo(cuentas, lines, tercero);
    if (faltaTercero) { res.status(400).json({ error: faltaTercero }); return; }
    const tocaTercero = provider !== undefined || ruc !== undefined || reference !== undefined;
    const tipo = tipoDeAsiento(cuentas, lines);
    const esCredito = esCreditoAsiento(cuentas, lines);

    const result = await req.prisma.$transaction(async (tx: any) => {
      const entry = await tx.journalEntry.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
        include: { lines: true },
      });
      if (!entry) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });

      if (entry.status !== 'BORRADOR') {
        throw Object.assign(
          new Error(`Solo se pueden editar asientos en BORRADOR. Estado actual: ${entry.status}`),
          { status: 400 },
        );
      }

      // Validar balance
      const totalDebit = lines.reduce((sum: number, l: any) => sum + (l.debit || 0), 0);
      const totalCredit = lines.reduce((sum: number, l: any) => sum + (l.credit || 0), 0);
      if (Math.abs(totalDebit - totalCredit) > 0.01) {
        throw Object.assign(
          new Error(`Asiento no balanceado. Débito: ${totalDebit.toFixed(2)}, Crédito: ${totalCredit.toFixed(2)}, Diferencia: ${Math.abs(totalDebit - totalCredit).toFixed(2)}`),
          { status: 400 },
        );
      }

      // 0 = 0 cuadra pero no es un asiento
      if (Math.round(totalDebit * 100) === 0) {
        throw Object.assign(
          new Error('El asiento no puede quedar en cero: asigna montos a las líneas'),
          { status: 400 },
        );
      }

      // Borrar líneas existentes y crear las nuevas
      await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id } });

      const updated = await tx.journalEntry.update({
        where: { id: entry.id },
        data: {
          date: parseLocalDate(date),
          description,
          lines: {
            create: lines.map((l: any) => ({
              accountId: l.accountId,
              debit: l.debit || 0,
              credit: l.credit || 0,
            })),
          },
        },
        include: {
          lines: { include: { account: true } },
          createdBy: { select: { name: true } },
        },
      });

      // Mantener la Transaction (metadata del tercero y tipo del asiento) en
      // línea con las líneas editadas. Los asientos que no tienen tercero no
      // crean Transaction: no hay nada que sincronizar.
      const existingTxn = await tx.transaction.findFirst({
        where: { journalEntryId: entry.id },
        select: { id: true, metadata: true },
      });
      if (existingTxn) {
        let m: any = {};
        try { m = JSON.parse(existingTxn.metadata || '{}'); } catch { /* metadata corrupta: se rehace */ }
        const esManual = !m.source || m.source === 'asiento-manual';
        const metadata = { ...m };
        if (tocaTercero) {
          const cambiaProveedor =
            (provider !== undefined && (m.provider || null) !== tercero.provider) ||
            (ruc !== undefined && (m.ruc || null) !== tercero.ruc);
          // Si cambia la identidad, los ids viejos apuntan a otro maestro:
          // el sync los vuelve a escribir con el que corresponda.
          if (cambiaProveedor) { delete metadata.supplierId; delete metadata.clientId; }
          if (provider !== undefined) metadata.provider = tercero.provider;
          if (ruc !== undefined) metadata.ruc = tercero.ruc;
          if (reference !== undefined) {
            metadata.reference = tercero.reference;
            metadata.invoiceNumber = tercero.reference;
          }
          if (esManual) metadata.fiscalSource = 'MANUAL';
        }
        if (esManual) metadata.source = metadata.source || 'asiento-manual';
        const data: any = { metadata: JSON.stringify(metadata) };
        if (esManual) {
          data.type = tipo;
          data.amount = Math.round(totalDebit * 100) / 100;
          data.description = description;
          data.concept = description;
          data.paymentMethod = esCredito ? 'CREDITO' : null;
        }
        await tx.transaction.update({ where: { id: existingTxn.id }, data });
      } else if (tocaTercero && cuentaDeTercero(cuentas) && (tercero.provider || tercero.ruc)) {
        await tx.transaction.create({
          data: {
            type: tipo,
            amount: Math.round(totalDebit * 100) / 100,
            description,
            concept: description,
            paymentMethod: esCredito ? 'CREDITO' : null,
            date: parseLocalDate(date),
            companyId,
            createdById: userId,
            journalEntryId: entry.id,
            metadata: JSON.stringify(datosTerceroAsiento(tercero)),
          },
        });
      }

      return { updated, previousLines: entry.lines.length };
    });

    // Sincronizar auxiliares (CxC/CxP) tras edición
    try {
      await syncEntityFromEntry(req.prisma, req.user!.companyId, result.updated);
    } catch (e) { /* no blocking */ }

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'JOURNAL_EDITED',
      entity: 'JournalEntry',
      entityId: req.params.id,
      before: { linesCount: result.previousLines },
      after: { linesCount: lines.length, description, date },
    });

    res.json(result.updated);
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

journalRouter.get('/mayor/:accountId', async (req, res) => {
  const { startDate, endDate } = req.query;
  const journalEntry: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] },
  };
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) journalEntry.date = dateFilter;

  const where: Record<string, unknown> = {
    accountId: req.params.accountId,
    journalEntry,
  };

  const lines = await req.prisma.journalLine.findMany({
    where,
    include: {
      journalEntry: {
        select: { id: true, date: true, description: true, status: true },
      },
      account: { select: { code: true, name: true, type: true } },
    },
    orderBy: { journalEntry: { date: 'asc' } },
  });

  // Calcular saldo acumulado
  let balance = 0;
  const detail = lines.map(l => {
    const isNatureDebit = ['ACTIVO', 'GASTO', 'COSTO'].includes(l.account.type);
    // Para cuentas de naturaleza débito: débito suma, crédito resta
    // Para cuentas de naturaleza crédito: crédito suma, débito resta
    if (isNatureDebit) {
      balance += l.debit - l.credit;
    } else {
      balance += l.credit - l.debit;
    }
    return {
      id: l.journalEntry.id,
      date: l.journalEntry.date,
      description: l.journalEntry.description,
      debit: l.debit,
      credit: l.credit,
      balance: Math.round(balance * 100) / 100,
      status: l.journalEntry.status,
    };
  });

  res.json({
    account: lines[0]?.account || null,
    detail,
    totals: {
      totalDebit: Math.round(detail.reduce((s, d) => s + d.debit, 0) * 100) / 100,
      totalCredit: Math.round(detail.reduce((s, d) => s + d.credit, 0) * 100) / 100,
      finalBalance: Math.round(balance * 100) / 100,
    },
  });
});
