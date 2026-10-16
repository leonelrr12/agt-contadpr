import { describe, it, expect } from 'vitest';
import { xmlATexto, pareceXmlDeFactura } from '../dgi-xml';
import { extractFromText } from '../pdf-extractor';

/**
 * El XML de la factura electrónica entra por el mismo extractor que los PDF, así
 * que lo único que tiene que hacer este conversor es dejar el texto donde los
 * regex ya afinados lo encuentran. Dos cosas no pueden fallar: que las etiquetas
 * que el extractor busca por nombre queden con SU formato, y que una fecha ISO
 * se normalice (los regex esperan el `dd/mm/aaaa` del PDF de la DGI).
 *
 * Los nombres de etiqueta de la fixture son los del esquema de la DGI, pero el
 * conversor reconoce por RAÍZ (`*ruc*`, `*total*`), no por nombre exacto: por eso
 * `numRUCEmisor` y `rucEmisor` caen en el mismo lugar.
 */

const FACTURA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<factura xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <!-- Datos del emisor -->
  <cabecera>
    <tipoDocumento>01</tipoDocumento>
    <numRUCEmisor>1555-12345-67</numRUCEmisor>
    <razonSocialEmisor>FERRETERÍA EL TORNILLO, S.A.</razonSocialEmisor>
    <nroFactura>0000221106</nroFactura>
    <fechaEmision>2026-06-19</fechaEmision>
  </cabecera>
  <items>
    <item><descripcion>Jabón líquido 1 lt</descripcion><cantidad>1.00</cantidad></item>
  </items>
  <totales>
    <subTotal>3.01</subTotal>
    <totalITBMS>0.21</totalITBMS>
    <totalFactura>3.22</totalFactura>
  </totales>
</factura>`;

describe('xmlATexto', () => {
  const texto = xmlATexto(FACTURA_XML);

  it('emite las etiquetas que el extractor busca por nombre, con su formato', () => {
    expect(texto).toContain('Emisor FERRETERÍA EL TORNILLO, S.A.');
    expect(texto).toContain('RUC 1555-12345-67');
    expect(texto).toContain('Número 0000221106');
    expect(texto).toContain('Total 3.22');
    expect(texto).toContain('Subtotal 3.01');
  });

  it('la fecha ISO se normaliza al formato del PDF de la DGI', () => {
    expect(texto).toContain('Fecha de Emisión 19/06/2026');
  });

  it('lo que no reconoce lo vuelca igual, para el LLM y los regex genéricos', () => {
    expect(texto).toContain('descripcion: Jabón líquido 1 lt');
    expect(texto).toContain('tipoDocumento: 01');
    expect(texto).toContain('ITBMS: 0.21');
  });

  it('saca la declaración, los comentarios y el espacio de nombres', () => {
    expect(texto).not.toContain('<?xml');
    expect(texto).not.toContain('<!--');
    expect(texto).not.toContain('ds:');
  });

  it('desescapa las entidades', () => {
    const t = xmlATexto('<f><razonSocialEmisor>PEREZ &amp; CIA &lt;S.A.&gt;</razonSocialEmisor></f>');
    expect(t).toBe('Emisor PEREZ & CIA <S.A.>');
  });

  it('no explota con lo que no es XML', () => {
    expect(xmlATexto('')).toBe('');
    expect(xmlATexto('esto no es xml')).toBe('');
    expect(xmlATexto('<a></a>')).toBe('');
  });

  it('reconoce el total aunque el proveedor lo llame de otra forma', () => {
    expect(xmlATexto('<f><montoTotal>10.50</montoTotal></f>')).toContain('Total 10.50');
    expect(xmlATexto('<f><importeTotal>10.50</importeTotal></f>')).toContain('Total 10.50');
  });

  it('una fecha con hora también se normaliza', () => {
    expect(xmlATexto('<f><fechaEmision>2026-06-19T10:30:00-05:00</fechaEmision></f>')).toContain('Fecha de Emisión 19/06/2026');
  });
});

describe('xmlATexto → extractFromText (el camino completo)', () => {
  it('saca proveedor, RUC, número, fecha y total de una factura electrónica', async () => {
    const r = await extractFromText(xmlATexto(FACTURA_XML));
    expect(r.provider).toBe('FERRETERÍA EL TORNILLO, S.A.');
    expect(r.ruc).toBe('1555-12345-67');
    expect(r.invoiceNumber).toBe('0000221106');
    expect(r.date).toBe('2026-06-19');
    expect(r.total).toBe(3.22);
    expect(r.subtotal).toBe(3.01);
  });

  it('el total del XML no lo pisa un monto del desglose', async () => {
    const r = await extractFromText(xmlATexto(FACTURA_XML));
    expect(r.total).toBe(3.22); // y no 0.21 (el ITBMS) ni 3.01 (el subtotal)
  });
});

describe('pareceXmlDeFactura', () => {
  it('acepta un XML de factura y rechaza otro XML cualquiera', () => {
    expect(pareceXmlDeFactura(FACTURA_XML)).toBe(true);
    expect(pareceXmlDeFactura('<?xml version="1.0"?><config><db>localhost</db></config>')).toBe(false);
    expect(pareceXmlDeFactura('')).toBe(false);
  });
});
