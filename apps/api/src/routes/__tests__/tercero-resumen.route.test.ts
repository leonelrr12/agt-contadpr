/**
 * Rutas del estado de cuenta del panel Terceros. Además del 200, el arnés
 * valida contra el DMMF todos los select/include que ejecuta el servicio.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { clientsRouter } from '../clients';
import { suppliersRouter } from '../suppliers';
import { prismaValidador } from '../../test-utils/prisma-validador';

const cliente = {
  id: 'cli-1', name: 'CLIENTE XYZ', tradeName: null, taxId: '8-777-1', dv: '45',
  phone: null, email: null, address: null, createdAt: new Date(),
  esAgenteRetenedor: false, porcentajeRetencionItbms: 0.5,
};
const proveedor = {
  id: 'sup-1', name: 'PROVEEDOR XYZ', tradeName: null, taxId: '8-733-2267', dv: '88',
  phone: null, email: null, address: null, createdAt: new Date(), paymentTerms: '30',
};

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'co-1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    const { prisma } = prismaValidador({
      'client.findFirst': () => cliente,
      'supplier.findFirst': () => proveedor,
      'invoice.findMany': () => [],
      'bill.findMany': () => [],
      'retentionItbms.groupBy': () => [],
    });
    req.prisma = prisma;
    next();
  });
  app.use('/api/clients', clientsRouter);
  app.use('/api/suppliers', suppliersRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('GET /:id/resumen', () => {
  it('devuelve el estado de cuenta del cliente', async () => {
    const res = await fetch(`${base}/api/clients/cli-1/resumen`);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.tipo).toBe('Cliente');
    expect(body.name).toBe('CLIENTE XYZ');
    expect(body.tendencia).toHaveLength(12);
  });

  it('devuelve el estado de cuenta del proveedor', async () => {
    const res = await fetch(`${base}/api/suppliers/sup-1/resumen`);
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body.tipo).toBe('Proveedor');
    expect(body.name).toBe('PROVEEDOR XYZ');
    expect(body.paymentTerms).toBe('30');
  });
});
