import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { tercerosRouter } from '../terceros';

const origen = {
  id: 's1', name: 'Ferrteria El Valle', taxId: null, dv: null, taxIdHash: null,
  phone: null, email: null, address: null, location: null, tradeName: null,
  contactName: null, taxIdType: null, paymentTerms: '30', notes: null,
  fiscalSource: null, fiscalUpdatedAt: null,
};
const destino = {
  ...origen, id: 's2', name: 'Ferreteria el valle',
};

function fakePrisma() {
  const prisma: any = {
    $transaction: async (cb: any) => cb(prisma),
    supplier: {
      findFirst: async ({ where }: any) => [origen, destino].find((x) => x.id === where.id) || null,
      update: async ({ where, data }: any) => ({ id: where.id, ...data }),
      delete: async ({ where }: any) => ({ id: where.id }),
    },
    bill: { updateMany: async () => ({ count: 2 }) },
    workerAccount: { updateMany: async () => ({ count: 0 }) },
    inventoryMovement: { updateMany: async () => ({ count: 1 }) },
    invoice: { updateMany: async () => ({ count: 0 }) },
    retentionItbms: { updateMany: async () => ({ count: 0 }) },
    transaction: { findMany: async () => [], update: async () => ({}) },
    auditLog: { create: async () => ({}) },
  };
  return prisma;
}

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'co-1', userId: 'u1', role: 'admin', name: 'Admin', email: 'a@x.com' };
    req.prisma = fakePrisma();
    next();
  });
  app.use('/api/terceros', tercerosRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('POST /api/terceros/fusionar', () => {
  it('fusiona y devuelve los conteos', async () => {
    const res = await fetch(`${base}/api/terceros/fusionar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'Proveedor', origenId: 's1', destinoId: 's2' }),
    });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.tipo).toBe('proveedor');
    expect(body.origen.name).toBe('Ferrteria El Valle');
    expect(body.destino.name).toBe('Ferreteria el valle');
    expect(body.movidos).toMatchObject({ bills: 2, inventoryMovements: 1 });
  });

  it('rechaza ids faltantes', async () => {
    const res = await fetch(`${base}/api/terceros/fusionar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tipo: 'Proveedor', origenId: 's1' }),
    });
    expect(res.status).toBe(400);
  });
});
