import { describe, it, expect, vi, afterEach } from 'vitest';
import { HkaProvider } from '../pac/hka';
import { PacError } from '../pac/types';
import type { PacInvoiceRequest, PacProviderConfig } from '../pac/types';

/**
 * Traducción del contrato neutral al payload REST de The Factory HKA.
 *
 * Lo que no puede fallar: el login `{usuario, clave}` y el Bearer, los códigos
 * de documento/receptor/forma de pago, los montos con 2 decimales, el total con
 * impuestos y el manejo de errores de negocio (HTTP 200 con `codigo != 200`).
 */

const config = (overrides: Partial<PacProviderConfig> = {}): PacProviderConfig => ({
  provider: 'HKA',
  baseUrl: 'https://demo.test/api',
  environment: 'PRUEBAS',
  companyUuid: '',
  apiKey: '',
  apiUser: 'usuario-integracion',
  apiPassword: 'clave-integracion',
  branchCode: '0000',
  pos: '001',
  timeoutMs: 1000,
  ...overrides,
});

const request = (overrides: Partial<PacInvoiceRequest> = {}): PacInvoiceRequest => ({
  controlId: 'AGT-TEST-1',
  documentKind: 'FACTURA',
  fiscalNumber: 0,
  receptor: { type: 'CONSUMIDOR_FINAL', name: 'CONSUMIDOR FINAL' },
  items: [
    {
      line: 1,
      description: 'SERVICIO DE PRUEBA',
      quantity: 1,
      unitPrice: 10,
      taxes: [{ kind: 'ITBMS', code: 'ITBMS_7', amount: 0.7 }],
    },
  ],
  payments: [{ type: 'EFECTIVO', amount: 10.7 }],
  paymentTerm: 'CONTADO',
  total: 10.7,
  ...overrides,
});

