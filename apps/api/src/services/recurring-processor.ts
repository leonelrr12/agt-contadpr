import { ClassificationAgent } from '@agt-contador/agents';
import { AccountingAgent } from '@agt-contador/agents';
import type { DialogResult } from '@agt-contador/agents';

export interface SingleProcessResult {
  executed: boolean;
  entryId?: string;
  error?: string;
}

export interface ProcessResult {
  processed: number;
  skipped: number;
  errors: { templateId: string; description: string; error: string }[];
  entryIds: string[];
}

/**
 * Calcula la próxima fecha de ejecución según la frecuencia.
 */
export function calculateNextRun(
  frequency: string,
  dayOfMonth: number | null,
  dayOfWeek: number | null,
  fromDate: Date = new Date(),
): Date {
  const next = new Date(fromDate);

  switch (frequency) {
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY': {
      const targetDay = dayOfWeek ?? next.getDay();
      const currentDay = next.getDay();
      const daysUntil = (targetDay - currentDay + 7) % 7 || 7;
      next.setDate(next.getDate() + daysUntil);
      break;
    }
    case 'MONTHLY': {
      const targetDay = dayOfMonth ?? next.getDate();
      next.setMonth(next.getMonth() + 1);
      next.setDate(Math.min(targetDay, new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()));
      break;
    }
    case 'YEARLY': {
      const targetDay = dayOfMonth ?? next.getDate();
      const targetMonth = next.getMonth();
      next.setFullYear(next.getFullYear() + 1);
      next.setMonth(targetMonth);
      next.setDate(Math.min(targetDay, new Date(next.getFullYear(), targetMonth + 1, 0).getDate()));
      break;
    }
    default:
      next.setDate(next.getDate() + 30); // default: mensual
  }

  // Normalizar a inicio del día
  next.setHours(0, 0, 0, 0);
  return next;
}

/**
 * Procesa UN solo template de forma atómica — sin riesgo de duplicados.
 * Actualiza nextRunAt DENTRO de la transacción para evitar race conditions.
 */
