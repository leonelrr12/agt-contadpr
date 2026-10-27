/**
 * El POST de reversión del flujo de corrección debe:
 *  · No exigir Nombre/RUC aunque el asiento espejo toque una cuenta con Anexo.
 *  · Crear una Transaction con el importe NEGATIVO y la metadata del original,
 *    para que Anexos/Proveedores neteen la corrección.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { journalRouter } from '../journal';
import { prismaValidador } from '../../test-utils/prisma-validador';

const CUENTAS = [
  { id: 'hon', code: '6.02.01', name: 'Honorarios Profesionales', type: 'GASTO', requiresAnexo: true, isBlocked: false },
  { id: 'banco', code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO', requiresAnexo: false, isBlocked: false },
];

let server: any;
let base = '';
let ultimo: any;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'co-1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    const originalTx = {
      amount: 100,
      type: 'GASTO',
      concept: 'Honorarios',
      paymentMethod: null,
      metadata: JSON.stringify({ provider: 'CONSULTORA XYZ', ruc: '8-1-1', supplierId: 's1' }),
    };
    ultimo = prismaValidador({
      'subscription.findFirst': () => ({
        id: 's1',
        status: 'ACTIVE',
        periodEnd: new Date(Date.now() + 86400000),
        movementsUsed: 0,
        movementsLimit: 100,
        plan: { name: 'Pro', modulos: [] },
        addons: [],
      }),
      'subscription.updateMany': () => ({ count: 1 }),
      'account.findMany': () => CUENTAS,
      'journalEntry.create': (args: any) => ({
        id: 'je-rev',
        ...args.data,
        lines: (args.data.lines?.create || []).map((l: any) => ({
          ...l,
          account: CUENTAS.find((c) => c.id === l.accountId),
        })),
      }),
      'journalEntry.findFirst': (args: any) =>
        args?.where?.id === 'je-orig'
          ? {
              id: 'je-orig',
              lines: [
                { accountId: 'hon', debit: 100, credit: 0 },
                { accountId: 'banco', debit: 0, credit: 100 },
              ],
            }
          : null,
      'transaction.findFirst': (args: any) =>
        args?.where?.journalEntryId === 'je-orig' ? originalTx : null,
      'transaction.create': (args: any) => ({ id: 'tx-rev', ...args.data }),
    });
    req.prisma = ultimo.prisma;
    next();
  });
  app.use('/api/journal', journalRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('POST /journal con reversalOf', () => {
  it('crea el asiento espejo y la Transaction negativa sin exigir tercero', async () => {
    const res = await fetch(`${base}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-10-27',
        description: 'REVERSIÓN [ref:je-orig]: Honorarios',
        lines: [
          { accountId: 'banco', debit: 100, credit: 0 },
          { accountId: 'hon', debit: 0, credit: 100 },
        ],
        reversalOf: 'je-orig',
      }),
    });

    expect(res.status).toBe(201);
    const tx = ultimo.llamadas.find((l: any) => l.delegate === 'transaction' && l.metodo === 'create');
    expect(tx.args.data.amount).toBe(-100);
    expect(tx.args.data.type).toBe('GASTO');
    expect(tx.args.data.journalEntryId).toBe('je-rev');
    expect(JSON.parse(tx.args.data.metadata)).toMatchObject({
      provider: 'CONSULTORA XYZ',
      supplierId: 's1',
      source: 'reversion',
      reversalOf: 'je-orig',
    });
  });

  it('rechaza un reverso cuyas líneas no son el espejo del original', async () => {
    const res = await fetch(`${base}/api/journal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-10-27',
        description: 'REVERSIÓN [ref:je-orig]: Honorarios',
        lines: [
          { accountId: 'hon', debit: 100, credit: 0 },
          { accountId: 'banco', debit: 0, credit: 100 },
        ],
        reversalOf: 'je-orig',
      }),
    });

    expect(res.status).toBe(400);
    expect(ultimo.llamadas.find((l: any) => l.delegate === 'journalEntry' && l.metodo === 'create')).toBeUndefined();
  });
});
