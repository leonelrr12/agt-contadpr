/**
 * Identidad canónica de un tercero (cliente/proveedor/empresa).
 *
 * El RUC panameño viaja de tres formas según la fuente: `342-240-75526`,
 * `342-240-75526-50` (con DV) o solo dígitos. Si se guarda y se hashea tal
 * como llega, el MISMO tercero entra dos veces y el dedupe no lo encuentra.
 * Acá se separa el DV y se deriva una clave estable (base sin DV) para el
 * `taxIdHash`; el DV se guarda aparte porque la DGI y el PAC lo piden así.
 *
 * No se calcula el DV: el algoritmo de la DGI no se reproduce con los pares
 * reales (ver la ficha de la empresa). Solo se lee cuando viene impreso.
 */
import crypto from 'crypto';

export interface RucPartes {
  /** RUC base tal como vino (conserva guiones), sin el DV. */
  base: string;
  /** Dígito verificador de 1-2 dígitos, o null si el valor no lo trae. */
  dv: string | null;
}

/**
 * Separa el DV del RUC cuando viene pegado como último grupo (`...-50`).
 * El cuerpo del RUC termina en un grupo más largo (`...-75526`, `...-2015`),
 * por eso un último grupo de 1-2 dígitos es DV. Se exigen 3+ grupos para no
 * partir una cédula corta (`1234-56`).
 */
export function separarRucDv(ruc?: string | null): RucPartes {
  const raw = String(ruc ?? '').trim();
  if (!raw) return { base: '', dv: null };

  // El Número Tributario (NT) de las entidades de gobierno NO lleva DV en el
  // sentido del RUC panameño: se conserva entero (`NT-123-456`) y no se parte.
  if (/^NT(?=\d|[-\s]|$)/i.test(raw)) return { base: raw, dv: null };

  const grupos = raw.split(/\D+/).filter(Boolean);
  if (grupos.length >= 3 && grupos[grupos.length - 1].length <= 2) {
    const dv = grupos[grupos.length - 1];
    const corte = raw.lastIndexOf(dv);
    if (corte > 0) {
      const base = raw.slice(0, corte).replace(/[^0-9A-Za-z]+$/, '').trim();
      if (base) return { base, dv };
    }
  }
  return { base: raw, dv: null };
}

/** RUC base en dígitos, para comparar/hashear sin importar guiones ni DV.
 *  El NT conserva su marca (`NT123456`) para no colisionar con un RUC numérico
 *  que casualmente tenga los mismos dígitos. */
export function normalizarRucBase(ruc?: string | null): string {
  const base = separarRucDv(ruc).base;
  if (/^NT(?=\d|[-\s]|$)/i.test(base)) return `NT${base.replace(/\D/g, '')}`;
  return base.replace(/\D/g, '');
}

/** RUC para mostrar: base + DV separado por guion (si hay DV). */
export function formatearRuc(base?: string | null, dv?: string | null): string {
  const b = String(base ?? '').trim();
  if (!b) return '';
  const d = String(dv ?? '').trim();
  return d ? `${b.replace(/-+$/, '')}-${d}` : b;
}

export interface IdentificacionTercero {
  taxIdType?: string | null;
  taxId?: string | null;
  dv?: string | null;
}

/**
 * Separa RUC/DV RESPETANDO el tipo de identificación.
 * Para CEDULA/PASAPORTE/NT se guarda entero. La excepción es un RUC completo
 * de 4+ grupos con DV al final (`8-819-43-33`): la forma manda aunque el tipo
 * diga CEDULA, porque una cédula panameña tiene 3 grupos.
 * Sin tipo se usa la forma: si no parece empresa (p. ej. 8-819-33), se conserva
 * completo; solo se parte un RUC que la forma reconozca como tal.
 */
export function separarIdentificacion(valor?: string | null, tipo?: string | null): RucPartes {
  const raw = String(valor ?? '').trim();
  if (!raw) return { base: '', dv: null };
  const grupos = raw.split(/\D+/).filter(Boolean);
  if (grupos.length >= 4 && grupos[grupos.length - 1].length <= 2) {
    return separarRucDv(raw);
  }
  const t = String(tipo || '').trim().toUpperCase();
  if (t === 'CEDULA' || t === 'PASAPORTE' || t === 'NT') {
    return { base: raw, dv: null };
  }
  if (!t && !esIdentificacionEmpresa({ taxId: raw })) {
    return { base: raw, dv: null };
  }
  return separarRucDv(raw);
}

