import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { parseImportFile, debitCreditDeFila, type ParsedRow } from '../services/csv-parser';
import { autoMatch, findUnmatchedBookEntries } from '../services/bank-matcher';
import { reconcileMatchSchema, reconcileCreateEntrySchema } from '../validation/schemas';
import { ClassificationAgent, AccountingAgent } from '@agt-contador/agents';
import { checkNotBlocked } from '../services/journal-guard';
import { parseLocalDate } from '../lib/dates';

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

    // Un extracto sin ninguna partida con fecha es un archivo que NO supimos
    // leer, no una conciliación vacía: se avisa y no se guarda nada. Antes se
    // aceptaba en silencio y el extracto quedaba en la lista con 0 filas y sin
    // nada que conciliar (pasó el 11-10 con dos cargas del ENERO).
    const filas = parsed.rows.filter(r => r.date);
    if (filas.length === 0) {
      res.status(400).json({
        error: parsed.rows.length === 0
          ? 'El archivo no trae ninguna fila de datos. ¿Es el extracto correcto?'
          : `No se pudo leer la fecha de ninguna de las ${parsed.rows.length} filas del archivo, así que no hay nada que conciliar. Revisá la columna de Fecha: se aceptan 01/01/2026, 2026-01-01 y 01-ene-2026.`,
      });
      return;
    }

    // Determinar fechas del extracto
    const dates = filas
      .map(r => r.date)
      .sort() as string[];
    const statementStart = new Date(dates[0]);
    const statementEnd = new Date(dates[dates.length - 1]);

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
          create: filas
            .map(r => ({
              date: parseLocalDate(r.date!),
              description: r.description || 'Sin descripción',
              reference: r.reference || null,
              // El extracto puede traer débito/crédito o una sola columna de
              // monto con signo (ver debitCreditDeFila): el conciliador necesita
              // los dos lados para comparar contra el libro.
              ...debitCreditDeFila(r),
              balance: r.balance || null,
            })),
        },
      },
      include: { rows: true },
    });

    // Ejecutar auto-matching
    const matches = await autoMatch(statement.id, req.prisma, req.user!.companyId, bankAccountId);

    // Buscar partidas de libro no conciliadas
    const unmatchedBooks = await findUnmatchedBookEntries(
      req.prisma,
      req.user!.companyId,
      bankAccountId,
      statementStart || undefined,
      statementEnd || undefined,
    );

    // Se relee el extracto para responder el MISMO cuerpo que GET /:id —el
    // frente usa un solo render para los tres—: las filas que devolvió el create
    // son de ANTES del auto-matching (todas UNMATCHED y sin el asiento
    // vinculado, así que el resumen decía "0 conciliados" aunque hubiera
    // matches), y sin `unmatchedBooks` el render reventaba con "Cannot read
    // properties of undefined (reading 'length')".
    const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, statement.id);

    res.status(201).json({
      ...(detalle ?? { statement, unmatchedBooks, summary: { total: statement.rows.length, matched: 0, unmatched: statement.rows.length, unmatchedBookCount: unmatchedBooks.length } }),
      summary: {
        ...(detalle?.summary ?? { total: statement.rows.length, matched: 0, unmatched: statement.rows.length, unmatchedBookCount: unmatchedBooks.length }),
        matches,
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
 * Detalle de un extracto: sus filas con el asiento vinculado, los asientos del
 * libro sin conciliar de esa cuenta, y el resumen.
 *
 * Lo comparten el GET, la subida y el "volver a conciliar": el frente tiene un
 * solo render, así que el cuerpo tiene que ser siempre el mismo.
 */
async function detalleDeExtracto(prisma: any, companyId: string, statementId: string): Promise<any | null> {
  const statement = await prisma.bankStatement.findFirst({
    where: { id: statementId, companyId },
    include: {
      bankAccount: { select: { code: true, name: true } },
      rows: {
        include: { matchedEntry: { select: { id: true, date: true, description: true, status: true } } },
        orderBy: { date: 'asc' },
      },
    },
  });
  if (!statement) return null;

  const unmatchedBooks = await findUnmatchedBookEntries(
    prisma,
    companyId,
    statement.bankAccountId,
    statement.statementStart || undefined,
    statement.statementEnd || undefined,
  );

  const filas: any[] = statement.rows;
  const matched = filas.filter(r => r.status === 'MATCHED').length;

  return {
    statement,
    unmatchedBooks,
    summary: {
      total: filas.length,
      matched,
      unmatched: filas.length - matched,
      unmatchedBookCount: unmatchedBooks.length,
    },
  };
}

/**
 * Suelta las filas que quedaron de MÁS sobre un mismo asiento.
 *
 * El matcher viejo le daba el mismo asiento a varias filas cuando los
 * movimientos eran idénticos, y el asiento gemelo quedaba "sin conciliar
 * (libros)" para siempre. Pero compartir asiento no siempre es un error: un
 * asiento con dos líneas de banco (dos transferencias cargadas juntas) sostiene
 * legítimamente dos filas. Así que se mira cuántas líneas de banco tiene el
 * asiento: si alcanzan para todas las filas, se dejan; si no, las sobrantes
 * vuelven a UNMATCHED — y ese asiento queda bloqueado para que el matcher no se
 * lo vuelva a dar a la fila liberada (su línea ya la usa otra fila).
 */
async function soltarAsientosRepetidos(
  prisma: any,
  rows: any[],
  bankAccountId: string,
): Promise<{ liberadas: number; bloqueadas: Set<string> }> {
  const porAsiento = new Map<string, any[]>();
  for (const r of rows) {
    if (r.status !== 'MATCHED' || !r.matchedEntryId) continue;
    porAsiento.set(r.matchedEntryId, [...(porAsiento.get(r.matchedEntryId) || []), r]);
  }

  const bloqueadas = new Set<string>();
  if (!porAsiento.size) return { liberadas: 0, bloqueadas };

  // Líneas que el asiento tiene EN LA CUENTA DEL EXTRACTO: cero significa que el
  // emparejamiento es cruzado (el asiento salió de otro banco o quedó en "Por
  // Clasificar"), y en ese caso ninguna fila puede quedarse con él.
  const lineas = await prisma.journalLine.findMany({
    where: {
      journalEntryId: { in: [...porAsiento.keys()] },
      accountId: bankAccountId,
    },
    select: { journalEntryId: true },
  });
  const lineasPorAsiento = new Map<string, number>();
  for (const l of lineas) {
    lineasPorAsiento.set(l.journalEntryId, (lineasPorAsiento.get(l.journalEntryId) || 0) + 1);
  }

  let liberadas = 0;
  for (const [entryId, filas] of porAsiento) {
    const disponibles = lineasPorAsiento.get(entryId) || 0;
    if (filas.length <= disponibles) continue; // todas las filas tienen su línea

    const orden = [...filas].sort((a, b) =>
      (Number(b.matchConfidence) || 0) - (Number(a.matchConfidence) || 0) ||
      new Date(a.date).getTime() - new Date(b.date).getTime() ||
      String(a.id).localeCompare(String(b.id)),
    );
    for (const sobra of orden.slice(disponibles)) {
      await prisma.bankStatementRow.update({
        where: { id: sobra.id },
        data: { status: 'UNMATCHED', matchedEntryId: null, matchConfidence: null },
      });
      liberadas++;
    }
    bloqueadas.add(entryId);
  }

  return { liberadas, bloqueadas };
}

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
  const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, req.params.id);
  if (!detalle) { res.status(404).json({ error: 'Extracto no encontrado' }); return; }
  res.json(detalle);
});

