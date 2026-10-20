import { describe, it, expect } from 'vitest';
import { buildInvoicePacRequest, emitInvoiceWithPac } from '../pac/emit-invoice';
import { PacError } from '../pac/types';

/**
 * Puente factura local → PAC. Lo crítico: el receptor contribuyente exige
 * DV/dirección/ubicación, la tasa de ITBMS se traduce a CÓDIGO (no solo monto),
 * y un rechazo/error deja la factura marcada sin revertir nada.
 */

const invoiceBase = (overrides: any = {}) => ({
  id: 'inv-1',
  companyId: 'c-1',
  number: 'A-000001',
  description: 'Venta de prueba',
  amount: 100,
  itbms: 7,
  total: 107,
  itbmsRate: 0.07,
  date: new Date('2026-10-20T12:00:00'),
  paymentMethod: 'EFECTIVO',
  pacStatus: 'NO_CONFIGURADO',
  pacAttempts: 0,
  items: [{ descripcion: 'Servicio de prueba', cantidad: 1, precio: 100, itbms: 7 }],
  client: {
    name: 'CONSUMIDOR FINAL',
    taxId: null,
    dv: null,
    address: null,
    location: null,
    email: null,
  },
  ...overrides,
});

const clienteContribuyente = (extra: any = {}) => ({
  name: 'ACME SA',
  taxId: '8-733-2267-88',
  dv: null,
  address: 'CALLE 1',
  location: '8-8-8',
  email: 'acme@example.com',
  ...extra,
});

function fakePrisma(invoice: any) {
  let current = { ...invoice };
  const updates: any[] = [];
  return {
    invoice: {
      findFirst: async () => current,
      update: async ({ data }: any) => {
        updates.push(data);
        const next: any = { ...current };
        for (const [k, v] of Object.entries(data)) {
          if (k === 'pacAttempts' && v && typeof v === 'object' && 'increment' in (v as any)) {
            next.pacAttempts = (next.pacAttempts || 0) + (v as any).increment;
          } else {
            next[k] = v;
          }
        }
        current = next;
        return current;
      },
    },
    updates: () => updates,
    actual: () => current,
  } as any;
}

function fakeProvider(resultOrError: any) {
  let lastRequest: any = null;
  let calls = 0;
  return {
    id: 'FACTURA_FACIL',
    environment: 'PRUEBAS',
    issue: async (req: any) => {
      calls++;
      lastRequest = req;
      if (resultOrError instanceof Error) throw resultOrError;
      return resultOrError;
    },
    find: async () => {
      throw new PacError('no encontrado', 'NOT_FOUND', 404);
    },
    downloadXml: async () => Buffer.from(''),
    downloadCafe: async () => Buffer.from(''),
    issueEvent: async () => ({ raw: {} }),
    lastRequest: () => lastRequest,
    calls: () => calls,
  } as any;
}

const resultadoAutorizado = () => ({
  rejected: false,
  cufe: 'FE0123456789012345678901234567890123456789012345678901234567890123',
  documentUuid: '11111111-1111-4111-8111-111111111111',
  documentNumber: '0000000001',
  authorizationNumber: 'AUTH-1',
  processDate: '2026-10-20T12:30:00',
  pdfUrl: 'https://pac/pdf',
  qrCodeData: 'QR-DATA',
  xml: '<xml/>',
  messages: [],
  raw: {},
});

describe('buildInvoicePacRequest', () => {
  it('mapea consumidor final con ITBMS 7% y pago de contado', () => {
    const req = buildInvoicePacRequest(invoiceBase());

    expect(req.receptor).toEqual({ type: 'CONSUMIDOR_FINAL', name: 'CONSUMIDOR FINAL' });
    expect(req.fiscalNumber).toBe(0);
    expect(req.items[0]).toMatchObject({
      line: 1,
      description: 'Servicio de prueba',
      quantity: 1,
      unitPrice: 100,
      discount: 0,
      taxes: [{ kind: 'ITBMS', code: 'ITBMS_7', amount: 7 }],
    });
    expect(req.payments).toEqual([{ type: 'EFECTIVO', amount: 107 }]);
    expect(req.paymentTerm).toBe('CONTADO');
    expect(req.total).toBe(107);
  });

  it('una factura a crédito usa pago, plazo CREDITO y una cuota', () => {
    const req = buildInvoicePacRequest(
      invoiceBase({
        paymentMethod: 'CREDITO',
        dueDate: new Date('2026-11-19T12:00:00'),
      }),
    );
    expect(req.payments[0].type).toBe('CREDITO');
    expect(req.paymentTerm).toBe('CREDITO');
    expect(req.installments).toEqual([{ expirationDate: '2026-11-19', value: 107 }]);
  });

  it('separa el DV cuando el RUC lo trae pegado', () => {
    const req = buildInvoicePacRequest(
      invoiceBase({ client: clienteContribuyente() }),
    );
    expect(req.receptor).toEqual({
      type: 'CONTRIBUYENTE',
      name: 'ACME SA',
      ruc: '8-733-2267',
      dv: '88',
      address: 'CALLE 1',
      location: '8-8-8',
      email: 'acme@example.com',
    });
  });

  it('usa el DV guardado cuando el RUC no lo trae (jurídico con año al final)', () => {
    const req = buildInvoicePacRequest(
      invoiceBase({
        client: clienteContribuyente({ taxId: '123456789-2-2024', dv: '42' }),
      }),
    );
    expect(req.receptor).toMatchObject({ ruc: '123456789-2-2024', dv: '42' });
  });

  it('exige DV, dirección y ubicación al contribuyente', () => {
    expect(() =>
      buildInvoicePacRequest(
        invoiceBase({ client: clienteContribuyente({ taxId: '123456789-2-2024' }) }),
      ),
    ).toThrowError(/falta el DV/);

    expect(() =>
      buildInvoicePacRequest(
        invoiceBase({ client: clienteContribuyente({ address: '' }) }),
      ),
    ).toThrowError(/dirección/);

    expect(() =>
      buildInvoicePacRequest(
        invoiceBase({ client: clienteContribuyente({ location: '' }) }),
      ),
    ).toThrowError(/ubicación/);

    expect(() =>
      buildInvoicePacRequest(
        invoiceBase({ client: clienteContribuyente({ location: '888' }) }),
      ),
    ).toThrowError(/PP-DD-CC/);
  });

  it('una factura sin ITBMS viaja como EXENTO', () => {
    const req = buildInvoicePacRequest(
      invoiceBase({ itbms: 0, total: 100, items: [{ descripcion: 'Servicio exento', cantidad: 1, precio: 100, itbms: 0 }] }),
    );
    expect((req.items[0].taxes as any[])[0]).toEqual({
      kind: 'ITBMS',
      code: 'EXENTO',
      amount: 0,
    });
  });

  it('rechaza una tasa de ITBMS que la DGI no soporta', () => {
    expect(() => buildInvoicePacRequest(invoiceBase({ itbmsRate: 0.05 }))).toThrowError(
      /no soportada/,
    );
  });
});