export async function processSingleTemplate(
  prisma: any,
  templateId: string,
  companyId: string,
): Promise<SingleProcessResult> {
  const template = await prisma.recurringTemplate.findFirst({
    where: { id: templateId, companyId },
  });
  if (!template) return { executed: false, error: 'Plantilla no encontrada' };

  // ── Guardia anti-duplicado por período ──
  if (template.lastRunAt) {
    const lastRun = new Date(template.lastRunAt);
    const now = new Date();
    const samePeriod = (() => {
      switch (template.frequency) {
        case 'DAILY':
          return lastRun.toDateString() === now.toDateString();
        case 'WEEKLY': {
          // misma semana (lunes como inicio)
          const getWeek = (d: Date) => {
            const start = new Date(d.getFullYear(), 0, 1);
            const days = Math.floor((d.getTime() - start.getTime()) / 86400000);
            return Math.floor((days + start.getDay() + 6) / 7);
          };
          return getWeek(lastRun) === getWeek(now) && lastRun.getFullYear() === now.getFullYear();
        }
        case 'MONTHLY':
          return lastRun.getMonth() === now.getMonth() && lastRun.getFullYear() === now.getFullYear();
        case 'YEARLY':
          return lastRun.getFullYear() === now.getFullYear();
        default:
          return false;
      }
    })();

    if (samePeriod) {
      const periodLabels: Record<string, string> = {
        DAILY: 'hoy', WEEKLY: 'esta semana', MONTHLY: 'este mes', YEARLY: 'este año',
      };
      return { executed: false, error: `Ya se ejecutó ${periodLabels[template.frequency] || 'en este período'}. Espera al siguiente ciclo.` };
    }
  }

  try {
    // Verificar quota
    const subscription = await prisma.subscription.findFirst({
      where: {
        companyId: template.companyId,
        status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
      },
    });

    if (!subscription || subscription.movementsUsed >= subscription.movementsLimit) {
      return { executed: false, error: 'Quota excedida. No se puede crear el asiento.' };
    }

    // Clasificar concepto
    const classifier = new ClassificationAgent({ prisma, companyId: template.companyId });
    const concept = template.concept || template.description;
    const classification = await classifier.classify(concept, template.type);

    if (!classification.accountId || classification.confidence < 0.3) {
      return { executed: false, error: `No se pudo clasificar "${concept}"` };
    }

    const accountId = template.debitAccountId || template.creditAccountId || classification.accountId;

    // Generar asiento
    const accountant = new AccountingAgent(prisma, template.companyId);
    await accountant.init();

    const dialog: DialogResult = {
      type: template.type as any,
      amount: template.amount,
      currency: 'USD',
      description: template.description,
      concept: concept,
      paymentMethod: (template.paymentMethod || null) as any,
      date: new Date().toISOString().split('T')[0],
      confidence: 0.95,
      missingFields: [],
      itbms: false,
      provider: null,
      suggestedResponse: '',
    };

    const classificationResult = { concept, accountId, confidence: 0.95 };
    const entry = accountant.generateEntry(dialog, classificationResult);

    const debitLines = entry.debit.map((d: any) => ({
      accountId: accountant.resolveAlias(d.accountId),
      debit: d.amount,
      credit: 0,
    }));
    const creditLines = entry.credit.map((c: any) => ({
      accountId: accountant.resolveAlias(c.accountId),
      debit: 0,
      credit: c.amount,
    }));

    const status = template.requireConfirmation ? 'BORRADOR' : 'CONFIRMADO';
    const next = calculateNextRun(template.frequency, template.dayOfMonth, template.dayOfWeek);

    // ── TODO en una sola transacción atómica ──
    const created = await prisma.$transaction(async (tx: any) => {
      // Actualizar nextRunAt PRIMERO para evitar que otro proceso concurrente también lo tome
      await tx.recurringTemplate.update({
        where: { id: template.id },
        data: { nextRunAt: next, lastRunAt: new Date() },
      });

      const je = await tx.journalEntry.create({
        data: {
          date: new Date(),
          description: `[Recurrente] ${entry.description}`,
          status,
          companyId: template.companyId,
          createdById: template.createdById,
          lines: { create: [...debitLines, ...creditLines] },
        },
      });

      await tx.transaction.create({
        data: {
          type: template.type,
          amount: template.amount,
          description: template.description,
          concept: concept,
          paymentMethod: template.paymentMethod,
          date: new Date(),
          companyId: template.companyId,
          createdById: template.createdById,
          journalEntryId: je.id,
          metadata: JSON.stringify({ recurring: true, templateId: template.id }),
        },
      });

      await tx.subscription.updateMany({
        where: {
          companyId: template.companyId,
          status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
        },
        data: { movementsUsed: { increment: 1 } },
      });

      // Actualizar lastEntryId
      await tx.recurringTemplate.update({
        where: { id: template.id },
        data: { lastEntryId: je.id },
      });

      return je;
    });

    return { executed: true, entryId: created.id };
  } catch (err: any) {
    return { executed: false, error: err.message || 'Error desconocido' };
  }
}

/**
 * Procesa todas las plantillas recurrentes que están pendientes de ejecución.
 */
