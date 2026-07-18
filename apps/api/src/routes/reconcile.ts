import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { parseImportFile, type ParsedRow } from '../services/csv-parser';
import { autoMatch, findUnmatchedBookEntries } from '../services/bank-matcher';
import { reconcileMatchSchema, reconcileCreateEntrySchema } from '../validation/schemas';
import { ClassificationAgent, AccountingAgent } from '@agt-contador/agents';

export const reconcileRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (ext.endsWith('.csv') || file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Formato no soportado. Use CSV.'));
    }
  },
});

/**
 * POST /api/reconcile/upload
 * Sube un CSV de extracto bancario, lo parsea, guarda, y ejecuta auto-matching.
 */
reconcileRouter.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  const { bankAccountId } = req.body;
  if (!bankAccountId) {
    res.status(400).json({ error: 'Se requiere bankAccountId (ID de la cuenta de banco)' });
    return;
  }

  try {
    // Verificar que la cuenta existe y es de banco
    const account = await req.prisma.account.findFirst({
      where: { id: bankAccountId, companyId: req.user!.companyId },
    });
    if (!account || !account.code.startsWith('1.1.02')) {
      res.status(400).json({ error: 'La cuenta seleccionada no es una cuenta bancaria válida (1.1.02.*)' });
      return;
    }

    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);

    // Determinar fechas del extracto
    const dates = parsed.rows
      .map(r => r.date)
      .filter(Boolean)
      .sort() as string[];
    const statementStart = dates.length > 0 ? new Date(dates[0]) : null;
    const statementEnd = dates.length > 0 ? new Date(dates[dates.length - 1]) : null;

    const openingBalance = parsed.rows[0]?.balance ?? 0;
    const closingBalance = parsed.rows[parsed.rows.length - 1]?.balance ?? 0;

    // Crear el statement
    const statement = await req.prisma.bankStatement.create({
      data: {
        companyId: req.user!.companyId,
        bankAccountId,
        fileName: req.file.originalname,
        statementStart,
        statementEnd,
        openingBalance,
        closingBalance,
        rows: {
          create: parsed.rows
            .filter(r => r.date)
            .map(r => ({
              date: new Date(r.date!),
              description: r.description || 'Sin descripción',
              reference: r.reference || null,
              debit: r.debit || 0,
              credit: r.credit || 0,
              balance: r.balance || null,
            })),
        },
      },
      include: { rows: true },
    });

    // Ejecutar auto-matching
    const matches = await autoMatch(statement.id, req.prisma, req.user!.companyId);

    // Buscar partidas de libro no conciliadas
    const unmatchedBooks = await findUnmatchedBookEntries(
      req.prisma,
      req.user!.companyId,
      statementStart || undefined,
      statementEnd || undefined,
    );

    const matchedRows = statement.rows.filter(r => r.status === 'MATCHED').length;
    const unmatchedRows = statement.rows.length - matchedRows;

    res.status(201).json({
      statement: {
        ...statement,
        rows: statement.rows,
      },
      summary: {
        total: statement.rows.length,
        matched: matchedRows,
        unmatched: unmatchedRows,
        matches,
        unmatchedBookCount: unmatchedBooks.length,
      },
    });
  } catch (error: any) {
    console.error('[Reconcile] Upload error:', error);
    res.status(400).json({
      error: error.message || 'Error al procesar el extracto',
      detail: error?.message,
    });
  }
});

/**
 * GET /api/reconcile — listar statements previos
 */
reconcileRouter.get('/', async (req, res) => {
  const statements = await req.prisma.bankStatement.findMany({
    where: { companyId: req.user!.companyId },
    include: {
      bankAccount: { select: { code: true, name: true } },
      _count: { select: { rows: true } },
    },
    orderBy: { uploadDate: 'desc' },
  });

  // Enriquecer con conteo de matched
  const enriched = await Promise.all(statements.map(async (s: any) => {
    const matched = await req.prisma.bankStatementRow.count({
      where: { statementId: s.id, status: 'MATCHED' },
    });
    return { ...s, matchedCount: matched, totalRows: s._count.rows };
  }));

  res.json(enriched);
});