const provider = (overrides: Partial<PacProviderConfig> = {}) =>
  new HkaProvider(config(overrides));

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const authOk = () =>
  jsonResponse({
    codigo: '200',
    mensaje: 'Token generado exitosamente',
    token: 'jwt-1',
    expiracion: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

function stubFetch(handler: (url: string, init: any) => Response | Promise<Response>) {
  const mock = vi.fn(handler);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HkaProvider.preview', () => {
  it('mapea una factura a consumidor final con ITBMS 7%', () => {
    const body: any = provider().preview(request());
    const doc = body.documento;

    expect(doc.codigoSucursalEmisor).toBe('0000');
    expect(doc.tipoSucursal).toBe('1');
    expect(doc.datosTransaccion).toMatchObject({
      tipoEmision: '01',
      tipoDocumento: '01',
      numeroDocumentoFiscal: '0',
      puntoFacturacionFiscal: '001',
      naturalezaOperacion: '01',
      tipoOperacion: '1',
    });
    expect(doc.datosTransaccion.fechaEmision).toMatch(/-05:00$/);
    expect(doc.datosTransaccion.cliente).toEqual({
      tipoClienteFE: '02',
      razonSocial: 'CONSUMIDOR FINAL',
      pais: 'PA',
    });

    expect(doc.listaItems[0]).toMatchObject({
      descripcion: 'SERVICIO DE PRUEBA',
      cantidad: '1.00',
      unidadMedida: 'und',
      precioUnitario: '10.00',
      precioItem: '10.00',
      valorTotal: '10.70',
      tasaITBMS: '01',
      valorITBMS: '0.70',
    });
    expect(doc.totalesSubTotales).toMatchObject({
      totalPrecioNeto: '10.00',
      totalITBMS: '0.70',
      totalMontoGravado: '0.70',
      totalDescuento: '0.00',
      totalFactura: '10.70',
      totalValorRecibido: '10.70',
      vuelto: '0.00',
      tiempoPago: '1',
      nroItems: '1',
      totalTodosItems: '10.70',
    });
    expect(doc.totalesSubTotales.listaFormaPago).toEqual([
      { formaPagoFact: '01', valorCuotaPagada: '10.70' },
    ]);
  });

  it('mapea receptor contribuyente con RUC, DV y ubicación', () => {
    const body: any = provider().preview(
      request({
        receptor: {
          type: 'CONTRIBUYENTE',
          name: 'ACME SA',
          ruc: '123456789-2-2024',
          dv: '12',
          rucType: 'JURIDICO',
          address: 'CALLE 1',
          location: '8-8-8',
          email: 'acme@example.com',
        },
      }),
    );

    expect(body.documento.datosTransaccion.cliente).toEqual({
      tipoClienteFE: '01',
      razonSocial: 'ACME SA',
      pais: 'PA',
      tipoContribuyente: '2',
      numeroRUC: '123456789-2-2024',
      digitoVerificadorRUC: '12',
      direccion: 'CALLE 1',
      codigoUbicacion: '8-8-8',
      correoElectronico1: 'acme@example.com',
    });
  });

  it('exige GNS en cada ítem cuando el receptor es Gobierno', () => {
    expect(() =>
      provider().preview(
        request({
          receptor: {
            type: 'GOBIERNO',
            name: 'MUNICIPIO',
            ruc: '123456789-2-2024',
            dv: '12',
            address: 'CALLE 1',
            location: '8-8-8',
          },
        }),
      ),
    ).toThrowError(/gns/);
  });

  it('mapea gns al código CPBS del ítem', () => {
    const body: any = provider().preview(
      request({
        items: [
          {
            line: 1,
            description: 'SERVICIO',
            quantity: 1,
            unitPrice: 10,
            gns: '8610',
            taxes: [{ kind: 'ITBMS', code: 'ITBMS_7', amount: 0.7 }],
          },
        ],
      }),
    );

    expect(body.documento.listaItems[0].codigoCPBS).toBe('8610');
  });

  it('exige RUC/DV/dirección/ubicación al contribuyente', () => {
    expect(() =>
      provider().preview(
        request({
          receptor: { type: 'CONTRIBUYENTE', name: 'ACME SA', ruc: '123', dv: '12' },
        }),
      ),
    ).toThrowError(/dirección/);
  });

  it('mapea una nota de crédito con el documento referenciado', () => {
    const body: any = provider().preview(
      request({
        documentKind: 'NOTA_CREDITO',
        referred: { documentNumber: 'FE' + 'A'.repeat(64), date: '2026-10-19' },
      }),
    );

    expect(body.documento.datosTransaccion.tipoDocumento).toBe('02');
    expect(body.documento.datosTransaccion.listaDocsFiscalReferenciados[0]).toEqual({
      fechaEmisionDocFiscalReferenciado: '2026-10-19',
      cufeFEReferenciada: 'FE' + 'A'.repeat(64),
    });
  });

  it('rechaza una nota sin documento referenciado antes de llamar al PAC', () => {
    expect(() =>
      provider().preview(request({ documentKind: 'NOTA_CREDITO' })),
    ).toThrowError(/referenciado/);
  });

  it('mapea crédito con cuota y tiempoPago 2', () => {
    const body: any = provider().preview(
      request({
        paymentTerm: 'CREDITO',
        payments: [{ type: 'CREDITO', amount: 10.7 }],
        installments: [{ expirationDate: '2026-11-20', value: 10.7 }],
      }),
    );

    expect(body.documento.totalesSubTotales.tiempoPago).toBe('2');
    expect(body.documento.totalesSubTotales.listaPagoPlazo).toEqual([
      { fechaVenceCuota: '2026-11-20', valorCuota: '10.70' },
    ]);
    expect(body.documento.totalesSubTotales.listaFormaPago[0].formaPagoFact).toBe('06');
  });

  it('mapea transferencia y descuento por ítem', () => {
    const body: any = provider().preview(
      request({
        items: [
          {
            line: 1,
            description: 'SERVICIO',
            quantity: 2,
            unitPrice: 10,
            discount: 1,
            taxes: [{ kind: 'ITBMS', code: 'ITBMS_7', amount: 1.33 }],
          },
        ],
        payments: [{ type: 'TRANSFERENCIA', amount: 19.33 }],
        total: 19.33,
      }),
    );

    const item = body.documento.listaItems[0];
    expect(item).toMatchObject({
      cantidad: '2.00',
      precioUnitario: '10.00',
      precioUnitarioDescuento: '1.00',
      precioItem: '18.00',
      valorTotal: '19.33',
    });
    expect(body.documento.totalesSubTotales.listaFormaPago[0].formaPagoFact).toBe('05');
    expect(body.documento.totalesSubTotales.totalDescuento).toBe('2.00');
  });

  it('exige POS de 3 dígitos y usa el de la config si no viene en el request', () => {
    expect(() => provider({ pos: '01' })).toThrowError(/3 dígitos/);
    const body: any = provider({ pos: '007' }).preview(request());
    expect(body.documento.datosTransaccion.puntoFacturacionFiscal).toBe('007');
  });
});

describe('HkaProvider: autenticación y emisión', () => {
  it('autentica con usuario/clave y emite con Bearer', async () => {
    const llamadas: any[] = [];
    stubFetch((url, init) => {
      llamadas.push({ url, init });
      if (url.endsWith('/Autenticacion')) return authOk();
      if (url.endsWith('/Enviar')) {
        return jsonResponse({
          codigo: '200',
          resultado: 'procesado',
          mensaje: 'Documento procesado',
          cufe: 'FEABC',
          qr: 'https://qr',
          fechaRecepcionDGI: '2026-11-06T10:00:00-05:00',
          nroProtocoloAutorizacion: 'AUTH-1',
        });
      }
      throw new Error(`URL inesperada: ${url}`);
    });

    const result = await provider().issue(request({ fiscalNumber: 123 }));

    expect(llamadas).toHaveLength(2);
    expect(JSON.parse(llamadas[0].init.body)).toEqual({
      usuario: 'usuario-integracion',
      clave: 'clave-integracion',
    });
    expect(llamadas[1].init.headers.Authorization).toBe('Bearer jwt-1');
    expect(result).toMatchObject({
      rejected: false,
      cufe: 'FEABC',
      documentNumber: '123',
      authorizationNumber: 'AUTH-1',
      qrCodeData: 'https://qr',
    });
  });

  it('cachea el JWT entre llamadas', async () => {
    let authCalls = 0;
    stubFetch((url) => {
      if (url.endsWith('/Autenticacion')) {
        authCalls++;
        return authOk();
      }
      return jsonResponse({ codigo: '200', resultado: 'procesado', mensaje: 'ok' });
    });

    const p = provider();
    await p.issue(request());
    await p.issue(request());
    expect(authCalls).toBe(1);
  });

  it('un rechazo de negocio vuelve como rejected, no como excepción', async () => {
    stubFetch((url) => {
      if (url.endsWith('/Autenticacion')) return authOk();
      return jsonResponse({ codigo: '400', resultado: 'error', mensaje: 'RUC inválido' });
    });

    const result = await provider().issue(request());
    expect(result.rejected).toBe(true);
    expect(result.messages[0]).toMatchObject({ code: '400', message: 'RUC inválido' });
  });

  it('un fallo de autenticación lanza PacError AUTH', async () => {
    stubFetch(() =>
      jsonResponse({ codigo: '201', mensaje: 'Error al generar Token' }),
    );

    await expect(provider().issue(request())).rejects.toMatchObject({
      name: 'PacError',
      code: 'AUTH',
    });
  });

  it('renueva el JWT una vez si la llamada devuelve 401', async () => {
    let authCalls = 0;
    let enviarCalls = 0;
    stubFetch((url) => {
      if (url.endsWith('/Autenticacion')) {
        authCalls++;
        return authOk();
      }
      enviarCalls++;
      if (enviarCalls === 1) return jsonResponse({ mensaje: 'expirado' }, 401);
      return jsonResponse({ codigo: '200', resultado: 'procesado', mensaje: 'ok' });
    });

    await provider().issue(request());
    expect(authCalls).toBe(2);
    expect(enviarCalls).toBe(2);
  });
});

describe('HkaProvider: consulta, descarga y anulación', () => {
  it('consulta por número fiscal y mapea el estado', async () => {
    stubFetch((url, init) => {
      if (url.endsWith('/Autenticacion')) return authOk();
      expect(url.endsWith('/EstadoDocumento')).toBe(true);
      expect(JSON.parse(init.body)).toMatchObject({
        codigoSucursalEmisor: '0000',
        numeroDocumentoFiscal: '123',
        puntoFacturacionFiscal: '001',
        tipoDocumento: '01',
        tipoEmision: '01',
      });
      return jsonResponse({
        codigo: '200',
        cufe: 'FEABC',
        estatusDocumento: 'AUTORIZADO',
        fechaEmisionDocumento: '2026-11-06',
        fechaAutorizacion: '2026-11-06',
      });
    });

    const status = await provider().find('123');
    expect(status).toMatchObject({
      id: '123',
      cufe: 'FEABC',
      statusDisplay: 'AUTORIZADO',
    });
  });

  it('descarga XML y PDF desde base64 con el tipo correcto', async () => {
    const tipos: string[] = [];
    stubFetch((url, init) => {
      if (url.endsWith('/Autenticacion')) return authOk();
      const body = JSON.parse(init.body);
      tipos.push(body.tipoArchivo);
      return jsonResponse({
        Codigo: 200,
        Resultado: 'OK',
        Mensaje: 'Archivo',
        Archivo: Buffer.from(`contenido-${body.tipoArchivo}`).toString('base64'),
      });
    });

    const p = provider();
    expect((await p.downloadXml('123', 'FEABC')).toString()).toBe('contenido-XML');
    expect((await p.downloadCafe('123', 'FEABC')).toString()).toBe('contenido-PDF');
    expect(tipos).toEqual(['XML', 'PDF']);
  });

  it('anula con motivo y datos del documento', async () => {
    let body: any;
    stubFetch((url, init) => {
      if (url.endsWith('/Autenticacion')) return authOk();
      body = JSON.parse(init.body);
      return jsonResponse({ codigo: '200', resultado: 'procesado', mensaje: 'Anulado' });
    });

    const result = await provider().issueEvent({
      type: 'ANULACION',
      cufe: 'FEABC',
      documentNumber: '123',
      reason: 'Error en el cliente',
    });

    expect(body).toEqual({
      motivoAnulacion: 'Error en el cliente',
      datosDocumento: {
        codigoSucursalEmisor: '0000',
        numeroDocumentoFiscal: '123',
        puntoFacturacionFiscal: '001',
        tipoDocumento: '01',
        tipoEmision: '01',
      },
    });
    expect(result.rejected).toBe(false);
    expect(result.message).toBe('Anulado');
  });

  it('la prueba de conexión usa FoliosRestantes y reporta los folios', async () => {
    stubFetch((url) => {
      if (url.endsWith('/Autenticacion')) return authOk();
      expect(url.endsWith('/FoliosRestantes')).toBe(true);
      return jsonResponse({
        codigo: '200',
        resultado: 'procesado',
        mensaje: 'Se retorna Licencia y Disponibilidad',
        foliosDisponibleCiclo: '5000',
      });
    });

    const result = await provider().testConnection();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('5000');
  });

  it('la prueba de conexión reporta credenciales inválidas', async () => {
    stubFetch(() => jsonResponse({ codigo: '201', mensaje: 'Token inválido' }));
    const result = await provider().testConnection();
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Token inválido|autenticación/i);
  });

  it('exige usuario y clave en el constructor', () => {
    expect(() => new HkaProvider(config({ apiUser: '' }))).toThrowError(PacError);
    expect(() => new HkaProvider(config({ apiPassword: '' }))).toThrowError(PacError);
  });
});
