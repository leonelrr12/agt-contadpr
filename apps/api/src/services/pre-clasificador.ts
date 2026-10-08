import { conceptoDelMapa } from '@agt-contador/agents';

/** Palabras de una factura que no dicen nada del rubro (metadata del DGI). */
const IGNORAR = new Set([
  'itbms', 'total', 'subtotal', 'neto', 'exento', 'gravado', 'impuesto', 'pagado',
  'vuelto', 'efectivo', 'página', 'pagina', 'fecha', 'emisión', 'emision', 'ruc', 'dv', 'dirección',
  'direccion', 'teléfono', 'telefono', 'correo', 'electrónica', 'electronica', 'comprobante', 'auxiliar',
  'operación', 'operacion', 'interna', 'factura', 'número', 'numero', 'cufe', 'protocolo', 'autorización',
  'autorizacion', 'pac', 'punto', 'facturación', 'facturacion', 'cliente', 'receptor', 'consumidor', 'final',
  'cédula', 'cedula', 'pasaporte', 'descripción', 'descripcion', 'cantidad', 'unidad', 'unitario', 'descuento',
  'monto', 'valor', 'item', 'desglose', 'base', 'forma', 'pago', 'caja', 'bancos', 'banco', 'general', 'local', 'planta', 'baja',
]);

/**
 * Concepto propuesto para una factura subida desde la web (imagen por OCR o PDF).
 *
 * Los ítems y el texto entero se evalúan antes que el proveedor —al revés que en
 * WhatsApp, donde el proveedor identifica mejor el rubro— y el mapa del código
 * solo propone candidatos que NOMBRAN a un concepto del catálogo de la empresa:
 * un rubro que la empresa no tiene (una farmacia sin Medicamentos) no se queda
 * con la propuesta y el texto sigue buscando por las demás palabras.
 */
export async function quickClassify(text: string | null | undefined, prisma?: any, companyId?: string): Promise<string | null> {
  if (!text) return null;
  const words = text.toLowerCase().split(/\s+/).filter(w => w.length >= 2 && !IGNORAR.has(w));
  if (words.length === 0) return null;

  // Catálogo de la empresa: la búsqueda de keywords queda dentro de la empresa y
  // el mapa se valida contra él. Si la lectura falla queda en null y se propone
  // sin validar, como antes.
  let catalogo: any[] | null = null;
  if (prisma && companyId) {
    catalogo = await prisma.concept.findMany({
      where: { companyId, isActive: true },
      include: { account: true },
    }).catch(() => null);
  }

  // 1. Buscar en DB (keywords aprendidos)
  if (prisma && companyId) {
    for (const word of words) {
      const concept = await prisma.concept.findFirst({
        where: { keywords: { contains: word }, isActive: true, companyId },
        select: { name: true },
      }).catch(() => null);
      if (concept) return concept.name;
    }
  }

  // 2. Buscar en KEYWORD_MAP estático
  for (const word of words) {
    const propuesto = conceptoDelMapa(word, catalogo);
    if (propuesto) return propuesto;
  }
  return null;
}
