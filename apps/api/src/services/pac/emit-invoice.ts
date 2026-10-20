/**
 * Emisión electrónica de una factura de venta.
 *
 * La factura y su asiento ya existen (transacción local). Acá se arma el payload
 * neutral, se llama al PAC y se guarda el resultado en `Invoice`. Un rechazo de
 * la DGI o un error de red NO revierten la factura: queda marcada y se reintenta.
 *
 * Idempotencia: `controlId = invoice.id`. Si la DGI RECHAZÓ el documento, el
 * reintento usa `invoice.id-r<attempt>` porque el anterior no fue autorizado y
 * reenviar el mismo id podría devolver el rechazo cacheado.
 */
import { PacError } from './types';
import type {
  PacInvoiceRequest,
  PacInvoiceResult,
  PacItbmsCode,
  PacItemTax,
  PacMessage,
  PacProvider,
  PacReceptor,
} from './types';
import { getPacProviderForCompany } from './company-config';

export type InvoicePacStatus = 'AUTORIZADA' | 'RECHAZADA' | 'ERROR' | 'NO_CONFIGURADO';

export interface InvoiceEmission {
  status: InvoicePacStatus;
  message: string;
  cufe?: string;
  documentNumber?: string;
  authorizationNumber?: string;
  pdfUrl?: string;
  messages: PacMessage[];
  /** Factura con los campos fiscales ya actualizados. */
  invoice: any;
}

