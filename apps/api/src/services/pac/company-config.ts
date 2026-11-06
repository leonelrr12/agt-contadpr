/**
 * Configuración del PAC POR EMPRESA (tabla `pac_config`).
 *
 * La fila es la fuente de verdad; el adaptador recibe un `PacProviderConfig` ya
 * resuelto. Las credenciales se descifran al leerlas con el cliente Prisma
 * extendido (services/crypto-fields.ts) y NUNCA salen por la API: la vista solo
 * informa si están cargadas.
 *
 * Multi-proveedor: cada empresa elige SU PAC en la misma ficha (`provider`).
 * Factura Fácil usa UUID/API key/Basic; HKA usa usuario/clave de integración.
 * La validación de habilitación es por proveedor. La ficha se puede guardar
 * incompleta para cargar los datos antes de que el proveedor entregue los accesos.
 */
import { PacError } from './types';
import type { PacEnvironment, PacProvider, PacProviderConfig } from './types';
import { createPacProvider } from './index';
import { FACTURA_FACIL, FACTURA_FACIL_ENDPOINTS } from './facturafacil';
import { HKA, HKA_ENDPOINTS } from './hka';
import { isEncrypted } from '../crypto-fields';

/**
 * Catálogo de proveedores soportados. Es la única lista que hay que tocar al
 * sumar un PAC: el adaptador en `services/pac/`, el case en la factory y esta
 * entrada. La UI arma el selector con lo que devuelve la API.
 */
export const PAC_PROVIDERS = [
  { id: FACTURA_FACIL, label: 'Factura Fácil' },
  { id: HKA, label: 'The Factory HKA' },
] as const;

const PROVIDERS = PAC_PROVIDERS.map((p) => p.id);
const ENVIRONMENTS: PacEnvironment[] = ['PRUEBAS', 'PRODUCCION'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PacProviderInfo {
  id: string;
  label: string;
}

export interface PacConfigInput {
  provider?: string;
  environment?: string;
  companyUuid?: string | null;
  /** Vacío/omitido = conservar la key guardada. */
  pacApiKey?: string | null;
  clearApiKey?: boolean;
  basicUser?: string | null;
  /** Vacío/omitido = conservar la contraseña guardada. */
  pacBasicPassword?: string | null;
  clearBasicPassword?: boolean;
  /** HKA: usuario de integración (`usuario`). */
  apiUser?: string | null;
  /** HKA: clave de integración (`clave`). Vacío/omitido = conservar la guardada. */
  apiPassword?: string | null;
  clearApiPassword?: boolean;
  /** URL base del proveedor. Si se omite, se usa la del ambiente. */
  baseUrl?: string | null;
  branchUuid?: string | null;
  branchCode?: string | null;
  pos?: string;
  enabled?: boolean;
}

export interface PacConfigView {
  configured: boolean;
  /** Catálogo soportado por la API; la UI no hardcodea proveedores. */
  providers: PacProviderInfo[];
  provider: string;
  environment: PacEnvironment;
  companyUuid: string;
  pos: string;
  branchUuid: string;
  branchCode: string;
  basicUser: string;
  apiUser: string;
  enabled: boolean;
  apiKeySet: boolean;
  basicPasswordSet: boolean;
  apiPasswordSet: boolean;
  baseUrl: string;
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
}

export interface PacTestResult {
  ok: boolean;
  message: string;
  status?: number;
}

const trimOrNull = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s || null;
};

const toBoolean = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return ['true', '1', 'si', 'sí'].includes(v.trim().toLowerCase());
  return Boolean(v);
};

export function emptyPacConfigView(): PacConfigView {
  return {
    configured: false,
    providers: PAC_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    provider: FACTURA_FACIL,
    environment: 'PRUEBAS',
    companyUuid: '',
    pos: '001',
    branchUuid: '',
    branchCode: '',
    basicUser: '',
    apiUser: '',
    enabled: false,
    apiKeySet: false,
    basicPasswordSet: false,
    apiPasswordSet: false,
    baseUrl: '',
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };
}