/**
 * GET /api/reconcile/:id — detalle del statement con filas y unmatched books
 */
reconcileRouter.get('/:id', async (req, res) => {
  const statement = await req.prisma.bankStatement.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: {
      bankAccount: { select: { code: true, name: true } },
      rows: {
        include: {
          matchedEntry: {
            select: { id: true, date: true, description: true, status: true },
          },
        },
        orderBy: { date: 'asc' },
      },
    },
  });

  if (!statement) { res.status(404).json({ error: 'Extracto no encontrado' }); return; }

  const unmatchedBooks = await findUnmatchedBookEntries(
    req.prisma,
    req.user!.companyId,
    (statement as any).statementStart || undefined,
    (statement as any).statementEnd || undefined,
  );

  const matched = (statement as any).rows.filter((r: any) => r.status === 'MATCHED').length;

  res.json({
    statement,
    unmatchedBooks,
    summary: {
      total: (statement as any).rows.length,
      matched,
      unmatched: (statement as any).rows.length - matched,
      unmatchedBookCount: unmatchedBooks.length,
    },
  });
});

/**
 * POST /api/reconcile/:id/match — vincular/desvincular manual
 */
reconcileRouter.post('/:id/match', validate(reconcileMatchSchema), async (req, res) => {
  const { rowId, entryId } = req.body;

  const row = await req.prisma.bankStatementRow.findFirst({
    where: { id: rowId, statement: { id: req.params.id, companyId: req.user!.companyId } },
  });

  if (!row) { res.status(404).json({ error: 'Fila no encontrada' }); return; }

  const updated = await req.prisma.bankStatementRow.update({
    where: { id: rowId },
    data: {
      matchedEntryId: entryId || null,
      status: entryId ? 'MATCHED' : 'UNMATCHED',
      matchConfidence: entryId ? 1.0 : null, // manual match = 100% confidence
    },
  });

  res.json(updated);
});

/**
 * POST /api/reconcile/:id/create-entry — crear asiento desde fila no conciliada
 */
reconcileRouter.post('/:id/create-entry', requireQuota, validate(reconcileCreateEntrySchema), async (req, res) => {
  const { rowId, description, debitAccountId, creditAccountId, amount } = req.body;

  const row = await req.prisma.bankStatementRow.findFirst({
    where: { id: rowId, statement: { id: req.params.id, companyId: req.user!.companyId } },
    include: { statement: true },
  });

  if (!row) { res.status(404).json({ error: 'Fila no encontrada' }); return; }

  try {
    const entry = await req.prisma.journalEntry.create({
      data: {
        date: new Date(row.date),
        description: description || row.description,
        status: 'BORRADOR',
        companyId: req.user!.companyId,
        createdById: req.user!.userId,
        lines: {
          create: [
            { accountId: debitAccountId, debit: amount, credit: 0 },
            { accountId: creditAccountId, debit: 0, credit: amount },
          ],
        },
      },
    });

    // Vincular la fila al nuevo asiento
    await req.prisma.bankStatementRow.update({
      where: { id: rowId },
      data: {
        matchedEntryId: entry.id,
        status: 'MATCHED',
        matchConfidence: 1.0,
      },
    });

    await incrementUsage(req);

    res.status(201).json({ entry, rowId });
  } catch (error: any) {
    console.error('[Reconcile] Create-entry error:', error);
    res.status(500).json({ error: 'Error al crear el asiento', detail: error?.message });
  }
});

/**
 * DELETE /api/reconcile/:id — eliminar extracto y sus filas
 */
reconcileRouter.delete('/:id', async (req, res) => {
  const statement = await req.prisma.bankStatement.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!statement) { res.status(404).json({ error: 'Extracto no encontrado' }); return; }

  await req.prisma.bankStatement.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// Manejo de errores de multer
reconcileRouter.use((err: any, _req: any, res: any, _next: any) => {
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
