/**
 * Adaptador de Factura Fácil (PAC / agente autorizado de la DGI).
 *
 * Es el ÚNICO archivo que conoce los códigos del proveedor: "FAC"/"NTC"/"NTD",
 * "01"/"02", "X-FF-Company", "X-FF-API-Key", etc. El resto de la app usa el
 * contrato neutral de `types.ts`.
 *
 * Contrato: https://backend-qa-api.facturafacil.com.pa/swagger/
 * (copia local: docs/facturafacil.openapi.json)
 *
 * Notas del proveedor:
 * - Auth: HTTP Basic + `X-FF-Company` (UUID del emisor) + `X-FF-API-Key`.
 * - Sucursal: `X-FF-Branch` (UUID) o `header.branch.code` (4 caracteres).
 * - Ambiente: header.environment "1" = producción, "2" = pruebas.
 * - `fd_number`: 0 usa la secuencia interna del PAC.
 */
import { PacError } from './types';
import type {
  PacDocumentKind,
  PacDocumentStatus,
  PacEnvironment,
  PacEventRequest,
  PacEventResult,
  PacInvoiceRequest,
  PacInvoiceResult,
  PacItem,
  PacItemTax,
  PacMessage,
  PacPayment,
  PacPaymentTerm,
  PacPaymentType,
  PacProvider,
  PacProviderConfig,
  PacReceptor,
  PacReceptorType,
  PacRucType,
  PacSaleType,
} from './types';

export const FACTURA_FACIL = 'FACTURA_FACIL';

/** URL base por ambiente. En Factura Fácil QA y producción son hosts distintos. */
export const FACTURA_FACIL_ENDPOINTS: Record<PacEnvironment, string> = {
  PRUEBAS: 'https://backend-qa-api.facturafacil.com.pa',
  PRODUCCION: 'https://api.facturafacil.com.pa',
};

const DOCUMENT_TYPE: Record<Exclude<PacDocumentKind, 'EXPORTACION'>, 'FAC' | 'NTC' | 'NTD'> = {
  FACTURA: 'FAC',
  NOTA_CREDITO: 'NTC',
  NOTA_DEBITO: 'NTD',
};

const RECEPTOR_TYPE: Record<PacReceptorType, '01' | '02' | '03' | '04'> = {
  CONTRIBUYENTE: '01',
  CONSUMIDOR_FINAL: '02',
  GOBIERNO: '03',
  EXTRANJERO: '04',
};

const RUC_TYPE: Record<PacRucType, '1' | '2'> = {
  NATURAL: '1',
  JURIDICO: '2',
};

const PAYMENT_TYPE: Record<PacPaymentType, string> = {
  CREDITO: '01',
  EFECTIVO: '02',
  TARJETA_CREDITO: '03',
  TARJETA_DEBITO: '04',
  TARJETA_FIDELIDAD: '05',
  VALE: '06',
  TARJETA_REGALO: '07',
  TRANSFERENCIA: '08',
  CHEQUE: '09',
  PUNTO_DE_VENTA: '10',
  OTRO: '99',
};

const ITBMS_CODE: Record<'EXENTO' | 'ITBMS_7' | 'ITBMS_10' | 'ITBMS_15', string> = {
  EXENTO: '00',
  ITBMS_7: '01',
  ITBMS_10: '02',
  ITBMS_15: '03',
};

const SALE_TYPE: Record<PacSaleType, '1' | '2' | '3' | '4'> = {
  GIRO: '1',
  ACTIVO_FIJO: '2',
  BIENES_RAICES: '3',
  SERVICIOS: '4',
};

const PAYMENT_TERM: Record<PacPaymentTerm, 1 | 2 | 3> = {
  CONTADO: 1,
  CREDITO: 2,
  MIXTO: 3,
};

/** Monto como cadena con 2 decimales (formato que exige el proveedor). */
const money = (n: number) => n.toFixed(2);

/** Fecha/hora local en el formato "YYYY-MM-DD H:M:S" del proveedor. */
function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') delete obj[key];
  }
  return obj;
}

