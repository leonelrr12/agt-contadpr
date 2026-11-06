/**
 * Adaptador de The Factory HKA (PAC / agente autorizado de la DGI, Panamá).
 *
 * Es el ÚNICO archivo que conoce el contrato REST de HKA: `POST /Autenticacion`
 * devuelve un JWT, y el resto de las operaciones viajan con
 * `Authorization: Bearer <token>`. La app sigue hablando el contrato neutral de
 * `types.ts`, así que sumar otro PAC es otro adaptador + un case en la factory.
 *
 * Ambiente demo: https://demointegracion.thefactoryhka.com.pa/api
 * Swagger:       https://demointegracion.thefactoryhka.com.pa/swagger/v1/swagger.json
 *
 * Notas del proveedor:
 * - Auth: `POST /api/Autenticacion` con `{ usuario, clave }`; el JWT vence a las
 *   ~24 h y se reutiliza hasta poco antes de expirar.
 * - Emisión: `POST /api/Enviar` con `{ documento: { datosTransaccion, listaItems,
 *   totalesSubTotales } }`.
 * - Consulta: `POST /api/EstadoDocumento` por número fiscal (NO por CUFE).
 * - Descarga: `POST /api/Descarga` con `tipoArchivo: "XML" | "PDF"`; el archivo
 *   vuelve en base64 (`Archivo`).
 * - Anulación: `POST /api/Anulacion` con `datosDocumento`.
 * - Folios (test de conexión): `GET /api/FoliosRestantes`.
 * - Los errores de negocio llegan HTTP 200 con `codigo != "200"`; no alcanza
 *   con mirar el status HTTP.
 */
