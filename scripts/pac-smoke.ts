/**
 * Smoke de emisión electrónica contra el ambiente de PRUEBAS de un PAC.
 *
 * Emite una factura mínima a consumidor final ($10.00 + ITBMS 7%), verifica que
 * la consulta por CUFE devuelva el documento y, opcionalmente, descarga el XML
 * y el CAFE. NO toca la base de datos ni crea asientos: valida el contrato
 * neutral (`PacProvider`) y las credenciales del proveedor.
 *
 * Uso (desde la raíz del repo):
 *   npx tsx scripts/pac-smoke.ts
 *   npx tsx scripts/pac-smoke.ts --download
 *   npx tsx scripts/pac-smoke.ts --dry-run
 *   npx tsx scripts/pac-smoke.ts --fiscal-number=123 --allow-prod
 *
 * Configuración: variables PAC_* en `.env` de la raíz (o en apps/api/.env).
 * Ver .env.example. Sin PAC_COMPANY_UUID ni PAC_API_KEY el script se detiene.
 *
 * Códigos de salida: 0 = autorizado y verificado · 1 = configuración o rechazo
 * de la DGI · 2 = error de red/HTTP/inesperado.
 *
 * Seguridad: si PAC_ENVIRONMENT=PRODUCCION exige --allow-prod y se niega a
 * correr en PRUEBAS contra el host de producción de Factura Fácil.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createPacProvider, loadPacConfigFromEnv, PacError, FacturaFacilProvider } from '../apps/api/src/services/pac';
import type { PacDocumentStatus, PacInvoiceRequest } from '../apps/api/src/services/pac';

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue; // el entorno manda
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

function fatal(message: string, code = 1): never {
  console.error(`❌ ${message}`);
  process.exit(code);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round2 = (n: number) => Math.round(n * 100) / 100;

function line(label: string, value: string | undefined): void {
  if (value) console.log(`   ${label.padEnd(14)} ${value}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(
      [
        'Uso: npx tsx scripts/pac-smoke.ts [opciones]',
        '',
        '  --download            Descarga XML y CAFE a un directorio temporal',
        '  --dry-run             Muestra el payload del proveedor sin enviarlo',
        '  --fiscal-number=N     Número fiscal a usar (0 = secuencia interna del PAC)',
        '  --allow-prod          Permite emitir contra PRODUCCION (por defecto solo QA)',
        '',
        'Variables: PAC_PROVIDER, PAC_ENVIRONMENT, PAC_BASE_URL, PAC_COMPANY_UUID,',
        'PAC_API_KEY, PAC_BASIC_USER, PAC_BASIC_PASSWORD, PAC_BRANCH_UUID,',
        'PAC_BRANCH_CODE, PAC_POS, PAC_TIMEOUT_MS.',
      ].join('\n'),
    );
    return;
  }

  loadEnvFile(path.join(ROOT, '.env'));
  loadEnvFile(path.join(ROOT, 'apps', 'api', '.env'));

  const allowProd = process.argv.includes('--allow-prod');
  const wantsDownload = process.argv.includes('--download');
  const dryRun = process.argv.includes('--dry-run');
  const fiscalArg = process.argv.find((a) => a.startsWith('--fiscal-number='));
  const fiscalNumber = fiscalArg ? Number(fiscalArg.slice('--fiscal-number='.length)) : 0;
  if (!Number.isInteger(fiscalNumber) || fiscalNumber < 0 || fiscalNumber > 9_999_999_999) {
    fatal('--fiscal-number debe ser un entero entre 0 y 9,999,999,999.');
  }

  const config = loadPacConfigFromEnv();

  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    fatal(`PAC_BASE_URL no es una URL válida: ${config.baseUrl}`);
  }

  if (config.environment === 'PRODUCCION' && !allowProd) {
    fatal(
      'PAC_ENVIRONMENT=PRODUCCION. Este smoke emite un documento real; si es lo que querés, repetí con --allow-prod.',
    );
  }
  if (config.environment === 'PRUEBAS' && host === 'api.facturafacil.com.pa') {
    fatal(
      `PAC_ENVIRONMENT=PRUEBAS apunta al host de producción (${host}). Corregí PAC_BASE_URL o usá PAC_ENVIRONMENT=PRODUCCION.`,
    );
  }

  const provider = createPacProvider(config);

  const itemPrice = 10;
  const itbms = round2(itemPrice * 0.07);
  const total = round2(itemPrice + itbms);
  const controlId = `AGT-SMOKE-${Date.now()}`;

  const request: PacInvoiceRequest = {
    controlId,
    documentKind: 'FACTURA',
    fiscalNumber,
    receptor: { type: 'CONSUMIDOR_FINAL', name: 'CONSUMIDOR FINAL' },
    items: [
      {
        line: 1,
        description: 'PRUEBA DE EMISION ELECTRONICA - AGT CONTADOR',
        quantity: 1,
        unitPrice: itemPrice,
        taxes: [{ kind: 'ITBMS', code: 'ITBMS_7', amount: itbms }],
      },
    ],
    payments: [{ type: 'EFECTIVO', amount: total }],
    paymentTerm: 'CONTADO',
    total,
    info: 'Documento de prueba emitido por el smoke script de agt-contador.',
  };

  console.log(`\n🧾 PAC smoke · ${provider.id}`);
  line('Ambiente:', config.environment);
  line('Host:', config.baseUrl);
  line('Emisor:', config.companyUuid);
  line('POS:', config.pos ?? '001');
  line(
    'Sucursal:',
    config.branchUuid
      ? `UUID ${config.branchUuid}`
      : config.branchCode
        ? `código ${config.branchCode}`
        : '⚠️  sin configurar',
  );
  line('controlId:', controlId);
  line('Nº fiscal:', fiscalNumber === 0 ? '0 (secuencia interna del PAC)' : String(fiscalNumber));

  if (dryRun) {
    if (!(provider instanceof FacturaFacilProvider)) {
      fatal(`Dry-run no implementado para el proveedor ${provider.id}.`);
    }
    console.log('\n🧪 Dry-run: payload que se enviaría (no se hace ninguna llamada):\n');
    console.log(JSON.stringify(provider.preview(request), null, 2));
    return;
  }

  console.log(`\nEmitiendo factura de prueba: $${itemPrice.toFixed(2)} + ITBMS $${itbms.toFixed(2)} = $${total.toFixed(2)} …\n`);

  let result;
  try {
    result = await provider.issue(request);
  } catch (err) {
    if (err instanceof PacError) {
      console.error(`❌ ${err.code}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`);
      process.exit(err.code === 'CONFIG' ? 1 : 2);
    }
    throw err;
  }

  if (result.rejected) {
    console.error(`❌ La DGI rechazó el documento${result.cufe ? ` (CUFE ${result.cufe})` : ''}.`);
    if (result.messages.length) {
      for (const m of result.messages) {
        console.error(`   ${m.code ?? '-'} ${m.message}${m.path ? ` @ ${m.path}` : ''}`);
      }
    } else {
      console.error('   El PAC no devolvió mensajes de rechazo.');
    }
    process.exit(1);
  }

  console.log('✅ Documento autorizado');
  line('CUFE:', result.cufe);
  line('Nº documento:', result.documentNumber);
  line('Autorización:', result.authorizationNumber);
  line('Procesado:', result.processDate);
  line('UUID:', result.documentUuid);
  line('PDF:', result.pdfUrl);
  if (result.qrCodeData) {
    line('QR:', result.qrCodeData.length > 90 ? `${result.qrCodeData.slice(0, 90)}…` : result.qrCodeData);
  }
  if (result.duplicated) {
    console.log('ℹ️  El PAC respondió "duplicado": el controlId ya existía y devolvió el documento previo.');
  }

  // Verificación del camino de idempotencia/consulta: CUFE → estado.
  let documentUuid = result.documentUuid;
  if (result.cufe) {
    let status: PacDocumentStatus | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        status = await provider.find(result.cufe);
        break;
      } catch (err) {
        const notFound = err instanceof PacError && err.code === 'NOT_FOUND';
        if (notFound && attempt === 1) {
          await sleep(2000); // el índice del PAC puede tardar unos segundos
          continue;
        }
        throw err;
      }
    }
    if (status) {
      console.log('\n🔎 Consulta por CUFE OK');
      line('Estado:', status.statusDisplay ?? (status.status != null ? String(status.status) : '—'));
      line('UUID:', status.id);
      documentUuid = documentUuid ?? status.id;
    }
  } else {
    console.log('\n⚠️  El PAC no devolvió CUFE; se omite la consulta por CUFE.');
  }

  if (wantsDownload) {
    if (!documentUuid || !result.cufe) {
      console.log('\n⚠️  Sin UUID/CUFE no se pueden descargar XML ni CAFE.');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pac-smoke-'));
      const xmlPath = path.join(dir, `${result.cufe}.xml`);
      const cafePath = path.join(dir, `${result.cufe}.pdf`);
      fs.writeFileSync(xmlPath, await provider.downloadXml(documentUuid, result.cufe));
      fs.writeFileSync(cafePath, await provider.downloadCafe(documentUuid, result.cufe));
      console.log('\n📥 Descargas OK');
      line('XML:', xmlPath);
      line('CAFE:', cafePath);
    }
  }

  console.log('\n✅ Smoke OK: emisión y consulta verificadas.\n');
}

main().catch((err) => {
  if (err instanceof PacError) {
    console.error(`\n❌ ${err.code}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`);
    if (err.messages.length) {
      for (const m of err.messages) {
        console.error(`   ${m.code ?? '-'} ${m.message}${m.path ? ` @ ${m.path}` : ''}`);
      }
    }
    process.exit(err.code === 'CONFIG' ? 1 : 2);
  }
  console.error('\n❌ Error inesperado:', err);
  process.exit(2);
});