/**
 * Regla B de terceros: ¿la identificación es de una EMPRESA (RUC/NT) o de una
 * persona (cédula/pasaporte)? Se usa para no crear proveedores desde gastos
 * que no llevan Anexo (p. ej. 6.01.16 Viáticos) cuando el tercero es una
 * persona; una persona solo entra al maestro por Anexo/Honorarios o CxP.
 *
 * El tipo explícito manda. Sin tipo, se reconoce por el DV/la forma del RUC:
 * una cédula panameña es `4-756-445`; un RUC trae DV (`8-733-2267-88`), una
 * base larga (`541-81-118009`), provincia > 13 o letras (`PE-…`, `N-…`).
 * Ante la duda devuelve false: es preferible no crear y que el contador lo
 * agregue a mano, a inventar un proveedor persona.
 */
export function esIdentificacionEmpresa(t: IdentificacionTercero): boolean {
  const tipo = String(t.taxIdType || '').trim().toUpperCase();
  if (tipo === 'RUC' || tipo === 'NT') return true;
  if (tipo === 'CEDULA' || tipo === 'PASAPORTE') return false;

  const raw = String(t.taxId || '').trim();
  if (!raw) return false;
  if (/^NT(?=\d|[-\s]|$)/i.test(raw)) return true;
  if (String(t.dv || '').trim()) return true;

  // Letras en la identificación (PE, N, NT…) → RUC/gobierno, no cédula.
  if (/[A-Za-z]/.test(raw)) return true;

  const grupos = raw.split(/\D+/).filter(Boolean);
  if (!grupos.length) return false;
  const primero = grupos[0];
  const ultimo = grupos[grupos.length - 1];
  // Primer grupo de 5+ dígitos o provincia > 13 (las cédulas van de 1 a 13).
  if (primero.length >= 5 || (Number(primero) || 0) > 13) return true;
  // RUC con DV pegado: 4+ grupos y el último de 1-2 dígitos.
  if (grupos.length >= 4 && ultimo.length <= 2) return true;
  // Base de RUC larga sin DV separado: 541-81-118009.
  if (grupos.length === 3 && ultimo.length >= 5) return true;
  return false;
}

/**
 * Normaliza el nombre para comparar variantes de la misma persona jurídica:
 * sin tildes, minúsculas, sin sufijos legales ni puntuación.
 */
export function normalizarNombreTercero(name?: string | null): string {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/\bs\s*a\b/g, '')
    .replace(/\bsa\b/g, '')
    .replace(/\bs\s*de\s*r\s*l\b/g, '')
    .replace(/\bc\s*por\s*a\b/g, '')
    .replace(/\binc\b/g, '')
    .replace(/\bltda\b/g, '')
    .replace(/\bcorp\b/g, '')
    .replace(/\bco\b/g, '')
    .replace(/[,;]/g, ' ')
    .replace(/[^a-z0-9ñ ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HMAC-SHA256 con clave derivada, para deduplicar por un valor cifrado sin
 * guardarlo en claro. Es la MISMA derivación que usa la extensión de Prisma en
 * `apps/api/src/main.ts` y el orquestador. Sin `FIELD_ENC_KEY` devuelve '' y el
 * dedupe por RUC queda deshabilitado (modo local sin cifrado).
 */
export function hashField(plain?: string | null): string {
  const value = String(plain ?? '').trim();
  if (!value) return '';
  const keyB64 = process.env.FIELD_ENC_KEY || '';
  const key = keyB64 ? Buffer.from(keyB64, 'base64') : null;
  if (!key || key.length !== 32) return '';
  const searchKey = crypto.createHmac('sha256', key).update('search').digest();
  return crypto.createHmac('sha256', searchKey).update(value).digest('hex');
}

/** Hash estable del RUC base (sin DV ni separadores). */
export function hashRucBase(ruc?: string | null): string {
  return hashField(normalizarRucBase(ruc));
}