export async function processDueItems(
  prisma: any,
  companyId?: string,
): Promise<ProcessResult> {
  const where: any = {
    isActive: true,
    nextRunAt: { lte: new Date() },
  };
  if (companyId) where.companyId = companyId;

  const templates = await prisma.recurringTemplate.findMany({
    where,
    include: { company: true },
  });

  const result: ProcessResult = {
    processed: 0,
    skipped: 0,
    errors: [],
    entryIds: [],
  };

  for (const template of templates) {
    try {
      // Verificar quota
      const subscription = await prisma.subscription.findFirst({
        where: {
          companyId: template.companyId,
          status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
        },
      });

      if (!subscription || subscription.movementsUsed >= subscription.movementsLimit) {
        result.skipped++;
        // Adelantar nextRunAt 1 día para reintentar
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        await prisma.recurringTemplate.update({
          where: { id: template.id },
          data: { nextRunAt: tomorrow },
        });
        continue;
      }

      // Clasificar concepto
      const classifier = new ClassificationAgent({
        prisma,
        companyId: template.companyId,
      });

      const concept = template.concept || template.description;
      const classification = await classifier.classify(concept, template.type);

      if (!classification.accountId || classification.confidence < 0.3) {
        result.errors.push({
          templateId: template.id,
          description: template.description,
          error: `No se pudo clasificar "${concept}"`,
        });
        // Adelantar de todas formas para no trancar
        const next = calculateNextRun(template.frequency, template.dayOfMonth, template.dayOfWeek);
        await prisma.recurringTemplate.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
        continue;
      }

      // Usar debitAccountId/creditAccountId explícitos si existen, si no usar el clasificado
      const accountId = template.debitAccountId || template.creditAccountId || classification.accountId;

      // Generar asiento
      const accountant = new AccountingAgent(prisma, template.companyId);
      await accountant.init();

      const dialog: DialogResult = {
        type: template.type as any,
        amount: template.amount,
        currency: 'USD',
        description: template.description,
        concept: concept,
        paymentMethod: (template.paymentMethod || null) as any,
        date: new Date().toISOString().split('T')[0],
        confidence: 0.95,
        missingFields: [],
        itbms: false,
        provider: null,
        suggestedResponse: '',
      };

      const classificationResult = { concept, accountId, confidence: 0.95 };
      const entry = accountant.generateEntry(dialog, classificationResult);

      const debitLines = entry.debit.map((d: any) => ({
        accountId: accountant.resolveAlias(d.accountId),
        debit: d.amount,
        credit: 0,
      }));
      const creditLines = entry.credit.map((c: any) => ({
        accountId: accountant.resolveAlias(c.accountId),
        debit: 0,
        credit: c.amount,
      }));

      const status = template.requireConfirmation ? 'BORRADOR' : 'CONFIRMADO';

      const je = await prisma.journalEntry.create({
        data: {
          date: new Date(),
          description: `[Recurrente] ${entry.description}`,
          status,
          companyId: template.companyId,
          createdById: template.createdById,
          lines: { create: [...debitLines, ...creditLines] },
        },
      });

      // Crear transacción vinculada
      await prisma.transaction.create({
        data: {
          type: template.type,
          amount: template.amount,
          description: template.description,
          concept: concept,
          paymentMethod: template.paymentMethod,
          date: new Date(),
          companyId: template.companyId,
          createdById: template.createdById,
          journalEntryId: je.id,
          metadata: JSON.stringify({ recurring: true, templateId: template.id }),
        },
      });

      // Incrementar quota
      await prisma.subscription.updateMany({
        where: {
          companyId: template.companyId,
          status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
        },
        data: { movementsUsed: { increment: 1 } },
      });

      // Actualizar template
      const next = calculateNextRun(template.frequency, template.dayOfMonth, template.dayOfWeek);
      await prisma.recurringTemplate.update({
        where: { id: template.id },
        data: {
          lastRunAt: new Date(),
          lastEntryId: je.id,
          nextRunAt: next,
        },
      });

      result.processed++;
      result.entryIds.push(je.id);
    } catch (err: any) {
      result.errors.push({
        templateId: template.id,
        description: template.description,
        error: err.message || 'Error desconocido',
      });
      // Adelantar nextRunAt para no reintentar infinitamente
      try {
        const next = calculateNextRun(template.frequency, template.dayOfMonth, template.dayOfWeek);
        await prisma.recurringTemplate.update({
          where: { id: template.id },
          data: { nextRunAt: next },
        });
      } catch { /* ignore */ }
    }
  }

  return result;
}
