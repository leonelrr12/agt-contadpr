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

function daysBetween(d1: Date, d2: Date): number {
  return Math.abs(Math.round((d1.getTime() - d2.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Encuentra el mejor match para una fila de extracto bancario contra los asientos registrados.
 * Busca en todas las cuentas de banco (código empieza con 1.1.02).
 */
async function findBestMatch(
  row: ParsedRow,
  prisma: any,
  companyId: string,
): Promise<{ entryId: string; confidence: number; matchType: MatchResult['matchType'] } | null> {
  if (!row.date || (!row.debit && !row.credit)) return null;

  const amount = row.debit || row.credit || 0;
  if (amount <= 0) return null;

  const rowDate = new Date(row.date);
  const tolerance = 0.02; // 2 centavos de tolerancia

  // Buscar asientos que afectan cuentas de banco (1.1.02.*) en un rango de ±5 días
  const startDate = new Date(rowDate);
  startDate.setDate(startDate.getDate() - 5);
  const endDate = new Date(rowDate);
  endDate.setDate(endDate.getDate() + 5);

  const bankLines = await prisma.journalLine.findMany({
    where: {
      account: {
        code: { startsWith: '1.1.02' },
        companyId,
      },
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

  let bestMatch: { entryId: string; confidence: number; matchType: MatchResult['matchType'] } | null = null;

  for (const line of bankLines) {
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
      bestMatch = { entryId: line.journalEntry.id, confidence, matchType };
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
): Promise<MatchResult[]> {
  const rows = await prisma.bankStatementRow.findMany({
    where: { statementId, status: 'UNMATCHED' },
  });

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
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      _raw: {},
    };

    const match = await findBestMatch(parsed, prisma, companyId);

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

      matches.push({ rowId: row.id, entryId: match.entryId, confidence: match.confidence, matchType: match.matchType });
    }
  }

  return matches;
}

/**
 * Encuentra asientos de libro NO conciliados (en cuentas de banco,
 * en el rango del extracto, que no están matcheados a ninguna fila).
 */
export async function findUnmatchedBookEntries(
  prisma: any,
  companyId: string,
  statementStart?: Date,
  statementEnd?: Date,
): Promise<any[]> {
  // Obtener todos los IDs de asientos ya matcheados en este statement
  const matchedIds = await prisma.bankStatementRow.findMany({
    where: { status: 'MATCHED', matchedEntryId: { not: null } },
    select: { matchedEntryId: true },
  });
  const matchedSet = new Set(matchedIds.map((r: any) => r.matchedEntryId));

  const dateFilter: any = {};
  if (statementStart) dateFilter.gte = statementStart;
  if (statementEnd) dateFilter.lte = statementEnd;

  const where: any = {
    companyId,
    status: { notIn: ['RECHAZADO', 'ANULADO'] },
    lines: { some: { account: { code: { startsWith: '1.1.02' } } } },
  };
  if (Object.keys(dateFilter).length > 0) where.date = dateFilter;

  const entries = await prisma.journalEntry.findMany({
    where,
    include: {
      lines: {
        include: { account: true },
        where: { account: { code: { startsWith: '1.1.02' } } },
      },
    },
    orderBy: { date: 'asc' },
  });

  // Filtrar: solo los no matcheados
  return entries.filter((e: any) => !matchedSet.has(e.id));
}
