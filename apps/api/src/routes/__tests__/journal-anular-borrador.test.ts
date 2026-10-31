/**
 * Anular un asiento que nunca se aprobó no genera reverso.
 *
 * El caso ALBRYND (julio 2026, Odesa): la corrida de planilla se anuló con sus
 * asientos en BORRADOR/RECHAZADO y cada uno dejó un espejo CONFIRMADO. Como los
 * informes excluyen RECHAZADO/ANULADO pero incluyen CONFIRMADO, la cuenta 2.1.07.01
 * (Acreedor Empleados) mostraba las reversiones sin el original: un saldo fantasma.
 *
 * La regla: CONFIRMADO → reverso fechado hoy; BORRADOR/RECHAZADO → ANULADO directo.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { journalRouter } from '../journal';

let entrada: any;
let creados: any[];
let actualizados: Array<{ id: string; data: any }>;

const prisma: any = {
  journalEntry: {
    findFirst: async ({ where }: any) =>
      where.id === entrada.id ? { ...entrada, lines: entrada.lines } : null,
    create: async ({ data }: any) => {
      creados.push(data);
      return { id: 'je-reverso', ...data, lines: [] };
    },
    update: async ({ where, data }: any) => {
      actualizados.push({ id: where.id, data });
      Object.assign(entrada, data);
      return { ...entrada };
    },
  },
  auditLog: { create: async () => ({}) },
  $transaction: async (fn: any) => fn(prisma),
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
  app.use('/api/journal', journalRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

beforeEach(() => {
  entrada = {
    id: 'je-1',
    companyId: 'c1',
    date: new Date('2026-07-03T12:00:00Z'),
    description: 'Planilla de ALBRYND CASTILLO — 2026-07-S1',
    status: 'BORRADOR',
    anuladoPorId: null,
    lines: [
      { id: 'l1', accountId: 'sueldo', debit: 30, credit: 0 },
      { id: 'l2', accountId: 'acreedor', debit: 0, credit: 30 },
    ],
  };
  creados = [];
  actualizados = [];
});

const anular = async (): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}/api/journal/je-1/anular`, { method: 'POST' });
  return { status: res.status, body: await res.json() };
};

describe('POST /journal/:id/anular', () => {
  it('un BORRADOR se anula directo: sin reverso y en estado ANULADO', async () => {
    const r = await anular();

    expect(r.status).toBe(200);
    expect(r.body.reversal).toBeNull();
    expect(entrada.status).toBe('ANULADO');
    expect(entrada.anuladoPorId).toBeNull();
    expect(creados).toHaveLength(0);
    expect(actualizados).toEqual([{ id: 'je-1', data: { status: 'ANULADO' } }]);
  });

  it('un RECHAZADO tampoco deja reverso', async () => {
    entrada.status = 'RECHAZADO';

    const r = await anular();

    expect(r.status).toBe(200);
    expect(r.body.reversal).toBeNull();
    expect(entrada.status).toBe('ANULADO');
    expect(creados).toHaveLength(0);
  });

  it('un CONFIRMADO sí crea el espejo fechado hoy y lo marca en el original', async () => {
    entrada.status = 'CONFIRMADO';

    const r = await anular();

    expect(r.status).toBe(200);
    expect(r.body.reversal.id).toBe('je-reverso');
    expect(entrada.anuladoPorId).toBe('je-reverso');
    expect(creados).toHaveLength(1);
    expect(creados[0].description).toBe('ANULACIÓN: Planilla de ALBRYND CASTILLO — 2026-07-S1');
    expect(creados[0].status).toBe('CONFIRMADO');
    expect(creados[0].lines.create).toEqual([
      { accountId: 'sueldo', debit: 0, credit: 30 },
      { accountId: 'acreedor', debit: 30, credit: 0 },
    ]);
  });
});
