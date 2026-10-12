import { parseImportFile, type ParsedRow, type ParseResult } from './csv-parser';

export interface MatchResult {
  rowId: string;
  entryId: string;
  confidence: number;
  matchType: 'exact' | 'near' | 'fuzzy';
}

/**
 * Normaliza un texto para comparación: minúsculas, sin puntuación, sin espacios extra.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-záéíóúñ0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calcula similaridad simple entre dos strings (0-1).
 * Usa Jaccard-like: intersección de palabras / unión de palabras.
 */
function textSimilarity(a: string, b: string): number {
  const wordsA = new Set(normalize(a).split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(normalize(b).split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    // También hacer substring matching
    for (const w2 of wordsB) {
      if (w === w2 || w.includes(w2) || w2.includes(w)) {
        intersection++;
        break;
      }
    }
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Día calendario (UTC) de una fecha de SOLO DÍA.
 *
 * Las dos puntas de la comparación se guardan con horas distintas: la fila del
 * extracto entra por `new Date('2026-06-01')` —medianoche UTC— y el asiento por
 * `parseLocalDate` —mediodía local, 16:00Z con el TZ del server—. Restar los
 * timestamps daba 16 h de diferencia dentro del MISMO día, y `Math.round` las
 * volvía un día entero: el par del mismo día puntuaba 0.9 ("cercano") y uno del
 * día ANTERIOR puntuaba 1.0 ("exacto") y se llevaba la fila. Así quedó "sin
 * conciliar (libros)" el asiento "Viaticos — $5.00" del 01-jun: perdió contra el
 * YAPPY de Edilza del 31-may, de monto idéntico (extracto de junio, 12-10).
 */
function dayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS);
}

function daysBetween(d1: Date, d2: Date): number {
  return Math.abs(dayNumber(d1) - dayNumber(d2));
}

/**
 * Encuentra el mejor match para una fila de extracto bancario contra los asientos
 * registrados EN LA CUENTA DEL EXTRACTO.
 */
async function findBestMatch(
  row: ParsedRow,
  prisma: any,
  companyId: string,
  /** Cuenta del extracto: solo sus líneas pueden sustentar una fila. */
  bankAccountId: string,
  /**
   * Lo que ya está conciliado. La unidad es la LÍNEA del asiento, no el asiento:
   * un asiento puede tener dos líneas de banco (dos transferencias cargadas
   * juntas) y entonces sostiene legítimamente dos filas del extracto; lo que no
   * puede repetirse es la misma línea —eso es un movimiento contado dos veces—.
   * `entradas` viene de los extractos anteriores, que solo guardan el asiento.
   */
  ocupados: { lineas: Set<string>; entradas: Set<string> } = { lineas: new Set(), entradas: new Set() },
): Promise<{ entryId: string; lineId: string; amount: number; confidence: number; matchType: MatchResult['matchType'] } | null> {
  if (!row.date || (!row.debit && !row.credit)) return null;

  const amount = row.debit || row.credit || 0;
  if (amount <= 0) return null;

  const rowDate = new Date(row.date);
  const tolerance = 0.02; // 2 centavos de tolerancia

  // Buscar líneas de la CUENTA DEL EXTRACTO en un rango de ±5 días.
  //
  // Es la cuenta del extracto, no cualquier 1.1.02.*: con dos bancos propios hay
  // montos repetidos y el matcher se llevaba el asiento del OTRO banco (mismo
  // monto y misma fecha), dejando huérfano el de la cuenta correcta — y el
  // contador veía como "sin conciliar" un movimiento que sí estaba registrado
  // (los $15 y $60 de enero en la 8829-7, que se los llevó la 2810-1).
  // La ventana también va por día calendario y cubre el día +5 COMPLETO: los
  // asientos del borde caen a las 16:00Z y un `lte` a medianoche los dejaba fuera.
  const rowDay = dayNumber(rowDate);
  const startDate = new Date((rowDay - 5) * DAY_MS);
  const endDate = new Date((rowDay + 6) * DAY_MS - 1);

  const bankLines = await prisma.journalLine.findMany({
    where: {
      accountId: bankAccountId,
      journalEntry: {
        companyId,
        status: { notIn: ['RECHAZADO', 'ANULADO'] },
        date: { gte: startDate, lte: endDate },
      },
    },
    include: {
      journalEntry: {
        select: { id: true, date: true, description: true },
      },
      account: { select: { code: true, name: true } },
    },
  });

  let bestMatch: { entryId: string; lineId: string; amount: number; confidence: number; matchType: MatchResult['matchType'] } | null = null;

  for (const line of bankLines) {
    // Línea ya usada por otra fila (o asiento ya conciliado en otro extracto):
    // se salta. Sin esto, dos movimientos idénticos del extracto se llevaban la
    // MISMA línea —el mismo movimiento contado dos veces— y el asiento gemelo
    // quedaba "sin conciliar (libros)" para siempre (dos YAPPY de $11,50).
    if (ocupados.lineas.has(line.id) || ocupados.entradas.has(line.journalEntry.id)) continue;

    // En el extracto: debit = salida del banco (se corresponde con credit en libros)
    // En el extracto: credit = entrada al banco (se corresponde con debit en libros)
    const bookAmount = row.debit && row.debit > 0 ? line.credit : line.debit;
    if (Math.abs(bookAmount - amount) > tolerance) continue;

    const jeDate = new Date(line.journalEntry.date);
    const dayDiff = daysBetween(rowDate, jeDate);

    let confidence = 0;
    let matchType: MatchResult['matchType'] = 'fuzzy';

    // Score: monto exacto + fecha exacta = confianza alta
    if (dayDiff === 0 && Math.abs(bookAmount - amount) < 0.005) {
      confidence = 1.0;
      matchType = 'exact';
    } else if (dayDiff <= 2 && Math.abs(bookAmount - amount) < 0.005) {
      confidence = 0.9;
      matchType = 'near';
    } else if (dayDiff <= 5 && Math.abs(bookAmount - amount) < tolerance) {
      // Similaridad de descripción
      const descSim = textSimilarity(row.description || '', line.journalEntry.description || '');
      if (descSim > 0.3) {
        confidence = 0.7;
        matchType = 'fuzzy';
      } else {
        confidence = 0.5;
        matchType = 'fuzzy';
      }
    } else {
      continue;
    }

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { entryId: line.journalEntry.id, lineId: line.id, amount: bookAmount, confidence, matchType };
    }
  }

  // Solo devolver matches con confianza suficiente
  if (bestMatch && bestMatch.confidence >= 0.5) {
    return bestMatch;
  }

  return null;
}

