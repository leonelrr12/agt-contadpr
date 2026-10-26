import { describe, it, expect } from 'vitest';
import { xmlATexto, pareceXmlDeFactura, receptorDeXml, itemsDeXml, emisorDeXml } from '../dgi-xml';
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

/**
 * El formato CAFE de la DGI (el que mandan los proveedores de verdad, RIBA SMITH
 * entre ellos): etiquetas `dNroDF`, `dFechaEm`, `dTotNeto`, `dDescProd`, y un
 * segundo `dRuc` que es el del RECEPTOR. Esta fixture es un recorte de una
 * factura real.
 */
const XML_CAFE = `<rContFe xmlns="http://dgi-fep.mef.gob.pa/wsdl/FeRecepFE">
  <xFe><rFE xmlns="http://dgi-fep.mef.gob.pa">
    <gDGen>
      <dNroDF>0000373708</dNroDF>
      <dPtoFacDF>002</dPtoFacDF>
      <dFechaEm>2026-09-27T19:20:07-05:00</dFechaEm>
      <dTipoRuc>2</dTipoRuc>
      <dRuc>342-240-75526</dRuc>
      <dDV>50</dDV>
      <dNombEm>RIBA SMITH S A</dNombEm>
      <iTipoRec>02</iTipoRec>
      <dTipoRuc>1</dTipoRuc>
      <dRuc>794485</dRuc>
      <dNombRec>Leonel Rodriguez</dNombRec>
    </gDGen>
    <gItem>
      <dDescProd>GUINEO</dDescProd><dCantCodInt>1.54</dCantCodInt><dValTotItem>1.519980</dValTotItem>
      <dDescProd>NARANJA DE JUGO</dDescProd><dCantCodInt>1.0</dCantCodInt><dValTotItem>1.420000</dValTotItem>
      <dDescProd>ENDIABLADO DE JAMON</dDescProd><dCantCodInt>1.0</dCantCodInt><dValTotItem>3.050000</dValTotItem>
    </gItem>
    <gTot><dTotNeto>12.49</dTotNeto><dTotITBMS>0.00</dTotITBMS><dTotGravado>0.00</dTotGravado><dVTot>12.49</dVTot><dVTotItems>12.49</dVTotItems></gTot>
    <dCUFE>FE0120000000342-240-75526-5010112026092700003737080020311294451567</dCUFE>
  </rFE></xFe>
</rContFe>`;

describe('xmlATexto — formato CAFE de la DGI', () => {
  const texto = xmlATexto(XML_CAFE);

  it('saca emisor, RUC del emisor, número, fecha y total', () => {
    expect(texto).toContain('Emisor RIBA SMITH S A');
    expect(texto).toContain('RUC 342-240-75526');
    expect(texto).toContain('Número 0000373708');
    expect(texto).toContain('Fecha de Emisión 27/09/2026');
    expect(texto).toContain('Total 12.49');
  });

  it('el total NO se confunde con el de cada ítem ni con el gravado', async () => {
    const r = await extractFromText(texto);
    expect(r.total).toBe(12.49); // y no 3.05 (el último ítem) ni 0.00 (el gravado)
  });

  it('el extractor completo saca los datos del emisor (el RUC es el primero, no el del cliente)', async () => {
    const r = await extractFromText(texto);
    expect(r.provider).toBe('RIBA SMITH S A');
    expect(r.ruc).toBe('342-240-75526');
    expect(r.invoiceNumber).toBe('0000373708');
    expect(r.date).toBe('2026-09-27');
  });

  it('el receptor se rotula como Cliente, no como Emisor', () => {
    expect(texto).toContain('Cliente: Leonel Rodriguez');
    expect(texto).not.toContain('Emisor Leonel Rodriguez');
  });
});

describe('receptorDeXml', () => {
  it('devuelve el nombre y el RUC del receptor (el SEGUNDO dRuc)', () => {
    expect(receptorDeXml(XML_CAFE)).toEqual({ nombre: 'Leonel Rodriguez', ruc: '794485' });
  });

  it('sin datos del receptor no inventa nada', () => {
    expect(receptorDeXml('<f><dRuc>1555-1234-5678</dRuc><dNombEm>PROVEEDOR</dNombEm></f>')).toEqual({ nombre: null, ruc: null });
  });
});

describe('emisorDeXml', () => {
  it('saca nombre, RUC y DV del emisor (el primer dRuc y su dDV)', () => {
    const e = emisorDeXml(XML_CAFE);
    expect(e.nombre).toBe('RIBA SMITH S A');
    expect(e.ruc).toBe('342-240-75526');
    expect(e.dv).toBe('50');
    // La fixture no trae dirección/teléfono/email del emisor.
    expect(e.address).toBeNull();
    expect(e.phone).toBeNull();
    expect(e.email).toBeNull();
  });

  it('toma los tags del emisor cuando existen, sin confundirlos con el receptor', () => {
    const xml = `<f>
      <dNombEm>FERRETERÍA XYZ S A</dNombEm>
      <dRuc>8-733-2267</dRuc>
      <dDV>88</dDV>
      <dDireccionEm>Calle 1, Ciudad</dDireccionEm>
      <dTelefonoEm>+507 6000-0000</dTelefonoEm>
      <dEmailEm>compras@xyz.com</dEmailEm>
      <dNombRec>OTRO CLIENTE</dNombRec>
      <dRuc>1555-1234-5678</dRuc>
      <dDireccionRec>Otra dirección</dDireccionRec>
    </f>`;
    const e = emisorDeXml(xml);
    expect(e).toMatchObject({
      nombre: 'FERRETERÍA XYZ S A',
      ruc: '8-733-2267',
      dv: '88',
      address: 'Calle 1, Ciudad',
      phone: '+507 6000-0000',
      email: 'compras@xyz.com',
    });
    expect(e.nombre).not.toContain('OTRO');
    expect(e.address).not.toContain('Otra');
  });
});

describe('itemsDeXml', () => {
  it('saca las descripciones de los ítems', () => {
    expect(itemsDeXml(XML_CAFE)).toEqual(['GUINEO', 'NARANJA DE JUGO', 'ENDIABLADO DE JAMON']);
  });

  it('un descuento no es un ítem', () => {
    expect(itemsDeXml('<f><dDescProd>CLAVOS</dDescProd><dDescuento>2.00</dDescuento></f>')).toEqual(['CLAVOS']);
  });
});

describe('pareceXmlDeFactura', () => {
  it('acepta un XML de factura y rechaza otro XML cualquiera', () => {
    expect(pareceXmlDeFactura(FACTURA_XML)).toBe(true);
    expect(pareceXmlDeFactura('<?xml version="1.0"?><config><db>localhost</db></config>')).toBe(false);
    expect(pareceXmlDeFactura('')).toBe(false);
  });
});
