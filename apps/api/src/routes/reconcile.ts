import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { parseImportFile, debitCreditDeFila, type ParsedRow } from '../services/csv-parser';
import { autoMatch, findUnmatchedBookEntries, daysBetween } from '../services/bank-matcher';
import { reconcileMatchSchema, reconcileCreateEntrySchema } from '../validation/schemas';
import { ClassificationAgent, AccountingAgent } from '@agt-contador/agents';
import { checkNotBlocked, loadAccountFlags } from '../services/journal-guard';
import { logAudit } from '../services/audit-log';
import { parseLocalDate } from '../lib/dates';

export const reconcileRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    if (
      ext.endsWith('.csv') || ext.endsWith('.xlsx') || ext.endsWith('.pdf') ||
      file.mimetype === 'text/csv' || file.mimetype === 'application/pdf'
    ) {
      cb(null, true);
    } else {
      cb(new Error('Formato no soportado. Use CSV, XLSX o PDF.'));
    }
  },
});

/** Fecha `YYYY-MM-DD` del filtro opcional del extracto. Vacía = sin límite. */
function leerFechaDeFiltro(valor: any): { fecha: string | null; invalida: boolean } {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  if (!texto) return { fecha: null, invalida: false };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return { fecha: null, invalida: true };
  // Valida el día real (2026-02-31 se desborda a marzo): se compara la fecha
  // normalizada, no solo el formato.
  const d = new Date(`${texto}T12:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== texto) return { fecha: null, invalida: true };
  return { fecha: texto, invalida: false };
}

/**
 * POST /api/reconcile/upload
 * Sube un CSV/XLSX/PDF de extracto bancario, lo parsea, guarda y ejecuta el
 * auto-matching. `fechaDesde`/`fechaHasta` (opcionales) recortan el extracto a
 * un rango: un PDF de 4 meses se puede conciliar mes por mes.
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

    // Filtro opcional de fechas: un PDF de varios meses se puede conciliar por
    // mes. Sin rango se conserva el comportamiento de siempre (todo el archivo).
    const filtroDesde = leerFechaDeFiltro(req.body.fechaDesde);
    const filtroHasta = leerFechaDeFiltro(req.body.fechaHasta);
    if (filtroDesde.invalida || filtroHasta.invalida) {
      res.status(400).json({ error: 'Las fechas del filtro deben ser válidas (formato YYYY-MM-DD).' });
      return;
    }
    if (filtroDesde.fecha && filtroHasta.fecha && filtroDesde.fecha > filtroHasta.fecha) {
      res.status(400).json({ error: 'El rango de fechas es inválido: «desde» no puede ser posterior a «hasta».' });
      return;
    }

    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);
    // Los avisos del parser no bloquean la carga, pero quedan en el log para
    // poder diagnosticar después una conciliación que quedó corta.
    if (parsed.warnings?.length) {
      console.warn('[Reconcile] Avisos del extracto:', parsed.warnings.join(' | '));
    }

    // Un extracto sin ninguna partida con fecha es un archivo que NO supimos
    // leer, no una conciliación vacía: se avisa y no se guarda nada. Antes se
    // aceptaba en silencio y el extracto quedaba en la lista con 0 filas y sin
    // nada que conciliar (pasó el 11-10 con dos cargas del ENERO).
    const conFecha = parsed.rows.filter(r => r.date);
    if (conFecha.length === 0) {
      res.status(400).json({
        error: parsed.rows.length === 0
          ? 'El archivo no trae ninguna fila de datos. ¿Es el extracto correcto?'
          : `No se pudo leer la fecha de ninguna de las ${parsed.rows.length} filas del archivo, así que no hay nada que conciliar. Revisá la columna de Fecha: se aceptan 01/01/2026, 2026-01-01 y 01-ene-2026.`,
      });
      return;
    }

    const filas = conFecha.filter(r =>
      (!filtroDesde.fecha || r.date! >= filtroDesde.fecha) &&
      (!filtroHasta.fecha || r.date! <= filtroHasta.fecha));
    if (filas.length === 0) {
      res.status(400).json({
        error: `El extracto no tiene movimientos en el rango ${filtroDesde.fecha || '…'} → ${filtroHasta.fecha || '…'}. No se guardó nada.`,
      });
      return;
    }

    // Determinar fechas del extracto. Con filtro manda el rango elegido (así la
    // lista de libros pendientes también es la del mes); sin filtro, las fechas
    // de las filas.
    const dates = filas
      .map(r => r.date)
      .sort() as string[];
    const statementStart = new Date(filtroDesde.fecha || dates[0]);
    const statementEnd = new Date(filtroHasta.fecha || dates[dates.length - 1]);

    const openingBalance = filas[0]?.balance ?? 0;
    const closingBalance = filas[filas.length - 1]?.balance ?? 0;

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
      // Avisos del parser (p. ej. la cadena de saldos del PDF no cierra): el
      // extracto se guardó igual, pero el frente muestra la alerta.
      warnings: parsed.warnings || [],
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
          matchedEntry: { select: { id: true, date: true, description: true, status: true, anuladoPorId: true } },
          // Qué partidas del libro sostienen la fila: una sola (lo normal) o
          // varias (el ACH de cuatro facturas). El frente las muestra y el
          // vinculador las precarga al editar.
          matches: {
            include: {
              entry: { select: { id: true, date: true, description: true, status: true, anuladoPorId: true } },
              // La línea con TODOS sus vínculos: al editar una fila, el máximo
              // aplicable es el total menos lo que ya usan las otras filas.
              line: {
                select: {
                  debit: true,
                  credit: true,
                  bankRowMatches: { select: { rowId: true, amount: true } },
                },
              },
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
 * Reconstruye el vínculo por LÍNEA de los matches viejos, y devuelve cuántos creó.
 *
 * Los extractos conciliados antes de que existiera `bank_row_match` (12-10)
 * guardan solo el asiento, no la línea que usaron. Sin ese dato el matcher
 * bloquea el asiento ENTERO —y una transferencia entre cuentas propias tiene una
 * línea en cada una (el 06-ene, 8829-7 → 2810-1: $2.100 y $5.000), así que la
 * cuenta receptora no podía conciliar las suyas aunque estuvieran libres—.
 *
 * La línea se reconstruye con la misma regla que usa el matcher —la cuenta del
 * extracto, el lado y el monto del movimiento—, y es exacta porque se parte de la
 * propia fila. Los ±5 días se piden para ELEGIR entre varias candidatas; cuando el
 * asiento tiene UNA sola línea de ese lado y monto en la cuenta, no hay elección
 * que hacer y la ventana sobra (ver el detalle abajo). Si no hay ninguna línea que
 * encaje, el match fue cruzado (el asiento salió de otra cuenta): no se inventa
 * vínculo y el asiento sigue bloqueado, que es lo conservador.
 */
async function reconstruirVinculos(prisma: any, companyId: string): Promise<number> {
  const faltantes = await prisma.bankStatementRow.findMany({
    where: {
      status: 'MATCHED',
      matchedEntryId: { not: null },
      matches: { none: {} },
      statement: { companyId },
    },
    select: {
      id: true, date: true, debit: true, credit: true, matchedEntryId: true,
      statement: { select: { bankAccountId: true } },
    },
  });
  if (!faltantes.length) return 0;

  // Líneas ya tomadas por otro vínculo: la misma línea no puede sostener dos filas.
  const vinculos = await prisma.bankRowMatch.findMany({
    where: { row: { statement: { companyId } } },
    select: { lineId: true },
  });
  const usadas = new Set<string>(vinculos.map((v: any) => v.lineId));

  const porCuenta = new Map<string, any[]>();
  for (const fila of faltantes) {
    const acc = fila.statement.bankAccountId;
    porCuenta.set(acc, [...(porCuenta.get(acc) || []), fila]);
  }

  let creados = 0;
  for (const [accountId, filas] of porCuenta) {
    const asientos = [...new Set(filas.map((f: any) => f.matchedEntryId))];
    const lineas = await prisma.journalLine.findMany({
      where: { accountId, journalEntryId: { in: asientos } },
      select: { id: true, journalEntryId: true, debit: true, credit: true, journalEntry: { select: { date: true } } },
    });

    for (const fila of filas) {
      const mio = fila.debit || fila.credit || 0;
      if (!mio) continue;
      const porMonto = lineas
        .filter((l: any) => l.journalEntryId === fila.matchedEntryId && !usadas.has(l.id))
        .map((l: any) => ({
          linea: l,
          monto: fila.debit > 0 ? l.credit : l.debit, // en el extracto el débito es salida; en libros, el haber
          dias: daysBetween(new Date(fila.date), new Date(l.journalEntry.date)),
        }))
        .filter((c: any) => Math.abs(c.monto - mio) < 0.02);

      // La ventana elige ENTRE candidatas; con una sola no hay elección que hacer —el
      // match ya está hecho y acá solo se anota qué línea usó—. Exigirla dejaba el
      // asiento bloqueado para siempre cuando sus patas salieron con más de 5 días de
      // diferencia: la planilla de enero de ODESA paga por la 6305-5 el 08 y por la
      // 2810-1 el 16, así que reconstruir el vínculo del 16 con la fecha del asiento
      // (08) quedaba a 8 días — y sin el vínculo, el asiento entero bloqueaba la línea
      // de la 6305-5, que estaba libre (12-10).
      const enVentana = porMonto
        .filter((c: any) => c.dias <= 5)
        .sort((a: any, b: any) => a.dias - b.dias || String(a.linea.id).localeCompare(String(b.linea.id)));
      const elegida = enVentana[0] ?? (porMonto.length === 1 ? porMonto[0] : undefined);
      if (!elegida) continue;

      await prisma.bankRowMatch.create({
        data: {
          rowId: fila.id,
          entryId: fila.matchedEntryId,
          lineId: elegida.linea.id,
          amount: Math.round(elegida.monto * 100) / 100,
          isManual: false,
        },
      });
      usadas.add(elegida.linea.id);
      creados++;
    }
  }

  return creados;
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
    // Primero los vínculos que faltan: los matches viejos bloquean su asiento
    // entero hasta que se sepa qué línea usaron (ver `reconstruirVinculos`).
    const vinculos = await reconstruirVinculos(req.prisma, req.user!.companyId);
    const { liberadas, bloqueadas } = await soltarAsientosRepetidos(req.prisma, statement.rows, statement.bankAccountId);
    const matches = await autoMatch(statement.id, req.prisma, req.user!.companyId, statement.bankAccountId, bloqueadas);
    const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, statement.id);

    res.json({
      ...detalle,
      summary: { ...detalle.summary, matches },
      rematch: { liberadas, nuevas: matches.length, vinculos },
    });
  } catch (error: any) {
    console.error('[Reconcile] Rematch error:', error);
    res.status(400).json({ error: error.message || 'No se pudo volver a conciliar' });
  }
});

/** Cuentas cuyo saldo se mueve con un extracto: Caja, Bancos y Tarjetas de crédito. */
function esCuentaMonetaria(code: string | null | undefined): boolean {
  if (!code) return false;
  return code === '1.1.01' || code.startsWith('1.1.01.') || code.startsWith('1.1.02') || code.startsWith('2.1.03');
}

interface MovidaCuenta {
  lineId: string;
  entryId: string;
  desde: string; // "1.1.02.09 — Por Clasificar"
  hasta: string; // "1.1.02.01 — Banco General …"
  reabierto: boolean;
}

/**
 * GET /api/reconcile/:id/candidates?rowId=…
 *
 * Partidas del libro del MISMO período que pueden sostener una fila del
 * extracto pero están en OTRA cuenta monetaria (Caja 1.1.01, otro banco
 * 1.1.02.*, tarjeta 2.1.03.*).
 *
 * Es la salida para la carga histórica: el movimiento se cargó en
 * «Por Clasificar» (1.1.02.09) o en el banco equivocado, y el matcher —que solo
 * mira la cuenta del extracto— no lo ve. El vinculador las ofrece al activar
 * «buscar en otros bancos»; al guardar, `POST /:id/match` las mueve a esta
 * cuenta (`moverCuenta`). Acá solo se listan; nada se toca.
 */
reconcileRouter.get('/:id/candidates', async (req, res) => {
  // Todo dentro del try: en Express 4 un throw suelto en un handler async no
  // llega al middleware de errores y deja la petición colgada para siempre.
  try {
    const rowId = typeof req.query.rowId === 'string' ? req.query.rowId : '';
    if (!rowId) { res.status(400).json({ error: 'Falta rowId (la fila del extracto a vincular)' }); return; }

    const statement = await req.prisma.bankStatement.findFirst({
      where: { id: req.params.id, companyId: req.user!.companyId },
      select: { id: true, bankAccountId: true, statementStart: true, statementEnd: true },
    });
    if (!statement) { res.status(404).json({ error: 'Extracto no encontrado' }); return; }

    const row = await req.prisma.bankStatementRow.findFirst({
      where: { id: rowId, statementId: statement.id },
      select: { id: true, date: true, debit: true, credit: true },
    });
    if (!row) { res.status(404).json({ error: 'Fila no encontrada' }); return; }

    // Cuentas monetarias distintas de la del extracto: son las únicas a las que
    // tiene sentido mover una pata de banco.
    const cuentas = await req.prisma.account.findMany({
      where: {
        companyId: req.user!.companyId,
        id: { not: statement.bankAccountId },
        OR: [
          { code: '1.1.01' },
          { code: { startsWith: '1.1.01.' } },
          { code: { startsWith: '1.1.02' } },
          { code: { startsWith: '2.1.03' } },
        ],
      },
      select: { id: true, code: true, name: true },
    });
    if (!cuentas.length) { res.json({ candidates: [] }); return; }

    const esEntrada = (row.credit || 0) > 0;
    const desde = statement.statementStart || new Date(new Date(row.date).getTime() - 5 * 24 * 60 * 60 * 1000);
    // Hasta el FIN del día de corte: un `lte` a medianoche deja fuera los asientos
    // del último día, que se guardan a mediodía local.
    const hasta = statement.statementEnd
      ? new Date(new Date(statement.statementEnd).getTime() + 24 * 60 * 60 * 1000 - 1)
      : new Date(new Date(row.date).getTime() + 6 * 24 * 60 * 60 * 1000 - 1);

    // Asientos ya conciliados por la vía vieja (sin vínculo por línea): no se
    // ofrecen de nuevo. El vínculo por línea ya se excluye con `bankRowMatches`.
    const viejos = await req.prisma.bankStatementRow.findMany({
      where: {
        status: 'MATCHED',
        matchedEntryId: { not: null },
        matches: { none: {} },
        statement: { companyId: req.user!.companyId },
      },
      select: { matchedEntryId: true },
    });
    const yaConciliados = new Set<string>(viejos.map((v: any) => v.matchedEntryId));

    const lineas = await req.prisma.journalLine.findMany({
      where: {
        accountId: { in: cuentas.map((c: any) => c.id) },
        // El lado que corresponde a la fila: una entrada del banco se sostiene con
        // el débito del libro; una salida, con el crédito.
        ...(esEntrada ? { debit: { gt: 0 } } : { credit: { gt: 0 } }),
        bankRowMatches: { none: {} },
        journalEntry: {
          companyId: req.user!.companyId,
          status: { notIn: ['RECHAZADO', 'ANULADO'] },
          // Anular no cambia el estado: el original queda BORRADOR/CONFIRMADO con
          // `anuladoPorId`. No se ofrece para mover de banco un asiento revertido.
          anuladoPorId: null,
          isClosing: false,
          date: { gte: desde, lte: hasta },
        },
      },
      include: {
        journalEntry: { select: { id: true, date: true, description: true, status: true } },
        account: { select: { id: true, code: true, name: true } },
      },
      orderBy: { journalEntry: { date: 'asc' } },
      take: 500,
    });

    const montoFila = esEntrada ? row.credit : row.debit;
    const candidates = lineas
      .filter((l: any) => !yaConciliados.has(l.journalEntry.id))
      .map((l: any) => ({
        lineId: l.id,
        entryId: l.journalEntry.id,
        date: l.journalEntry.date,
        descripcion: l.journalEntry.description,
        disponible: esEntrada ? l.debit : l.credit,
        accountId: l.account.id,
        accountCode: l.account.code,
        accountName: l.account.name,
        entryStatus: l.journalEntry.status,
      }))
      // Primero el monto exacto y después la fecha más cercana: con 293
      // movimientos en «Por Clasificar» lo probable tiene que salir arriba.
      .sort((a: any, b: any) => {
        const exactoA = Math.abs(a.disponible - montoFila) <= 0.02 ? 0 : 1;
        const exactoB = Math.abs(b.disponible - montoFila) <= 0.02 ? 0 : 1;
        return exactoA - exactoB
          || daysBetween(new Date(a.date), new Date(row.date)) - daysBetween(new Date(b.date), new Date(row.date))
          || String(a.descripcion).localeCompare(String(b.descripcion));
      });

    res.json({ candidates });
  } catch (error: any) {
    console.error('[Reconcile] Candidates error:', error);
    res.status(400).json({ error: error.message || 'No se pudieron buscar partidas en otras cuentas' });
  }
});

/**
 * Vincula a mano una fila del extracto con las partidas del libro que la
 * sostienen. Devuelve `{ error }` o `{ movidas }`.
 *
 * El caso que lo pide: el ACH de Inmobiliaria Don Antonio del 20-feb por
 * $17.353,68 son cuatro facturas cobradas de una vez. El matcher empareja UNA
 * línea contra UNA fila por monto exacto, así que ese depósito no tiene contra
 * qué conciliarse solo; acá el contador arma el vínculo y la suma tiene que dar
 * el monto de la fila (±2 centavos).
 *
 * `moverCuenta` habilita el caso de la carga histórica: la partida está en OTRA
 * cuenta monetaria (típicamente 1.1.02.09 «Por Clasificar» o el banco
 * equivocado) y el contador decide, en el mismo acto, cambiarla a la cuenta del
 * extracto y conciliarla. El asiento conserva fecha, montos y contrapartidas;
 * solo cambia la cuenta de esa línea. Si estaba CONFIRMADO vuelve a BORRADOR
 * para que el contador lo re-apruebe: no se inventan asientos de reclasificación.
 */
async function vincularLineas(
  prisma: any,
  companyId: string,
  userId: string,
  row: any,
  links: Array<{ lineId: string; amount?: number }>,
  moverCuenta: boolean,
): Promise<{ error: string } | { movidas: MovidaCuenta[] }> {
  const bankAccountId = row.statement.bankAccountId;
  const lineIds = [...new Set(links.map(l => l.lineId))];
  const esEntrada = (row.credit || 0) > 0; // entra plata al banco → la partida va al débito
  const montoFila = esEntrada ? row.credit : row.debit;

  const lineas = await prisma.journalLine.findMany({
    where: { id: { in: lineIds } },
    include: {
      journalEntry: {
        select: { id: true, companyId: true, date: true, description: true, status: true, isClosing: true, anuladoPorId: true },
      },
      account: { select: { id: true, code: true, name: true } },
    },
  });
  if (lineas.length !== lineIds.length) {
    return { error: 'Alguna de las partidas no existe.' };
  }

  // Lo que OTRAS filas ya aplicaron de cada partida. Una línea puede repartirse
  // entre varias filas mientras la suma no pase de su monto: una partida de $12
  // que se cobra en dos movimientos de $6 se aplica $6 a cada fila.
  const otros = await prisma.bankRowMatch.findMany({
    where: { lineId: { in: lineIds }, rowId: { not: row.id } },
    select: { lineId: true, amount: true },
  });
  const aplicadoPorLinea = new Map<string, number>();
  for (const v of otros) {
    aplicadoPorLinea.set(v.lineId, (aplicadoPorLinea.get(v.lineId) ?? 0) + (Number(v.amount) || 0));
  }

  const porLinea = new Map<string, any>(lineas.map((l: any) => [l.id, l]));
  const aplicados: Array<{ lineId: string; entryId: string; amount: number }> = [];
  /** Líneas que hay que cambiar de cuenta, con su asiento, en el mismo acto. */
  const movimientos: Array<{
    linea: any;
    je: any;
    reabrir: boolean;
    desde: { id: string; code: string; name: string };
    estadoOriginal: string;
  }> = [];
  const lineasPorAsiento = new Map<string, any[]>();

  for (const link of links) {
    const linea = porLinea.get(link.lineId)!;
    const je = linea.journalEntry;
    if (je.companyId !== companyId) return { error: 'Alguna de esas partidas es de otra empresa.' };
    if (je.status === 'RECHAZADO' || je.status === 'ANULADO') {
      return { error: `El asiento "${je.description}" está ${je.status.toLowerCase()} y no puede conciliarse.` };
    }
    // Un asiento anulado conserva su estado y solo lleva `anuladoPorId` (el
    // reverso lo netea): sin este chequeo se puede conciliar una fila contra él.
    if (je.anuladoPorId) {
      return { error: `El asiento "${je.description}" está anulado y no puede conciliarse.` };
    }
    if (je.isClosing) {
      return { error: `El asiento "${je.description}" es un asiento de cierre y no puede conciliarse.` };
    }

    // En el extracto, débito = salida del banco y crédito = entrada; en libros
    // la partida va al revés. Solo sirve el lado que corresponde.
    const total = esEntrada ? linea.debit : linea.credit;
    if (!(total > 0)) {
      return { error: `La partida "${je.description}" no sirve para esta fila: es una ${esEntrada ? 'entrada' : 'salida'} de dinero y esa partida está del otro lado.` };
    }
    const aplicado = Math.round((aplicadoPorLinea.get(linea.id) ?? 0) * 100) / 100;
    const disponible = Math.round((total - aplicado) * 100) / 100;
    if (!(disponible > 0.005)) {
      return { error: `La partida "${je.description}" ya está conciliada en otra fila por completo ($${total.toFixed(2)}). Desvinculala de ahí primero.` };
    }
    const amount = link.amount ?? disponible;
    if (amount > disponible + 0.02) {
      return { error: `El monto aplicado a "${je.description}" ($${amount.toFixed(2)}) es mayor que lo que queda de la partida ($${disponible.toFixed(2)} de $${total.toFixed(2)}).` };
    }

    if (linea.accountId !== bankAccountId) {
      if (!moverCuenta) {
        return { error: `La partida "${je.description}" está en ${linea.account.code} ${linea.account.name}, no en la cuenta de este extracto. Activá «mover cuenta» para cambiarla de banco y conciliarla.` };
      }
      // Mover una línea ya vinculada arrastraría las filas de OTRO extracto a
      // una cuenta que no es la suya: primero se desvincula.
      if (aplicado > 0) {
        return { error: `La partida "${je.description}" ya está conciliada en otra fila: desvinculala de ahí antes de moverla de cuenta.` };
      }
      if (!esCuentaMonetaria(linea.account.code)) {
        return { error: `La partida "${je.description}" está en ${linea.account.code} ${linea.account.name}, que no es una cuenta monetaria (Caja/Bancos/Tarjetas): moverla no es una corrección de banco.` };
      }

      // Un año ya cerrado no admite retoques: el saldo de cierre dejaría de
      // cuadrar. Un cierre ANULADO no cuenta (es el que se reabrió para re-cerrar).
      const anio = new Date(je.date).getFullYear();
      const cierre = await prisma.journalEntry.findFirst({
        where: { companyId, isClosing: true, status: { not: 'ANULADO' }, period: String(anio) },
        select: { id: true },
      });
      if (cierre) {
        return { error: `El año ${anio} está cerrado: anulá el cierre antes de mover movimientos de banco.` };
      }

      // Si el asiento ya tiene una línea en la cuenta destino, esto es una
      // transferencia entre cuentas propias: mover la otra pata dejaría las dos
      // en el mismo banco. Se bloquea; la línea que ya está ahí concilia sola.
      if (!lineasPorAsiento.has(je.id)) {
        lineasPorAsiento.set(je.id, await prisma.journalLine.findMany({
          where: { journalEntryId: je.id },
          select: { id: true, accountId: true },
        }));
      }
      const delAsiento = lineasPorAsiento.get(je.id)!;
      if (delAsiento.some((l: any) => l.id !== linea.id && l.accountId === bankAccountId)) {
        return { error: `El asiento "${je.description}" ya tiene la otra pata en esta cuenta: parece una transferencia entre cuentas, no un movimiento mal clasificado.` };
      }

      movimientos.push({
        linea,
        je,
        reabrir: je.status === 'CONFIRMADO',
        desde: { id: linea.account.id, code: linea.account.code, name: linea.account.name },
        estadoOriginal: je.status,
      });
    }

    aplicados.push({ lineId: linea.id, entryId: je.id, amount: Math.round(amount * 100) / 100 });
  }

  const total = Math.round(aplicados.reduce((s, a) => s + a.amount, 0) * 100) / 100;
  const dif = Math.round((total - montoFila) * 100) / 100;
  if (Math.abs(dif) > 0.02) {
    return { error: dif < 0
      ? `Faltan $${Math.abs(dif).toFixed(2)} para cuadrar la fila de $${montoFila.toFixed(2)}.`
      : `Las partidas se pasan por $${dif.toFixed(2)} de la fila de $${montoFila.toFixed(2)}.` };
  }

  // El cambio de cuenta y el vínculo van juntos: una fila nunca queda a medias.
  await prisma.$transaction(async (tx: any) => {
    for (const mov of movimientos) {
      await tx.journalLine.update({
        where: { id: mov.linea.id },
        data: { accountId: bankAccountId },
      });
      if (mov.reabrir) {
        await tx.journalEntry.update({
          where: { id: mov.je.id },
          data: { status: 'BORRADOR', reviewedById: null, reviewedAt: null, reviewNotes: null },
        });
      }
    }

    // Primero los vínculos nuevos y después los que ya no van: el unique
    // (rowId, lineId) no se pisa y la fila nunca queda a medias.
    const previos = await tx.bankRowMatch.findMany({ where: { rowId: row.id }, select: { lineId: true } });
    const previosSet = new Set<string>(previos.map((p: any) => p.lineId));
    const nuevos = aplicados.filter(a => !previosSet.has(a.lineId));
    if (nuevos.length) {
      await tx.bankRowMatch.createMany({
        data: nuevos.map(a => ({ rowId: row.id, entryId: a.entryId, lineId: a.lineId, amount: a.amount, isManual: true })),
      });
    }
    await tx.bankRowMatch.deleteMany({
      where: { rowId: row.id, lineId: { notIn: aplicados.map(a => a.lineId) } },
    });
    await tx.bankStatementRow.update({
      where: { id: row.id },
      data: { matchedEntryId: aplicados[0].entryId, status: 'MATCHED', matchConfidence: 1.0 },
    });
  });

  const destino = row.statement.bankAccount;
  for (const mov of movimientos) {
    await logAudit(prisma, {
      userId,
      action: 'JOURNAL_LINE_MOVED',
      entity: 'JournalLine',
      entityId: mov.linea.id,
      before: {
        accountId: mov.desde.id,
        accountCode: mov.desde.code,
        accountName: mov.desde.name,
      },
      after: {
        accountId: bankAccountId,
        accountCode: destino?.code ?? null,
        accountName: destino?.name ?? null,
        statementId: row.statement.id,
        rowId: row.id,
      },
    });
    if (mov.reabrir) {
      await logAudit(prisma, {
        userId,
        action: 'JOURNAL_REOPENED',
        entity: 'JournalEntry',
        entityId: mov.je.id,
        before: { status: mov.estadoOriginal },
        after: { status: 'BORRADOR', reason: 'bank-account-moved' },
      });
    }
  }

  return {
    movidas: movimientos.map(m => ({
      lineId: m.linea.id,
      entryId: m.je.id,
      desde: `${m.desde.code} — ${m.desde.name}`,
      hasta: destino ? `${destino.code} — ${destino.name}` : '',
      reabierto: m.reabrir,
    })),
  };
}

/**
 * POST /api/reconcile/:id/match — vincular/desvincular a mano.
 *
 *  · `{ rowId, links: [{ lineId, amount? }] }` — vínculo fino: una fila
 *    sostenida por varias partidas del libro (o por una, con monto parcial).
 *  · `moverCuenta: true` — las partidas que están en otra cuenta monetaria se
 *    mueven a la del extracto antes de vincularlas (carga histórica).
 *  · `{ rowId, entryId }` — el 1:1 clásico; `entryId: null` desvincula.
 *
 * Responde el detalle completo del extracto, igual que la subida y el rematch:
 * el frente tiene un solo render.
 */
reconcileRouter.post('/:id/match', validate(reconcileMatchSchema), async (req, res) => {
  const { rowId, entryId, links, moverCuenta } = req.body;

  // Todo dentro del try: en Express 4 un throw suelto en un handler async no
  // llega al middleware de errores y deja la petición colgada para siempre.
  try {
    const row = await req.prisma.bankStatementRow.findFirst({
      where: { id: rowId, statement: { id: req.params.id, companyId: req.user!.companyId } },
      include: {
        statement: {
          select: {
            id: true,
            bankAccountId: true,
            bankAccount: { select: { code: true, name: true } },
          },
        },
      },
    });

    if (!row) { res.status(404).json({ error: 'Fila no encontrada' }); return; }

    if (Array.isArray(links) && links.length > 0) {
      // Mover una línea de banco es una corrección contable: no la hace un
      // usuario de solo lectura. Desvincular/vincular de la misma cuenta sigue
      // abierto a cualquier autenticado, como antes.
      if (moverCuenta && !['admin', 'contador', 'superadmin'].includes(req.user!.role || '')) {
        res.status(403).json({ error: 'Solo un admin o contador puede cambiar un movimiento de cuenta bancaria.' });
        return;
      }
      const result = await vincularLineas(req.prisma, req.user!.companyId, req.user!.userId, row, links, !!moverCuenta);
      if ('error' in result) { res.status(400).json({ error: result.error }); return; }

      const detalle = await detalleDeExtracto(req.prisma, req.user!.companyId, req.params.id);
      res.json({ ...detalle, movidas: result.movidas });
      return;
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

    // Este formulario solo elige UNA cuenta: no pide Nombre, RUC ni N° de factura,
    // así que un asiento contra una cuenta con Anexo DGI quedaría fuera del Anexo y
    // sin tercero. Se rechaza y se remite al Asiento Manual, que sí los pide.
    const flags = await loadAccountFlags(req.prisma, req.user!.companyId, [debitAccountId, creditAccountId]);
    const anexo = [debitAccountId, creditAccountId]
      .map((id) => flags.get(id))
      .find((f) => f?.requiresAnexo);
    if (anexo) {
      res.status(400).json({
        error: `📎 La cuenta ${anexo.code} — ${anexo.name} lleva Anexo DGI (Nombre, RUC y N° de factura). Creá este asiento desde Revisión → ➕ Asiento Manual.`,
      });
      return;
    }

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
