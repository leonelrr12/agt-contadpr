/**
 * Descarga de una factura de la DGI desde el enlace del CUTE (el del QR).
 *
 * El visor de la DGI no devuelve el PDF: devuelve una página con el XML OFICIAL
 * embebido en un input oculto, y el PDF se pide aparte por POST a
 * `Consultas/DescargarFacturaPDF`. Ese baile estaba duplicado —WhatsApp y
 * `/api/factura/extract-url`— y las dos copias ya habían divergido (User-Agent,
 * timeouts, qué se considera un error). Acá vive una sola vez.
 *
 * El servicio NO habla el idioma del usuario: lanza `DgiError` con un código, y
 * cada llamador traduce el código a su propio mensaje (los de WhatsApp empiezan
 * con ❌, los de la API son JSON). El XML viaja con el PDF porque es el
 * documento legal: lo que se archiva en «Facturas recibidas» es él, no el PDF.
 */

/** La DGI exige User-Agent de navegador; sin él devuelve una página distinta. */
export const DGI_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36';

export type DgiErrorCode =
  /** El QR decodificado llegó incompleto y la DGI rechaza el contenido. */
  | 'DGI_DETERIORADO'
  /** La respuesta no es un PDF (una página web, o un archivo de otro tipo). */
  | 'DGI_NO_PDF'
  /** El servidor respondió con error HTTP, o la red falló. */
  | 'DGI_HTTP'
  /** Se agotó el tiempo de espera. */
  | 'DGI_TIMEOUT'
  /** El visor venía sin el XML que hay que reenviarle para que entregue el PDF. */
  | 'DGI_QR_INVALIDO';

export class DgiError extends Error {
  readonly code: DgiErrorCode;
  /** Etapa que falló: el GET del enlace, o el POST que pide el PDF. */
  readonly etapa: 'GET' | 'POST';
  /** HTTP status cuando hubo respuesta (ausente si la red falló). */
  readonly status?: number;
  /** La respuesta era una página web, no un archivo. */
  readonly eraHtml: boolean;

  constructor(
    code: DgiErrorCode,
    message: string,
    extra: { etapa?: 'GET' | 'POST'; status?: number; eraHtml?: boolean } = {},
  ) {
    super(message);
    this.name = 'DgiError';
    this.code = code;
    this.etapa = extra.etapa || 'GET';
    this.status = extra.status;
    this.eraHtml = extra.eraHtml ?? false;
  }
}

export interface DescargaDgiOpts {
  /** ms por request. WhatsApp espera 60 s; `/api/factura/extract-url`, 30 s. */
  timeoutMs?: number;
  /** User-Agent del GET. `null` = sin la cabecera (como hacía `/extract-url`). */
  userAgent?: string | null;
}

export interface FacturaDgiDescargada {
  /** El PDF de la factura (pedido a la DGI si el enlace abrió el visor). */
  pdf: Buffer;
  /** El enlace del CUTE que se siguió. */
  dgiUrl: string;
  /** XML oficial embebido en el visor; null si el enlace ya era el PDF. */
  dgiXml: string | null;
}

/** El visor escapa el XML dentro del atributo `value`. */
function decodificarXml(valor: string): string {
  return valor
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Traduce el fallo de `fetch`/`AbortSignal.timeout` al código del servicio. */
function errorDeRed(err: any, etapa: 'GET' | 'POST'): DgiError {
  const timeout = err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR';
  return new DgiError(timeout ? 'DGI_TIMEOUT' : 'DGI_HTTP', err?.message || 'fallo de red', { etapa });
}

export async function descargarFacturaDgi(
  url: string,
  opts: DescargaDgiOpts = {},
): Promise<FacturaDgiDescargada> {
  const timeout = opts.timeoutMs ?? 60000;
  const headers: Record<string, string> = {};
  if (opts.userAgent !== null) headers['User-Agent'] = opts.userAgent || DGI_BROWSER_UA;

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  } catch (err: any) {
    throw errorDeRed(err, 'GET');
  }
  if (!response.ok) {
    throw new DgiError('DGI_HTTP', `HTTP ${response.status}`, { status: response.status });
  }

  let buffer = Buffer.from(await response.arrayBuffer());
  // El form con `facturaXML` aparece lejos del inicio del HTML (~byte 25k): por
  // eso el encabezado solo sirve para saber si es una página, y el XML se busca
  // sobre el HTML COMPLETO.
  const headStr = buffer.slice(0, 500).toString();
  const esHtml =
    headStr.includes('<!DOCTYPE') || headStr.includes('<html') || headStr.includes('facturaXML');
  let dgiXml: string | null = null;

  if (esHtml) {
    const html = buffer.toString();

    // El QR decodificado quedó truncado/deteriorado: la DGI rechaza el
    // contenido y no genera el form de descarga.
    if (html.includes('mal construido')) {
      throw new DgiError('DGI_DETERIORADO', 'La DGI rechaza el contenido del QR (incompleto)', {
        eraHtml: true,
      });
    }

    if (!html.includes('facturaXML') || !html.includes('DescargarFacturaPDF')) {
      throw new DgiError('DGI_NO_PDF', 'La URL abrió una página web, no un PDF', { eraHtml: true });
    }

    const match = html.match(/id="facturaXML"[^>]*value="([^"]*)"/);
    if (!match?.[1]) {
      throw new DgiError('DGI_QR_INVALIDO', 'El visor no trae el XML de la factura', {
        eraHtml: true,
      });
    }
    dgiXml = decodificarXml(match[1]);

    const baseUrl = new URL(url);
    let pdfRes: Response;
    try {
      pdfRes = await fetch(`${baseUrl.protocol}//${baseUrl.host}/Consultas/DescargarFacturaPDF`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: url, ...headers },
        body: `facturaXML=${encodeURIComponent(dgiXml)}`,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err: any) {
      throw errorDeRed(err, 'POST');
    }
    if (!pdfRes.ok) {
      throw new DgiError('DGI_HTTP', `HTTP ${pdfRes.status}`, {
        etapa: 'POST',
        status: pdfRes.status,
        eraHtml: true,
      });
    }
    buffer = Buffer.from(await pdfRes.arrayBuffer());
  }

  // Magic bytes %PDF (el header real es «%PDF-1.7»): no comparar los 5 bytes
  // exactos o ninguna factura de verdad pasa.
  if (!buffer.subarray(0, 5).toString().startsWith('%PDF')) {
    throw new DgiError('DGI_NO_PDF', 'El archivo descargado no es un PDF válido', { eraHtml: esHtml });
  }

  return { pdf: buffer, dgiUrl: url, dgiXml };
}
