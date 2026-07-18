import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireQuota } from '../middleware/quota';
import { calculateNextRun, processDueItems, processSingleTemplate } from '../services/recurring-processor';
import {
  createRecurringSchema,
  updateRecurringSchema,
  toggleRecurringSchema,
} from '../validation/schemas';

export const recurringRouter = Router();

// GET /api/recurring — listar plantillas
recurringRouter.get('/', async (req, res) => {
  const templates = await req.prisma.recurringTemplate.findMany({
    where: { companyId: req.user!.companyId },
    include: {
      lastEntry: {
        select: { id: true, date: true, status: true },
      },
    },
    orderBy: { nextRunAt: 'asc' },
  });

  const pendientes = templates.filter(t => t.requireConfirmation && t.lastEntryId);
  const pendingReviewCount = await req.prisma.journalEntry.count({
    where: {
      id: { in: pendientes.map(t => t.lastEntryId!).filter(Boolean) },
      status: 'BORRADOR',
    },
  });

  res.json({ templates, pendingReview: pendingReviewCount });
});

// POST /api/recurring — crear plantilla
recurringRouter.post('/', validate(createRecurringSchema), async (req, res) => {
  const { description, amount, concept, type, paymentMethod, debitAccountId, creditAccountId, frequency, dayOfMonth, dayOfWeek, requireConfirmation } = req.body;

  const nextRunAt = calculateNextRun(frequency, dayOfMonth ?? null, dayOfWeek ?? null);

  const template = await req.prisma.recurringTemplate.create({
    data: {
      companyId: req.user!.companyId,
      createdById: req.user!.userId,
      description,
      amount,
      concept: concept || null,
      type,
      paymentMethod: paymentMethod || null,
      debitAccountId: debitAccountId || null,
      creditAccountId: creditAccountId || null,
      frequency,
      dayOfMonth: dayOfMonth ?? null,
      dayOfWeek: dayOfWeek ?? null,
      nextRunAt,
      requireConfirmation: requireConfirmation ?? true,
    },
  });

  res.status(201).json(template);
});

// PUT /api/recurring/:id — editar plantilla
recurringRouter.put('/:id', validate(updateRecurringSchema), async (req, res) => {
  const existing = await req.prisma.recurringTemplate.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Plantilla no encontrada' }); return; }

  const data: any = { ...req.body };

  // Si cambió la frecuencia, recalcular nextRunAt
  if (data.frequency && data.frequency !== existing.frequency) {
    const dayOfMonth = data.dayOfMonth ?? existing.dayOfMonth;
    const dayOfWeek = data.dayOfWeek ?? existing.dayOfWeek;
    data.nextRunAt = calculateNextRun(data.frequency, dayOfMonth ?? null, dayOfWeek ?? null);
  }

  const template = await req.prisma.recurringTemplate.update({
    where: { id: req.params.id },
    data,
  });

  res.json(template);
});

// DELETE /api/recurring/:id — eliminar plantilla
recurringRouter.delete('/:id', async (req, res) => {
  const existing = await req.prisma.recurringTemplate.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Plantilla no encontrada' }); return; }

  await req.prisma.recurringTemplate.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// POST /api/recurring/:id/toggle — pausar/reanudar
recurringRouter.post('/:id/toggle', validate(toggleRecurringSchema), async (req, res) => {
  const existing = await req.prisma.recurringTemplate.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Plantilla no encontrada' }); return; }

  const { isActive } = req.body;
  const updates: any = { isActive };
  if (isActive && existing.nextRunAt < new Date()) {
    updates.nextRunAt = calculateNextRun(existing.frequency, existing.dayOfMonth, existing.dayOfWeek);
  }

  const template = await req.prisma.recurringTemplate.update({
    where: { id: req.params.id },
    data: updates,
  });

  res.json(template);
});

// POST /api/recurring/:id/run — ejecutar UN template específico AHORA (atómico, sin duplicados)
recurringRouter.post('/:id/run', requireQuota, async (req, res) => {
  try {
    const result = await processSingleTemplate(req.prisma, req.params.id as string, req.user!.companyId);
    res.json(result);
  } catch (error: any) {
    console.error('[Recurring] Run error:', error);
    res.status(500).json({ error: 'Error al ejecutar', detail: error?.message });
  }
});

// POST /api/recurring/process — ejecutar pendientes
recurringRouter.post('/process', requireQuota, async (req, res) => {
  try {
    const result = await processDueItems(req.prisma, req.user!.companyId);
    res.json(result);
  } catch (error: any) {
    console.error('[Recurring] Process error:', error);
    res.status(500).json({
      error: 'Error al procesar transacciones recurrentes',
      detail: error?.message,
    });
  }
});
