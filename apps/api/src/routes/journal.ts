import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { buildDateFilter } from '../lib/date-filter';
import { logAudit } from '../services/audit-log';
import { syncEntityFromEntry } from '../services/entity-service';
import { requireQuota, incrementUsage } from '../middleware/quota';
import {
  createJournalEntrySchema,
  reviewJournalSchema,
  updateJournalStatusSchema,
  updateJournalEntrySchema,
} from '../validation/schemas';

export const journalRouter = Router();

journalRouter.get('/pendientes', async (req, res) => {
  const { startDate, endDate } = req.query;
  const where: Record<string, unknown> = {
    companyId: req.user!.companyId,
    status: 'BORRADOR',
  };
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) where.date = dateFilter;

  const entries = await req.prisma.journalEntry.findMany({
    where,
    include: {
      lines: { include: { account: true } },
      createdBy: { select: { name: true, email: true } },
    },
    orderBy: { date: 'asc' },
  });
  res.json(entries);
});

journalRouter.post('/:id/review', requireRole('admin', 'contador'), validate(reviewJournalSchema), async (req, res) => {
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
  const where: Record<string, unknown> = { companyId: req.user!.companyId };
  if (status) where.status = status;
  const dateFilter = buildDateFilter(startDate as string, endDate as string);
  if (dateFilter) where.date = dateFilter;

  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr as string) || 50));

  const allEntries = await req.prisma.journalEntry.findMany({
    where,
    include: {
      lines: { include: { account: true } },
      createdBy: { select: { name: true } },
      transactions: { select: { metadata: true, concept: true } },
    },
    orderBy: { date: 'desc' },
  });

  const enriched = allEntries.map((e: any) => {
    const tx = e.transactions?.[0];
    let provider: string | null = null;
    if (tx?.metadata) {
      try { const m = JSON.parse(tx.metadata); provider = m.provider || null; } catch { }
    }
    return { ...e, provider };
  });

  const filtered = providerFilter
    ? enriched.filter((e: any) => e.provider && e.provider.toLowerCase().includes((providerFilter as string).toLowerCase()))
    : enriched;

  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const paginated = filtered.slice((page - 1) * pageSize, page * pageSize);

  res.json({ entries: paginated, total, page, pageSize, totalPages });
});

journalRouter.get('/:id', async (req, res) => {
  const entry = await req.prisma.journalEntry.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: {
      lines: { include: { account: true } },
      createdBy: { select: { name: true } },
      reviewedBy: { select: { name: true } },
    },
  });
  if (!entry) { res.status(404).json({ error: 'Journal entry not found' }); return; }
  res.json(entry);
});

journalRouter.post('/', requireQuota, validate(createJournalEntrySchema), async (req, res) => {
  const { date, description, lines } = req.body;
  const totalDebit = lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    res.status(400).json({ error: `Debit (${totalDebit}) != Credit (${totalCredit})` });
    return;
  }

  const entry = await req.prisma.journalEntry.create({
    data: {
      date: new Date(date),
      description,
      companyId: req.user!.companyId,
      createdById: req.user!.userId,
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

journalRouter.post('/:id/anular', requireRole('admin', 'contador'), async (req, res) => {
  const entryId = req.params.id;

  try {
    const result = await req.prisma.$transaction(async (tx) => {
      const original = await tx.journalEntry.findFirst({
        where: { id: entryId, companyId: req.user!.companyId },
        include: { lines: true, transactions: true },
      });
      const orig = original as any;
      if (!orig) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });
      if (orig.status === 'ANULADO') throw Object.assign(new Error('El asiento ya está anulado'), { status: 400 });
      if (orig.description.startsWith('ANULACIÓN:')) throw Object.assign(new Error('No se puede anular un asiento de reversión'), { status: 400 });

      const reversal = await tx.journalEntry.create({
        data: {
          date: new Date(),
          description: `ANULACIÓN: ${orig.description}`,
          status: 'CONFIRMADO',
          companyId: req.user!.companyId,
          createdById: req.user!.userId,
          lines: {
            create: orig.lines.map((l: any) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
            })),
          },
        },
        include: { lines: { include: { account: true } } },
      });

      await tx.journalEntry.update({
        where: { id: orig.id },
        data: { status: 'ANULADO' },
      });

      if (orig.transactions?.length > 0) {
        await tx.transaction.updateMany({
          where: { journalEntryId: orig.id },
          data: { journalEntryId: reversal.id },
        });
      }

      return { original: { ...original, status: 'ANULADO' }, reversal };
    });

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'JOURNAL_ANNULED',
      entity: 'JournalEntry',
      entityId: entryId,
      before: { status: result.original.status },
      after: { status: 'ANULADO', reversalId: result.reversal.id },
    });

    res.json(result);
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

// PUT /:id — Editar un asiento BORRADOR (solo admin)
journalRouter.put('/:id', requireRole('admin'), validate(updateJournalEntrySchema), async (req, res) => {
  const { date, description, lines } = req.body;

  try {
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

      // Borrar líneas existentes y crear las nuevas
      await tx.journalLine.deleteMany({ where: { journalEntryId: entry.id } });

      const updated = await tx.journalEntry.update({
        where: { id: entry.id },
        data: {
          date: new Date(date + 'T12:00:00'),
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
