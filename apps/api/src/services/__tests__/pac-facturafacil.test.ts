import { describe, it, expect } from 'vitest';
import { FacturaFacilProvider } from '../pac/facturafacil';
import { loadPacConfigFromEnv } from '../pac/config';
import { PacError } from '../pac/types';
import type { PacInvoiceRequest, PacProviderConfig } from '../pac/types';

/**
 * Traducción del contrato neutral al payload de Factura Fácil. Lo que NO puede
 * fallar: los códigos (FAC/01/02), los montos como cadena con 2 decimales, el
 * ambiente (QA "2" / producción "1") y las validaciones que el proveedor
 * rechazaría con un 400 genérico (receptor contribuyente sin DV, nota sin
 * documento referenciado, gobierno sin GNS).
 */

const config = (overrides: Partial<PacProviderConfig> = {}): PacProviderConfig => ({
  provider: 'FACTURA_FACIL',
  baseUrl: 'https://backend-qa-api.facturafacil.com.pa',
  environment: 'PRUEBAS',
  companyUuid: '11111111-1111-4111-8111-111111111111',
  apiKey: 'test-key',
  branchUuid: '22222222-2222-4222-8222-222222222222',
  pos: '001',
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

const provider = () => new FacturaFacilProvider(config());

describe('FacturaFacilProvider.preview', () => {
  it('mapea una factura a consumidor final con ITBMS 7%', () => {
    const { header, document: doc } = provider().preview(request());

    expect(header).toMatchObject({ id: 'AGT-TEST-1', environment: '2', pos: '001' });
    expect(doc).toMatchObject({
      fd_number: 0,
      type: 'FAC',
      payment_term: 1,
      total: '10.70',
    });
    // Consumidor final no lleva RUC, DV ni ubicación (el PAC rechaza el RUC).
    expect(doc.receptor).toEqual({ type: '02', name: 'CONSUMIDOR FINAL' });
    expect((doc.items as any[])[0]).toEqual({
      line: 1,
      price: '10.00',
      quantity: '1.00',
      description: 'SERVICIO DE PRUEBA',
      taxes: [{ type: '01', code: '01', amount: '0.70' }],
      discount: '0.00',
    });
    expect(doc.payments).toEqual([{ type: '02', amount: 10.7 }]);
  });

  it('usa environment "1" en producción y "2" en pruebas', () => {
    expect(provider().preview(request()).header.environment).toBe('2');
    expect(
      new FacturaFacilProvider(config({ environment: 'PRODUCCION' })).preview(request()).header
        .environment,
    ).toBe('1');
  });

  it('mapea receptor contribuyente con RUC, DV, dirección, ubicación y tipo', () => {
    const { document: doc } = provider().preview(
      request({
        receptor: {
          type: 'CONTRIBUYENTE',
          name: 'ACME SA',
          ruc: '123456789-2-2024',
          dv: '12',
          rucType: 'JURIDICO',
          address: 'CALLE 1',
          location: '8-8-8',
        },
      }),
    );

    expect(doc.receptor).toEqual({
      type: '01',
      name: 'ACME SA',
      ruc: '123456789-2-2024',
      ruc_type: '2',
      address: 'CALLE 1',
      dv: '12',
      location: '8-8-8',
    });
  });

  it('mapea notas de crédito con su documento referenciado', () => {
    const { document: doc } = provider().preview(
      request({
        documentKind: 'NOTA_CREDITO',
        referred: { documentNumber: 'FE123', date: '2026-10-19' },
      }),
    );

    expect(doc.type).toBe('NTC');
    expect(doc.referred).toEqual({ fd_number: 'FE123', fd_date: '2026-10-19' });
  });

  it('rechaza una nota sin documento referenciado antes de llamar al PAC', () => {
    expect(() => provider().preview(request({ documentKind: 'NOTA_CREDITO' }))).toThrowError(
      /referenciado/,
    );
  });

  it('exige GNS en cada ítem cuando el receptor es Gobierno', () => {
    const req = request({
      receptor: {
        type: 'GOBIERNO',
        name: 'MUNICIPIO',
        ruc: '123456789-2-2024',
        dv: '12',
        address: 'CALLE 1',
        location: '8-8-8',
      },
    });

    expect(() => provider().preview(req)).toThrowError(/gns/);
  });

  it('exige la descripción larga para la forma de pago "OTRO"', () => {
    const req = request({ payments: [{ type: 'OTRO', amount: 10.7, description: 'corto' }] });
    expect(() => provider().preview(req)).toThrow(PacError);
  });

  it('usa el código de sucursal en el cuerpo si no hay UUID de sucursal', () => {
    const p = new FacturaFacilProvider(config({ branchUuid: undefined, branchCode: '0001' }));
    expect(p.preview(request()).header.branch).toEqual({ code: '0001' });
  });

  it('se niega a emitir sin sucursal configurada', () => {
    const p = new FacturaFacilProvider(config({ branchUuid: undefined, branchCode: undefined }));
    expect(() => p.preview(request())).toThrowError(/sucursal/);
  });

  it('exige POS de 3 dígitos', () => {
    const p = new FacturaFacilProvider(config({ pos: '01' }));
    expect(() => p.preview(request())).toThrowError(/3 dígitos/);
  });
});

describe('loadPacConfigFromEnv', () => {
  it('lista las variables faltantes', () => {
    expect(() => loadPacConfigFromEnv({} as NodeJS.ProcessEnv)).toThrowError(
      /PAC_COMPANY_UUID, PAC_API_KEY/,
    );
  });

  it('cae al QA de Factura Fácil por defecto', () => {
    const c = loadPacConfigFromEnv({
      PAC_COMPANY_UUID: 'uuid',
      PAC_API_KEY: 'key',
    } as NodeJS.ProcessEnv);

    expect(c.provider).toBe('FACTURA_FACIL');
    expect(c.environment).toBe('PRUEBAS');
    expect(c.baseUrl).toBe('https://backend-qa-api.facturafacil.com.pa');
    expect(c.pos).toBe('001');
  });

  it('exige usuario y contraseña Basic juntos', () => {
    expect(() =>
      loadPacConfigFromEnv({
        PAC_COMPANY_UUID: 'uuid',
        PAC_API_KEY: 'key',
        PAC_BASIC_USER: 'user',
      } as NodeJS.ProcessEnv),
    ).toThrowError(/juntas/);
  });
});
