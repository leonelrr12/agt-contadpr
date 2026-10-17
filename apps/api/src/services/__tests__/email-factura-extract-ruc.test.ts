import { describe, it, expect, vi } from 'vitest';

/**
 * Regresión del duplicado del 17-10: el mismo correo traía el PDF y el XML de
 * la MISMA factura. El PDF (vía LLM) devolvía el RUC sin dígito verificador
 * (`342-240-75526`) y el XML lo devolvía completo (`342-240-75526-50`), así que
 * la clave del Set no coincidía y ambos adjuntos pasaban al pipeline — que
 * creó dos asientos idénticos con 1.5 s de diferencia.
 *
 * Acá se sustituye el extractor real (necesitaría el LLM y un PDF de verdad)
 * para reproducir exactamente esa diferencia de formato.
 */

const DATOS = {
  text: 'RIBA SMITH S A\nNúmero: 0000333326\nFecha de Emisión: 16/10/2026\nTotal 18.49',
  provider: 'RIBA SMITH S A',
  invoiceNumber: '0000333326',
  date: '2026-10-16',
  total: 18.49,
  subtotal: 17.28,
  itbms: 1.21,
  itbmsRate: 7,
  clientName: null,
  clientRuc: null,
  confidence: 0.9,
  source: 'pdf-parse+llm' as const,
};

vi.mock('../pdf-extractor', async (importOriginal) => {
  const real = await importOriginal<typeof import('../pdf-extractor')>();
  return {
    ...real,
    // El PDF impreso: RUC sin DV.
    extractFromPDF: async () => ({ ...DATOS, ruc: '342-240-75526' }),
    // El XML de la DGI: RUC con DV en su propio grupo.
    extractFromText: async () => ({ ...DATOS, ruc: '342-240-75526-50' }),
  };
});

import { extraerFacturasDeMensaje } from '../email-factura-extract';

const XML_FACTURA = `<?xml version="1.0" encoding="UTF-8"?>
<factura><cabecera>
  <numRUCEmisor>342-240-75526-50</numRUCEmisor>
  <razonSocialEmisor>RIBA SMITH S A</razonSocialEmisor>
  <nroFactura>0000333326</nroFactura>
  <fechaEmision>2026-10-16</fechaEmision>
</cabecera>
<totales><totalFactura>18.49</totalFactura></totales>
</factura>`;

const adjunto = (filename: string, content: Buffer, contentType: string) => ({ filename, contentType, content });

describe('extraerFacturasDeMensaje — RUC con y sin dígito verificador', () => {
  it('el PDF sin DV y el XML con DV de la misma factura cuentan UNA vez (el PDF manda)', async () => {
    const r = await extraerFacturasDeMensaje({}, {
      adjuntos: [
        adjunto('10110040000333326.xml', Buffer.from(XML_FACTURA), 'application/xml'),
        adjunto('10110040000333326.pdf', Buffer.from('%PDF-1.4'), 'application/pdf'),
      ],
    });

    expect(r.facturas).toHaveLength(1);
    expect(r.facturas[0].via).toBe('PDF');
  });
});
