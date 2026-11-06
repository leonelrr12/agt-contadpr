/**
 * Prueba de credenciales del PAC The Factory HKA SIN emitir documentos.
 *
 * Soporta los dos servicios del proveedor:
 *   - REST: POST /api/Autenticacion {usuario, clave} → JWT, y GET /api/FoliosRestantes.
 *   - SOAP: POST .../Service.svc con SOAPAction FoliosRestantes y tokens en el body.
 *
 * En ambos casos la operación es de solo lectura: no emite, no anula y no
 * consume folios. Devuelve los folios disponibles si las credenciales son
 * válidas; si no, el código/mensaje del rechazo.
 *
 * Uso (desde la raíz del repo):
 *   HKA_TOKEN_EMPRESA=... HKA_TOKEN_PASSWORD=... npx tsx scripts/hka-probe.ts
 *   npx tsx scripts/hka-probe.ts --url=https://demoemision.thefactoryhka.com.pa/ws/obj/v1.0/Service.svc
 *   npx tsx scripts/hka-probe.ts --mode=soap
 *
 * Variables: HKA_TOKEN_EMPRESA, HKA_TOKEN_PASSWORD, HKA_URL, HKA_TIMEOUT_MS.
 * Se leen del entorno, del `.env` de la raíz o de `apps/api/.env` (gitignored).
 * Los argumentos mandan sobre el entorno. Los tokens NUNCA se imprimen.
 *
 * Códigos de salida: 0 = credenciales válidas · 1 = credenciales inválidas ·
 * 2 = red/HTTP/respuesta no reconocida.
 */

import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REST_URL = 'https://demointegracion.thefactoryhka.com.pa/api';
const DEFAULT_TIMEOUT_MS = 20_000;

type Mode = 'rest' | 'soap';

interface Options {
  url: string;
  tokenEmpresa: string;
  tokenPassword: string;
  timeoutMs: number;
  raw: boolean;
  mode?: Mode;
}

/** Carga KEY=VALUE sin sobreescribir lo que ya viene en el entorno. */
function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function parseArgs(argv: string[]): Partial<Options> & { help?: boolean } {
  const out: Partial<Options> & { help?: boolean } = {};
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--raw') out.raw = true;
    else if (arg.startsWith('--url=')) out.url = arg.slice(6).trim();
    else if (arg.startsWith('--token-empresa=')) out.tokenEmpresa = arg.slice(16);
    else if (arg.startsWith('--token-password=')) out.tokenPassword = arg.slice(17);
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice(13));
    else if (arg.startsWith('--mode=')) {
      const mode = arg.slice(7).trim().toLowerCase();
      if (mode === 'rest' || mode === 'soap') out.mode = mode;
    }
  }
  return out;
}