/**
 * POST /api/reconcile/:id/rematch — volver a conciliar sin borrar ni subir otra vez.
 *
 * Existe porque el matching corre UNA sola vez, en la subida: cuando se corrige
 * un criterio del matcher, cuando el contador registra asientos que faltaban o
 * cuando quedaron emparejamientos repetidos, el extracto ya cargado se quedaba
 * con la foto vieja. Suelta los asientos repetidos y vuelve a correr el matcher
 * sobre las filas que quedaron sin conciliar.
 */
reconcileRouter.post('/:id/rematch', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const statement = await req.prisma.bankStatement.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { rows: true },
  });
  if (!statement) { res.status(404).json({ error: 'Extracto no encontrado' }); return; }

  try {
    const { liberadas, bloqueadas } = await soltarAsientosRepetidos(req.prisma, statement.rows, statement.bankAccountId);
    const matches = await autoMatch(statement.id, req.prisma, req.user!.companyId, statement.bankAccountId, bloqueadas);
    const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, statement.id);

    res.json({
      ...detalle,
      summary: { ...detalle.summary, matches },
      rematch: { liberadas, nuevas: matches.length },
    });
  } catch (error: any) {
    console.error('[Reconcile] Rematch error:', error);
    res.status(400).json({ error: error.message || 'No se pudo volver a conciliar' });
  }
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
    // Cuentas bloqueadas: rechaza el asiento (antes no validaba nada aquí)
    const blocked = await checkNotBlocked(req.prisma, req.user!.companyId, [debitAccountId, creditAccountId]);
    if (blocked) { res.status(400).json({ error: blocked }); return; }

    const entry = await req.prisma.journalEntry.create({
      data: {
        // Hereda la fecha de la fila del extracto (ya viene a mediodía local)
        date: row.date,
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
