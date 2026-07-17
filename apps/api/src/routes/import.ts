import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { parseImportFile } from '../services/csv-parser';
import { ClassificationAgent } from '@agt-contador/agents';
import { AccountingAgent } from '@agt-contador/agents';
import { importExecuteSchema } from '../validation/schemas';

export const importRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    // También aceptar por extensión (algunos navegadores no envían el MIME correcto)
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no soportado: ${file.mimetype}. Use CSV o XLSX.`));
    }
  },
});

/**
 * POST /api/import/preview
 * Sube un archivo CSV/XLSX, lo parsea, clasifica conceptos, y devuelve preview.
 */
importRouter.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);

    // Clasificar las primeras 20 filas para el preview
    const classifier = new ClassificationAgent({
      prisma: req.prisma,
      companyId: req.user!.companyId,
    });

    const previewRows = [];
    for (const row of parsed.rows.slice(0, 20)) {
      const concept = row.concept || row.description || '';
      let classification = null;
      if (concept) {
        classification = await classifier.classify(concept, row.type || 'GASTO');
      }
      previewRows.push({
        ...row,
        _raw: undefined, // no enviar raw al frontend
        classification: classification ? {
          concept: classification.concept,
          accountId: classification.accountId,
          confidence: classification.confidence,
        } : null,
      });
    }

    res.json({
      headers: parsed.headers,
      detectedMapping: parsed.detectedMapping,
      previewRows,
      totalRows: parsed.totalRows,
    });
  } catch (error: any) {
    console.error('[Import] Preview error:', error);
    res.status(400).json({
      error: error.message || 'Error al procesar el archivo',
      detail: error?.message,
    });
  }
});

// ── Lógica compartida de ejecución ──

/** Convierte una fecha "YYYY-MM-DD" a Date en hora local (evita offset UTC → día anterior) */
function toLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);  // Mediodía local: sin riesgo de cambio de día por zona horaria
}

interface ImportRow {
  date: string;
  description: string;
  amount: number;
  concept?: string;
  paymentMethod?: string | null;
  type: string;
  provider?: string | null;
  debitAccountId?: string;
  creditAccountId?: string;
}

async function executeImportRows(
  rows: ImportRow[],
  prisma: any,
  companyId: string,
  userId: string,
  incrementUsageFn: (req: any) => Promise<void>,
  req: any,
): Promise<{ success: number; errors: { row: number; error: string }[]; entryIds: string[] }> {
  const classifier = new ClassificationAgent({ prisma, companyId });
  const accountant = new AccountingAgent(prisma, companyId);
  await accountant.init();

  const results = { success: 0, errors: [] as { row: number; error: string }[], entryIds: [] as string[] };
  const batchSize = 50;

  for (let batchStart = 0; batchStart < rows.length; batchStart += batchSize) {
    const batch = rows.slice(batchStart, batchStart + batchSize);

    await prisma.$transaction(async (tx: any) => {
      for (let i = 0; i < batch.length; i++) {
        const row = batch[i];
        const rowNum = batchStart + i + 1;

        try {
          let accountId = row.debitAccountId || row.creditAccountId;
          if (!accountId) {
            const concept = row.concept || row.description || 'Gastos Varios';
            const classification = await classifier.classify(concept, row.type);
            if (!classification.accountId || classification.confidence < 0.3) {
              throw new Error(`No se pudo clasificar el concepto "${concept}"`);
            }
            accountId = classification.accountId;
          }

          const dialog = {
            type: row.type as any,
            amount: row.amount,
            currency: 'USD',
            description: row.description,
            concept: row.concept || row.description,
            paymentMethod: (row.paymentMethod || null) as any,
            date: row.date,
            confidence: 0.9,
            missingFields: [] as string[],
            itbms: false,
            provider: row.provider || null,
            suggestedResponse: '',
          };

          const classification = { concept: row.concept || row.description, accountId, confidence: 0.9 };
          const entry = accountant.generateEntry(dialog, classification);
          const validation = accountant.validateEntry(entry);
          if (!validation.valid) {
            throw new Error(validation.error || 'Asiento no balanceado');
          }

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

          const je = await tx.journalEntry.create({
            data: {
              date: toLocalDate(row.date),
              description: entry.description,
              status: 'BORRADOR',
              companyId,
              createdById: userId,
              lines: { create: [...debitLines, ...creditLines] },
            },
          });

          await tx.transaction.create({
            data: {
              type: row.type,
              amount: row.amount,
              description: row.description,
              concept: row.concept || row.description,
              paymentMethod: row.paymentMethod,
              date: toLocalDate(row.date),
              companyId,
              createdById: userId,
              journalEntryId: je.id,
              metadata: JSON.stringify(row.provider ? { provider: row.provider } : {}),
            },
          });

          results.entryIds.push(je.id);
          results.success++;
        } catch (err: any) {
          results.errors.push({ row: rowNum, error: err.message || 'Error desconocido' });
        }
      }
    });

    for (let i = 0; i < results.success; i++) {
      try { await incrementUsageFn(req); } catch { /* quota exhausted */ }
    }
  }

  return results;
}

/**
 * POST /api/import/execute
 * Recibe las filas procesadas y crea los asientos contables en lote.
 */
importRouter.post('/execute', requireQuota, validate(importExecuteSchema), async (req, res) => {
  const { rows } = req.body;

  try {
    const results = await executeImportRows(
      rows, req.prisma, req.user!.companyId, req.user!.userId,
      incrementUsage, req,
    );

    res.json({
      success: results.success,
      errors: results.errors,
      total: rows.length,
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Import] Execute error:', error);
    res.status(500).json({
      error: 'Error al ejecutar la importación',
      detail: error?.message,
    });
  }
});

/**
 * POST /api/import/execute-all
 * Atajo: recibe archivo + mapping y ejecuta todo en un solo paso.
 */
importRouter.post('/execute-all', requireQuota, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);

    // Construir rows desde el parseo automático
    // Fecha por defecto: la que indica el usuario, o la de hoy
    const defaultDate = (req.body.importDate as string) || new Date().toISOString().split('T')[0];
    let skippedNoAmount = 0;

    const rows = parsed.rows
      .filter(r => {
        if (!r.amount || r.amount <= 0) { skippedNoAmount++; return false; }
        return true;
      })
      .map(r => ({
        date: r.date || defaultDate,  // Si no tiene fecha, usar la fecha indicada por el usuario o la de hoy
        description: r.description || 'Importado',
        amount: r.amount!,
        concept: r.concept || r.description || '',
        paymentMethod: r.paymentMethod,
        type: r.type || 'GASTO',
        provider: r.provider,
      }));

    if (rows.length === 0) {
      const reasons: string[] = [];
      if (skippedNoAmount > 0) reasons.push(`${skippedNoAmount} sin monto válido`);
      const msg = reasons.length > 0
        ? `No se encontraron filas válidas: ${reasons.join(', ')}.`
        : 'No se encontraron filas válidas en el archivo.';
      res.status(400).json({ error: msg });
      return;
    }

    // Verificar cuota: ¿hay cupo suficiente para todas las filas?
    const sub = (req as any).subscription;
    if (sub) {
      const remaining = sub.movementsLimit - sub.movementsUsed;
      if (rows.length > remaining) {
        res.status(429).json({
          error: `No tienes suficientes movimientos disponibles. Tu plan permite ${sub.movementsLimit} por período y has usado ${sub.movementsUsed}. Te quedan ${remaining} pero necesitas ${rows.length}.`,
          code: 'QUOTA_EXCEEDED',
          limit: sub.movementsLimit,
          used: sub.movementsUsed,
          remaining,
          required: rows.length,
        });
        return;
      }
    }

    // Ejecutar usando la misma lógica
    const results = await executeImportRows(
      rows, req.prisma, req.user!.companyId, req.user!.userId,
      incrementUsage, req,
    );

    res.json({
      success: results.success,
      errors: results.errors,
      total: rows.length,
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Import] Execute-all error:', error);
    // Errores de validación/negocio → 400; errores internos → 500
    const isClientError = /no se pudo|no encontrad|inválid|formato|balance/i.test(error.message || '');
    const status = isClientError ? 400 : 500;
    res.status(status).json({
      error: isClientError ? error.message : 'Error interno al procesar la importación. Intente de nuevo.',
      detail: error?.message,
    });
  }
});

// Manejo de errores de multer
importRouter.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 10MB.' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message });
    return;
  }
});
