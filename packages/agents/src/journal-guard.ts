/**
 * Guard de cuentas bloqueadas (`Account.isBlocked`) — Fase C de Anexo-DGI.md.
 *
 * Una cuenta bloqueada no admite asientos nuevos en NINGÚN flujo. Se aplica a la
 * creación de asientos (manual, cargas, cobros, planilla, retenciones, recurrentes,
 * agentes…). Exentos: `anular` (revierte un asiento existente) y `year-close`
 * (debe poder saldar cuentas con saldo).
 *
 * Devuelve un mensaje de error en vez de lanzar: Express 4 no captura errores de
 * handlers async, así que un throw dentro de una ruta dejaría la petición colgada.
 * Los call sites usan el idioma habitual de las rutas: `if (msg) { res.status(400)… }`.
 */
/** Cliente Prisma, cliente de transacción ($transaction) o PrismaLike (agents):
 *  basta con que sepa consultar cuentas. */
type Db = {
  account: {
    findMany: (args: any) => Promise<Array<{ id: string; code: string; name: string; isBlocked: boolean }>>;
  };
};

export interface AccountFlags {
  code: string;
  name: string;
  isBlocked: boolean;
}

/** Carga los flags de las cuentas de la empresa. 1 sola query: los flujos por lote
 *  la cargan una vez y reusan el Map fila a fila. */
export async function loadAccountFlags(
  client: Db,
  companyId: string,
  ids?: string[],
): Promise<Map<string, AccountFlags>> {
  const accounts = await client.account.findMany({
    where: { companyId, ...(ids ? { id: { in: ids } } : {}) },
    select: { id: true, code: true, name: true, isBlocked: true },
  });
  return new Map(accounts.map(a => [a.id, { code: a.code, name: a.name, isBlocked: a.isBlocked }]));
}

/** Versión pura (sin BD) para los bucles: devuelve el primer mensaje de error, o null.
 *  Los ids desconocidos se ignoran: los resuelve la validación de cada flujo. */
export function blockedMessage(
  flags: Map<string, AccountFlags>,
  ids: Array<string | null | undefined>,
): string | null {
  for (const id of ids) {
    if (!id) continue;
    const f = flags.get(id);
    if (f?.isBlocked) return `Cuenta ${f.code} — ${f.name} está bloqueada: no admite asientos.`;
  }
  return null;
}

/** Cuentas bloqueadas distintas dentro de una lista de ids: para los flujos que
 *  rechazan el lote entero y necesitan decir CUÁLES cuentas lo bloquean. */
export function blockedAccounts(
  flags: Map<string, AccountFlags>,
  ids: Array<string | null | undefined>,
): AccountFlags[] {
  const seen = new Set<string>();
  const out: AccountFlags[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    const f = flags.get(id);
    if (f?.isBlocked) { seen.add(id); out.push(f); }
  }
  return out;
}

/** Atajo para los flujos de un solo asiento: carga los flags y valida en un paso. */
export async function checkNotBlocked(
  client: Db,
  companyId: string,
  ids: Array<string | null | undefined>,
): Promise<string | null> {
  const wanted = ids.filter((id): id is string => !!id);
  if (!wanted.length) return null;
  return blockedMessage(await loadAccountFlags(client, companyId, wanted), wanted);
}