/** Vista segura: sin secretos, solo el booleano de "está cargado". */
export function toPacConfigView(row: any): PacConfigView {
  return {
    configured: true,
    providers: PAC_PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
    provider: row.provider || FACTURA_FACIL,
    environment: (row.environment as PacEnvironment) || 'PRUEBAS',
    companyUuid: row.companyUuid || '',
    pos: row.pos || '001',
    branchUuid: row.branchUuid || '',
    branchCode: row.branchCode || '',
    basicUser: row.basicUser || '',
    apiUser: row.apiUser || '',
    enabled: Boolean(row.enabled),
    apiKeySet: Boolean(row.pacApiKey),
    basicPasswordSet: Boolean(row.pacBasicPassword),
    apiPasswordSet: Boolean(row.apiPassword),
    baseUrl: row.baseUrl || '',
    lastTestAt: row.lastTestAt ? new Date(row.lastTestAt).toISOString() : null,
    lastTestOk: row.lastTestOk ?? null,
    lastTestError: row.lastTestError ?? null,
  };
}

export async function getPacConfigView(prisma: any, companyId: string): Promise<PacConfigView> {
  const row = await prisma.pacConfig.findUnique({ where: { companyId } });
  return row ? toPacConfigView(row) : emptyPacConfigView();
}

export async function savePacConfig(
  prisma: any,
  companyId: string,
  input: PacConfigInput,
): Promise<PacConfigView> {
  const existing = await prisma.pacConfig.findUnique({ where: { companyId } });

  const provider = (
    input.provider !== undefined ? String(input.provider).trim().toUpperCase() : existing?.provider || FACTURA_FACIL
  );
  if (!PROVIDERS.includes(provider)) {
    throw new PacError(
      `Proveedor PAC no soportado: "${provider}". Hoy: ${PROVIDERS.join(', ')}.`,
      'VALIDATION',
    );
  }
  const isHka = provider === HKA;

  const environment = (
    input.environment !== undefined
      ? String(input.environment).trim().toUpperCase()
      : existing?.environment || 'PRUEBAS'
  );
  if (!ENVIRONMENTS.includes(environment as PacEnvironment)) {
    throw new PacError('El ambiente del PAC debe ser PRUEBAS o PRODUCCION.', 'VALIDATION');
  }

  const companyUuid =
    input.companyUuid !== undefined ? trimOrNull(input.companyUuid) : existing?.companyUuid || null;
  if (companyUuid && companyUuid.length > 100) {
    throw new PacError('El UUID del emisor no puede superar 100 caracteres.', 'VALIDATION');
  }
  if (companyUuid && provider === FACTURA_FACIL && !UUID_RE.test(companyUuid)) {
    throw new PacError('El UUID del emisor no tiene formato UUID (8-4-4-4-12).', 'VALIDATION');
  }

  const pos = input.pos !== undefined ? String(input.pos).trim() : existing?.pos || '001';
  if (!/^\d{3}$/.test(pos)) {
    throw new PacError('El punto de venta (POS) debe tener exactamente 3 dígitos.', 'VALIDATION');
  }

  const branchUuid =
    input.branchUuid !== undefined ? trimOrNull(input.branchUuid) : existing?.branchUuid || null;
  if (branchUuid && branchUuid.length > 100) {
    throw new PacError('El UUID de sucursal no puede superar 100 caracteres.', 'VALIDATION');
  }
  if (branchUuid && provider === FACTURA_FACIL && !UUID_RE.test(branchUuid)) {
    throw new PacError('El UUID de sucursal no tiene formato UUID (8-4-4-4-12).', 'VALIDATION');
  }

  const branchCode =
    input.branchCode !== undefined ? trimOrNull(input.branchCode) : existing?.branchCode || null;
  if (branchCode && branchCode.length !== 4) {
    throw new PacError('El código de sucursal debe tener exactamente 4 caracteres.', 'VALIDATION');
  }

  const baseUrl =
    input.baseUrl !== undefined ? trimOrNull(input.baseUrl) : existing?.baseUrl || null;
  if (baseUrl) {
    if (baseUrl.length > 300) {
      throw new PacError('La URL base del PAC no puede superar 300 caracteres.', 'VALIDATION');
    }
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocolo');
    } catch {
      throw new PacError('La URL base del PAC no es una URL válida.', 'VALIDATION');
    }
  }

  // Secretos: un campo vacío NO borra lo guardado (la UI nunca los rellena).
  // Para borrarlos hay que pedirlo explícitamente con clearApiKey/clearBasicPassword.
  let pacApiKey: string | null = existing?.pacApiKey || null;
  if (input.clearApiKey) pacApiKey = null;
  else if (input.pacApiKey !== undefined && String(input.pacApiKey).trim()) {
    pacApiKey = String(input.pacApiKey).trim();
  }

  let pacBasicPassword: string | null = existing?.pacBasicPassword || null;
  if (input.clearBasicPassword) pacBasicPassword = null;
  else if (input.pacBasicPassword !== undefined && String(input.pacBasicPassword) !== '') {
    // La contraseña no se trimea: puede tener espacios a propósito.
    pacBasicPassword = String(input.pacBasicPassword);
  }

  const basicUser =
    input.basicUser !== undefined ? trimOrNull(input.basicUser) : existing?.basicUser || null;
  if (basicUser && basicUser.length > 150) {
    throw new PacError('El usuario Basic no puede superar 150 caracteres.', 'VALIDATION');
  }
  if (!isHka && Boolean(basicUser) !== Boolean(pacBasicPassword)) {
    throw new PacError(
      'El usuario y la contraseña HTTP Basic deben configurarse juntos (o ninguno).',
      'VALIDATION',
    );
  }

  const apiUser =
    input.apiUser !== undefined ? trimOrNull(input.apiUser) : existing?.apiUser || null;
  if (apiUser && apiUser.length > 150) {
    throw new PacError('El usuario de integración no puede superar 150 caracteres.', 'VALIDATION');
  }

  let apiPassword: string | null = existing?.apiPassword || null;
  if (input.clearApiPassword) apiPassword = null;
  else if (input.apiPassword !== undefined && String(input.apiPassword) !== '') {
    // Igual que la clave Basic: no se trimea, puede tener espacios a propósito.
    apiPassword = String(input.apiPassword);
  }
  if (isHka && Boolean(apiUser) !== Boolean(apiPassword)) {
    throw new PacError(
      'El usuario y la clave de integración de HKA deben configurarse juntos (o ninguno).',
      'VALIDATION',
    );
  }

  const enabled = input.enabled !== undefined ? toBoolean(input.enabled) : Boolean(existing?.enabled);
  if (enabled) {
    const missing = isHka
      ? [
          !apiUser && 'usuario de integración',
          !apiPassword && 'clave de integración',
          !branchCode && 'código de sucursal',
          environment === 'PRODUCCION' && !baseUrl && 'URL base de producción',
        ].filter(Boolean)
      : [
          !companyUuid && 'UUID del emisor',
          !pacApiKey && 'API key',
          !branchUuid && !branchCode && 'sucursal (UUID o código)',
        ].filter(Boolean);
    if (missing.length) {
      throw new PacError(
        `Para habilitar la emisión faltan: ${missing.join(', ')}.`,
        'VALIDATION',
      );
    }
  }

  const data = {
    provider,
    environment,
    companyUuid,
    pacApiKey,
    basicUser,
    pacBasicPassword,
    apiUser,
    apiPassword,
    baseUrl,
    branchUuid,
    branchCode,
    pos,
    enabled,
  };

  const row = await prisma.pacConfig.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  });
  return toPacConfigView(row);
}