import { PacError } from './types';
import type {
  PacConnectionTest,
  PacDocumentKind,
  PacDocumentStatus,
  PacEnvironment,
  PacEventRequest,
  PacEventResult,
  PacInvoiceRequest,
  PacInvoiceResult,
  PacItem,
  PacItemTax,
  PacItbmsCode,
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

export const HKA = 'HKA';

/** URL base por ambiente. Producción la entrega HKA: se configura por empresa. */
export const HKA_ENDPOINTS: Record<PacEnvironment, string | undefined> = {
  PRUEBAS: 'https://demointegracion.thefactoryhka.com.pa/api',
  PRODUCCION: undefined,
};

/**
 * Códigos del documento. HKA Panamá usa la nomenclatura de la DGI:
 * 01 factura, 02 nota de crédito, 03 nota de débito, 04 exportación.
 */
const DOCUMENT_TYPE: Record<PacDocumentKind, string> = {
  FACTURA: '01',
  NOTA_CREDITO: '02',
  NOTA_DEBITO: '03',
  EXPORTACION: '04',
};

const RECEPTOR_TYPE: Record<PacReceptorType, string> = {
  CONTRIBUYENTE: '01',
  CONSUMIDOR_FINAL: '02',
  GOBIERNO: '03',
  EXTRANJERO: '04',
};

const RUC_TYPE: Record<PacRucType, string> = {
  NATURAL: '1',
  JURIDICO: '2',
};

/**
 * Formas de pago de la DGI. Los tipos que HKA no distingue (vale, tarjeta de
 * regalo, punto de venta) van como "07 Otro" con su descripción.
 */
const PAYMENT_TYPE: Record<PacPaymentType, string> = {
  EFECTIVO: '01',
  TARJETA_CREDITO: '02',
  TARJETA_DEBITO: '03',
  CHEQUE: '04',
  TRANSFERENCIA: '05',
  CREDITO: '06',
  OTRO: '07',
  VALE: '07',
  TARJETA_FIDELIDAD: '07',
  TARJETA_REGALO: '07',
  PUNTO_DE_VENTA: '07',
};

const ITBMS_CODE: Record<PacItbmsCode, string> = {
  EXENTO: '00',
  ITBMS_7: '01',
  ITBMS_10: '02',
  ITBMS_15: '03',
};

const SALE_TYPE: Record<PacSaleType, string> = {
  GIRO: '1',
  ACTIVO_FIJO: '2',
  BIENES_RAICES: '3',
  SERVICIOS: '4',
};

const PAYMENT_TERM: Record<PacPaymentTerm, string> = {
  CONTADO: '1',
  CREDITO: '2',
  MIXTO: '3',
};

const money = (n: number) => n.toFixed(2);

/**
 * HKA espera ISO-8601 con el offset de Panamá (-05:00, sin horario de verano).
 * Se formatea sobre la hora local panameña, no sobre la del servidor.
 */
function formatDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const local = new Date(d.getTime() - 5 * 60 * 60 * 1000);
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}-05:00`
  );
}

function compact<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined || obj[key] === null || obj[key] === '') delete obj[key];
  }
  return obj;
}

function toMessages(data: any): PacMessage[] {
  const mensaje = typeof data?.mensaje === 'string' ? data.mensaje : '';
  if (!mensaje) return [];
  return [
    {
      code: data?.codigo != null ? String(data.codigo) : undefined,
      message: mensaje,
    },
  ];
}

function esExito(codigo: string, resultado: string): boolean {
  return codigo === '200' || /procesado|exito|éxito|success/i.test(resultado);
}

export class HkaProvider implements PacProvider {
  readonly id = HKA;
  readonly environment: PacEnvironment;
  private readonly config: PacProviderConfig;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: PacProviderConfig) {
    if (!config.baseUrl) throw new PacError('Falta la URL base de HKA.', 'CONFIG');
    if (!config.apiUser) {
      throw new PacError('Falta el usuario de integración de HKA (usuario).', 'CONFIG');
    }
    if (!config.apiPassword) {
      throw new PacError('Falta la clave de integración de HKA (clave).', 'CONFIG');
    }
    if (config.pos && !/^\d{3}$/.test(config.pos)) {
      throw new PacError('El punto de facturación (POS) debe tener exactamente 3 dígitos.', 'CONFIG');
    }
    if (config.branchCode && config.branchCode.length !== 4) {
      throw new PacError('El código de sucursal debe tener exactamente 4 caracteres.', 'CONFIG');
    }

    this.config = config;
    this.environment = config.environment;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : 20_000;
  }

  /**
   * Arma el body EXACTO de `/Enviar` sin hacer la llamada. Sirve para tests y
   * para inspeccionar el mapeo antes de emitir.
   */
  preview(req: PacInvoiceRequest): Record<string, unknown> {
    if (!req.items?.length) throw new PacError('La factura no tiene ítems.', 'CONFIG');
    if (!req.payments?.length) throw new PacError('La factura no tiene formas de pago.', 'CONFIG');
    if (req.documentKind === 'NOTA_CREDITO' || req.documentKind === 'NOTA_DEBITO') {
      if (!req.referred) {
        throw new PacError('Las notas de crédito/débito exigen el documento referenciado.', 'CONFIG');
      }
    }
    if (req.receptor.type === 'GOBIERNO' && req.items.some((it) => !it.gns)) {
      throw new PacError('El receptor GOBIERNO exige gns (código CPBS) en cada ítem.', 'CONFIG');
    }

    const items = req.items.map((it) => this.buildItem(it));
    const totales = this.buildTotales(req, items);
    const datosTransaccion = compact({
      tipoEmision: '01',
      tipoDocumento: DOCUMENT_TYPE[req.documentKind],
      numeroDocumentoFiscal: String(req.fiscalNumber),
      puntoFacturacionFiscal: req.pos || this.config.pos || '001',
      fechaEmision: formatDateTime(req.issueDate ?? new Date()),
      naturalezaOperacion: '01',
      tipoOperacion: '1',
      destinoOperacion: '1',
      formatoCAFE: '2',
      entregaCAFE: '3',
      envioContenedor: '1',
      procesoGeneracion: '1',
      tipoVenta: req.saleType ? SALE_TYPE[req.saleType] : undefined,
      informacionInteres: req.info,
      cliente: this.buildCliente(req.receptor),
      datosFacturaExportacion: req.exportInfo
        ? compact({
            condicionesEntrega: req.exportInfo.incoterms,
            monedaOperExportacion: req.exportInfo.currency,
            monedaOperExportacionNonDef: req.exportInfo.currencyDescription,
            tipoDeCambio:
              req.exportInfo.exchangeRate != null ? money(req.exportInfo.exchangeRate) : undefined,
            montoMonedaExtranjera: req.exportInfo.value != null ? money(req.exportInfo.value) : undefined,
            puertoEmbarque: req.exportInfo.portOfShipment,
          })
        : undefined,
      listaDocsFiscalReferenciados: req.referred
        ? [this.buildReferenciado(req.referred)]
        : undefined,
    });

    return {
      documento: compact({
        codigoSucursalEmisor: this.config.branchCode || '0000',
        tipoSucursal: '1',
        datosTransaccion,
        listaItems: items,
        totalesSubTotales: totales,
      }),
    };
  }

  async issue(req: PacInvoiceRequest): Promise<PacInvoiceResult> {
    const body = this.preview(req);
    const res = await this.send('POST', '/Enviar', { body });
    const data = res.json ?? {};
    const codigo = String(data.codigo ?? '');
    const resultado = String(data.resultado ?? '').toLowerCase();
    const messages = toMessages(data);

    if (codigo === '101' || codigo === '201' || /token|autentic/i.test(String(data.mensaje ?? ''))) {
      throw new PacError(
        `HKA rechazó la autenticación al emitir: ${data.mensaje || codigo || 'sin detalle'}`,
        'AUTH',
        res.status,
        messages,
        data,
      );
    }
    if (!codigo && !resultado) {
      throw new PacError('Respuesta inesperada de HKA al emitir.', 'HTTP', res.status, messages, data);
    }

    return {
      rejected: !esExito(codigo, resultado),
      cufe: data.cufe ?? undefined,
      // HKA no devuelve el número fiscal en la respuesta: se conserva el enviado.
      documentNumber: req.fiscalNumber > 0 ? String(req.fiscalNumber) : undefined,
      authorizationNumber: data.nroProtocoloAutorizacion ?? undefined,
      processDate: data.fechaRecepcionDGI ?? undefined,
      qrCodeData: data.qr ?? undefined,
      messages,
      raw: data,
    };
  }

  /**
   * HKA consulta por número fiscal, no por CUFE. El argumento neutral
   * `cufeOrId` se interpreta como `numeroDocumentoFiscal`.
   */
  async find(numeroDocumentoFiscal: string): Promise<PacDocumentStatus> {
    if (!numeroDocumentoFiscal) {
      throw new PacError('Indicá el número fiscal del documento para consultar.', 'CONFIG');
    }
    const res = await this.send('POST', '/EstadoDocumento', {
      body: this.documentData(numeroDocumentoFiscal),
    });
    const data = res.json ?? {};
    const codigo = String(data.codigo ?? '');
    if (codigo !== '200') {
      const notFound = /no (existe|encontrad|registrad)/i.test(String(data.mensaje ?? ''));
      throw new PacError(
        `HKA no devolvió el documento ${numeroDocumentoFiscal}: ${data.mensaje || codigo || 'sin detalle'}`,
        notFound ? 'NOT_FOUND' : 'HTTP',
        res.status,
        toMessages(data),
        data,
      );
    }

    return {
      id: numeroDocumentoFiscal,
      cufe: data.cufe ?? undefined,
      statusDisplay: data.estatusDocumento ?? undefined,
      createdAt: data.fechaEmisionDocumento ?? undefined,
      updatedAt: data.fechaAutorizacion ?? data.fechaRecepcionDocumento ?? undefined,
      raw: data,
    };
  }

  async downloadXml(documentUuid: string, cufe: string): Promise<Buffer> {
    return this.download(documentUuid, cufe, 'XML');
  }

  async downloadCafe(documentUuid: string, cufe: string): Promise<Buffer> {
    return this.download(documentUuid, cufe, 'PDF');
  }

  async issueEvent(req: PacEventRequest): Promise<PacEventResult> {
    if (req.type !== 'ANULACION') {
      throw new PacError('HKA solo soporta anulación de documentos.', 'CONFIG');
    }
    const numeroDocumento = req.documentNumber || '';
    if (!numeroDocumento) {
      throw new PacError(
        'La anulación en HKA exige el número de documento fiscal (documentNumber).',
        'CONFIG',
      );
    }

    const res = await this.send('POST', '/Anulacion', {
      body: {
        motivoAnulacion: req.reason || 'Anulación de documento',
        datosDocumento: this.documentData(numeroDocumento, {
          documentKind: req.documentKind,
          branchCode: req.branchCode,
          pos: req.pos,
          tipoEmision: req.tipoEmision,
        }),
      },
    });
    const data = res.json ?? {};
    const codigo = String(data.codigo ?? '');
    const resultado = String(data.resultado ?? '').toLowerCase();

    return {
      rejected: !esExito(codigo, resultado),
      message: data.mensaje ?? undefined,
      raw: data,
    };
  }

  async testConnection(): Promise<PacConnectionTest> {
    try {
      const res = await this.send('GET', '/FoliosRestantes');
      const data = res.json ?? {};
      const codigo = String(data.codigo ?? '');
      const resultado = String(data.resultado ?? '').toLowerCase();
      const ok = esExito(codigo, resultado);
      return {
        ok,
        message: ok
          ? `Credenciales válidas — folios disponibles: ${data.foliosDisponibleCiclo ?? data.foliosTotalesDisponibles ?? '?'}`
          : `HKA rechazó la consulta: ${data.mensaje || codigo || 'sin detalle'}`,
        status: res.status,
        raw: data,
      };
    } catch (err) {
      if (err instanceof PacError) {
        return { ok: false, message: err.message, status: err.status, raw: err.raw };
      }
      return { ok: false, message: (err as Error)?.message || 'Error al probar HKA.' };
    }
  }

  // ── Autenticación y HTTP ──

  private async authenticate(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const res = await this.rawFetch('/Autenticacion', {
      method: 'POST',
      body: { usuario: this.config.apiUser, clave: this.config.apiPassword },
    });
    const data = res.json ?? {};
    const codigo = String(data.codigo ?? '');
    if (codigo !== '200' || !data.token) {
      throw new PacError(
        `HKA rechazó la autenticación: ${data.mensaje || codigo || 'sin detalle'}`,
        'AUTH',
        res.status,
        toMessages(data),
        data,
      );
    }

    this.token = String(data.token);
    const exp = data.expiracion ? new Date(String(data.expiracion)).getTime() : NaN;
    // Se renueva un minuto antes; si el PAC no manda expiración, 20 minutos.
    this.tokenExpiresAt = Number.isFinite(exp) ? exp - 60_000 : Date.now() + 20 * 60 * 1000;
    return this.token!;
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown } = {},
  ): Promise<{ status: number; json: any; buffer: Buffer }> {
    const requiresAuth = path !== '/Autenticacion';
    let token = requiresAuth ? await this.authenticate() : undefined;
    let res = await this.rawFetch(path, { method, body: opts.body, token });

    // El token pudo vencer entre la validación local y la llamada: se renueva
    // una sola vez para no entrar en un loop de reintentos.
    if (requiresAuth && res.status === 401) {
      token = await this.authenticate(true);
      res = await this.rawFetch(path, { method, body: opts.body, token });
    }

    if (!res.ok) throw this.httpError(res.status, res.json, res.buffer);
    return res;
  }

  private async rawFetch(
    path: string,
    opts: { method: string; body?: unknown; token?: string },
  ): Promise<{ status: number; ok: boolean; json: any; buffer: Buffer }> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new PacError(
          `HKA no respondió en ${this.timeoutMs} ms (${opts.method} ${path}).`,
          'TIMEOUT',
          undefined,
          [],
          err,
        );
      }
      throw new PacError(
        `No se pudo conectar con HKA (${opts.method} ${url}).`,
        'NETWORK',
        undefined,
        [],
        err,
      );
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
    return { status: res.status, ok: res.ok, json, buffer };
  }

  private httpError(status: number, json: any, buffer: Buffer): PacError {
    const messages = toMessages(json);
    const detail =
      json?.mensaje || json?.Mensaje || buffer.toString('utf8').slice(0, 300) || `HTTP ${status}`;

    if (status === 401 || status === 403) {
      return new PacError(`Credenciales o permisos rechazados por HKA: ${detail}`, 'AUTH', status, messages, json);
    }
    if (status === 400 || status === 422) {
      return new PacError(`Validación de HKA: ${detail}`, 'VALIDATION', status, messages, json);
    }
    if (status === 404) {
      return new PacError(`No encontrado en HKA: ${detail}`, 'NOT_FOUND', status, messages, json);
    }
    return new PacError(`Error HTTP ${status} de HKA: ${detail}`, 'HTTP', status, messages, json);
  }

  // ── Mapeo contrato neutral → payload de HKA ──

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

    const descuento = it.discount ?? 0;
    if (descuento >= it.unitPrice) {
      throw new PacError(
        `El descuento del ítem ${it.line} debe ser menor que su precio unitario.`,
        'CONFIG',
      );
    }

    const precioItem = it.quantity * (it.unitPrice - descuento);
    const impuestos = this.taxTotals(it.taxes);

    return compact({
      descripcion: it.description.slice(0, 500),
      codigo: it.internalCode?.slice(0, 20),
      unidadMedida: it.unit?.slice(0, 20) || 'und',
      cantidad: money(it.quantity),
      codigoCPBS: it.gns?.slice(0, 20),
      precioUnitario: money(it.unitPrice),
      precioUnitarioDescuento: money(descuento),
      precioItem: money(precioItem),
      valorTotal: money(precioItem + impuestos.total),
      tasaITBMS: impuestos.tasaITBMS,
      valorITBMS: impuestos.tasaITBMS ? money(impuestos.itbms) : undefined,
      tasaISC: impuestos.tasaISC,
      valorISC: impuestos.tasaISC ? money(impuestos.isc) : undefined,
      listaItemOTI: impuestos.oti.length ? impuestos.oti : undefined,
    });
  }

  private taxTotals(taxes: PacItemTax[]): {
    itbms: number;
    isc: number;
    total: number;
    tasaITBMS?: string;
    tasaISC?: string;
    oti: Record<string, unknown>[];
  } {
    let itbms = 0;
    let isc = 0;
    let tasaITBMS: string | undefined;
    let tasaISC: string | undefined;
    const oti: Record<string, unknown>[] = [];

    for (const t of taxes) {
      if (t.kind === 'ITBMS') {
        tasaITBMS = ITBMS_CODE[t.code];
        itbms += t.amount;
      } else if (t.kind === 'ISC') {
        tasaISC = money(t.rate);
        isc += t.amount;
      } else {
        oti.push(compact({ tasaOTI: t.code, valorTasa: money(t.amount) }));
      }
    }

    return {
      itbms,
      isc,
      total: itbms + isc + oti.reduce((s, o) => s + Number(o.valorTasa), 0),
      tasaITBMS,
      tasaISC,
      oti,
    };
  }

  private buildTotales(req: PacInvoiceRequest, items: Record<string, unknown>[]): Record<string, unknown> {
    let totalPrecioNeto = 0;
    let totalITBMS = 0;
    let totalISC = 0;
    let totalDescuento = 0;
    let totalOTI = 0;

    for (const it of items) {
      totalPrecioNeto += Number(it.precioItem || 0);
      totalITBMS += Number(it.valorITBMS || 0);
      totalISC += Number(it.valorISC || 0);
      totalDescuento += Number(it.cantidad || 0) * Number(it.precioUnitarioDescuento || 0);
      const oti = Array.isArray(it.listaItemOTI) ? (it.listaItemOTI as Record<string, unknown>[]) : [];
      totalOTI += oti.reduce((s, o) => s + Number(o.valorTasa || 0), 0);
    }

    const totalCalculado = totalPrecioNeto + totalITBMS + totalISC + totalOTI;
    const totalFactura = req.total != null ? req.total : totalCalculado;
    const totalRecibido = req.payments.reduce((s, p) => s + p.amount, 0);
    const vuelto = Math.max(0, totalRecibido - totalFactura);

    const listaFormaPago = req.payments.map((p: PacPayment) =>
      compact({
        formaPagoFact: PAYMENT_TYPE[p.type],
        descFormaPago: p.description?.slice(0, 100),
        valorCuotaPagada: money(p.amount),
      }),
    );

    const listaPagoPlazo = (req.installments ?? []).map((i) =>
      compact({
        fechaVenceCuota: i.expirationDate,
        valorCuota: money(i.value),
        infoPagoCuota: i.info,
      }),
    );

    const listaTotalOTI = req.items
      .flatMap((it) => it.taxes.filter((t) => t.kind === 'OTI'))
      .map((t) =>
        compact({
          codigoTotalOTI: t.kind === 'OTI' ? t.code : undefined,
          valorTotalOTI: money(t.amount),
        }),
      );

    return compact({
      totalPrecioNeto: money(totalPrecioNeto),
      totalITBMS: money(totalITBMS),
      totalISC: money(totalISC),
      // En el ejemplo de HKA este campo lleva el monto de los impuestos, no la base.
      totalMontoGravado: money(totalITBMS + totalISC),
      totalDescuento: money(totalDescuento),
      totalFactura: money(totalFactura),
      totalValorRecibido: money(totalRecibido || totalFactura),
      vuelto: money(vuelto),
      tiempoPago: PAYMENT_TERM[req.paymentTerm ?? 'CONTADO'],
      nroItems: String(req.items.length),
      totalTodosItems: money(totalFactura),
      listaFormaPago,
      listaPagoPlazo: listaPagoPlazo.length ? listaPagoPlazo : undefined,
      listaTotalOTI: listaTotalOTI.length ? listaTotalOTI : undefined,
    });
  }

  private buildCliente(r: PacReceptor): Record<string, unknown> {
    if (!r?.name?.trim()) throw new PacError('El receptor necesita un nombre.', 'CONFIG');

    const base = {
      tipoClienteFE: RECEPTOR_TYPE[r.type],
      razonSocial: r.name.slice(0, 200),
      pais: 'PA',
    };

    if (r.type === 'CONSUMIDOR_FINAL') {
      return compact({
        ...base,
        direccion: r.address,
        correoElectronico1: r.email,
      });
    }

    if (r.type === 'EXTRANJERO') {
      return compact({
        ...base,
        pais: r.country || 'PA',
        paisExtranjero: r.country,
        nroIdentificacionExtranjero: r.ruc,
        correoElectronico1: r.email,
      });
    }

    const missing = [
      !r.ruc && 'RUC',
      !r.dv && 'dígito verificador (DV)',
      !r.address && 'dirección',
      !r.location && 'ubicación PP-DD-CC',
    ].filter(Boolean);
    if (missing.length) {
      throw new PacError(`El receptor ${r.type} exige ${missing.join(', ')}.`, 'CONFIG');
    }

    return compact({
      ...base,
      tipoContribuyente: r.rucType ? RUC_TYPE[r.rucType] : undefined,
      numeroRUC: r.ruc,
      digitoVerificadorRUC: r.dv,
      direccion: r.address,
      codigoUbicacion: r.location,
      correoElectronico1: r.email,
    });
  }

  private buildReferenciado(r: { documentNumber: string; date: string }): Record<string, unknown> {
    const numero = String(r.documentNumber || '');
    const esCufe = /^FE[0-9A-F]{64}$/i.test(numero);
    return compact({
      fechaEmisionDocFiscalReferenciado: r.date,
      cufeFEReferenciada: esCufe ? numero : undefined,
      nroFacturaImpFiscal: esCufe ? undefined : numero,
    });
  }

  private documentData(
    numeroDocumentoFiscal: string,
    opts: {
      documentKind?: PacDocumentKind;
      branchCode?: string;
      pos?: string;
      tipoEmision?: string;
    } = {},
  ): Record<string, unknown> {
    return compact({
      codigoSucursalEmisor: opts.branchCode || this.config.branchCode || '0000',
      numeroDocumentoFiscal,
      puntoFacturacionFiscal: opts.pos || this.config.pos || '001',
      tipoDocumento: DOCUMENT_TYPE[opts.documentKind ?? 'FACTURA'],
      tipoEmision: opts.tipoEmision || '01',
    });
  }

  private async download(
    numeroDocumento: string,
    cufe: string,
    tipoArchivo: 'XML' | 'PDF',
  ): Promise<Buffer> {
    if (!numeroDocumento && !cufe) {
      throw new PacError(
        `Para descargar el ${tipoArchivo} hacen falta el número de documento o el CUFE.`,
        'CONFIG',
      );
    }

    const res = await this.send('POST', '/Descarga', {
      body: compact({ cufe, numeroDocumento, tipoArchivo }),
    });
    const data = res.json ?? {};
    const codigo = String(data.Codigo ?? data.codigo ?? '');
    if (codigo !== '200' || !data.Archivo) {
      throw new PacError(
        `HKA no devolvió el ${tipoArchivo}: ${data.Mensaje || data.mensaje || codigo || 'sin detalle'}`,
        'HTTP',
        res.status,
        toMessages({ codigo, mensaje: data.Mensaje || data.mensaje }),
        data,
      );
    }

    return Buffer.from(String(data.Archivo), 'base64');
  }
}
