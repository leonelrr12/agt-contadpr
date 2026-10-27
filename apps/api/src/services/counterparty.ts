/**
 * Resolver único de contrapartes (Client/Supplier) — higiene de duplicidad.
 *
 * Orden de dedupe (igual para clientes y proveedores):
 *   1. RUC: se compara por el RUC BASE (sin DV ni separadores) con
 *      `taxIdHash` determinista. El mismo RUC puede llegar como
 *      `342-240-75526`, `342-240-75526-50` o solo dígitos; si se hashea tal
 *      como llega, el tercero entra dos veces (ver packages/shared/src/ruc.ts).
 *   2. Nombre exacto (case-insensitive).
 *   3. Nombre normalizado (quita tildes, S.A., C.A., INC., LIDA, puntuación…).
 *
 * Además de crear, COMPLETA los campos fiscales que el registro existente no
 * tenga (dv, teléfono, email, dirección, ubicación…). Nunca pisa un dato ya
 * cargado: la prioridad MANUAL > XML/PDF oficial > OCR/chat se decide en el
 * llamador; acá el registro existente siempre gana.
 *
 * Lo usan los puntos de creación: emisión de factura, import normal
 * (entity-service), chat/WhatsApp (orchestrator-agent), CRUD clients/suppliers.
 */
import { hashField, normalizarNombreTercero, normalizarRucBase, separarIdentificacion, separarRucDv } from '@agt-contador/shared';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface CounterpartyInput {
  name?: string | null;
  taxId?: string | null;
  dv?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  location?: string | null;
  tradeName?: string | null;
  contactName?: string | null;
  taxIdType?: string | null;
  /** MANUAL | XML | PDF | OCR | IMPORT | CHAT — trazabilidad del perfil. */
  fiscalSource?: string | null;
  /** Concepto contable que dio origen al alta (solo se escribe al CREAR). */
  notes?: string | null;
}

/** Campos fiscales que se completan solo si el registro no los tiene. */
const CAMPOS_FISCALES = [
  'dv', 'phone', 'email', 'address', 'location',
  'tradeName', 'contactName', 'taxIdType',
] as const;

type Modelo = 'client' | 'supplier';

/**
 * RUC base + DV separado + hash canónico.
 * Un DV explícito manda: el taxId se toma como base y no se vuelve a partir
 * (si el usuario pegó el DV al final, se quita). La cédula/pasaporte sin DV
 * se guarda entera.
 */
function fiscal(input: CounterpartyInput) {
  const raw = String(input.taxId ?? '').trim();
  const dvInput = String(input.dv ?? '').trim();
  let base = raw;
  let dv: string | null = dvInput || null;
  if (dv) {
    const sufijo = `-${dv}`;
    if (base.endsWith(sufijo)) base = base.slice(0, -sufijo.length).replace(/[^0-9A-Za-z]+$/, '');
  } else {
    const partes = separarIdentificacion(raw, input.taxIdType);
    base = partes.base;
    dv = partes.dv;
  }
  const hash = base ? hashField(normalizarRucBase(base)) : '';
  return { base: base || null, dv: dv || null, hash: hash || null };
}

/** Normaliza los campos opcionales: recorta y convierte '' en null. */
function limpiar(input: CounterpartyInput): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const campo of CAMPOS_FISCALES) {
    const v = String(input[campo] ?? '').trim();
    if (v) out[campo] = v;
  }
  return out;
}

async function findByRucHash(prisma: any, model: Modelo, companyId: string, taxId: string): Promise<any | null> {
  const base = normalizarRucBase(taxId);
  if (!base) return null;
  const hash = hashField(base);
  if (!hash) return null;

  const byHash = await prisma[model].findFirst({ where: { companyId, taxIdHash: hash } });
  if (byHash) return byHash;

  // Compatibilidad con registros viejos: el hash se calculó sobre el texto
  // crudo (con DV y/o guiones). Se prueban esas variantes para no duplicar
  // mientras corre el backfill; después del backfill esto no encuentra nada.
  const variantes = new Set<string>();
  variantes.add(String(taxId).trim());
  const partes = separarRucDv(taxId);
  if (partes.base) variantes.add(partes.base);
  for (const v of variantes) {
    const h = hashField(v);
    if (!h || h === hash) continue;
    const found = await prisma[model].findFirst({ where: { companyId, taxIdHash: h } });
    if (found) return found;
  }
  return null;
}