function parseMessages(json: unknown): PacMessage[] {
  if (typeof json !== 'string' || !json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function resumenMensajes(messages: PacMessage[], fallback: string): string {
  return messages.length ? messages.map((m) => m.message).join(' · ') : fallback;
}

function codigoItbms(tasa: number, linea: number): PacItbmsCode {
  if (tasa <= 0.0001) return 'EXENTO';
  if (Math.abs(tasa - 0.07) < 0.0005) return 'ITBMS_7';
  if (Math.abs(tasa - 0.1) < 0.0005) return 'ITBMS_10';
  if (Math.abs(tasa - 0.15) < 0.0005) return 'ITBMS_15';
  throw new PacError(
    `La línea ${linea} tiene una tasa de ITBMS de ${(tasa * 100).toFixed(2)}%, no soportada por la DGI (0, 7, 10 o 15%).`,
    'CONFIG',
  );
}

function fechaSoloDia(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Receptor neutral a partir de la ficha del cliente. */
function datosReceptor(client: any): PacReceptor {
  const nombre = String(client?.name || '').trim() || 'CONSUMIDOR FINAL';
  const taxId = String(client?.taxId || '').trim();

  if (!taxId || /^consumidor final$/i.test(nombre)) {
    return { type: 'CONSUMIDOR_FINAL', name: nombre };
  }

  // El RUC puede venir completo (`8-733-2267-88`): el último grupo de 1-2
  // dígitos es el DV y el RUC base es lo que se compara. Si el DV está en su
  // propio campo, igual se quita del final para no enviarlo dos veces.
  let ruc = taxId;
  let dv = String(client?.dv || '').trim();
  const m = taxId.match(/^(.*)-(\d{1,2})$/);
  if (m && m[1].split('-').length >= 3) {
    ruc = m[1];
    if (!dv) dv = m[2];
  }

  if (!dv) {
    throw new PacError(
      `El cliente "${nombre}" tiene RUC pero falta el DV. Completá su ficha fiscal antes de emitir electrónicamente.`,
      'CONFIG',
    );
  }
  if (ruc.length > 20) {
    throw new PacError(`El RUC del cliente "${nombre}" supera los 20 caracteres.`, 'CONFIG');
  }

  const address = String(client?.address || '').trim();
  if (!address) {
    throw new PacError(
      `El cliente "${nombre}" no tiene dirección. Es obligatoria para facturar electrónicamente a contribuyentes.`,
      'CONFIG',
    );
  }

  const location = String(client?.location || '').trim();
  if (!location) {
    throw new PacError(
      `El cliente "${nombre}" no tiene ubicación DGI (PP-DD-CC). Completá su ficha fiscal antes de emitir.`,
      'CONFIG',
    );
  }
  if (!/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(location) || location.length < 5 || location.length > 8) {
    throw new PacError(
      `La ubicación del cliente "${nombre}" debe tener el formato PP-DD-CC (ej. 8-8-8).`,
      'CONFIG',
    );
  }

  return {
    type: 'CONTRIBUYENTE',
    name: nombre,
    ruc,
    dv,
    address: address.slice(0, 100),
    location,
    email: client?.email ? String(client.email).slice(0, 255) : undefined,
  };
}

/** Traduce la factura local al contrato neutral. Puro: se testea sin BD ni PAC. */
export function buildInvoicePacRequest(
  invoice: any,
  opts: { controlId?: string } = {},
): PacInvoiceRequest {
  if (!invoice?.items?.length) throw new PacError('La factura no tiene ítems.', 'CONFIG');
  const total = Number(invoice.total);
  if (!(total > 0)) throw new PacError('La factura no tiene un total válido.', 'CONFIG');

  const tasa = Number(invoice.itbmsRate ?? 0.07);
  const items = invoice.items.map((it: any, i: number) => {
    const cantidad = Number(it.cantidad) || 1;
    const precio = Number(it.precio) || 0;
    if (!(cantidad > 0)) {
      throw new PacError(`El ítem ${i + 1} tiene una cantidad inválida.`, 'CONFIG');
    }
    if (!(precio >= 0)) {
      throw new PacError(`El ítem ${i + 1} tiene un precio inválido.`, 'CONFIG');
    }
    const descripcion = String(it.descripcion || '').trim();
    if (descripcion.length < 2) {
      throw new PacError(
        `El ítem ${i + 1} necesita una descripción de al menos 2 caracteres para la DGI.`,
        'CONFIG',
      );
    }

    const code = codigoItbms(Number(invoice.itbms) > 0 ? tasa : 0, i + 1);
    return {
      line: i + 1,
      description: descripcion.slice(0, 500),
      quantity: cantidad,
      unitPrice: precio,
      taxes: [{ kind: 'ITBMS', code, amount: Number(it.itbms) || 0 }] as PacItemTax[],
      discount: 0,
    };
  });

  let issueDate = invoice.date ? new Date(invoice.date) : new Date();
  if (Number.isNaN(issueDate.getTime())) issueDate = new Date();
  let dueDate = invoice.dueDate ? new Date(invoice.dueDate) : issueDate;
  if (Number.isNaN(dueDate.getTime())) dueDate = issueDate;

  const esCredito = invoice.paymentMethod === 'CREDITO';
  const info = `Factura ${invoice.number || invoice.id}${invoice.description ? ` - ${invoice.description}` : ''}`;

  return {
    controlId: opts.controlId || invoice.id,
    documentKind: 'FACTURA',
    // 0 = secuencia interna del PAC. El número que devuelve se guarda aparte
    // (pacDocumentNumber) sin tocar el correlativo local del PDF.
    fiscalNumber: 0,
    issueDate,
    receptor: datosReceptor(invoice.client),
    items,
    payments: [{ type: esCredito ? 'CREDITO' : 'EFECTIVO', amount: total }],
    paymentTerm: esCredito ? 'CREDITO' : 'CONTADO',
    // El PAC exige al menos una cuota cuando el plazo es a crédito.
    ...(esCredito
      ? { installments: [{ expirationDate: fechaSoloDia(dueDate), value: total }] }
      : {}),
    total,
    info: info.slice(0, 5000),
  };
}

function fechaAutorizacion(processDate?: string): Date {
  if (processDate) {
    const d = new Date(processDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/**
 * Emite (o reintenta) una factura. Nunca lanza por un rechazo del PAC: devuelve
 * el estado y deja la factura marcada. `opts.provider` existe para tests.
 */
export async function emitInvoiceWithPac(
  prisma: any,
  companyId: string,
  invoiceId: string,
  opts: { provider?: PacProvider } = {},
): Promise<InvoiceEmission> {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, companyId },
    include: { items: true, client: true },
  });
  if (!invoice) {
    throw Object.assign(new PacError('Factura no encontrada.', 'NOT_FOUND'), { status: 404 });
  }

  if (invoice.pacStatus === 'AUTORIZADA') {
    return {
      status: 'AUTORIZADA',
      message: 'La factura ya estaba autorizada por la DGI.',
      cufe: invoice.cufe ?? undefined,
      documentNumber: invoice.pacDocumentNumber ?? undefined,
      authorizationNumber: invoice.pacAuthorizationNumber ?? undefined,
      pdfUrl: invoice.pacPdfUrl ?? undefined,
      messages: parseMessages(invoice.pacMessages),
      invoice,
    };
  }

  let provider = opts.provider;
  if (!provider) {
    try {
      provider = await getPacProviderForCompany(prisma, companyId);
    } catch (err) {
      const message =
        err instanceof PacError ? err.message : 'No se pudo cargar la configuración del PAC.';
      const updated = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { pacStatus: 'NO_CONFIGURADO', pacLastError: message.slice(0, 1000) },
      });
      return { status: 'NO_CONFIGURADO', message, messages: [], invoice: updated };
    }
  }

  const attempt = (invoice.pacAttempts || 0) + 1;
  // Tras un RECHAZO hace falta un controlId nuevo: el anterior no terminó en un
  // documento autorizado. Tras un ERROR de red se conserva para no duplicar.
  const controlId =
    invoice.pacStatus === 'RECHAZADA' ? `${invoice.id}-r${attempt}` : invoice.id;

  let request: PacInvoiceRequest;
  try {
    request = buildInvoicePacRequest(invoice, { controlId });
  } catch (err) {
    const message =
      err instanceof PacError ? err.message : 'No se pudo preparar la factura electrónica.';
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        pacStatus: 'ERROR',
        pacAttempts: { increment: 1 },
        pacProvider: provider.id,
        pacEnvironment: provider.environment,
        pacLastError: message.slice(0, 1000),
      },
    });
    return { status: 'ERROR', message, messages: [], invoice: updated };
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      pacStatus: 'PENDIENTE',
      pacControlId: controlId,
      pacAttempts: { increment: 1 },
      pacProvider: provider.id,
      pacEnvironment: provider.environment,
      pacLastError: null,
    },
  });

  let result: PacInvoiceResult;
  try {
    result = await provider.issue(request);
  } catch (err) {
    const messages = err instanceof PacError ? err.messages : [];
    const message =
      err instanceof PacError ? err.message : 'Error inesperado al emitir en el PAC.';
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        pacStatus: 'ERROR',
        pacLastError: message.slice(0, 1000),
        pacMessages: messages.length ? JSON.stringify(messages) : null,
      },
    });
    return { status: 'ERROR', message, messages, invoice: updated };
  }

  const autorizada = !result.rejected;
  const message = resumenMensajes(
    result.messages,
    autorizada ? 'Autorizada por la DGI.' : 'Rechazada por la DGI.',
  );

  const updated = await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      pacStatus: autorizada ? 'AUTORIZADA' : 'RECHAZADA',
      cufe: result.cufe ?? null,
      pacDocumentUuid: result.documentUuid ?? null,
      pacDocumentNumber: result.documentNumber ?? null,
      pacAuthorizationNumber: result.authorizationNumber ?? null,
      pacPdfUrl: result.pdfUrl ?? null,
      pacQrData: result.qrCodeData ?? null,
      pacXml: result.xml ?? null,
      pacMessages: result.messages.length ? JSON.stringify(result.messages) : null,
      pacAuthorizedAt: autorizada ? fechaAutorizacion(result.processDate) : null,
      pacLastError: autorizada ? null : message.slice(0, 1000),
    },
  });

  return {
    status: autorizada ? 'AUTORIZADA' : 'RECHAZADA',
    message,
    cufe: result.cufe,
    documentNumber: result.documentNumber,
    authorizationNumber: result.authorizationNumber,
    pdfUrl: result.pdfUrl,
    messages: result.messages,
    invoice: updated,
  };
}
