/**
 * Configuración del PAC POR EMPRESA (tabla `pac_config`).
 *
 * La fila es la fuente de verdad; el adaptador recibe un `PacProviderConfig` ya
 * resuelto. Las credenciales se descifran al leerlas con el cliente Prisma
 * extendido (services/crypto-fields.ts) y NUNCA salen por la API: la vista solo
 * informa si están cargadas.
 *
 * Regla de habilitación: para emitir hacen falta UUID del emisor, API key y
 * sucursal (UUID o código). La ficha se puede guardar incompleta para cargar los
 * datos antes de que el proveedor entregue los accesos.
 */
import { PacError } from './types';
import type { PacEnvironment, PacProvider, PacProviderConfig } from './types';
import { createPacProvider } from './index';
import { FACTURA_FACIL, FACTURA_FACIL_ENDPOINTS } from './facturafacil';
import { isEncrypted } from '../crypto-fields';

const PROVIDERS = [FACTURA_FACIL];
const ENVIRONMENTS: PacEnvironment[] = ['PRUEBAS', 'PRODUCCION'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  branchUuid?: string | null;
  branchCode?: string | null;
  pos?: string;
  enabled?: boolean;
}

export interface PacConfigView {
  configured: boolean;
  provider: string;
  environment: PacEnvironment;
  companyUuid: string;
  pos: string;
  branchUuid: string;
  branchCode: string;
  basicUser: string;
  enabled: boolean;
  apiKeySet: boolean;
  basicPasswordSet: boolean;
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
    provider: FACTURA_FACIL,
    environment: 'PRUEBAS',
    companyUuid: '',
    pos: '001',
    branchUuid: '',
    branchCode: '',
    basicUser: '',
    enabled: false,
    apiKeySet: false,
    basicPasswordSet: false,
    lastTestAt: null,
    lastTestOk: null,
    lastTestError: null,
  };
}

/** Vista segura: sin secretos, solo el booleano de "está cargado". */
export function toPacConfigView(row: any): PacConfigView {
  return {
    configured: true,
    provider: row.provider || FACTURA_FACIL,
    environment: (row.environment as PacEnvironment) || 'PRUEBAS',
    companyUuid: row.companyUuid || '',
    pos: row.pos || '001',
    branchUuid: row.branchUuid || '',
    branchCode: row.branchCode || '',
    basicUser: row.basicUser || '',
    enabled: Boolean(row.enabled),
    apiKeySet: Boolean(row.pacApiKey),
    basicPasswordSet: Boolean(row.pacBasicPassword),
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
  if (Boolean(basicUser) !== Boolean(pacBasicPassword)) {
    throw new PacError(
      'El usuario y la contraseña HTTP Basic deben configurarse juntos (o ninguno).',
      'VALIDATION',
    );
  }

  const enabled = input.enabled !== undefined ? toBoolean(input.enabled) : Boolean(existing?.enabled);
  if (enabled) {
    const missing = [
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

function providerBaseUrl(provider: string, environment: PacEnvironment): string {
  switch (provider) {
    case FACTURA_FACIL:
      return FACTURA_FACIL_ENDPOINTS[environment];
    default:
      throw new PacError(`El proveedor "${provider}" no define una URL base.`, 'CONFIG');
  }
}

/**
 * Resuelve la configuración que consume el adaptador. `requireEnabled: false`
 * sirve para PROBAR credenciales sin habilitar la emisión.
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
  if (!row.companyUuid) {
    throw new PacError('Falta el UUID del emisor en la configuración del PAC.', 'CONFIG');
  }
  if (!row.pacApiKey) {
    throw new PacError('Falta la API key del PAC.', 'CONFIG');
  }
  // Mismo fantasma que la contraseña IMAP: si el proceso usa el cliente Prisma
  // SIN la extensión, el valor llega cifrado (`v1:…`) y el proveedor lo rechaza.
  if (isEncrypted(row.pacApiKey) || isEncrypted(row.pacBasicPassword)) {
    throw new PacError(
      'Las credenciales del PAC llegaron cifradas al adaptador: usá el cliente Prisma extendido (no el crudo).',
      'CONFIG',
    );
  }

  const environment = (row.environment as PacEnvironment) || 'PRUEBAS';
  const timeoutRaw = process.env.PAC_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 20_000;

  return {
    provider: row.provider || FACTURA_FACIL,
    baseUrl: providerBaseUrl(row.provider || FACTURA_FACIL, environment),
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
 * Prueba de credenciales SIN emitir: consulta un CUFE con formato válido pero
 * inexistente. Un 404/NO_FOUND prueba que la autenticación y la compañía son
 * correctas; 401/403 o un error de red, no.
 */
export async function probePacCredentials(provider: PacProvider): Promise<PacTestResult> {
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
