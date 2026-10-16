/**
 * XML de factura electrónica → texto, para el mismo extractor que lee los PDF.
 *
 * **Qué XML entra acá y qué no**: entra el XML que el proveedor manda como
 * adjunto (el archivo de la factura electrónica, que es XML de verdad). NO entra
 * lo que la DGI embebe en el visor del CUTE (`id="facturaXML"`): ese valor es un
 * blob base64 opaco —dos facturas distintas comparten los primeros 200 bytes
 * decodificados y la entropía es ~8 bits/byte, o sea que está cifrado o
 * empaquetado por la DGI— y solo sirve para que la DGI lo reciba de vuelta en
 * `DescargarFacturaPDF`. Se archiva tal cual; nadie lo parsea.
 *
 * Sin librería de XML a propósito: cada elemento con texto se vuelca como una
 * línea y los regex ya afinados de `pdf-extractor.ts` hacen el resto. Es más
 * barato de auditar que sumar `fast-xml-parser`, y si el XML no se entiende
 * queda el PDF, que es el camino principal.
 */

/**
 * Etiquetas que se emiten con el MISMO formato del PDF de la DGI (`Total 3.22`,
 * sin dos puntos), porque son las que los regex del extractor buscan por su
 * nombre exacto. Se reconocen por la RAÍZ del nombre y no por el nombre completo
 * porque el esquema de la DGI usa mayúsculas raras (`rUCEmisor`) y cada proveedor
 * le pone lo suyo: `totalFactura`, `importeTotal` y `montoTotal` son lo mismo.
 *
 * El orden importa: `totalITBMS` tiene que caer en ITBMS y `subTotal` en
 * Subtotal antes de que la regla de `total` los atrape.
 */
const ETIQUETAS: { test: RegExp; etiqueta: string; sinDosPuntos?: boolean }[] = [
  // `iva` suelto NO entra: en camelCase se cuela dentro de otras palabras
  // ("domicilioPrivado" contiene «iva») y etiquetaría mal una dirección.
  { test: /itbms|impuesto/i, etiqueta: 'ITBMS' },
  { test: /gravado|grav.*base|base.*grava|sub\s*total/i, etiqueta: 'Subtotal', sinDosPuntos: true },
  // El receptor va ANTES que el emisor: `dNombRec` no puede caer en «Emisor».
  { test: /(nomb|razon|nombre).*rec|rec.*(nomb|razon|nombre)|cliente/i, etiqueta: 'Cliente' },
  { test: /(nomb|razon|nombre).*(em\b|emisor|proveedor)|(emisor|proveedor).*(nomb|razon|nombre)/i, etiqueta: 'Emisor', sinDosPuntos: true },
  { test: /ruc/i, etiqueta: 'RUC', sinDosPuntos: true },
  // `dNroDF` es el «documento fiscal» del formato CAFE de la DGI.
  { test: /(nro|num|numero).*(df\b|factura|documento)|(factura|documento).*(nro|num|numero)/i, etiqueta: 'Número', sinDosPuntos: true },
  // `dFechaEm` / `fechaEmision` / `fechaExpedicion`.
  { test: /fecha.*(em\b|emision|expedicion)|(emision|expedicion).*fecha/i, etiqueta: 'Fecha de Emisión', sinDosPuntos: true },
  // `dTotNeto`, `dVTot`, `dTotRec`, `dVTotItems` y los totales de otros esquemas.
  // OJO: `dValTotItem` (el total de CADA ítem) no entra — no dice «total» ni
  // empieza con «vtot» — y `dTotGravado` ya cayó en Subtotal más arriba.
  { test: /^d?vtot|totneto|totrec|vtotitems|total/i, etiqueta: 'Total', sinDosPuntos: true },
];

