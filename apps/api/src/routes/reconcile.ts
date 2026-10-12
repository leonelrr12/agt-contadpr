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
    if (ext.endsWith('.csv') || ext.endsWith('.xlsx') || file.mimetype === 'text/csv') {
      cb(null, true);
    } else {
      cb(new Error('Formato no soportado. Use CSV o XLSX.'));
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
    // La cuenta existe y es conciliable: banco (1.1.02.*) o tarjeta de crédito
    // (2.1.03.*). El motor sirve igual para las dos — la compra con tarjeta
    // entra como CARGO en el estado y como crédito al pasivo en libros, que es
    // exactamente el par que compara el matcher.
    const account = await req.prisma.account.findFirst({
      where: { id: bankAccountId, companyId: req.user!.companyId },
    });
    if (!account || !(account.code.startsWith('1.1.02') || account.code.startsWith('2.1.03'))) {
      res.status(400).json({ error: 'La cuenta seleccionada no es conciliable: se aceptan cuentas de banco (1.1.02.*) y tarjetas de crédito (2.1.03.*)' });
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
        include: {
          matchedEntry: { select: { id: true, date: true, description: true, status: true } },
          // Qué partidas del libro sostienen la fila: una sola (lo normal) o
          // varias (el ACH de cuatro facturas). El frente las muestra y el
          // vinculador las precarga al editar.
          matches: {
            include: {
              entry: { select: { id: true, date: true, description: true } },
              line: { select: { debit: true, credit: true } },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
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
  // Un vínculo MANUAL (banco ↔ varias partidas, o el 1:1 elegido a mano) no se
  // suelta nunca: es una decisión del contador, no un emparejamiento del matcher.
  const vinculos = await prisma.bankRowMatch.findMany({
    where: { rowId: { in: rows.map(r => r.id) } },
    select: { rowId: true, isManual: true },
  });
  const manuales = new Set<string>(vinculos.filter((v: any) => v.isManual).map((v: any) => v.rowId));
  const conVinculo = new Set<string>(vinculos.map((v: any) => v.rowId));

  const porAsiento = new Map<string, any[]>();
  for (const r of rows) {
    if (r.status !== 'MATCHED' || !r.matchedEntryId) continue;
    if (manuales.has(r.id)) continue;
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
      // La fila liberada suelta también su vínculo: si no, la línea quedaría
      // ocupada por una fila que ya no la sostiene.
      if (conVinculo.has(sobra.id)) {
        await prisma.bankRowMatch.deleteMany({ where: { rowId: sobra.id } });
      }
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
 * Vincula a mano una fila del extracto con las partidas del libro que la
 * sostienen. Devuelve el mensaje de error, o null si quedó vinculada.
 *
 * El caso que lo pide: el ACH de Inmobiliaria Don Antonio del 20-feb por
 * $17.353,68 son cuatro facturas cobradas de una vez. El matcher empareja UNA
 * línea contra UNA fila por monto exacto, así que ese depósito no tiene contra
 * qué conciliarse solo; acá el contador arma el vínculo y la suma tiene que dar
 * el monto de la fila (±2 centavos).
 */
async function vincularLineas(
  prisma: any,
  companyId: string,
  row: any,
  links: Array<{ lineId: string; amount?: number }>,
): Promise<string | null> {
  const bankAccountId = row.statement.bankAccountId;
  const lineIds = [...new Set(links.map(l => l.lineId))];
  const esEntrada = (row.credit || 0) > 0; // entra plata al banco → la partida va al débito
  const montoFila = esEntrada ? row.credit : row.debit;

  const lineas = await prisma.journalLine.findMany({
    where: { id: { in: lineIds }, accountId: bankAccountId },
    include: { journalEntry: { select: { id: true, companyId: true, date: true, description: true, status: true } } },
  });
  if (lineas.length !== lineIds.length) {
    return 'Alguna de las partidas no es de la cuenta de este extracto.';
  }

  const ocupadas = await prisma.bankRowMatch.findMany({
    where: { lineId: { in: lineIds }, rowId: { not: row.id } },
    select: { lineId: true },
  });
  if (ocupadas.length) {
    return 'Una de esas partidas ya está conciliada en otra fila del extracto: desvinculala de ahí primero.';
  }

  const porLinea = new Map<string, any>(lineas.map((l: any) => [l.id, l]));
  const aplicados: Array<{ lineId: string; entryId: string; amount: number }> = [];
  for (const link of links) {
    const linea = porLinea.get(link.lineId)!;
    const je = linea.journalEntry;
    if (je.companyId !== companyId) return 'Alguna de esas partidas es de otra empresa.';
    if (je.status === 'RECHAZADO' || je.status === 'ANULADO') {
      return `El asiento "${je.description}" está ${je.status.toLowerCase()} y no puede conciliarse.`;
    }

    // En el extracto, débito = salida del banco y crédito = entrada; en libros
    // la partida va al revés. Solo sirve el lado que corresponde.
    const disponible = esEntrada ? linea.debit : linea.credit;
    if (!(disponible > 0)) {
      return `La partida "${je.description}" no sirve para esta fila: es una ${esEntrada ? 'entrada' : 'salida'} de dinero y esa partida está del otro lado.`;
    }
    const amount = link.amount ?? disponible;
    if (amount > disponible + 0.02) {
      return `El monto aplicado a "${je.description}" ($${amount.toFixed(2)}) es mayor que el de la partida ($${disponible.toFixed(2)}).`;
    }
    aplicados.push({ lineId: linea.id, entryId: je.id, amount: Math.round(amount * 100) / 100 });
  }

  const total = Math.round(aplicados.reduce((s, a) => s + a.amount, 0) * 100) / 100;
  const dif = Math.round((total - montoFila) * 100) / 100;
  if (Math.abs(dif) > 0.02) {
    return dif < 0
      ? `Faltan $${Math.abs(dif).toFixed(2)} para cuadrar la fila de $${montoFila.toFixed(2)}.`
      : `Las partidas se pasan por $${dif.toFixed(2)} de la fila de $${montoFila.toFixed(2)}.`;
  }

  // Primero los vínculos nuevos y después los que ya no van: el unique
  // (rowId, lineId) no se pisa y la fila nunca queda a medias.
  const previos = await prisma.bankRowMatch.findMany({ where: { rowId: row.id }, select: { lineId: true } });
  const previosSet = new Set<string>(previos.map((p: any) => p.lineId));
  const nuevos = aplicados.filter(a => !previosSet.has(a.lineId));
  if (nuevos.length) {
    await prisma.bankRowMatch.createMany({
      data: nuevos.map(a => ({ rowId: row.id, entryId: a.entryId, lineId: a.lineId, amount: a.amount, isManual: true })),
    });
  }
  await prisma.bankRowMatch.deleteMany({
    where: { rowId: row.id, lineId: { notIn: aplicados.map(a => a.lineId) } },
  });
  await prisma.bankStatementRow.update({
    where: { id: row.id },
    data: { matchedEntryId: aplicados[0].entryId, status: 'MATCHED', matchConfidence: 1.0 },
  });

  return null;
}

/**
 * POST /api/reconcile/:id/match — vincular/desvincular a mano.
 *
 *  · `{ rowId, links: [{ lineId, amount? }] }` — vínculo fino: una fila
 *    sostenida por varias partidas del libro (o por una, con monto parcial).
 *  · `{ rowId, entryId }` — el 1:1 clásico; `entryId: null` desvincula.
 *
 * Responde el detalle completo del extracto, igual que la subida y el rematch:
 * el frente tiene un solo render.
 */
reconcileRouter.post('/:id/match', validate(reconcileMatchSchema), async (req, res) => {
  const { rowId, entryId, links } = req.body;

  // Todo dentro del try: en Express 4 un throw suelto en un handler async no
  // llega al middleware de errores y deja la petición colgada para siempre.
  try {
    const row = await req.prisma.bankStatementRow.findFirst({
      where: { id: rowId, statement: { id: req.params.id, companyId: req.user!.companyId } },
      include: { statement: { select: { bankAccountId: true } } },
    });

    if (!row) { res.status(404).json({ error: 'Fila no encontrada' }); return; }

    if (Array.isArray(links) && links.length > 0) {
      const error = await vincularLineas(req.prisma, req.user!.companyId, row, links);
      if (error) { res.status(400).json({ error }); return; }
    } else {
      await req.prisma.bankRowMatch.deleteMany({ where: { rowId } });
      await req.prisma.bankStatementRow.update({
        where: { id: rowId },
        data: {
          matchedEntryId: entryId || null,
          status: entryId ? 'MATCHED' : 'UNMATCHED',
          matchConfidence: entryId ? 1.0 : null, // manual match = 100% confidence
        },
      });
    }

    const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, req.params.id);
    res.json(detalle);
  } catch (error: any) {
    console.error('[Reconcile] Match error:', error);
    res.status(400).json({ error: error.message || 'No se pudo vincular la fila' });
  }
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
