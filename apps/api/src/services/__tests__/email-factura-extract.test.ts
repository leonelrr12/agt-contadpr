import { describe, it, expect, vi, afterEach } from 'vitest';
import PDFDocument from 'pdfkit';
import { extraerFacturasDeMensaje, enlacesCute, MAX_FACTURAS_POR_CORREO } from '../email-factura-extract';

/**
 * La detección decide si un correo trae una factura o no, y de qué manera la
 * trae (PDF adjunto, XML adjunto o enlace del CUTE en el cuerpo). Es la puerta
 * del módulo: lo que no detecta acá, no se carga nunca — y lo que detecta de más,
 * termina en un asiento que alguien tiene que anular.
 *
 * El PDF de las fixtures se genera acá mismo con pdfkit, con el texto que emite
 * la DGI, para que la prueba no dependa de un archivo binario en el repo.
 */

/** Un PDF con texto real (las líneas que el extractor sabe leer). */
function pdfConTexto(lineas: string[]): Promise<Buffer> {
  const doc = new PDFDocument();
  const trozos: Buffer[] = [];
  doc.on('data', (c: Buffer) => trozos.push(c));
  const fin = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(trozos))));
  for (const l of lineas) doc.text(l);
  doc.end();
  return fin;
}

const RUC_EMISOR = '356-19-77860';

const lineasFactura = (numero: string) => [
  'SUPERMERCADOS XTRA, S.A.',
  `RUC: ${RUC_EMISOR}`,
  'Emisor: SUPERMERCADOS XTRA, S.A.',
  `Número: ${numero}`,
  'Fecha de Emisión: 19/06/2026',
  'Valor Item',
  '1 Jabón líquido 1.00 1.50',
  '2 Cloro 1.00 1.51',
  'Desglose ITBMS',
  'Subtotal 3.01',
  'ITBMS 7% 0.21',
  'Total 3.22',
];

const LINEAS_FACTURA_DGI = lineasFactura('0000221106');

/** El XML de la MISMA factura que el PDF (mismo RUC y mismo número). */
const XML_FACTURA = `<?xml version="1.0" encoding="UTF-8"?>
<factura><cabecera>
  <numRUCEmisor>${RUC_EMISOR}</numRUCEmisor>
  <razonSocialEmisor>SUPERMERCADOS XTRA, S.A.</razonSocialEmisor>
  <nroFactura>0000221106</nroFactura>
  <fechaEmision>2026-06-19</fechaEmision>
</cabecera>
<totales><subTotal>3.01</subTotal><totalITBMS>0.21</totalITBMS><totalFactura>3.22</totalFactura></totales>
</factura>`;

const adjunto = (filename: string, content: Buffer, contentType: string) => ({ filename, contentType, content });

afterEach(() => vi.unstubAllGlobals());

describe('extraerFacturasDeMensaje — PDF adjunto', () => {
  it('lee proveedor, número, fecha y total, y saca los items', async () => {
    const pdf = await pdfConTexto(LINEAS_FACTURA_DGI);
    const r = await extraerFacturasDeMensaje({}, { adjuntos: [adjunto('FE-0000221106.pdf', pdf, 'application/pdf')] });

    expect(r.motivo).toBeNull();
    expect(r.facturas).toHaveLength(1);
    const f = r.facturas[0];
    expect(f.via).toBe('PDF');
    expect(f.factura.proveedor).toContain('SUPERMERCADOS XTRA');
    expect(f.factura.ruc).toBe('356-19-77860');
    expect(f.factura.numeroFactura).toBe('0000221106');
    expect(f.factura.fecha).toBe('2026-06-19');
    expect(f.factura.total).toBe(3.22);
    expect(f.items).toContain('Jabón líquido');
  });
});

describe('extraerFacturasDeMensaje — XML adjunto', () => {
  it('lo pasa por el mismo extractor y saca los mismos datos', async () => {
    const r = await extraerFacturasDeMensaje({}, { adjuntos: [adjunto('factura.xml', Buffer.from(XML_FACTURA), 'text/xml')] });

    expect(r.facturas).toHaveLength(1);
    const f = r.facturas[0];
    expect(f.via).toBe('XML');
    expect(f.factura.proveedor).toBe('SUPERMERCADOS XTRA, S.A.');
    expect(f.factura.ruc).toBe(RUC_EMISOR);
    expect(f.factura.total).toBe(3.22);
    expect(f.factura.fecha).toBe('2026-06-19');
  });

  it('el PDF y el XML de la misma factura cuentan UNA vez (el PDF manda)', async () => {
    const pdf = await pdfConTexto(LINEAS_FACTURA_DGI);
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [adjunto('factura.xml', Buffer.from(XML_FACTURA), 'text/xml'), adjunto('factura.pdf', pdf, 'application/pdf')],
    });

    expect(r.facturas).toHaveLength(1);
    expect(r.facturas[0].via).toBe('PDF');
  });

  it('un XML que no es de factura no cuenta', async () => {
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [adjunto('config.xml', Buffer.from('<?xml version="1.0"?><config><db>localhost</db></config>'), 'text/xml')],
    });
    expect(r.facturas).toHaveLength(0);
    expect(r.motivo).toBe('SIN_DATOS');
  });
});