/**
 * Ejecuta el matching automático para todas las filas de un extracto.
 * Devuelve los matches encontrados.
 */
export async function autoMatch(
  statementId: string,
  prisma: any,
  companyId: string,
  /** Cuenta del extracto que se está conciliando. */
  bankAccountId: string,
  /** Asientos que NO deben usarse en esta corrida (los que acaban de soltar filas sobrantes). */
  entradasBloqueadas: Set<string> = new Set(),
): Promise<MatchResult[]> {
  const rows = await prisma.bankStatementRow.findMany({
    where: { statementId, status: 'UNMATCHED' },
  });

  // Asientos ya conciliados en OTROS extractos: no se reutilizan. Los de este
  // mismo extracto quedan fuera a propósito —sus filas pueden compartir un
  // asiento mientras cada una use una línea distinta (dos transferencias
  // cargadas en un solo asiento)— y el reparto fino lo hace `ocupados.lineas`.
  const yaConciliados = await prisma.bankStatementRow.findMany({
    where: { status: 'MATCHED', matchedEntryId: { not: null }, statementId: { not: statementId } },
    select: { matchedEntryId: true },
  });

  // Líneas ya conciliadas a mano (banco ↔ varias partidas del libro): el matcher
  // no las toca. Sin esto, la corrida automática se llevaría una de las cuatro
  // facturas de un depósito ACH ya vinculado y rompería el vínculo.
  const vinculadas = await prisma.bankRowMatch.findMany({ select: { lineId: true } });

  const ocupados = {
    lineas: new Set<string>(vinculadas.map((v: any) => v.lineId)),
    entradas: new Set<string>([...yaConciliados.map((r: any) => r.matchedEntryId), ...entradasBloqueadas]),
  };

  const matches: MatchResult[] = [];

  for (const row of rows) {
    const parsed: ParsedRow = {
      date: row.date.toISOString().split('T')[0],
      description: row.description,
      amount: row.debit || row.credit,
      concept: null,
      paymentMethod: null,
      type: null,
      provider: null,
      reference: row.reference,
      ruc: null,
      itbms: null,
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      _raw: {},
    };

    const match = await findBestMatch(parsed, prisma, companyId, bankAccountId, ocupados);

    if (match) {
      // Actualizar la fila con el match
      await prisma.bankStatementRow.update({
        where: { id: row.id },
        data: {
          status: 'MATCHED',
          matchedEntryId: match.entryId,
          matchConfidence: match.confidence,
        },
      });
      // El vínculo por línea es la verdad de qué quedó conciliado, lo haya hecho
      // el matcher o el contador: así el vínculo automático también protege su
      // línea de otra corrida y la UI puede mostrar qué partidas lo sostienen.
      await prisma.bankRowMatch.create({
        data: { rowId: row.id, entryId: match.entryId, lineId: match.lineId, amount: match.amount, isManual: false },
      });
      ocupados.lineas.add(match.lineId);

      matches.push({ rowId: row.id, entryId: match.entryId, confidence: match.confidence, matchType: match.matchType });
    }
  }

  return matches;
}

