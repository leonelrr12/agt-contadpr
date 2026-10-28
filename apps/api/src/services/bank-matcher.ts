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

export function daysBetween(d1: Date, d2: Date): number {
  return Math.abs(dayNumber(d1) - dayNumber(d2));
}

/**
 * Encuentra el mejor match para una fila de extracto bancario contra las líneas
 * de la cuenta del extracto que ya se cargaron para su ventana de fechas.
 *
 * La consulta se hace UNA vez por día en `autoMatch` (no una vez por fila):
 * con extractos de cientos de movimientos, 573 filas × varias rondas eran miles
 * de consultas y el upload superaba el timeout de nginx (504).
 */
function findBestMatch(
  row: ParsedRow,
  /** Líneas de la cuenta del extracto en la ventana de ±5 días de la fila. */
  bankLines: any[],
  /**
   * Lo que ya está conciliado. La unidad es la LÍNEA del asiento, no el asiento:
   * un asiento puede tener dos líneas de banco (dos transferencias cargadas
   * juntas) y entonces sostiene legítimamente dos filas del extracto; lo que no
   * puede repetirse es la misma línea —eso es un movimiento contado dos veces—.
   * `entradas` viene de los extractos anteriores, que solo guardan el asiento.
   */
  ocupados: { lineas: Set<string>; entradas: Set<string> } = { lineas: new Set(), entradas: new Set() },
  /**
   * Confianza mínima para devolver un candidato. Las bandas son 1.0 (mismo día),
   * 0.9 (±2 días) y 0.7/0.5 (hasta ±5, según se parezcan las descripciones); el
   * reparto por rondas de `autoMatch` las usa para emparejar primero lo del mismo
   * día y dejar lo difuso para el final.
   */
  minConfianza = 0.5,
): { entryId: string; lineId: string; amount: number; confidence: number; matchType: MatchResult['matchType'] } | null {
  if (!row.date || (!row.debit && !row.credit)) return null;

  const amount = row.debit || row.credit || 0;
  if (amount <= 0) return null;

  const rowDate = new Date(row.date);
  const tolerance = 0.02; // 2 centavos de tolerancia

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
  if (bestMatch && bestMatch.confidence >= minConfianza) {
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
  //
  // Ojo con bloquear el asiento ENTERO: una transferencia entre cuentas propias
  // lleva crédito en una cuenta y débito en la otra (el 06-ene, 8829-7 → 2810-1:
  // $2.100 y $5.000), así que el extracto de la cuenta receptora tiene que poder
  // conciliar SUS líneas aunque el de la emisora ya haya usado las suyas. Antes
  // el asiento entero quedaba bloqueado y esas dos filas no conciliaban nunca
  // (12-10). El bloqueo por asiento se mantiene solo para los matches viejos, de
  // antes de `bank_row_match`: esos no dejaron dicho qué línea usaron.
  const yaConciliados = await prisma.bankStatementRow.findMany({
    where: {
      status: 'MATCHED',
      matchedEntryId: { not: null },
      statementId: { not: statementId },
      matches: { none: {} },
    },
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
  /** Filas que ya quedaron emparejadas en esta corrida. */
  const resueltas = new Set<string>();

  /** El estado de la fila, con la forma que espera `findBestMatch`. */
  const comoFila = (row: any): ParsedRow => ({
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
  });

  /** Asigna el emparejamiento y deja la constancia: fila + vínculo por línea. */
  const asignar = async (row: any, match: any) => {
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
    resueltas.add(row.id);
    matches.push({ rowId: row.id, entryId: match.entryId, confidence: match.confidence, matchType: match.matchType });
  };

  // Las líneas de la cuenta se consultan UNA vez por DÍA del extracto, no una
  // vez por fila (ni por ronda): con un extracto de 573 filas eran miles de
  // consultas y el upload superaba el timeout de nginx (504). La ventana de
  // cada día es la misma de siempre: ±5 días calendario, con el +5 completo.
  //
  // Es la cuenta del extracto, no cualquier 1.1.02.*: con dos bancos propios hay
  // montos repetidos y el matcher se llevaba el asiento del OTRO banco.
  const cacheLineasPorDia = new Map<number, any[]>();
  const lineasDelDia = async (fecha: Date): Promise<any[]> => {
    const day = dayNumber(fecha);
    const enCache = cacheLineasPorDia.get(day);
    if (enCache) return enCache;

    const startDate = new Date((day - 5) * DAY_MS);
    const endDate = new Date((day + 6) * DAY_MS - 1);
    const lineas = await prisma.journalLine.findMany({
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
    cacheLineasPorDia.set(day, lineas);
    return lineas;
  };

  // Dos bandas, de la mejor confianza a la peor: primero lo del MISMO día o ±2
  // (0.9-1.0) y después lo difuso (0.5-0.7, hasta ±5 días).
  //
  // Antes se recorría una sola vez, en el orden en que vinieran las filas, y cada una
  // agarraba lo primero aceptable (≥0.5). Con montos idénticos y repetidos —los $6 de
  // alimentación, que salen casi todos los días— eso corre el reparto un día hacia
  // atrás: cada día se lleva las partidas del día siguiente. En marzo de ODESA las
  // tres filas del 31-03 se quedaron sin contraparte mientras su asiento figuraba
  // conciliado por las del 26-03, y como el asiento ya estaba "conciliado" la lista
  // de libros lo escondía (12-10).
  for (const banda of [0.9, 0.5]) {
    for (;;) {
      const pendientes = rows.filter((r: any) => !resueltas.has(r.id));
      if (!pendientes.length) break;

      // Primero se piden TODAS las propuestas y después se asignan: así una fila no
      // consume una partida que otra necesita más (a igual banda, gana la confianza
      // más alta). Las que pierden su candidata vuelven a proponer en la ronda
      // siguiente, ya sin ella en juego.
      const propuestas: Array<{ row: any; match: any }> = [];
      for (const row of pendientes) {
        const match = findBestMatch(comoFila(row), await lineasDelDia(new Date(row.date)), ocupados, banda);
        if (match) propuestas.push({ row, match });
      }
      if (!propuestas.length) break;

      propuestas.sort((a, b) => b.match.confidence - a.match.confidence);

      let asignadas = 0;
      for (const p of propuestas) {
        if (resueltas.has(p.row.id) || ocupados.lineas.has(p.match.lineId)) continue;
        await asignar(p.row, p.match);
        asignadas++;
      }
      // Nadie pudo tomar nada: no queda nada que repartir en esta banda.
      if (!asignadas) break;
    }
  }

  return matches;
}

/**
 * Encuentra las PARTIDAS de libro NO conciliadas de la cuenta del extracto, en
 * su rango de fechas.
 *
 * La unidad de la lista es la LÍNEA, no el asiento. Un asiento puede tener dos
 * líneas de banco (dos transferencias cargadas juntas) y una de ellas seguir
 * libre; y una línea de $12 aplicada $6 al vincular una fila todavía tiene $6
 * por conciliar. Antes cualquier vínculo escondía el asiento ENTERO: al hacer el
 * primer vínculo el saldo que faltaba desaparecía de la lista y no había forma
 * de conciliar la segunda fila (28-10).
 *
 * Los matches viejos (de antes de `bank_row_match`) sí bloquean el asiento
 * entero: no dejaron constancia de qué línea usaron.
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
  // Vínculos viejos: bloquean el asiento entero (ver arriba).
  const viejos = await prisma.bankStatementRow.findMany({
    where: {
      status: 'MATCHED',
      matchedEntryId: { not: null },
      matches: { none: {} },
      statement: { companyId },
    },
    select: { matchedEntryId: true },
  });
  const bloqueados = new Set<string>(viejos.map((v: any) => v.matchedEntryId));

  // Lo ya aplicado de cada línea, sumando TODAS las filas de la empresa: una
  // partida puede repartirse entre varias filas (y entre extractos distintos),
  // y lo que queda por conciliar es el total menos esa suma.
  const vinculos = await prisma.bankRowMatch.findMany({
    where: { row: { statement: { companyId } } },
    select: { lineId: true, amount: true },
  });
  const aplicado = new Map<string, number>();
  for (const v of vinculos) {
    aplicado.set(v.lineId, (aplicado.get(v.lineId) || 0) + (Number(v.amount) || 0));
  }

  const dateFilter: any = {};
  if (statementStart) dateFilter.gte = statementStart;
  if (statementEnd) {
    // El fin del extracto se guarda a medianoche UTC y los asientos a mediodía
    // local. Un `lte` crudo dejaba fuera el ÚLTIMO día del rango; se incluye
    // completo (el matcher no usa este filtro, solo la lista de libros).
    dateFilter.lte = new Date(new Date(statementEnd).getTime() + 24 * 60 * 60 * 1000 - 1);
  }

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

  // Solo las líneas con saldo por conciliar: las aplicadas completas no se
  // ofrecen, y las parciales se ofrecen por lo que queda, no por su total.
  const pendientes: any[] = [];
  for (const e of entries) {
    if (bloqueados.has(e.id)) continue;
    const lines = (e.lines || [])
      .map((l: any) => {
        const usado = Math.round((aplicado.get(l.id) || 0) * 100) / 100;
        return {
          ...l,
          aplicado: usado,
          remainingDebit: Math.max(0, Math.round((l.debit - usado) * 100) / 100),
          remainingCredit: Math.max(0, Math.round((l.credit - usado) * 100) / 100),
        };
      })
      .filter((l: any) => l.remainingDebit > 0.005 || l.remainingCredit > 0.005);
    if (lines.length) pendientes.push({ ...e, lines });
  }
  return pendientes;
}
