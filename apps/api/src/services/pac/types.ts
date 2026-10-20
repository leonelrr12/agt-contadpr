/**
 * Contrato neutral de facturación electrónica (PAC / agente autorizado de la DGI).
 *
 * La app no habla con el proveedor: habla con `PacProvider`. Cada PAC implementa
 * esta interfaz y traduce a SU payload. Así, sumar otro proveedor es agregar un
 * archivo en `services/pac/` y una entrada en la factory, sin tocar facturas,
 * asientos ni la UI.
 *
 * Los nombres son deliberadamente neutrales (FACTURA, NOTA_CREDITO, ITBMS_7,
 * CONSUMIDOR_FINAL…) y no los del proveedor. El adaptador es el único que conoce
 * códigos como "FAC", "01" o "X-FF-Company".
 */

/** Identificador del proveedor. Hoy: 'FACTURA_FACIL'. */
export type PacProviderId = string;

export type PacEnvironment = 'PRUEBAS' | 'PRODUCCION';

export type PacDocumentKind = 'FACTURA' | 'NOTA_CREDITO' | 'NOTA_DEBITO' | 'EXPORTACION';

export type PacReceptorType = 'CONTRIBUYENTE' | 'CONSUMIDOR_FINAL' | 'GOBIERNO' | 'EXTRANJERO';

export type PacRucType = 'NATURAL' | 'JURIDICO';

export type PacPaymentType =
  | 'CREDITO'
  | 'EFECTIVO'
  | 'TARJETA_CREDITO'
  | 'TARJETA_DEBITO'
  | 'TARJETA_FIDELIDAD'
  | 'VALE'
  | 'TARJETA_REGALO'
  | 'TRANSFERENCIA'
  | 'CHEQUE'
  | 'PUNTO_DE_VENTA'
  | 'OTRO';

/** Códigos de ITBMS que publica la DGI. El adaptador los traduce al código del PAC. */
export type PacItbmsCode = 'EXENTO' | 'ITBMS_7' | 'ITBMS_10' | 'ITBMS_15';

export type PacSaleType = 'GIRO' | 'ACTIVO_FIJO' | 'BIENES_RAICES' | 'SERVICIOS';

export type PacPaymentTerm = 'CONTADO' | 'CREDITO' | 'MIXTO';

export interface PacProviderConfig {
  provider: PacProviderId;
  /** Base URL del ambiente. En Factura Fácil QA: https://backend-qa-api.facturafacil.com.pa */
  baseUrl: string;
  environment: PacEnvironment;
  /** UUID del emisor que exige el PAC (Factura Fácil: X-FF-Company). */
  companyUuid: string;
  /** API key del emisor (Factura Fácil: X-FF-API-Key). */
  apiKey: string;
  /** Autenticación HTTP Basic, si el proveedor la exige además de la API key. */
  basicUser?: string;
  basicPassword?: string;
  /** Código de sucursal en el cuerpo (Factura Fácil: 4 caracteres). */
  branchCode?: string;
  /** UUID de la sucursal en la cabecera (Factura Fácil: X-FF-Branch). */
  branchUuid?: string;
  /** Punto de venta / punto de emisión (Factura Fácil: 3 dígitos). */
  pos?: string;
  timeoutMs?: number;
}

export interface PacBranch {
  /** Obligatorio si la sucursal se envía en el cuerpo. */
  code?: string;
  address?: string;
  /** Ejemplo: +08.9539,-79.5343 */
  coordinates?: string;
  phone?: string;
  email?: string;
  /** Código compuesto de ubicación PP-DD-CC. */
  location?: string;
}

export interface PacReceptor {
  type: PacReceptorType;
  name: string;
  ruc?: string;
  dv?: string;
  rucType?: PacRucType;
  address?: string;
  /** Ubicación PP-DD-CC. Obligatoria para contribuyente y gobierno. */
  location?: string;
  email?: string;
  /** Solo para receptor extranjero (pasaporte): país ISO-2. */
  country?: string;
}

export type PacItemTax =
  | { kind: 'ITBMS'; code: PacItbmsCode; amount: number }
  | { kind: 'OTI'; code?: string; amount: number }
  | { kind: 'ISC'; amount: number; rate: number };

export interface PacItem {
  line: number;
  description: string;
  quantity: number;
  /** Precio unitario sin impuestos. */
  unitPrice: number;
  /** Descuento en Balboas por unidad (no porcentaje). */
  discount?: number;
  /** Array porque un ítem puede llevar más de un impuesto (ITBMS + ISC, etc.). */
  taxes: PacItemTax[];
  internalCode?: string;
  /** Unidad de medida (Factura Fácil: mu). */
  unit?: string;
  /** Código CPBS/GNS; obligatorio para receptor Gobierno. */
  gns?: string;
}