/** Entidades que la DGI y los proveedores usan dentro de los valores. */
function desescapar(texto: string): string {
  return texto
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Las fechas de los XML vienen en ISO (`2026-06-19` o `2026-06-19T10:00:00-05:00`)
 * y el extractor espera el `dd/mm/aaaa` del PDF de la DGI: se normaliza acá, que
 * es una sola vez, en vez de enseñarle al extractor un formato más.
 */
function normalizarFecha(valor: string): string {
  const iso = valor.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/);
  return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : valor;
}

/**
 * Convierte el XML en líneas `Etiqueta: valor` (una por elemento con texto), en
 * el orden del documento para que los regex que buscan «el último monto» sigan
 * encontrando el mismo que encontrarían en el PDF.
 */
export function xmlATexto(xml: string): string {
  const limpio = String(xml || '')
    .replace(/<\?[\s\S]*?\?>/g, '')      // declaración <?xml ... ?>
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  if (!limpio.includes('<')) return '';

  const lineas: string[] = [];
  // Solo elementos con contenido de texto (los que tienen hijos los abre su propio match).
  const re = /<([A-Za-z_][\w.\-]*(?::[\w.\-]+)?)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpio)) !== null) {
    const local = m[1].includes(':') ? m[1].split(':').pop()! : m[1];
    let valor = desescapar(m[2].trim());
    if (!valor) continue;

    const regla = ETIQUETAS.find((e) => e.test.test(local));
    if (regla) {
      if (regla.etiqueta === 'Fecha de Emisión') valor = normalizarFecha(valor);
      lineas.push(regla.sinDosPuntos ? `${regla.etiqueta} ${valor}` : `${regla.etiqueta}: ${valor}`);
    } else {
      lineas.push(`${local}: ${valor}`);
    }
  }
  return lineas.join('\n');
}

/** Todos los valores de las etiquetas cuyo nombre dé en el patrón. */
function valoresDe(xml: string, test: RegExp): string[] {
  const valores: string[] = [];
  for (const m of String(xml || '').matchAll(/<([A-Za-z0-9_:]+)(?:\s[^>]*)?>([^<]*)<\/\1>/g)) {
    const local = m[1].includes(':') ? m[1].split(':').pop()! : m[1];
    const valor = desescapar(m[2].trim());
    if (valor && test.test(local)) valores.push(valor);
  }
  return valores;
}

/**
 * Los datos del RECEPTOR, que en el formato CAFE viajan en su propio bloque
 * (`dNombRec`, y un segundo `dRuc` después del del emisor).
 *
 * Van aparte del texto porque son la única defensa contra cargar la factura del
 * cliente de al lado: la comparación tiene que ser determinista, no lo que el
 * LLM crea leer.
 */
export function receptorDeXml(xml: string): { nombre: string | null; ruc: string | null } {
  const nombre = valoresDe(xml, /(nomb|razon|nombre).*rec|rec.*(nomb|razon|nombre)/i)[0] || null;
  // El primer `dRuc` es el del emisor (la factura la emite él); el del receptor
  // viene después, así que el último es el que sirve.
  const rucs = valoresDe(xml, /ruc/i);
  return { nombre, ruc: rucs.length > 1 ? rucs[rucs.length - 1] : null };
}

/**
 * Las descripciones de los ítems del XML. Las usa la clasificación: en el
 * formato CAFE cada ítem trae la suya en `dDescProd`, que es justo lo que el
 * clasificador mira cuando el proveedor no nombra ningún rubro.
 */
export function itemsDeXml(xml: string): string[] {
  // `(?!uen)`: un descuento (`dDescuento`) no es un ítem.
  return valoresDe(xml, /^d?desc(?!uen)/i)
    .map((v) => v.trim())
    .filter((v) => v.length >= 3 && v.length <= 80)
    .slice(0, 60);
}

/** ¿Este adjunto es un XML de factura y no otra cosa (un .xml de configuración)? */
export function pareceXmlDeFactura(xml: string): boolean {
  const texto = String(xml || '').slice(0, 4000).toLowerCase();
  return texto.includes('<') && /factura|comprobante|dgi|fe\b|cfeb/.test(texto);
}
