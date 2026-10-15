import { describe, it, expect, vi, afterEach } from 'vitest';
import { descargarFacturaDgi, DgiError, DGI_BROWSER_UA } from '../dgi-cute';

/**
 * El baile del CUTE —el visor de la DGI trae el XML en un input oculto y el PDF
 * se pide aparte por POST— vivía duplicado en WhatsApp y en `/factura/extract-url`,
 * y las dos copias ya habían divergido. Estos tests fijan lo que el servicio
 * tiene que hacer (y con qué código falla) para que los dos llamadores puedan
 * traducirlo a su propio mensaje.
 */

const PDF = Buffer.from('%PDF-1.7\n...resto del pdf...');
const XML = '<?xml version="1.0" encoding="UTF-8"?><factura><cufe>ABC</cufe></factura>';

/** El visor escapa el XML dentro del atributo `value`. */
const escapar = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const visorHtml = (extra = '') =>
  `<!DOCTYPE html><html><body>...<form><input type="hidden" id="facturaXML" value="${escapar(XML)}" />` +
  `<button name="DescargarFacturaPDF"></button></form>${extra}</body></html>`;

const respuesta = (body: string | Buffer, status = 200) => {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    ok: status >= 200 && status < 300,
    status,
    // OJO: el ArrayBuffer del Buffer es el pool entero — hay que recortarlo por
    // byteOffset/byteLength, o el servicio lee basura delante.
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe('descargarFacturaDgi — enlace directo a un PDF', () => {
  it('devuelve el PDF sin XML y manda el User-Agent de navegador', async () => {
    const fetchFalso = vi.fn(async (_url: string, _init: any) => respuesta(PDF));
    vi.stubGlobal('fetch', fetchFalso);

    const r = await descargarFacturaDgi('https://dgi-fep.mef.gob.pa/f.pdf');

    expect(r.pdf.toString()).toBe(PDF.toString());
    expect(r.dgiXml).toBeNull();
    expect(r.dgiUrl).toBe('https://dgi-fep.mef.gob.pa/f.pdf');
    expect(fetchFalso.mock.calls[0][1].headers['User-Agent']).toBe(DGI_BROWSER_UA);
  });

  it('con userAgent: null no manda la cabecera (lo que hacía /extract-url)', async () => {
    const fetchFalso = vi.fn(async (_url: string, _init: any) => respuesta(PDF));
    vi.stubGlobal('fetch', fetchFalso);

    await descargarFacturaDgi('https://x.test/f.pdf', { userAgent: null });

    expect(fetchFalso.mock.calls[0][1].headers['User-Agent']).toBeUndefined();
  });
});

describe('descargarFacturaDgi — visor del CUTE', () => {
  it('saca el XML del input oculto y pide el PDF por POST al host del enlace', async () => {
    const fetchFalso = vi.fn(async (url: string, init: any) =>
      init?.method === 'POST' ? respuesta(PDF) : respuesta(visorHtml()),
    );
    vi.stubGlobal('fetch', fetchFalso);

    const r = await descargarFacturaDgi('https://dgi-fep.mef.gob.pa/Consultas/FacturasPorQR?chash=x');

    expect(r.dgiXml).toBe(XML); // entidades decodificadas
    expect(r.pdf.toString()).toBe(PDF.toString());

    const [urlPost, initPost] = fetchFalso.mock.calls[1];
    expect(urlPost).toBe('https://dgi-fep.mef.gob.pa/Consultas/DescargarFacturaPDF');
    expect(initPost.body).toContain(`facturaXML=${encodeURIComponent(XML)}`);
    expect(initPost.headers.Referer).toContain('FacturasPorQR');
  });

  it('el QR deteriorado se rechaza ANTES de pedir el PDF', async () => {
    const fetchFalso = vi.fn(async () => respuesta('<html><body>El código QR está mal construido</body></html>'));
    vi.stubGlobal('fetch', fetchFalso);

    await expect(descargarFacturaDgi('https://dgi-fep.mef.gob.pa/qr?chash=x')).rejects.toMatchObject({
      code: 'DGI_DETERIORADO',
      eraHtml: true,
    });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it('el visor sin el input del XML es DGI_QR_INVALIDO', async () => {
    // Los marcadores están, pero el input del XML no: el regex no encuentra nada.
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(visorHtml().replace(/id="facturaXML"/, 'id="facturaXML2"'))));

    await expect(descargarFacturaDgi('https://dgi-fep.mef.gob.pa/qr')).rejects.toMatchObject({
      code: 'DGI_QR_INVALIDO',
    });
  });

  it('si la DGI no entrega el PDF, el error dice que fue en el POST', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) =>
      init?.method === 'POST' ? respuesta('error', 500) : respuesta(visorHtml()),
    ));

    await expect(descargarFacturaDgi('https://dgi-fep.mef.gob.pa/qr')).rejects.toMatchObject({
      code: 'DGI_HTTP',
      etapa: 'POST',
      status: 500,
    });
  });
});

describe('descargarFacturaDgi — lo que no es una factura', () => {
  it('una página web cualquiera es DGI_NO_PDF con eraHtml', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta('<!DOCTYPE html><html><body>Hola</body></html>')));

    await expect(descargarFacturaDgi('https://ejemplo.test')).rejects.toMatchObject({
      code: 'DGI_NO_PDF',
      eraHtml: true,
    });
  });

  it('un archivo que no es PDF tampoco pasa', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(Buffer.from('PK\u0003\u0004zip'))));

    await expect(descargarFacturaDgi('https://ejemplo.test/x.zip')).rejects.toMatchObject({
      code: 'DGI_NO_PDF',
      eraHtml: false,
    });
  });

  it('un error HTTP del GET no se confunde con un timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta('no', 404)));

    await expect(descargarFacturaDgi('https://ejemplo.test/x')).rejects.toMatchObject({
      code: 'DGI_HTTP',
      etapa: 'GET',
      status: 404,
    });
  });

  it('el timeout del socket es DGI_TIMEOUT', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }));

    await expect(descargarFacturaDgi('https://dgi-fep.mef.gob.pa/qr')).rejects.toMatchObject({
      code: 'DGI_TIMEOUT',
    });
  });

  it('todos los fallos son DgiError, para que el llamador los distinga de lo inesperado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respuesta('no', 500)));

    await expect(descargarFacturaDgi('https://dgi-fep.mef.gob.pa/qr')).rejects.toBeInstanceOf(DgiError);
  });
});