export interface PacPayment {
  type: PacPaymentType;
  amount: number;
  description?: string;
}

/** Cuota de una factura a crédito (Factura Fácil la exige con payment_term=2). */
export interface PacInstallment {
  /** Fecha de vencimiento, YYYY-MM-DD. */
  expirationDate: string;
  value: number;
  info?: string;
}

export interface PacReferredDocument {
  /** Número fiscal o CUFE del documento referenciado. */
  documentNumber: string;
  /** Fecha del documento referenciado, YYYY-MM-DD. */
  date: string;
}

export interface PacInvoiceRequest {
  /**
   * Identificador de control/idempotencia. El PAC lo usa para detectar envíos
   * repetidos: dos emisiones con el mismo controlId devuelven el mismo documento.
   */
  controlId: string;
  documentKind: PacDocumentKind;
  /** Número fiscal de la serie. 0 = el PAC asigna la secuencia interna. */
  fiscalNumber: number;
  issueDate?: Date;
  pos?: string;
  branch?: PacBranch;
  receptor: PacReceptor;
  items: PacItem[];
  payments: PacPayment[];
  paymentTerm?: PacPaymentTerm;
  /** Cuotas. Obligatorias en el PAC cuando el plazo es CREDITO. */
  installments?: PacInstallment[];
  /** Total con impuestos. Si se omite, el PAC lo calcula a partir de las líneas. */
  total?: number;
  referred?: PacReferredDocument;
  info?: string;
  saleType?: PacSaleType;
  /** Exportación: país de destino (ISO-2). Por defecto PA. */
  destinationCountry?: string;
  exportInfo?: {
    incoterms: string;
    currency?: string;
    currencyDescription?: string;
    exchangeRate?: number;
    value?: number;
    portOfShipment?: string;
  };
}

export interface PacMessage {
  code?: string;
  message: string;
  fieldName?: string;
  path?: string;
  /** R = rechazo, N = notificación. */
  type?: string;
}

export interface PacInvoiceResult {
  /** true = el PAC devolvió el documento pero la DGI lo rechazó. */
  rejected: boolean;
  duplicated?: boolean;
  cufe?: string;
  documentNumber?: string;
  authorizationNumber?: string;
  documentUuid?: string;
  processDate?: string;
  pdfUrl?: string;
  qrCodeData?: string;
  qrImageB64?: string;
  xml?: string;
  messages: PacMessage[];
  /** Respuesta cruda del proveedor, para diagnóstico y archivo. */
  raw: unknown;
}

export interface PacDocumentStatus {
  id: string;
  cufe?: string;
  status?: number;
  statusDisplay?: string;
  createdAt?: string;
  updatedAt?: string;
  xml?: string;
  raw: unknown;
}

export interface PacEventRequest {
  type: 'ANULACION' | 'MODIFICACION';
  cufe: string;
  /** Motivo. Factura Fácil exige un mínimo de 15 caracteres para AN. */
  reason?: string;
  code?: string;
}

export interface PacEventResult {
  rejected?: boolean;
  message?: string;
  digestValue?: string;
  authDate?: string;
  raw: unknown;
}

export type PacErrorCode =
  | 'CONFIG'
  | 'AUTH'
  | 'VALIDATION'
  | 'REJECTED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP'
  | 'UNKNOWN';

export class PacError extends Error {
  constructor(
    message: string,
    readonly code: PacErrorCode,
    readonly status?: number,
    readonly messages: PacMessage[] = [],
    readonly raw?: unknown,
  ) {
    super(message);
    this.name = 'PacError';
  }

  /** Errores que tiene sentido reintentar (red, timeout, 429 o 5xx). */
  get retryable(): boolean {
    return (
      this.code === 'TIMEOUT' ||
      this.code === 'NETWORK' ||
      this.status === 429 ||
      (this.status != null && this.status >= 500)
    );
  }
}

export interface PacProvider {
  readonly id: PacProviderId;
  readonly environment: PacEnvironment;

  /** Emite una FE/NC/ND/exportación. Un rechazo de la DGI NO lanza: viene en `rejected`. */
  issue(req: PacInvoiceRequest): Promise<PacInvoiceResult>;

  /** Consulta por CUFE o UUID. Sirve para idempotencia y para refrescar estados. */
  find(cufeOrId: string): Promise<PacDocumentStatus>;

  /** XML autorizado. */
  downloadXml(documentUuid: string, cufe: string): Promise<Buffer>;

  /** CAFE (PDF con la representación gráfica). */
  downloadCafe(
    documentUuid: string,
    cufe: string,
    opts?: { copies?: number; view?: boolean },
  ): Promise<Buffer>;

  /** Eventos posteriores: anulación, modificación, etc. */
  issueEvent(req: PacEventRequest): Promise<PacEventResult>;
}
