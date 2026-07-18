/**
 * Servicio de búsqueda de cuentas contables por nombre.
 * Usado principalmente para carga inicial donde el CSV trae nombres de cuentas
 * (ej: "Banco", "Cuentas por Cobrar") en vez de códigos o IDs.
 */

export interface AccountMatch {
  id: string;
  name: string;
  code: string;
  type: string;
}

// Palabras muy comunes que no sirven para identificar una cuenta
const STOP_WORDS = new Set([
  'de', 'del', 'la', 'las', 'los', 'el', 'por', 'y', 'e', 'o', 'a', 'con',
  'para', 'en', 'al', 'su', 'sus', 'un', 'una', 'unos', 'unas', 'se',
  'the', 'of', 'and', 'or', 'in', 'on', 'to', 'for',
]);

/**
 * Normaliza texto para comparación: elimina acentos, pasa a minúsculas.
 */
function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // eliminar acentos
}

/**
 * Extrae palabras significativas (sin stop words, min 2 chars).
 */
function significantWords(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));
}

/**
 * Busca una cuenta contable por nombre usando matching progresivo:
 * 1. Match exacto case-insensitive (sin acentos)
 * 2. Match por contains (para nombres parciales como "Banco" → "Banco General")
 * 3. Match por palabras significativas compartidas
 *    (ej: "Impuesto por Pagar" comparte "pagar" con "ITBMS por Pagar")
 *
 * Si hay múltiples matches, elige la cuenta con el nombre más corto
 * (la cuenta más general/sumaria). Si se especifica preferredType, las cuentas
 * de ese tipo tienen prioridad sobre las demás.
 */
export async function findAccountByName(
  prisma: any,
  companyId: string,
  name: string,
  preferredType?: string,
): Promise<AccountMatch | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const normalized = normalize(trimmed);

  // Cargamos todas las cuentas activas y comparamos en memoria
  // para poder hacer comparación sin acentos que Prisma no soporta nativamente
  const allAccounts: AccountMatch[] = await prisma.account.findMany({
    where: { companyId, isActive: true },
    select: { id: true, name: true, code: true, type: true },
  });

  if (allAccounts.length === 0) return null;

  // Helper: ordena poniendo las del tipo preferido primero, luego por nombre más corto
  const sortByPreference = (accounts: AccountMatch[]) => {
    accounts.sort((a, b) => {
      const aPref = preferredType && a.type === preferredType ? 0 : 1;
      const bPref = preferredType && b.type === preferredType ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.name.length - b.name.length;
    });
  };

  // Paso 1: Match exacto sin acentos
  const exactMatch = allAccounts.find(a => normalize(a.name) === normalized);
  if (exactMatch) return exactMatch;

  // Paso 2: Match por contains sin acentos
  const containing = allAccounts.filter(a =>
    normalize(a.name).includes(normalized)
  );

  if (containing.length > 0) {
    sortByPreference(containing);
    return containing[0];
  }

  // Paso 3: Match por palabras significativas compartidas
  const searchWords = significantWords(trimmed);
  if (searchWords.length === 0) return null;

  // También buscar si alguna palabra del search está contenida en nombres de cuenta
  // (ej: "impuesto" contenido en "Impuesto sobre la Renta")
  const containingAnyWord = allAccounts.filter(a => {
    const na = normalize(a.name);
    return searchWords.some(sw => na.includes(sw) || sw.includes(na));
  });

  if (containingAnyWord.length > 0) {
    sortByPreference(containingAnyWord);
    return containingAnyWord[0];
  }

  // Paso 4: Match por palabras significativas compartidas (intersección)
  let bestMatch: AccountMatch | null = null;
  let bestScore = 0;

  for (const account of allAccounts) {
    const accountWords = significantWords(account.name);
    const matchingWords = searchWords.filter(sw =>
      accountWords.some(aw => aw.includes(sw) || sw.includes(aw))
    );
    const score = matchingWords.length;

    // Preferir tipo correcto, más palabras compartidas, y nombre más corto
    const typeBonus = preferredType && account.type === preferredType ? 100 : 0;
    const effectiveScore = score + typeBonus;

    if (
      effectiveScore > bestScore ||
      (effectiveScore === bestScore && bestMatch && account.name.length < bestMatch.name.length)
    ) {
      bestScore = effectiveScore;
      bestMatch = account;
    }
  }

  if (bestMatch && bestScore >= 1 && searchWords.every(w => w.length >= 4)) {
    return bestMatch;
  }

  return null;
}

export interface CargaInicialRowInput {
  accountType: string;
  accountName: string;
  amount: number;
}

export interface CargaInicialRowLookup {
  accountType: string;
  accountName: string;
  amount: number;
  matchedAccount: AccountMatch | null;
  side: 'Debe' | 'Haber';
  status: 'ok' | 'not_found';
}

/**
 * Procesa todas las filas de una carga inicial: busca cada cuenta por nombre
 * y determina el lado (Debe/Haber) según el tipo de cuenta.
 */
export async function resolveCargaInicialRows(
  prisma: any,
  companyId: string,
  rows: CargaInicialRowInput[],
): Promise<{ results: CargaInicialRowLookup[]; totalDebit: number; totalCredit: number }> {
  const results: CargaInicialRowLookup[] = [];

  for (const row of rows) {
    const matchedAccount = await findAccountByName(prisma, companyId, row.accountName, row.accountType);

    // Determinar lado: Activo/GASTO/COSTO → Debe, Pasivo/PATRIMONIO/INGRESO → Haber
    let side: 'Debe' | 'Haber' = 'Debe';
    const type = row.accountType.toUpperCase();
    if (['PASIVO', 'PATRIMONIO', 'INGRESO'].includes(type)) {
      side = 'Haber';
    }

    results.push({
      accountType: row.accountType,
      accountName: row.accountName,
      amount: row.amount,
      matchedAccount,
      side,
      status: matchedAccount ? 'ok' : 'not_found',
    });
  }

  const totalDebit = results
    .filter(r => r.side === 'Debe')
    .reduce((sum, r) => sum + r.amount, 0);
  const totalCredit = results
    .filter(r => r.side === 'Haber')
    .reduce((sum, r) => sum + r.amount, 0);

  return { results, totalDebit, totalCredit };
}
