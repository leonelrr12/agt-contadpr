/**
 * Detección: ¿qué facturas trae este correo?
 *
 * Un correo puede traer 0, 1 o N facturas, y traerlas de tres maneras distintas:
 *
 *  1. **PDF adjunto** — el camino principal: es el documento que la DGI emite y
 *     el único que trae los items (que es lo que después clasifica el concepto).
 *  2. **XML adjunto** — el archivo de la factura electrónica, XML de verdad.
 *  3. **Enlace del CUTE en el cuerpo** — el proveedor manda el link del QR; de
 *     ahí sale el PDF y, de paso, el blob que la DGI acepta de vuelta.
 *
 * El orden importa: el PDF manda sobre el XML del mismo proveedor (trae items y
 * es lo que el contador ve), y por eso se procesan primero.
 *
 * Acá NO se crea nada: el módulo devuelve lo que encontró y quien llama decide
 * (el barrido lo anota en el ledger; el pipeline —fase siguiente— crea el asiento).
 */

import { extractFromPDF, extractFromText, extractInvoiceItems } from './pdf-extractor';
import { xmlATexto, pareceXmlDeFactura, receptorDeXml, itemsDeXml, emisorDeXml } from './dgi-xml';
import { descargarFacturaDgi } from './dgi-cute';
import { normalizarRuc, type FacturaExtraida } from './reembolsos';

/** Tope de facturas por correo: un buzón con 40 adjuntos no es una carga normal. */
export const MAX_FACTURAS_POR_CORREO = 5;

export interface AdjuntoMensaje {
  filename?: string | null;
  contentType?: string | null;
  content: Buffer;
}

export interface MensajeFactura {
  text?: string | null;
  html?: string | null;
  adjuntos: AdjuntoMensaje[];
}

export interface FacturaDetectada {
  via: 'PDF' | 'XML' | 'CUTE';
  /** De dónde salió: el nombre del adjunto, o el enlace del cuerpo. */
  origen: string;
  /** Lo que consumen `buildDedupeKey` y el pipeline. */
  factura: FacturaExtraida;
  /** Texto del documento (recortado): lo mira la clasificación y el LLM. */
  texto: string;
  items: string[];
  /** El receptor: con esto se descarta la factura de otro cliente. */
  clienteRuc: string | null;
  clienteNombre: string | null;
}

export type MotivoSinFactura = 'SIN_ADJUNTOS' | 'SIN_FACTURA' | 'SIN_DATOS';

export interface DeteccionMensaje {
  facturas: FacturaDetectada[];
  /** Por qué no hay facturas (el estado que va al ledger). Null si hay alguna. */
  motivo: MotivoSinFactura | null;
  /** Enlaces del CUTE vistos en el cuerpo, aunque no se hayan podido usar. */
  enlaces: string[];
}