function providerBaseUrl(
  provider: string,
  environment: PacEnvironment,
  override?: string | null,
): string {
  if (override) return override;
  switch (provider) {
    case FACTURA_FACIL:
      return FACTURA_FACIL_ENDPOINTS[environment];
    case HKA: {
      const url = HKA_ENDPOINTS[environment];
      if (!url) {
        throw new PacError(
          'HKA en PRODUCCION exige configurar la URL base que entregue el proveedor.',
          'CONFIG',
        );
      }
      return url;
    }
    default:
      throw new PacError(`El proveedor "${provider}" no define una URL base.`, 'CONFIG');
  }
}

/**
 * Resuelve la configuración que consume el adaptador. `requireEnabled: false`
 * sirve para PROBAR credenciales sin habilitar la emisión.
 *
 * Cada proveedor exige sus propias credenciales: Factura Fácil (UUID + API key)
 * y HKA (usuario + clave de integración). Los campos del otro proveedor se
 * ignoran.
 */
export function buildProviderConfig(
  row: any,
  opts: { requireEnabled?: boolean } = {},
): PacProviderConfig {
  if (!row) {
    throw new PacError('Esta empresa no tiene configurada la facturación electrónica.', 'CONFIG');
  }
  if (opts.requireEnabled !== false && !row.enabled) {
    throw new PacError('La emisión electrónica está deshabilitada para esta empresa.', 'CONFIG');
  }

  const provider = row.provider || FACTURA_FACIL;

  // Mismo fantasma que la contraseña IMAP: si el proceso usa el cliente Prisma
  // SIN la extensión, el valor llega cifrado (`v1:…`) y el proveedor lo rechaza.
  if (
    isEncrypted(row.pacApiKey) ||
    isEncrypted(row.pacBasicPassword) ||
    (provider === HKA && isEncrypted(row.apiPassword))
  ) {
    throw new PacError(
      'Las credenciales del PAC llegaron cifradas al adaptador: usá el cliente Prisma extendido (no el crudo).',
      'CONFIG',
    );
  }
  const environment = (row.environment as PacEnvironment) || 'PRUEBAS';
  const timeoutRaw = process.env.PAC_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 20_000;

  if (provider === HKA) {
    if (!row.apiUser) {
      throw new PacError('Falta el usuario de integración de HKA.', 'CONFIG');
    }
    if (!row.apiPassword) {
      throw new PacError('Falta la clave de integración de HKA.', 'CONFIG');
    }
    return {
      provider,
      baseUrl: providerBaseUrl(provider, environment, row.baseUrl),
      environment,
      companyUuid: row.companyUuid || '',
      apiKey: row.pacApiKey || '',
      apiUser: row.apiUser,
      apiPassword: row.apiPassword,
      branchCode: row.branchCode || undefined,
      pos: row.pos || '001',
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000,
    };
  }

  if (provider === FACTURA_FACIL) {
    if (!row.companyUuid) {
      throw new PacError('Falta el UUID del emisor en la configuración del PAC.', 'CONFIG');
    }
    if (!row.pacApiKey) {
      throw new PacError('Falta la API key del PAC.', 'CONFIG');
    }
    return {
      provider,
      baseUrl: providerBaseUrl(provider, environment, row.baseUrl),
      environment,
      companyUuid: row.companyUuid,
      apiKey: row.pacApiKey,
      basicUser: row.basicUser || undefined,
      basicPassword: row.pacBasicPassword || undefined,
      branchUuid: row.branchUuid || undefined,
      branchCode: row.branchCode || undefined,
      pos: row.pos || '001',
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000,
    };
  }

  throw new PacError(`Proveedor PAC no soportado: "${provider}".`, 'CONFIG');
}

