/**
 * El Diario de Informes pide el período COMPLETO con `pageSize=all`.
 *
 * Antes la pantalla solo recibía la primera página (50 asientos, orden fecha desc):
 * con junio de Odesa cargado, los 50 más recientes eran solo del 27 al 30 y el resto
 * no aparecía. El export ya cargaba todo; esto alinea la pantalla.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { journalRouter } from '../journal';

let consultas: any[] = [];
let total = 305;

const prisma: any = {
  journalEntry: {
    findFirst: async () => null, // getAnioFiscal: sin asientos → año calendario
    count: async () => total,
    findMany: async (args: any) => {
      consultas.push(args);
      return [
        {
          id: 'je-1',
          date: new Date('2026-06-30T12:00:00Z'),
          description: 'Asiento de junio',
          status: 'CONFIRMADO',
          isClosing: false,
          lines: [{ id: 'l1', debit: 10, credit: 0, account: { id: 'a1', code: '1.1.01', name: 'Caja' } }],
          createdBy: { name: 'Contador' },
          transactions: [],
        },
      ];
    },
  },
};

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'contador' };
    req.prisma = prisma;
    next();
  });
  app.use('/api/journal', journalRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

const pedir = async (query: string): Promise<any> => {
  consultas = [];
  const res = await fetch(`${base}/api/journal?${query}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /journal — paginación del Diario', () => {
  it('pageSize=all devuelve el período completo: sin skip/take y con el total real', async () => {
    const r = await pedir('startDate=2026-06-01&endDate=2026-06-30&pageSize=all');

    expect(r.status).toBe(200);
    expect(r.body.total).toBe(305);
    expect(r.body.pageSize).toBe(305);
    expect(r.body.totalPages).toBe(1);
    expect(r.body.entries).toHaveLength(1); // el stub devuelve uno; lo que importa es la consulta
    expect(consultas[0].skip).toBeUndefined();
    expect(consultas[0].take).toBeUndefined();
  });

  it('sin pageSize sigue paginando de a 50 (otros consumidores del endpoint)', async () => {
    const r = await pedir('startDate=2026-06-01&endDate=2026-06-30');

    expect(r.body.total).toBe(305);
    expect(r.body.pageSize).toBe(50);
    expect(r.body.totalPages).toBe(7);
    expect(consultas[0]).toMatchObject({ skip: 0, take: 50 });
  });

  it('una página explícita mantiene el skip calculado', async () => {
    const r = await pedir('startDate=2026-06-01&endDate=2026-06-30&page=3&pageSize=100');

    expect(r.body.page).toBe(3);
    expect(r.body.pageSize).toBe(100);
    expect(consultas[0]).toMatchObject({ skip: 200, take: 100 });
  });
});
