/**
 * Resolver único de contrapartes (Client/Supplier) — higiene de duplicidad.
 *
 * Orden de dedupe (igual para clientes y proveedores):
 *   1. RUC: taxIdHash determinista (HMAC) — el valor cifrado no se puede
 *      comparar en SQL (AES-GCM con IV aleatorio); el hash se setea
 *      automáticamente en main.ts (Client/Supplier/Company).
 *   2. Nombre exacto (case-insensitive).
 *   3. Nombre normalizado (quita S.A., C.A., INC., LIDA, puntuación…).
 *
 * Lo usan los 5 puntos de creación: emisión de factura, import normal
 * (entity-service), chat/WhatsApp (orchestrator-agent), CRUD clients/suppliers.
 */
import { hashField } from './crypto-fields';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** Normaliza el nombre de una persona jurídica para comparar variantes. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\bs\s*a\b/g, '')
    .replace(/\bsa\b/g, '')
    .replace(/\bs\s*de\s*r\s*l\b/g, '')
    .replace(/\bc\s*por\s*a\b/g, '')
    .replace(/\binc\b/g, '')
    .replace(/\bltda\b/g, '')
    .replace(/[^a-z0-9áéíóúüñ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface CounterpartyInput {
  name?: string | null;
  taxId?: string | null;
}

async function findByRucHash(prisma: any, model: 'client' | 'supplier', companyId: string, taxId: string): Promise<any | null> {
  const hash = hashField(taxId.trim());
  if (!hash) return null;
  return prisma[model].findFirst({ where: { companyId, taxIdHash: hash } });
}

async function findByName(
  prisma: any,
  model: 'client' | 'supplier',
  companyId: string,
  name: string,
): Promise<any | null> {
  let match = await prisma[model].findFirst({
    where: { companyId, name: { equals: name, mode: 'insensitive' } },
  });
  if (match) return match;

  const normalized = normalizeName(name);
  if (normalized.length < 3) return null;

  const rows = await prisma[model].findMany({
    where: { companyId },
    select: { id: true, name: true },
  });
  for (const r of rows) {
    const rNorm = normalizeName(r.name);
    if (rNorm === normalized || (rNorm.includes(normalized) && normalized.length >= 4) || (normalized.includes(rNorm) && rNorm.length >= 4)) {
      return r;
    }
  }
  return null;
}

/** Busca una contraparte existente: por RUC (hash) y luego por nombre. */
export async function findClient(prisma: any, companyId: string, input: CounterpartyInput): Promise<any | null> {
  const taxId = (input.taxId || '').trim() || null;
  if (taxId) {
    const byRuc = await findByRucHash(prisma, 'client', companyId, taxId);
    if (byRuc) return byRuc;
  }
  const name = (input.name || '').trim();
  if (!name) return null;
  return findByName(prisma, 'client', companyId, name);
}

export async function findSupplier(prisma: any, companyId: string, input: CounterpartyInput): Promise<any | null> {
  const taxId = (input.taxId || '').trim() || null;
  if (taxId) {
    const byRuc = await findByRucHash(prisma, 'supplier', companyId, taxId);
    if (byRuc) return byRuc;
  }
  const name = (input.name || '').trim();
  if (!name) return null;
  return findByName(prisma, 'supplier', companyId, name);
}

/**
 * Find-or-create: si existe (RUC/nombre) lo devuelve — completando el RUC si
 * al registro le faltaba; si no, crea. Maneja la carrera de unique (P2002).
 */
export async function findOrCreateClient(prisma: any, companyId: string, input: CounterpartyInput): Promise<any> {
  const name = (input.name || '').trim();
  const taxId = (input.taxId || '').trim() || null;
  if (!name) throw new Error('El nombre del cliente es requerido');

  const existing = await findClient(prisma, companyId, { name, taxId });
  if (existing) {
    if (taxId && !existing.taxId) {
      try {
        return await prisma.client.update({ where: { id: existing.id }, data: { taxId } });
      } catch { /* carrera — devolver el existente igual */ }
    }
    return existing;
  }

  try {
    return await prisma.client.create({ data: { companyId, name, taxId } });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await findClient(prisma, companyId, { name, taxId });
      if (winner) return winner;
    }
    throw error;
  }
}

export async function findOrCreateSupplier(prisma: any, companyId: string, input: CounterpartyInput): Promise<any> {
  const name = (input.name || '').trim();
  const taxId = (input.taxId || '').trim() || null;
  if (!name) throw new Error('El nombre del proveedor es requerido');

  const existing = await findSupplier(prisma, companyId, { name, taxId });
  if (existing) {
    if (taxId && !existing.taxId) {
      try {
        return await prisma.supplier.update({ where: { id: existing.id }, data: { taxId } });
      } catch { /* carrera — devolver el existente igual */ }
    }
    return existing;
  }

  try {
    return await prisma.supplier.create({ data: { companyId, name, taxId } });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await findSupplier(prisma, companyId, { name, taxId });
      if (winner) return winner;
    }
    throw error;
  }
}

export { r2 };
