import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { reconcileRouter } from '../reconcile';

/**
 * «+ Crear asiento» de la conciliación: el formulario solo elige UNA cuenta y no
 * pide Nombre, RUC ni N° de factura. Si la contrapartida (o el banco del extracto)
 * lleva Anexo DGI, el asiento quedaría fuera del Anexo y sin tercero: la API lo
 * rechaza y remite a Revisión → Asiento Manual, que sí pide esos campos.
 */

const BANCO = { id: 'acc-banco', code: '1.1.02.01', name: 'Banco General', requiresAnexo: false, isBlocked: false };
const GASTO_ANEXO = { id: 'acc-anexo', code: '6.01.22', name: 'Limpieza', requiresAnexo: true, isBlocked: false };
const GASTO = { id: 'acc-gasto', code: '6.01.01', name: 'Gastos Generales', requiresAnexo: false, isBlocked: false };

let cuentas: any[] = [];
let entradas: any[] = [];
let fila: any;

const prisma: any = {
  subscription: {
    findFirst: async () => ({
      id: 's1', status: 'ACTIVE', periodEnd: new Date(Date.now() + 86400000),
      movementsUsed: 0, movementsLimit: 500, plan: {},
    }),
    updateMany: async () => ({ count: 1 }),
    update: async () => ({}),
  },
  bankStatementRow: {
    findFirst: async () => ({ ...fila, statement: { id: 'bs1', companyId: 'c1' } }),
    update: async ({ data }: any) => { Object.assign(fila, data); return fila; },
  },
  account: {
    findMany: async ({ where }: any = {}) =>
      cuentas.filter((c) => !where?.id?.in || where.id.in.includes(c.id)),
  },
  journalEntry: {
    create: async ({ data }: any) => { const e = { id: 'je-nuevo', ...data }; entradas.push(e); return e; },
  },
};

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin' };
    req.prisma = prisma;
    next();
  });
  app.use('/api/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/reconcile`;
});

afterAll(() => server?.close());

beforeEach(() => {
  cuentas = [BANCO, GASTO_ANEXO, GASTO];
  entradas = [];
  fila = {
    id: 'r1', statementId: 'bs1', date: new Date('2026-07-10T12:00:00Z'),
    description: 'COMPRA', debit: 100, credit: 0,
    status: 'UNMATCHED', matchedEntryId: null, matchConfidence: null,
  };
});

const crear = async (debitAccountId: string, creditAccountId = BANCO.id) => {
  const res = await fetch(`${base}/bs1/create-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowId: 'r1', description: 'Compra', debitAccountId, creditAccountId, amount: 100 }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

describe('POST /reconcile/:id/create-entry — cuentas con Anexo DGI', () => {
  it('rechaza la contrapartida con Anexo y remite al Asiento Manual', async () => {
    const r = await crear(GASTO_ANEXO.id);

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Anexo DGI/);
    expect(r.body.error).toMatch(/Asiento Manual/);
    expect(entradas).toHaveLength(0);
    expect(fila.status).toBe('UNMATCHED');
  });

  it('también rechaza cuando la cuenta con Anexo es la del extracto', async () => {
    cuentas = [{ ...BANCO, requiresAnexo: true }, GASTO];

    const r = await crear(GASTO.id);

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Asiento Manual/);
    expect(entradas).toHaveLength(0);
  });

  it('crea el asiento y vincula la fila cuando ninguna cuenta lleva Anexo', async () => {
    const r = await crear(GASTO.id);

    expect(r.status).toBe(201);
    expect(entradas).toHaveLength(1);
    expect(fila.status).toBe('MATCHED');
    expect(fila.matchedEntryId).toBe('je-nuevo');
  });
});