async function findByName(
  prisma: any,
  model: Modelo,
  companyId: string,
  name: string,
): Promise<any | null> {
  let match = await prisma[model].findFirst({
    where: { companyId, name: { equals: name, mode: 'insensitive' } },
  });
  if (match) return match;

  const normalized = normalizarNombreTercero(name);
  if (normalized.length < 3) return null;

  const rows = await prisma[model].findMany({
    where: { companyId },
    select: { id: true, name: true },
  });
  for (const r of rows) {
    const rNorm = normalizarNombreTercero(r.name);
    if (rNorm === normalized || (rNorm.includes(normalized) && normalized.length >= 4) || (normalized.includes(rNorm) && rNorm.length >= 4)) {
      return r;
    }
  }
  return null;
}

/** Busca una contraparte existente: por RUC canónico y luego por nombre. */
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
 * Completa los campos fiscales vacíos de un registro existente. No pisa nada.
 * Devuelve el registro actualizado (o el mismo si no había nada que completar).
 */
async function completarFiscal(prisma: any, model: Modelo, existing: any, input: CounterpartyInput, fiscalData: ReturnType<typeof fiscal>): Promise<any> {
  const data: Record<string, any> = {};
  for (const [campo, valor] of Object.entries(limpiar(input))) {
    if (valor && !existing[campo]) data[campo] = valor;
  }
  // RUC: si el registro no tenía RUC, se completa con la base canónica.
  if (fiscalData.base && !existing.taxId) {
    data.taxId = fiscalData.base;
  }
  if (fiscalData.dv && !existing.dv) data.dv = fiscalData.dv;
  if (fiscalData.hash && !existing.taxIdHash) data.taxIdHash = fiscalData.hash;
  if (!Object.keys(data).length) return existing;

  if (input.fiscalSource) {
    data.fiscalSource = input.fiscalSource;
    data.fiscalUpdatedAt = new Date();
  }
  try {
    return await prisma[model].update({ where: { id: existing.id }, data });
  } catch (error: any) {
    // Carrera con otro request sobre el mismo RUC/nombre: se devuelve el
    // existente sin romper la factura. El siguiente pase completará el dato.
    if (error?.code === 'P2002') return existing;
    throw error;
  }
}

/**
 * Find-or-create con enriquecimiento: si existe (RUC/nombre) completa los
 * campos fiscales que falten; si no, crea con todo lo que venga.
 */
export async function findOrCreateClient(prisma: any, companyId: string, input: CounterpartyInput): Promise<any> {
  const name = (input.name || '').trim();
  if (!name) throw new Error('El nombre del cliente es requerido');
  const f = fiscal(input);

  const existing = await findClient(prisma, companyId, { name, taxId: input.taxId });
  if (existing) return completarFiscal(prisma, 'client', existing, input, f);

  try {
    return await prisma.client.create({
      data: {
        companyId,
        name,
        taxId: f.base,
        taxIdHash: f.hash,
        ...(f.dv ? { dv: f.dv } : {}),
        ...limpiar(input),
        ...(input.fiscalSource ? { fiscalSource: input.fiscalSource, fiscalUpdatedAt: new Date() } : {}),
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await findClient(prisma, companyId, { name, taxId: input.taxId });
      if (winner) return completarFiscal(prisma, 'client', winner, input, f);
    }
    throw error;
  }
}

export async function findOrCreateSupplier(prisma: any, companyId: string, input: CounterpartyInput): Promise<any> {
  const name = (input.name || '').trim();
  if (!name) throw new Error('El nombre del proveedor es requerido');
  const f = fiscal(input);
  // La nota es la traza del alta (p. ej. "Concepto: Honorarios"): se escribe
  // solo al crear. El registro existente manda y no se pisa.
  const notes = String(input.notes ?? '').trim();

  const existing = await findSupplier(prisma, companyId, { name, taxId: input.taxId });
  if (existing) return completarFiscal(prisma, 'supplier', existing, input, f);

  try {
    return await prisma.supplier.create({
      data: {
        companyId,
        name,
        taxId: f.base,
        taxIdHash: f.hash,
        ...(f.dv ? { dv: f.dv } : {}),
        ...limpiar(input),
        ...(notes ? { notes } : {}),
        ...(input.fiscalSource ? { fiscalSource: input.fiscalSource, fiscalUpdatedAt: new Date() } : {}),
      },
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const winner = await findSupplier(prisma, companyId, { name, taxId: input.taxId });
      if (winner) return completarFiscal(prisma, 'supplier', winner, input, f);
    }
    throw error;
  }
}

/** Compatibilidad: el normalizador histórico vivía acá. */
export const normalizeName = normalizarNombreTercero;

export { r2 };