/** Proveedor listo para emitir (o para probar, con requireEnabled: false). */
export async function getPacProviderForCompany(
  prisma: any,
  companyId: string,
  opts: { requireEnabled?: boolean } = {},
): Promise<PacProvider> {
  const row = await prisma.pacConfig.findUnique({ where: { companyId } });
  return createPacProvider(buildProviderConfig(row, opts));
}

/**
 * Prueba de credenciales SIN emitir. Cada adaptador decide su operación de solo
 * lectura (HKA: FoliosRestantes; Factura Fácil: consulta un CUFE inexistente).
 * Si un proveedor no implementa `testConnection`, se mantiene el fallback del
 * CUFE con formato válido pero inexistente.
 */
export async function probePacCredentials(provider: PacProvider): Promise<PacTestResult> {
  if (typeof provider.testConnection === 'function') {
    const result = await provider.testConnection();
    return { ok: result.ok, message: result.message, status: result.status };
  }

  const nonexistentCufe = 'FE' + '0'.repeat(64);
  try {
    await provider.find(nonexistentCufe);
    return { ok: true, message: 'El PAC respondió a la consulta: credenciales válidas.' };
  } catch (err) {
    if (err instanceof PacError && err.code === 'NOT_FOUND') {
      return {
        ok: true,
        message: 'Credenciales válidas: el PAC autenticó la consulta y no encontró el documento de prueba (esperado).',
      };
    }
    if (err instanceof PacError) {
      return { ok: false, message: err.message, status: err.status };
    }
    return { ok: false, message: (err as Error)?.message || 'Error desconocido al probar el PAC.' };
  }
}

/** Prueba la configuración guardada y deja el resultado en la ficha. */
export async function testPacConnection(prisma: any, companyId: string): Promise<PacTestResult> {
  const row = await prisma.pacConfig.findUnique({ where: { companyId } });
  if (!row) {
    throw new PacError('No hay configuración de PAC guardada para esta empresa.', 'CONFIG');
  }

  let result: PacTestResult;
  try {
    const provider = createPacProvider(buildProviderConfig(row, { requireEnabled: false }));
    result = await probePacCredentials(provider);
  } catch (err) {
    result = {
      ok: false,
      message:
        err instanceof PacError ? err.message : (err as Error)?.message || 'Error al probar el PAC.',
    };
  }

  await prisma.pacConfig.update({
    where: { companyId },
    data: {
      lastTestAt: new Date(),
      lastTestOk: result.ok,
      lastTestError: result.ok ? null : result.message.slice(0, 1000),
    },
  });

  return result;
}
