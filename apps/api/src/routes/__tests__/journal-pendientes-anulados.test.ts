/**
 * La cola de Revisión no puede listar asientos anulados.
 *
 * Un asiento CONFIRMADO anulado conserva su estado y solo lleva `anuladoPorId` (su
 * reverso lo netea desde el mes de la corrección). Sin el filtro reaparece como
 * pendiente —pasó con una corrida de planilla re-hecha (2026-07-S1 de ALBRYND
 * CASTILLO), donde el asiento del 3 de julio anulado seguía en Revisión al lado del
 * bueno del 4 de julio—. Los BORRADOR/RECHAZADO anulados ahora quedan en ANULADO,
 * pero el filtro sigue siendo la red para los anulados bajo la regla anterior.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { journalRouter } from '../journal';
import { prismaValidador } from '../../test-utils/prisma-validador';

let server: any;
let base = '';
let ultimo: any;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'co1', userId: 'u1', role: 'contador', name: 'Contador', email: 'c@x.com' };
    ultimo = prismaValidador({ 'journalEntry.findMany': () => [] });
    req.prisma = ultimo.prisma;
    next();
  });
  app.use('/api/journal', journalRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

describe('GET /journal/pendientes', () => {
  it('excluye los asientos anulados de la cola de revisión', async () => {
    const res = await fetch(`${base}/api/journal/pendientes`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    const consulta = ultimo.llamadas.find(
      (l: any) => l.delegate === 'journalEntry' && l.metodo === 'findMany',
    );
    expect(consulta).toBeTruthy();
    expect(consulta.args.where).toMatchObject({
      companyId: 'co1',
      status: 'BORRADOR',
      isClosing: false,
      anuladoPorId: null,
    });
  });
});
