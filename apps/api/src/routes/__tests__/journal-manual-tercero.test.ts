/**
 * Asientos manuales con tercero (Anexo / venta / compra).
 *
 * El POST crea el JournalEntry y su Transaction en la misma operación: la
 * metadata de la Transaction es lo que leen el sync (maestro) y el informe
 * Anexos. La cuenta con 📎 exige Nombre y RUC (y factura si es crédito).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { journalRouter } from '../journal';
import { prismaValidador } from '../../test-utils/prisma-validador';

const CUENTAS = [
  { id: 'hon', code: '6.02.01', name: 'Honorarios Profesionales', type: 'GASTO', requiresAnexo: true, isBlocked: false },
  { id: 'banco', code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO', requiresAnexo: false, isBlocked: false },
  { id: 'caja', code: '1.1.01', name: 'Caja', type: 'ACTIVO', requiresAnexo: false, isBlocked: false },
  { id: 'ventas', code: '4.01.01', name: 'Ventas', type: 'INGRESO', requiresAnexo: false, isBlocked: false },
  { id: 'cxc', code: '1.1.03.01', name: 'Clientes', type: 'ACTIVO', requiresAnexo: false, isBlocked: false },
  { id: 'cxp', code: '2.1.01', name: 'Proveedores', type: 'PASIVO', requiresAnexo: false, isBlocked: false },
];

let server: any;
let base = '';
let ultimo: any;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'co1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    let txCreada: any = null;
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
        id: 'je1',
        ...args.data,
        lines: (args.data.lines?.create || []).map((l: any) => ({
          ...l,
          account: CUENTAS.find((c) => c.id === l.accountId),
        })),
      }),
      'journalEntry.findFirst': () => ({ id: 'je1', status: 'BORRADOR', lines: [] }),
      'journalEntry.update': (args: any) => ({
        id: 'je1',
        ...args.data,
        lines: (args.data.lines?.create || []).map((l: any) => ({
          ...l,
          account: CUENTAS.find((c) => c.id === l.accountId),
        })),
      }),
      'journalEntry.findUnique': () => null,
      'transaction.create': (args: any) => {
        txCreada = { id: 'tx1', ...args.data };
        return txCreada;
      },
      'transaction.findFirst': () => txCreada,
      'transaction.update': (args: any) => {
        txCreada = { ...(txCreada || {}), ...args.data };
        return txCreada;
      },
      'supplier.findFirst': () => null,
      'supplier.findMany': () => [],
      'supplier.create': (args: any) => ({ id: 's1', ...args.data }),
      'client.findFirst': () => null,
      'client.findMany': () => [],
      'client.create': (args: any) => ({ id: 'c1', ...args.data }),
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

async function post(body: any) {
  const res = await fetch(`${base}/api/journal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const llamada = (delegate: string, metodo: string) =>
  ultimo.llamadas.find((l: any) => l.delegate === delegate && l.metodo === metodo);

describe('asientos manuales: tercero y Anexo', () => {
  it('una cuenta con Anexo sin Nombre/RUC rebota antes de escribir', async () => {
    const r = await post({
      date: '2026-10-27',
      description: 'Honorarios',
      lines: [
        { accountId: 'hon', debit: 100, credit: 0 },
        { accountId: 'banco', debit: 0, credit: 100 },
      ],
    });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('lleva Anexo DGI');
    expect(llamada('journalEntry', 'create')).toBeUndefined();
  });

  it('un gasto con Anexo crea la Transaction y el proveedor con la nota del concepto', async () => {
    const r = await post({
      date: '2026-10-27',
      description: 'Honorarios',
      lines: [
        { accountId: 'hon', debit: 100, credit: 0 },
        { accountId: 'banco', debit: 0, credit: 100 },
      ],
      provider: 'CONSULTORA XYZ',
      ruc: '8-123-456',
    });

    expect(r.status).toBe(201);
    const tx = llamada('transaction', 'create');
    expect(tx.args.data.type).toBe('GASTO');
    expect(JSON.parse(tx.args.data.metadata)).toMatchObject({
      provider: 'CONSULTORA XYZ',
      ruc: '8-123-456',
      source: 'asiento-manual',
    });
    const sup = llamada('supplier', 'create');
    expect(sup.args.data.name).toBe('CONSULTORA XYZ');
    expect(sup.args.data.notes).toBe('Concepto: Honorarios');
  });

  it('una venta al contado alimenta el cliente y no crea proveedor', async () => {
    const r = await post({
      date: '2026-10-27',
      description: 'Venta de servicio',
      lines: [
        { accountId: 'caja', debit: 100, credit: 0 },
        { accountId: 'ventas', debit: 0, credit: 100 },
      ],
      provider: 'CLIENTE XYZ',
      ruc: '8-777-1',
    });

    expect(r.status).toBe(201);
    expect(llamada('transaction', 'create').args.data.type).toBe('VENTA');
    const cli = llamada('client', 'create');
    expect(cli.args.data.name).toBe('CLIENTE XYZ');
    expect(llamada('supplier', 'create')).toBeUndefined();
  });

  it('una venta a crédito crea la Invoice del asiento', async () => {
    const r = await post({
      date: '2026-10-27',
      description: 'Venta a crédito',
      lines: [
        { accountId: 'cxc', debit: 100, credit: 0 },
        { accountId: 'ventas', debit: 0, credit: 100 },
      ],
      provider: 'CLIENTE XYZ',
      ruc: '8-777-1',
    });

    expect(r.body, `status ${r.status}`).toBeTruthy();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(llamada('transaction', 'create').args.data.type).toBe('VENTA');
    expect(llamada('invoice', 'create')).toBeTruthy();
    expect(llamada('client', 'create').args.data.name).toBe('CLIENTE XYZ');
  });
});