/**
 * Encuentra asientos de libro NO conciliados de la cuenta del extracto, en su
 * rango de fechas.
 *
 * La cuenta es la DEL EXTRACTO a propósito: antes se listaban los asientos de
 * TODAS las cuentas 1.1.02.* y el contador veía como "sin conciliar" el
 * alquiler, la planilla o la letra del carro que salieron de OTRO banco (84
 * asientos para un extracto de enero que solo tenía 9 suyos).
 */
export async function findUnmatchedBookEntries(
  prisma: any,
  companyId: string,
  bankAccountId: string,
  statementStart?: Date,
  statementEnd?: Date,
): Promise<any[]> {
  // Obtener todos los IDs de asientos ya matcheados en este statement
  const matchedIds = await prisma.bankStatementRow.findMany({
    where: { status: 'MATCHED', matchedEntryId: { not: null } },
    select: { matchedEntryId: true },
  });
  const matchedSet = new Set(matchedIds.map((r: any) => r.matchedEntryId));

  // Y los asientos que sostienen una fila por vínculo fino (banco ↔ varias
  // partidas): una de las cuatro facturas de un depósito ACH también está
  // conciliada, aunque `matchedEntryId` de la fila apunte a otra.
  const vinculadas = await prisma.bankRowMatch.findMany({ select: { entryId: true } });
  for (const v of vinculadas) matchedSet.add(v.entryId);

  const dateFilter: any = {};
  if (statementStart) dateFilter.gte = statementStart;
  if (statementEnd) dateFilter.lte = statementEnd;

  const where: any = {
    companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] },
    lines: { some: { accountId: bankAccountId } },
  };
  if (Object.keys(dateFilter).length > 0) where.date = dateFilter;

  const entries = await prisma.journalEntry.findMany({
    where,
    include: {
      lines: {
        include: { account: true },
        where: { accountId: bankAccountId },
      },
    },
    orderBy: { date: 'asc' },
  });

  // Filtrar: solo los no matcheados
  return entries.filter((e: any) => !matchedSet.has(e.id));
}