function help(): void {
  console.log(
    [
      'Uso: npx tsx scripts/hka-probe.ts [opciones]',
      '',
      '  --token-empresa=...   Usuario/token de integración (o HKA_TOKEN_EMPRESA en .env)',
      '  --token-password=...  Clave/token password (o HKA_TOKEN_PASSWORD en .env)',
      '  --url=...             Endpoint REST (/api) o SOAP (.svc) (o HKA_URL)',
      '  --mode=rest|soap      Fuerza el protocolo (por defecto se detecta por la URL)',
      '  --timeout-ms=20000    Timeout de cada request',
      '  --raw                 Muestra la respuesta (el token JWT se redacta)',
      '',
      `REST por defecto: ${DEFAULT_REST_URL}`,
      'SOAP demo: https://demoemision.thefactoryhka.com.pa/ws/obj/v1.0/Service.svc',
      'Prueba de solo lectura: NO emite ni anula documentos.',
    ].join('\n'),
  );
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(xml: string, name: string): string | undefined {
  const re = new RegExp(
    `<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`,
    'i',
  );
  const m = xml.match(re);
  if (!m) return undefined;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function visibleToken(token: string): string {
  if (token.length <= 8) return '***';
  return `${token.slice(0, 3)}…${token.slice(-2)}`;
}

function header(label: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  console.log(`   ${label.padEnd(16)} ${value}`);
}

function fail(message: string, code: number): never {
  console.error(`❌ ${message}`);
  process.exit(code);
}

function resolveMode(url: string, explicit?: Mode): Mode {
  if (explicit) return explicit;
  return /\/ws\/|\.svc(\?|$)/i.test(url) ? 'soap' : 'rest';
}

function redactJson(text: string): string {
  return text.replace(/("token"\s*:\s*")[^"]+(")/gi, '$1***$2');
}

async function probeRest(url: string, opts: Options): Promise<void> {
  const base = url.replace(/\/+$/, '');
  const authUrl = `${base}/Autenticacion`;
  const title = 'HKA REST — prueba de credenciales (solo lectura)';
  console.log(title);
  header('Endpoint', authUrl);
  header('Usuario', visibleToken(opts.tokenEmpresa));

  let authRes: Response;
  try {
    authRes = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: opts.tokenEmpresa, clave: opts.tokenPassword }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    fail(timedOut ? `Timeout tras ${opts.timeoutMs} ms.` : `Error de red: ${e.message}`, 2);
  }

  const authText = await authRes.text();
  console.log(`   ${'HTTP'.padEnd(16)} ${authRes.status}`);

  let auth: Record<string, unknown>;
  try {
    auth = JSON.parse(authText);
  } catch {
    console.error(`\n❌ Respuesta de autenticación no es JSON (${authText.length} bytes).`);
    if (opts.raw) console.error(redactJson(authText).slice(0, 2000));
    process.exit(2);
  }

  header('Código', String(auth.codigo ?? ''));
  header('Mensaje', String(auth.mensaje ?? ''));
  header('Expiración', String(auth.expiracion ?? ''));
  if (opts.raw) console.log(`\n--- Autenticación (token redactado) ---\n${redactJson(JSON.stringify(auth, null, 2))}`);

  const token = typeof auth.token === 'string' ? auth.token : '';
  if (!token) {
    console.error('\n❌ Credenciales inválidas: el servicio no devolvió un JWT.');
    process.exit(1);
  }

  const foliosUrl = `${base}/FoliosRestantes`;
  let foliosRes: Response;
  try {
    foliosRes = await fetch(foliosUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    fail(timedOut ? `Timeout tras ${opts.timeoutMs} ms.` : `Error de red: ${e.message}`, 2);
  }

  const foliosText = await foliosRes.text();
  console.log(`   ${'Folios HTTP'.padEnd(16)} ${foliosRes.status}`);

  let folios: Record<string, unknown>;
  try {
    folios = JSON.parse(foliosText);
  } catch {
    console.error(`\n❌ Respuesta de folios no es JSON (${foliosText.length} bytes).`);
    if (opts.raw) console.error(foliosText.slice(0, 2000));
    process.exit(2);
  }

  header('Resultado', String(folios.resultado ?? ''));
  header('Código folios', String(folios.codigo ?? ''));
  header('Mensaje folios', String(folios.mensaje ?? ''));
  header('Licencia', String(folios.licencia ?? ''));
  header('Vigencia', String(folios.fechaLicencia ?? ''));
  header('Ciclo', String(folios.fechaCiclo ?? ''));
  header('Folios ciclo', `${folios.foliosDisponibleCiclo ?? '?'} / ${folios.foliosTotalesCiclo ?? '?'}`);
  header('Folios totales', String(folios.foliosTotalesDisponibles ?? folios.foliosTotales ?? ''));
  if (opts.raw) console.log(`\n--- Folios ---\n${JSON.stringify(folios, null, 2)}`);

  if (String(folios.codigo) === '200' || /^(procesado|ok|success|exito|éxito)$/i.test(String(folios.resultado))) {
    console.log('\n✅ Credenciales válidas');
    return;
  }

  console.error(`\n❌ Credenciales inválidas: ${folios.mensaje || 'el servicio rechazó la consulta'}`);
  process.exit(1);
}

function buildSoapEnvelope(tokenEmpresa: string, tokenPassword: string): string {
  return [
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">',
    '  <soapenv:Header/>',
    '  <soapenv:Body>',
    '    <tem:FoliosRestantes>',
    `      <tem:tokenEmpresa>${escapeXml(tokenEmpresa)}</tem:tokenEmpresa>`,
    `      <tem:tokenPassword>${escapeXml(tokenPassword)}</tem:tokenPassword>`,
    '    </tem:FoliosRestantes>',
    '  </soapenv:Body>',
    '</soapenv:Envelope>',
  ].join('\n');
}

async function probeSoap(url: string, opts: Options): Promise<void> {
  console.log('HKA SOAP — prueba de credenciales (solo lectura)');
  header('Endpoint', url);
  header('Token empresa', visibleToken(opts.tokenEmpresa));

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '"http://tempuri.org/IService/FoliosRestantes"',
      },
      body: buildSoapEnvelope(opts.tokenEmpresa, opts.tokenPassword),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
    fail(timedOut ? `Timeout tras ${opts.timeoutMs} ms.` : `Error de red: ${e.message}`, 2);
  }

  const body = await res.text();
  console.log(`   ${'HTTP'.padEnd(16)} ${res.status}`);

  if (res.status !== 200) {
    console.error(`\n❌ HTTP ${res.status}. Respuesta:`);
    console.error(body.slice(0, 2000));
    process.exit(2);
  }

  const fault = /<(?:[\w.-]+:)?Fault[\s>]/i.test(body);
  const faultString = tag(body, 'faultstring') || tag(body, 'Text');
  const resultado = tag(body, 'resultado');
  const codigo = tag(body, 'codigo');
  const mensaje = tag(body, 'mensaje');
  const foliosDisponibles = tag(body, 'foliosDisponibles');
  const foliosTotales = tag(body, 'foliosTotales');
  const disponibleCiclo = tag(body, 'foliosDisponibleCiclo');

  header('Resultado', resultado);
  header('Código', codigo);
  header('Mensaje', mensaje);
  header('Folios', foliosDisponibles);
  header('Folios totales', foliosTotales);
  header('Ciclo', disponibleCiclo ? `${disponibleCiclo} disponibles` : undefined);

  if (opts.raw) console.log(`\n--- Respuesta SOAP ---\n${body}`);

  if (fault) {
    console.error(`\n❌ SOAP Fault${faultString ? `: ${faultString}` : ''}`);
    process.exit(2);
  }

  if (/^(ok|success|exito|éxito)$/i.test(resultado || '')) {
    const detalle = foliosDisponibles ? ` — folios disponibles: ${foliosDisponibles}` : '';
    console.log(`\n✅ Credenciales válidas${detalle}`);
    return;
  }

  if (/error/i.test(resultado || '') || codigo === '101') {
    console.error(`\n❌ Credenciales inválidas: ${mensaje || 'el PAC rechazó los tokens'}`);
    process.exit(1);
  }

  console.error('\n⚠️ Respuesta no reconocida. Revisá el cuerpo completo con --raw.');
  process.exit(2);
}

async function main(): Promise<void> {
  loadEnvFile(path.join(ROOT, '.env'));
  loadEnvFile(path.join(ROOT, 'apps/api/.env'));

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    help();
    return;
  }

  const url = args.url || process.env.HKA_URL || DEFAULT_REST_URL;
  const tokenEmpresa = args.tokenEmpresa ?? process.env.HKA_TOKEN_EMPRESA ?? '';
  const tokenPassword = args.tokenPassword ?? process.env.HKA_TOKEN_PASSWORD ?? '';
  const timeoutMs = args.timeoutMs || Number(process.env.HKA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  if (!tokenEmpresa || !tokenPassword) {
    fail(
      'Faltan credenciales. Pasá --token-empresa/--token-password o HKA_TOKEN_EMPRESA/HKA_TOKEN_PASSWORD.',
      2,
    );
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    fail('Timeout inválido en --timeout-ms.', 2);
  }

  const opts: Options = {
    url,
    tokenEmpresa,
    tokenPassword,
    timeoutMs,
    raw: Boolean(args.raw),
    mode: args.mode,
  };

  if (resolveMode(url, args.mode) === 'soap') await probeSoap(url, opts);
  else await probeRest(url, opts);
}

main().catch((err) => {
  console.error('❌ Error inesperado:', (err as Error)?.message || err);
  process.exit(2);
});