describe('extraerFacturasDeMensaje — lo que NO es una factura', () => {
  it('una promoción sin adjuntos queda SIN_ADJUNTOS', async () => {
    const r = await extraerFacturasDeMensaje({}, {
      text: '¡50% de descuento en toda la tienda! Te esperamos.',
      html: '<html><body><b>50% de descuento</b></body></html>',
      adjuntos: [],
    });
    expect(r.facturas).toHaveLength(0);
    expect(r.motivo).toBe('SIN_ADJUNTOS');
  });

  it('un PDF que no es una factura queda SIN_FACTURA', async () => {
    const pdf = await pdfConTexto(['Términos y condiciones del servicio', 'El presente contrato se celebra entre las partes']);
    const r = await extraerFacturasDeMensaje({}, { adjuntos: [adjunto('terminos.pdf', pdf, 'application/pdf')] });
    expect(r.facturas).toHaveLength(0);
    expect(r.motivo).toBe('SIN_FACTURA');
  });

  it('un adjunto ilegible no tumba el análisis: queda SIN_DATOS', async () => {
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [adjunto('roto.pdf', Buffer.from('esto no es un pdf'), 'application/pdf')],
    });
    expect(r.facturas).toHaveLength(0);
    expect(r.motivo).toBe('SIN_DATOS');
  });

  it('un adjunto que no es un documento (una foto) queda SIN_FACTURA, no SIN_DATOS', async () => {
    // SIN_DATOS es «había un documento y no se pudo leer»; una foto no es un
    // documento de factura, y el dueño arregla cada caso de forma distinta.
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [adjunto('foto.jpg', Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg')],
    });
    expect(r.facturas).toHaveLength(0);
    expect(r.motivo).toBe('SIN_FACTURA');
  });
});

describe('extraerFacturasDeMensaje — enlace del CUTE en el cuerpo', () => {
  const URL_CUTE = 'https://dgi-fep.mef.gob.pa/Consultas/FacturasPorQR?chFE=FE01&iAmb=1&digestValue=abc%3D';

  it('sin adjuntos, sigue el enlace y deja el PDF y el blob de la DGI', async () => {
    const pdf = await pdfConTexto(LINEAS_FACTURA_DGI);
    const visor = `<!DOCTYPE html><html><body><form action="/Consultas/DescargarFacturaPDF"><input id="facturaXML" name="facturaXML" type="hidden" value="QkxPQi1ERUwtVklTT1I="></form></body></html>`;
    const fetchFalso = vi.fn(async (_url: string, init: any) => {
      const cuerpo = init?.method === 'POST' ? pdf : Buffer.from(visor);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => cuerpo.buffer.slice(cuerpo.byteOffset, cuerpo.byteOffset + cuerpo.byteLength),
      };
    });
    vi.stubGlobal('fetch', fetchFalso);

    const r = await extraerFacturasDeMensaje({}, { text: `Te mando la factura: ${URL_CUTE}`, adjuntos: [] });

    expect(r.facturas).toHaveLength(1);
    const f = r.facturas[0];
    expect(f.via).toBe('CUTE');
    expect(f.origen).toBe(URL_CUTE);
    expect(f.factura.dgiUrl).toBe(URL_CUTE);
    // El valor del visor se archiva TAL CUAL (es base64 opaco, no XML: la DGI lo
    // recibe de vuelta así en DescargarFacturaPDF). No se decodifica a propósito.
    expect(f.factura.dgiXml).toBe('QkxPQi1ERUwtVklTT1I=');
    expect(f.factura.total).toBe(3.22);
  });

  it('un enlace roto no rompe el correo: se anota y sigue', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) })));
    const r = await extraerFacturasDeMensaje({}, { text: URL_CUTE, adjuntos: [] });
    expect(r.facturas).toHaveLength(0);
    expect(r.enlaces).toEqual([URL_CUTE]);
  });

  it('con adjuntos NO se sigue el enlace (el adjunto manda)', async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal('fetch', fetchFalso);
    const pdf = await pdfConTexto(LINEAS_FACTURA_DGI);
    await extraerFacturasDeMensaje({}, { text: URL_CUTE, adjuntos: [adjunto('f.pdf', pdf, 'application/pdf')] });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe('enlacesCute', () => {
  it('encuentra el enlace aunque venga escapado en el HTML', () => {
    const html = '<p>Factura: <a href="https://dgi-fep.mef.gob.pa/Consultas/FacturasPorQR?chFE=FE01&amp;iAmb=1">ver</a></p>';
    const r = enlacesCute(html);
    expect(r).toHaveLength(1);
    expect(r[0]).toContain('&iAmb=1'); // desescapado: la query tiene que llegar entera
    expect(r[0]).not.toContain('&amp;');
  });

  it('no confunde otros enlaces', () => {
    expect(enlacesCute('mira https://ejemplo.com/factura.pdf y https://otro.test')).toEqual([]);
  });

  it('el mismo enlace dos veces cuenta una sola', () => {
    const u = 'https://dgi-fep.mef.gob.pa/x?chFE=FE01';
    expect(enlacesCute(`${u} ... ${u}`)).toEqual([u]);
  });
});

describe('extraerFacturasDeMensaje — topes', () => {
  it(`no pasa de ${MAX_FACTURAS_POR_CORREO} facturas por correo`, async () => {
    const adjuntos = await Promise.all(
      Array.from({ length: 8 }, async (_, i) =>
        adjunto(`f${i}.pdf`, await pdfConTexto(lineasFactura(`000022110${i}`)), 'application/pdf'),
      ),
    );
    const r = await extraerFacturasDeMensaje({}, { adjuntos });
    expect(r.facturas).toHaveLength(MAX_FACTURAS_POR_CORREO);
  });

  it('la misma factura adjunta dos veces cuenta una sola', async () => {
    const pdf = await pdfConTexto(LINEAS_FACTURA_DGI);
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [adjunto('factura.pdf', pdf, 'application/pdf'), adjunto('factura (1).pdf', pdf, 'application/pdf')],
    });
    expect(r.facturas).toHaveLength(1);
  });
});