describe('emitInvoiceWithPac', () => {
  it('guarda CUFE, UUID y XML cuando la factura se autoriza', async () => {
    const prisma = fakePrisma(invoiceBase());
    const provider = fakeProvider(resultadoAutorizado());

    const emision = await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(emision.status).toBe('AUTORIZADA');
    expect(prisma.actual().pacStatus).toBe('AUTORIZADA');
    expect(prisma.actual().cufe).toBe(resultadoAutorizado().cufe);
    expect(prisma.actual().pacDocumentUuid).toBe(resultadoAutorizado().documentUuid);
    expect(prisma.actual().pacXml).toBe('<xml/>');
    expect(prisma.actual().pacAttempts).toBe(1);
    expect(prisma.actual().pacEnvironment).toBe('PRUEBAS');
  });

  it('marca RECHAZADA y guarda el mensaje de la DGI', async () => {
    const prisma = fakePrisma(invoiceBase());
    const provider = fakeProvider({
      rejected: true,
      messages: [{ code: '01', message: 'RUC del receptor inválido', type: 'R' }],
      raw: {},
    });

    const emision = await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(emision.status).toBe('RECHAZADA');
    expect(prisma.actual().pacStatus).toBe('RECHAZADA');
    expect(prisma.actual().pacLastError).toContain('RUC del receptor inválido');
    expect(prisma.actual().pacAuthorizedAt).toBeNull();
  });

  it('marca ERROR y no revierte la factura si el PAC no responde', async () => {
    const prisma = fakePrisma(invoiceBase());
    const provider = fakeProvider(new PacError('El PAC no respondió en 20000 ms.', 'TIMEOUT'));

    const emision = await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(emision.status).toBe('ERROR');
    expect(prisma.actual().pacStatus).toBe('ERROR');
    expect(prisma.actual().pacLastError).toContain('no respondió');
  });

  it('no vuelve a llamar al PAC si la factura ya está autorizada', async () => {
    const prisma = fakePrisma(
      invoiceBase({ pacStatus: 'AUTORIZADA', cufe: 'FE-EXISTENTE', pacDocumentNumber: '10' }),
    );
    const provider = fakeProvider(resultadoAutorizado());

    const emision = await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(emision.status).toBe('AUTORIZADA');
    expect(provider.calls()).toBe(0);
  });

  it('reintenta un RECHAZO con un controlId nuevo', async () => {
    const prisma = fakePrisma(invoiceBase({ pacStatus: 'RECHAZADA', pacAttempts: 1 }));
    const provider = fakeProvider(resultadoAutorizado());

    await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(provider.lastRequest().controlId).toBe('inv-1-r2');
  });

  it('reintenta un ERROR de red con el MISMO controlId (idempotencia)', async () => {
    const prisma = fakePrisma(invoiceBase({ pacStatus: 'ERROR', pacAttempts: 1 }));
    const provider = fakeProvider(resultadoAutorizado());

    await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(provider.lastRequest().controlId).toBe('inv-1');
  });

  it('si falta la ficha fiscal del cliente no llama al PAC y deja ERROR', async () => {
    const prisma = fakePrisma(
      invoiceBase({ client: clienteContribuyente({ location: '' }) }),
    );
    const provider = fakeProvider(resultadoAutorizado());

    const emision = await emitInvoiceWithPac(prisma, 'c-1', 'inv-1', { provider });

    expect(emision.status).toBe('ERROR');
    expect(prisma.actual().pacStatus).toBe('ERROR');
    expect(provider.calls()).toBe(0);
  });
});