/** Enlaces del CUTE (el QR de la DGI) dentro de un texto. */
export function enlacesCute(texto: string): string[] {
  const urls = String(texto || '').match(/https?:\/\/[^\s"'<>]*dgi-fep\.mef\.gob\.pa\/[^\s"'<>]*/gi) || [];
  // En el HTML el `&` de la query viaja como `&amp;`: sin desescaparlo, la URL
  // baja al visor con parámetros rotos y la DGI responde otra página.
  return [...new Set(urls.map((u) => u.replace(/&amp;/g, '&').replace(/[.,;)]+$/, '')))];
}

const esPdf = (a: AdjuntoMensaje) =>
  /pdf/i.test(a.contentType || '') || /\.pdf$/i.test(a.filename || '');
const esXml = (a: AdjuntoMensaje) =>
  /xml/i.test(a.contentType || '') || /\.xml$/i.test(a.filename || '');

/** Una factura sin total o sin proveedor no es una factura: es un adjunto. */
function esFactura(f: FacturaExtraida): boolean {
  return !!(f.total || f.proveedor);
}

async function facturaDePdf(prisma: any, buffer: Buffer): Promise<Omit<FacturaDetectada, 'via' | 'origen' | 'factura'> & { factura: FacturaExtraida; vacio: boolean }> {
  const r = await extractFromPDF(buffer, prisma);
  return {
    texto: r.text,
    items: extractInvoiceItems(r.text),
    clienteRuc: r.clientRuc,
    clienteNombre: r.clientName,
    vacio: !r.text.trim(),
    factura: {
      proveedor: r.provider,
      ruc: r.ruc,
      dv: r.providerDv,
      phone: r.providerPhone,
      email: r.providerEmail,
      address: r.providerAddress,
      location: r.providerLocation,
      fiscalSource: 'PDF',
      numeroFactura: r.invoiceNumber,
      fecha: r.date,
      total: r.total,
      itbms: r.itbms,
    },
  };
}

/**
 * Extrae las facturas de un mensaje ya parseado (texto + adjuntos).
 *
 * Nunca lanza por un adjunto ilegible: un PDF que no se puede leer es un motivo
 * más (`SIN_DATOS`), no una excepción que tumbe la corrida entera.
 */
export async function extraerFacturasDeMensaje(
  prisma: any,
  msg: MensajeFactura,
): Promise<DeteccionMensaje> {
  const adjuntos = msg.adjuntos || [];
  const cuerpo = `${msg.text || ''}\n${msg.html || ''}`;
  const enlaces = enlacesCute(cuerpo);
  const facturas: FacturaDetectada[] = [];
  let huboDocumento = false;
  let huboTexto = false;

  // El PDF y el XML del mismo comprobante son la MISMA factura en dos formatos:
  // el proveedor manda los dos y contarlos dos veces llenaría el ledger de
  // duplicados (y en la fase siguiente, de asientos que alguien tiene que anular).
  const vistas = new Set<string>();
  const clave = (f: FacturaExtraida): string | null => {
    // El RUC se compara sin el dígito verificador: el PDF lo imprime sin DV y
    // el XML lo trae completo (`...-50`). Sin normalizarlo, el PDF y el XML de
    // la misma factura no se reconocen y ambos pasan al pipeline.
    const ruc = normalizarRuc(f.ruc);
    const numero = (f.numeroFactura || '').replace(/\D/g, '');
    return ruc && numero ? `${ruc}|${numero}` : null;
  };

  const agregar = (f: FacturaDetectada) => {
    if (facturas.length >= MAX_FACTURAS_POR_CORREO || !esFactura(f.factura)) return;
    const k = clave(f.factura);
    if (k && vistas.has(k)) return;
    if (k) vistas.add(k);
    facturas.push(f);
  };

  // 1) PDFs
  for (const a of adjuntos.filter(esPdf)) {
    huboDocumento = true;
    try {
      const d = await facturaDePdf(prisma, a.content);
      if (d.vacio) continue;
      huboTexto = true;
      agregar({ via: 'PDF', origen: a.filename || 'adjunto.pdf', ...d, factura: d.factura });
    } catch (err: any) {
      console.error('[EmailFacturas] PDF ilegible:', a.filename, err?.message);
    }
  }

  // 2) XMLs (solo si el PDF no alcanzó el tope)
  if (facturas.length < MAX_FACTURAS_POR_CORREO) {
    for (const a of adjuntos.filter(esXml)) {
      huboDocumento = true;
      const xml = a.content.toString('utf8');
      if (!pareceXmlDeFactura(xml)) continue;
      const texto = xmlATexto(xml);
      if (!texto.trim()) continue;
      huboTexto = true;
      const r = await extractFromText(texto, prisma);
      // El receptor y los ítems salen del XML, no del LLM: son los dos datos que
      // tienen que ser exactos (uno decide si la factura es de esta empresa, el
      // otro alimenta la clasificación cuando el proveedor no nombra el rubro).
      const receptor = receptorDeXml(xml);
      const emisor = emisorDeXml(xml);
      agregar({
        via: 'XML',
        origen: a.filename || 'adjunto.xml',
        texto: r.text,
        items: itemsDeXml(xml),
        clienteRuc: receptor.ruc || r.clientRuc,
        clienteNombre: receptor.nombre || r.clientName,
        factura: {
          proveedor: emisor.nombre || r.provider,
          ruc: emisor.ruc || r.ruc,
          dv: emisor.dv || r.providerDv,
          phone: emisor.phone || r.providerPhone,
          email: emisor.email || r.providerEmail,
          address: emisor.address || r.providerAddress,
          location: emisor.location || r.providerLocation,
          fiscalSource: 'XML',
          numeroFactura: r.invoiceNumber,
          fecha: r.date,
          total: r.total,
          itbms: r.itbms,
        },
      });
    }
  }

  // 3) Enlaces del CUTE del cuerpo
  if (!adjuntos.length && facturas.length < MAX_FACTURAS_POR_CORREO) {
    for (const url of enlaces.slice(0, MAX_FACTURAS_POR_CORREO)) {
      huboDocumento = true;
      try {
        const baja = await descargarFacturaDgi(url, { timeoutMs: 30000 });
        const d = await facturaDePdf(prisma, baja.pdf);
        huboTexto = huboTexto || !d.vacio;
        agregar({
          via: 'CUTE',
          origen: url,
          ...d,
          factura: { ...d.factura, dgiUrl: url, dgiXml: baja.dgiXml },
        });
      } catch (err: any) {
        // Un enlace vencido o deteriorado no es un error del correo: se anota y
        // sigue (el proveedor suele mandar el PDF en el mismo mensaje).
        console.error('[EmailFacturas] Enlace del CUTE:', err?.code || err?.message);
      }
    }
  }

  if (facturas.length) return { facturas, motivo: null, enlaces };
  const motivo: MotivoSinFactura = !huboDocumento
    ? adjuntos.length || enlaces.length
      ? 'SIN_FACTURA' // traía cosas, pero ninguna es una factura
      : 'SIN_ADJUNTOS'
    : huboTexto
      ? 'SIN_FACTURA'
      : 'SIN_DATOS';
  return { facturas: [], motivo, enlaces };
}
