/**
 * Configuración del PAC desde variables de entorno (PAC_*).
 *
 * La usa el smoke script y cualquier herramienta operativa. En la app, la
 * configuración saldrá de la empresa (BD): este loader es solo para procesos
 * que corren fuera de una request (scripts, jobs).
 */
import { PacError } from './types';
import type { PacEnvironment, PacProviderConfig } from './types';

const FACTURA_FACIL_QA = 'https://backend-qa-api.facturafacil.com.pa';

export function loadPacConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PacProviderConfig {
  const provider = (env.PAC_PROVIDER ?? 'FACTURA_FACIL').trim().toUpperCase();

  const environment = (env.PAC_ENVIRONMENT ?? 'PRUEBAS').trim().toUpperCase() as PacEnvironment;
  if (environment !== 'PRUEBAS' && environment !== 'PRODUCCION') {
    throw new PacError('PAC_ENVIRONMENT debe ser PRUEBAS o PRODUCCION.', 'CONFIG');
  }

  const baseUrl =
    env.PAC_BASE_URL?.trim() || (provider === 'FACTURA_FACIL' ? FACTURA_FACIL_QA : '');

  const companyUuid = env.PAC_COMPANY_UUID?.trim() ?? '';
  const apiKey = env.PAC_API_KEY?.trim() ?? '';

  const missing = [
    !baseUrl && 'PAC_BASE_URL',
    !companyUuid && 'PAC_COMPANY_UUID',
    !apiKey && 'PAC_API_KEY',
  ].filter((v): v is string => Boolean(v));
  if (missing.length) {
    throw new PacError(
      `Faltan variables de entorno del PAC: ${missing.join(', ')}. Ver .env.example.`,
      'CONFIG',
    );
  }

  const basicUser = env.PAC_BASIC_USER?.trim() || undefined;
  const basicPassword = env.PAC_BASIC_PASSWORD || undefined;
  if (Boolean(basicUser) !== Boolean(basicPassword)) {
    throw new PacError(
      'PAC_BASIC_USER y PAC_BASIC_PASSWORD deben configurarse juntas (autenticación HTTP Basic).',
      'CONFIG',
    );
  }

  const timeoutRaw = env.PAC_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PacError('PAC_TIMEOUT_MS debe ser un número positivo de milisegundos.', 'CONFIG');
  }

  const pos = env.PAC_POS?.trim() || '001';
  if (!/^\d{3}$/.test(pos)) {
    throw new PacError('PAC_POS debe tener exactamente 3 dígitos (ej.: 001).', 'CONFIG');
  }

  const branchCode = env.PAC_BRANCH_CODE?.trim() || undefined;
  if (branchCode && branchCode.length !== 4) {
    throw new PacError('PAC_BRANCH_CODE debe tener exactamente 4 caracteres.', 'CONFIG');
  }

  return {
    provider,
    baseUrl,
    environment,
    companyUuid,
    apiKey,
    basicUser,
    basicPassword,
    branchUuid: env.PAC_BRANCH_UUID?.trim() || undefined,
    branchCode,
    pos,
    timeoutMs,
  };
}
