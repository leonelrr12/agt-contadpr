// Cifrado de campos sensibles en reposo: AES-256-GCM con IV aleatorio por valor.
// Formato almacenado: v1:<iv hex>:<authTag hex>:<ciphertext hex>.
// Si FIELD_ENC_KEY no está definida, las funciones son pass-through (modo sin cifrar).
// La clave debe ser base64 de 32 bytes — se genera con: openssl rand -base64 32
import crypto from 'crypto';

const KEY_B64 = process.env.FIELD_ENC_KEY || '';
const KEY = KEY_B64 ? Buffer.from(KEY_B64, 'base64') : null;

// Campos a cifrar (por nombre, en los modelos Company/Client/Supplier/PaymentRecord).
// User.email queda FUERA: se usa como login y es unique.
const ENCRYPTED_FIELDS = ['taxId', 'email', 'phone', 'reference'];
// Modelo excluido del cifrado por completo
const EXCLUDED_MODELS = new Set(['User', 'AuthToken', 'ApiKey']);

export function encryptionEnabled(): boolean {
  return KEY !== null && KEY.length === 32;
}

export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('v1:');
}

export function encryptField(plain: string): string {
  if (!KEY || KEY.length !== 32) return plain; // pass-through sin clave
  if (isEncrypted(plain)) return plain; // idempotente
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

export function decryptField(value: unknown): unknown {
  if (typeof value !== 'string' || !value.startsWith('v1:')) return value;
  if (!KEY || KEY.length !== 32) return value;
  try {
    const [, ivHex, tagHex, ctHex] = value.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return value; // si no descifra (clave cambiada), devolver el valor tal cual
  }
}

// Hash determinista con clave para búsquedas exactas (dedupe de RUC) sin filtrar el valor.
export function hashField(plain: string): string {
  if (!KEY || KEY.length !== 32) return '';
  const searchKey = crypto.createHmac('sha256', KEY).update('search').digest();
  return crypto.createHmac('sha256', searchKey).update(String(plain)).digest('hex');
}

/** Cifra los campos sensibles de un objeto `data` de Prisma (muta y devuelve el mismo objeto). */
export function encryptData(data: any, model: string | undefined): any {
  if (!data || typeof data !== 'object' || (model && EXCLUDED_MODELS.has(model))) return data;
  for (const [k, v] of Object.entries(data)) {
    if (ENCRYPTED_FIELDS.includes(k) && typeof v === 'string' && v) {
      data[k] = encryptField(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      encryptData(v, undefined); // recursión para create/update anidados
    }
  }
  return data;
}

/** Descifra los campos sensibles en el resultado de una query (recorrido profundo, idempotente). */
export function decryptResult(result: any): any {
  if (result == null) return result;
  if (Array.isArray(result)) return result.map(decryptResult);
  if (typeof result === 'object') {
    for (const [k, v] of Object.entries(result)) {
      if (ENCRYPTED_FIELDS.includes(k)) result[k] = decryptField(v);
      else result[k] = decryptResult(v);
    }
  }
  return result;
}