function toMessages(data: any): PacMessage[] {
  const raw = Array.isArray(data?.messages) ? data.messages : [];
  return raw.map((m: any) => ({
    code: m?.code != null ? String(m.code) : undefined,
    message: String(m?.message ?? m ?? ''),
    fieldName: m?.field_name ?? undefined,
    path: m?.path ?? undefined,
    type: m?.type ?? undefined,
  }));
}

function describeMessages(messages: PacMessage[], fallback: string): string {
  if (!messages.length) return fallback;
  return messages
    .map((m) => `[${m.code ?? '-'}] ${m.message}${m.path ? ` (${m.path})` : ''}`)
    .join(' · ');
}

export class FacturaFacilProvider implements PacProvider {
  readonly id = FACTURA_FACIL;
  readonly environment: PacEnvironment;
  private readonly config: PacProviderConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: PacProviderConfig) {
    if (!config.baseUrl) throw new PacError('Falta la URL base del PAC.', 'CONFIG');
    if (!config.companyUuid) {
      throw new PacError('Falta el UUID del emisor (X-FF-Company) en la configuración.', 'CONFIG');
    }
    if (!config.apiKey) throw new PacError('Falta la API key del emisor (X-FF-API-Key).', 'CONFIG');

    this.config = config;
    this.environment = config.environment;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 20_000;
  }

  /**
   * Arma el payload EXACTO que se enviaría, sin hacer la llamada. Sirve para
   * dry-run, para el smoke y para testear el mapeo sin credenciales.
   */
  preview(req: PacInvoiceRequest): {
    header: Record<string, unknown>;
    document: Record<string, unknown>;
  } {
    return { header: this.buildHeader(req), document: this.buildDocument(req) };
  }

  async issue(req: PacInvoiceRequest): Promise<PacInvoiceResult> {
    const body = this.preview(req);
    const res = await this.send('POST', '/api/pac/reception_fe/detailed/', { body });
    const data = res.json ?? {};

    return {
      rejected: Boolean(data.rejected),
      duplicated: data.duplicated != null ? Boolean(data.duplicated) : undefined,
      cufe: data.cufe ?? undefined,
      documentNumber: data.document_number ?? undefined,
      authorizationNumber: data.authorization_number ?? undefined,
      documentUuid: data.document_uuid ?? undefined,
      processDate: data.process_date ?? undefined,
      pdfUrl: data.pdf_url ?? undefined,
      qrCodeData: data.qr_code_data ?? undefined,
      qrImageB64: data.qr_image_b64 ?? undefined,
      xml: data.xml ?? undefined,
      messages: toMessages(data),
      raw: data,
    };
  }

  async find(cufeOrId: string): Promise<PacDocumentStatus> {
    if (!cufeOrId) throw new PacError('Indicá un CUFE o UUID para consultar.', 'CONFIG');
    const res = await this.send('GET', '/api/pac/reception_fe/find_by_cufe_or_id/', {
      query: { cufe_or_id: cufeOrId },
    });
    const data = res.json;
    // El endpoint puede devolver el objeto, un array o una página { data: [...] }.
    const row = Array.isArray(data) ? data[0] : (data?.data?.[0] ?? data);

    if (!row || (!row.id && !row.cufe)) {
      throw new PacError('Respuesta inesperada al consultar el documento en el PAC.', 'HTTP', res.status, [], data);
    }

    return {
      id: row.id,
      cufe: row.cufe ?? undefined,
      status: row.status ?? undefined,
      statusDisplay: row.status_display ?? undefined,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined,
      xml: row.xml_data ?? undefined,
      raw: data,
    };
  }

  async downloadXml(documentUuid: string, cufe: string): Promise<Buffer> {
    if (!documentUuid || !cufe) {
      throw new PacError('Para descargar el XML hacen falta el UUID del documento y el CUFE.', 'CONFIG');
    }
    const res = await this.send(
      'GET',
      `/api/pac/reception_fe/${encodeURIComponent(documentUuid)}/download_xml/`,
      { query: { cufe }, accept: 'application/xml' },
    );
    return res.buffer;
  }

  async downloadCafe(
    documentUuid: string,
    cufe: string,
    opts: { copies?: number; view?: boolean } = {},
  ): Promise<Buffer> {
    if (!documentUuid || !cufe) {
      throw new PacError('Para descargar el CAFE hacen falta el UUID del documento y el CUFE.', 'CONFIG');
    }
    const res = await this.send(
      'GET',
      `/api/pac/reception_fe/${encodeURIComponent(documentUuid)}/download_cafe/`,
      {
        query: { cufe, copies: opts.copies, view: opts.view },
        accept: 'application/pdf',
      },
    );
    return res.buffer;
  }

  async issueEvent(req: PacEventRequest): Promise<PacEventResult> {
    if (!req.cufe) throw new PacError('El evento exige el CUFE del documento.', 'CONFIG');
    if (req.reason != null && req.reason.length > 0 && req.reason.length < 15) {
      throw new PacError('El motivo del evento debe tener al menos 15 caracteres.', 'CONFIG');
    }

    const body = compact({
      type: req.type === 'ANULACION' ? 'AN' : 'MF',
      cufe: req.cufe,
      reason: req.reason,
      code: req.code,
    });

    const res = await this.send('POST', '/api/pac/event/issue/', { body });
    const data = res.json ?? {};
    return {
      rejected: data.rejected != null ? Boolean(data.rejected) : undefined,
      message: data.message ?? undefined,
      digestValue: data.digest_value ?? undefined,
      authDate: data.auth_date ?? undefined,
      raw: data,
    };
  }

  // ── Mapeo contrato neutral → payload del proveedor ──

  private buildHeader(req: PacInvoiceRequest): Record<string, unknown> {
    if (!req.controlId) {
      throw new PacError('La emisión exige un controlId (idempotencia del envío).', 'CONFIG');
    }

    const header: Record<string, unknown> = compact({
      id: req.controlId,
      environment: this.config.environment === 'PRUEBAS' ? '2' : '1',
      issue_date: req.issueDate ? formatDateTime(req.issueDate) : undefined,
      pos: req.pos ?? this.config.pos ?? '001',
    });

    const branch = req.branch ?? (this.config.branchCode ? { code: this.config.branchCode } : undefined);
    if (branch) {
      if (!branch.code) {
        throw new PacError(
          'La sucursal en el cuerpo exige branch.code (4 caracteres). Alternativa: configurar el UUID de sucursal (X-FF-Branch).',
          'CONFIG',
        );
      }
      header.branch = compact({
        code: branch.code,
        address: branch.address,
        coordinates: branch.coordinates,
        phone: branch.phone,
        email: branch.email,
        location: branch.location,
      });
    } else if (!this.config.branchUuid) {
      throw new PacError(
        'Falta la sucursal emisora: configurá el UUID de sucursal (X-FF-Branch) o el código de sucursal.',
        'CONFIG',
      );
    }

    if (!/^\d{3}$/.test(String(header.pos))) {
      throw new PacError('El punto de venta (POS) debe tener exactamente 3 dígitos.', 'CONFIG');
    }

    return header;
  }

  private buildDocument(req: PacInvoiceRequest): Record<string, unknown> {
    if (!Number.isInteger(req.fiscalNumber) || req.fiscalNumber < 0 || req.fiscalNumber > 9_999_999_999) {
      throw new PacError('El número fiscal debe ser un entero entre 0 y 9,999,999,999 (0 = secuencia interna).', 'CONFIG');
    }
    if (!req.items?.length) throw new PacError('La factura no tiene ítems.', 'CONFIG');
    if (!req.payments?.length) throw new PacError('La factura no tiene formas de pago.', 'CONFIG');

    this.validateReceptor(req.receptor, req.items);

    const isNote = req.documentKind === 'NOTA_CREDITO' || req.documentKind === 'NOTA_DEBITO';
    if (isNote && !req.referred) {
      throw new PacError('Las notas de crédito/débito exigen el documento referenciado.', 'CONFIG');
    }
    if (req.documentKind === 'EXPORTACION') {
      if (!req.exportInfo?.incoterms) {
        throw new PacError('La exportación exige exportInfo.incoterms.', 'CONFIG');
      }
      if (!req.destinationCountry || req.destinationCountry === 'PA') {
        throw new PacError('La exportación exige un país de destino distinto de PA.', 'CONFIG');
      }
    }

    const doc: Record<string, unknown> = {
      fd_number: req.fiscalNumber,
      type: req.documentKind === 'EXPORTACION' ? 'FAC' : DOCUMENT_TYPE[req.documentKind],
      receptor: this.buildReceptor(req.receptor),
      items: req.items.map((it) => this.buildItem(it)),
      payments: req.payments.map((p) => this.buildPayment(p)),
      payment_term: PAYMENT_TERM[req.paymentTerm ?? 'CONTADO'],
    };

    if (req.saleType) doc.sale_type = SALE_TYPE[req.saleType];
    if (req.info) doc.info = req.info.slice(0, 5000);
    if (req.total != null) doc.total = money(req.total);
    if (req.installments?.length) {
      doc.installments = req.installments.map((i) =>
        compact({
          expiration_date: i.expirationDate,
          value: money(i.value),
          info: i.info,
        }),
      );
    }
    if (req.destinationCountry) doc.dest_country = req.destinationCountry;
    if (req.exportInfo) {
      doc.export_info = compact({
        incoterms: req.exportInfo.incoterms,
        currency: req.exportInfo.currency,
        currency_desc: req.exportInfo.currencyDescription,
        exchange_rate: req.exportInfo.exchangeRate != null ? money(req.exportInfo.exchangeRate) : undefined,
        value: req.exportInfo.value != null ? money(req.exportInfo.value) : undefined,
        port_of_shipment: req.exportInfo.portOfShipment,
      });
    }
    if (req.referred) {
      doc.referred = { fd_number: req.referred.documentNumber, fd_date: req.referred.date };
    }

    return doc;
  }

  private buildReceptor(r: PacReceptor): Record<string, unknown> {
    const receptor = compact({
      type: RECEPTOR_TYPE[r.type],
      name: r.name,
      ruc: r.type === 'CONSUMIDOR_FINAL' ? undefined : r.ruc,
      ruc_type: r.rucType ? RUC_TYPE[r.rucType] : undefined,
      address: r.address,
      email: r.email,
      dv: r.type === 'CONSUMIDOR_FINAL' ? undefined : r.dv,
      location: r.type === 'CONSUMIDOR_FINAL' ? undefined : r.location,
      country: r.country,
    });
    return receptor;
  }

  private buildItem(it: PacItem): Record<string, unknown> {
    if (!Number.isInteger(it.line) || it.line < 1) {
      throw new PacError('Cada ítem debe llevar un número de línea entero (>= 1).', 'CONFIG');
    }
    if (!it.description || it.description.trim().length < 2) {
      throw new PacError(`El ítem ${it.line} necesita una descripción de al menos 2 caracteres.`, 'CONFIG');
    }
    if (!(it.quantity > 0)) {
      throw new PacError(`La cantidad del ítem ${it.line} debe ser mayor que cero.`, 'CONFIG');
    }
    if (!(it.unitPrice >= 0)) {
      throw new PacError(`El precio del ítem ${it.line} debe ser mayor o igual a 0.`, 'CONFIG');
    }

    const item = compact({
      line: it.line,
      price: money(it.unitPrice),
      quantity: money(it.quantity),
      internal_code: it.internalCode?.slice(0, 20),
      description: it.description.slice(0, 500),
      mu: it.unit?.slice(0, 20),
      taxes: it.taxes.map(taxToFf),
      // El proveedor lo exige siempre; 0.00 = sin descuento.
      discount: money(it.discount ?? 0),
      gns: it.gns?.slice(0, 4),
    });

    if (it.discount != null && it.discount >= it.unitPrice) {
      throw new PacError(`El descuento del ítem ${it.line} debe ser menor que su precio unitario.`, 'CONFIG');
    }

    return item;
  }

  private buildPayment(p: PacPayment): Record<string, unknown> {
    if (!(p.amount >= 0)) {
      throw new PacError('El monto de cada forma de pago debe ser mayor o igual a 0.', 'CONFIG');
    }
    if (p.type === 'OTRO' && (!p.description || p.description.length < 10)) {
      throw new PacError('La forma de pago "OTRO" exige una descripción de al menos 10 caracteres.', 'CONFIG');
    }
    return compact({
      type: PAYMENT_TYPE[p.type],
      amount: p.amount,
      description: p.description?.slice(0, 100),
    });
  }

  private validateReceptor(r: PacReceptor, items: PacItem[]): void {
    if (!r?.name?.trim()) throw new PacError('El receptor necesita un nombre.', 'CONFIG');
    if (r.type === 'CONTRIBUYENTE' || r.type === 'GOBIERNO') {
      const missing = [
        !r.ruc && 'RUC',
        !r.dv && 'dígito verificador (DV)',
        !r.address && 'dirección',
        !r.location && 'ubicación PP-DD-CC',
      ].filter(Boolean);
      if (missing.length) {
        throw new PacError(
          `El receptor ${r.type} exige ${missing.join(', ')}.`,
          'CONFIG',
        );
      }
    }
    if (r.type === 'GOBIERNO' && items.some((it) => !it.gns)) {
      throw new PacError('El receptor GOBIERNO exige gns (código CPBS) en cada ítem.', 'CONFIG');
    }
  }

  // ── HTTP ──

  private async send(
    method: 'GET' | 'POST',
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      accept?: string;
    } = {},
  ): Promise<{ status: number; json: any; buffer: Buffer }> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: opts.accept ?? 'application/json',
      'X-FF-Company': this.config.companyUuid,
      'X-FF-API-Key': this.config.apiKey,
    };
    if (this.config.branchUuid) headers['X-FF-Branch'] = this.config.branchUuid;
    if (this.config.basicUser && this.config.basicPassword) {
      headers.Authorization =
        'Basic ' + Buffer.from(`${this.config.basicUser}:${this.config.basicPassword}`).toString('base64');
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new PacError(`El PAC no respondió en ${this.timeoutMs} ms (${method} ${url.pathname}).`, 'TIMEOUT', undefined, [], err);
      }
      throw new PacError(`No se pudo conectar con el PAC (${method} ${url.host}${url.pathname}).`, 'NETWORK', undefined, [], err);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    let json: any = null;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('json') || (buffer.length > 0 && buffer[0] === 0x7b)) {
      try {
        json = JSON.parse(buffer.toString('utf8'));
      } catch {
        // Respuesta no-JSON: se conserva el buffer para el diagnóstico.
      }
    }

    if (!res.ok) throw this.httpError(res.status, json, buffer);
    return { status: res.status, json, buffer };
  }

  private httpError(status: number, json: any, buffer: Buffer): PacError {
    const messages = toMessages(json);
    const detail = typeof json?.detail === 'string' ? json.detail : undefined;
    const fallback = buffer.toString('utf8').slice(0, 300) || `HTTP ${status}`;
    const text = describeMessages(messages, detail || fallback);

    if (status === 400 || status === 422) {
      return new PacError(`Validación del PAC: ${text}`, 'VALIDATION', status, messages, json);
    }
    if (status === 401 || status === 403) {
      return new PacError(`Credenciales o permisos rechazados por el PAC: ${text}`, 'AUTH', status, messages, json);
    }
    if (status === 404) {
      return new PacError(`No encontrado en el PAC: ${text}`, 'NOT_FOUND', status, messages, json);
    }
    if (status === 409) {
      return new PacError(`Documento duplicado o en conflicto: ${text}`, 'REJECTED', status, messages, json);
    }
    return new PacError(`Error HTTP ${status} del PAC: ${text}`, 'HTTP', status, messages, json);
  }
}

function taxToFf(t: PacItemTax): Record<string, unknown> {
  if (t.kind === 'ITBMS') {
    return { type: '01', code: ITBMS_CODE[t.code], amount: money(t.amount) };
  }
  if (t.kind === 'OTI') {
    return compact({ type: '02', code: t.code, amount: money(t.amount) });
  }
  return { type: '03', amount: money(t.amount), rate: money(t.rate) };
}
