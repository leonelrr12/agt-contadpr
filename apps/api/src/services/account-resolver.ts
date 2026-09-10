/**
 * Resolución de cuentas contables a partir de texto (código, nombre o alias),
 * tolerante a typos. La usan:
 * - cobros (cuenta destino del depósito),
 * - import de gastos/compras (columna "Banco/Cuenta" → banco por defecto),
 * - cargas de Planilla/Honorarios (columna "Banco" por fila).
 */

export interface CompanyAccount {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Normaliza texto para comparar nombres: minúsculas, sin acentos ni puntuación.
 */
export function normalizeNameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza a solo letras para comparación de tokens (palabra a palabra). */
export function wordKey(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

/** Todas las cuentas de la empresa (catálogo completo para resolver). */
export async function loadCompanyAccounts(prisma: any, companyId: string): Promise<CompanyAccount[]> {
  return prisma.account.findMany({
    where: { companyId },
    select: { id: true, code: true, name: true, aliases: true },
  });
}

/** Candidatas a recibir un pago: cuentas de banco (1.1.02.*) o cajas. */
export function filterPayoutAccounts(accounts: CompanyAccount[]): CompanyAccount[] {
  return accounts.filter(a => {
    const haystack = `${a.code} ${a.name} ${(a.aliases || []).join(' ')}`.toLowerCase();
    return a.code.startsWith('1.1.02') || haystack.includes('caja');
  });
}

/**
 * Resuelve la cuenta de destino desde el texto del archivo:
 * 1. coincidencia exacta con código/alias/nombre (sin acentos ni símbolos),
 * 2. tolerante a typos ("Bnaco General" → "Banco General"): por tokens con
 *    distancia de edición ≤ 1 en palabras de ≥ 4 letras, cobertura completa
 *    de ambos lados y menor distancia total.
 */
export function resolveAccount(accounts: CompanyAccount[], raw: string | null): CompanyAccount | null {
  if (!raw) return null;
  const input = raw.trim();
  if (!input) return null;

  // 1) Exacta: código, alias o nombre, normalizados (sin acentos ni símbolos)
  const want = wordKey(input).replace(/\s+/g, '');
  for (const a of accounts) {
    const keys = [a.code, a.name, ...(a.aliases || [])];
    for (const k of keys) {
      if (wordKey(k).replace(/\s+/g, '') === want) return a;
    }
  }

  // 2) Tolerante a typos. IMPORTANTE: se normaliza conservando los espacios
  // (normalizeNameKey) — wordKey elimina todo lo no alfanumérico y colapsaría
  // "Banco de Panama" a un solo token "bancodepanama".
  const inputWords = normalizeNameKey(input).split(/\s+/).filter(w => w.length >= 2);
  if (inputWords.length === 0) return null;

  const wordMatch = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true; // "bancos" vs "banco"
    if (a.length >= 5 && b.length >= 5 && levenshtein(a, b) <= 2) return true; // "Bnaco" ↔ "Banco" (transposición)
    return a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 1;
  };

  let best: { account: CompanyAccount; dist: number } | null = null;

  for (const acc of accounts) {
    const accWords = [
      ...normalizeNameKey(acc.name).split(/\s+/).filter(w => w.length >= 2),
      ...(acc.aliases || []).map(normalizeNameKey).flatMap(a => a.split(/\s+/)).filter(w => w.length >= 2),
    ];
    if (accWords.length === 0) continue;

    // Cobertura completa de ambos lados
    const inputOk = inputWords.every(iw => accWords.some(aw => wordMatch(iw, aw)));
    const accOk = accWords.every(aw => inputWords.some(iw => wordMatch(iw, aw)));
    if (!inputOk || !accOk) continue;

    // Menor distancia total (suma del mejor match por token de entrada)
    let dist = 0;
    for (const iw of inputWords) {
      let bestWord = Infinity;
      for (const aw of accWords) bestWord = Math.min(bestWord, levenshtein(iw, aw));
      dist += bestWord;
    }
    if (!best || dist < best.dist || (dist === best.dist && acc.name.length < best.account.name.length)) {
      best = { account: acc, dist };
    }
  }

  return best ? best.account : null;
}

export interface PayoutResolution {
  account: CompanyAccount | null;
  /** Origen de la cuenta: columna "Banco" del archivo, banco por defecto o respaldo 1.1.02.01. */
  source: 'archivo' | 'default' | 'fallback' | 'ninguna';
  /** Texto del archivo que no se pudo resolver (para avisar en el preview). */
  unresolvedName: string | null;
}

/**
 * Aviso legible cuando el banco usado NO salió de la columna del archivo
 * (nombre no reconocido o respaldo sin banco por defecto). null = sin aviso.
 */
export function payoutAviso(payout: PayoutResolution | null): string | null {
  if (!payout || !payout.account) return null;
  if (payout.source === 'archivo') return null;
  if (payout.unresolvedName) {
    return `Banco "${payout.unresolvedName}" no está en el catálogo; se usa ${payout.account.name}`;
  }
  if (payout.source === 'fallback') {
    return `Sin banco por defecto configurado; se usa ${payout.account.name} (${payout.account.code})`;
  }
  return null;
}

export interface PayoutCache {
  accounts: CompanyAccount[] | null;
  defaultId: string | null;
}

/**
 * Cadena de pago de una fila (Planilla/Honorarios): banco indicado en la
 * columna "Banco" (si resuelve en el catálogo) → cuenta de banco por defecto
 * configurada (Company.bancoDefaultId) → respaldo 1.1.02.01. Si el nombre del
 * archivo no resuelve se usa el default y se reporta `unresolvedName`.
 */
export async function resolvePayoutAccount(
  prisma: any,
  companyId: string,
  bankName: string | null | undefined,
  cache: PayoutCache,
): Promise<PayoutResolution> {
  if (!cache.accounts) {
    cache.accounts = filterPayoutAccounts(await loadCompanyAccounts(prisma, companyId));
    const company: any = await prisma.company.findUnique({
      where: { id: companyId },
      select: { bancoDefaultId: true },
    });
    cache.defaultId = company?.bancoDefaultId || null;
  }
  const bancos = cache.accounts;
  const wanted = (bankName || '').trim() || null;

  if (wanted) {
    const acc = resolveAccount(bancos, wanted);
    if (acc) return { account: acc, source: 'archivo', unresolvedName: null };
  }
  if (cache.defaultId) {
    const cfg = bancos.find(a => a.id === cache.defaultId);
    if (cfg) return { account: cfg, source: 'default', unresolvedName: wanted };
  }
  const fallback = bancos.find(a => a.code === '1.1.02.01') || null;
  if (fallback) return { account: fallback, source: 'fallback', unresolvedName: wanted };
  return { account: null, source: 'ninguna', unresolvedName: wanted };
}
