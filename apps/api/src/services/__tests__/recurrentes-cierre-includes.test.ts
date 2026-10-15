/**
 * El guardia del DMMF apuntado a los dos caminos que corren **sin que nadie mire**: las
 * transacciones recurrentes (cron cada 30 minutos) y el cierre de año fiscal.
 *
 * Son los peores candidatos para un `include` mal puesto: nadie los abre a mano, así que
 * un error ahí se descubre cuando el asiento no apareció (o apareció mal) y ya pasó el
 * mes. Acá se corren las funciones reales contra un Prisma de mentira que valida las
 * consultas contra el schema, con los vacíos que devolvería la base sin datos: terminar
 * en «plantilla no encontrada» o «no hay movimientos» es un resultado esperado — lo que
 * no puede pasar es que una consulta nombre una relación que no existe.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { processSingleTemplate, processDueItems } from '../recurring-processor';
import { closeYear, computeYearBalances } from '../year-close';
import { recurringRouter } from '../../routes/recurring';
import { yearCloseRouter } from '../../routes/year-close';
import { prismaValidador, type Arnés } from '../../test-utils/prisma-validador';

let server: any;
let base = '';
let ultimo: Arnés | null = null;

const arnes = () =>
  prismaValidador({
    subscription: {
      findFirst: () => ({ id: 's1', status: 'ACTIVE', periodEnd: new Date(Date.now() + 86400000), movimientosUsados: 0, plan: {} }),
    },
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    ultimo = arnes();
    req.prisma = ultimo.prisma;
    next();
  });
  app.use('/api/recurring', recurringRouter);
  app.use('/api/year-close', yearCloseRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

async function pegar(ruta: string, init?: any): Promise<{ status: number; texto: string; consultas: number }> {
  const res = await fetch(`${base}${ruta}`, init);
  const texto = await res.text();
  expect(texto).not.toMatch(/no existe en el modelo/);
  expect(texto).not.toMatch(/Unknown field .* for (include|select) statement/);
  return { status: res.status, texto, consultas: ultimo?.llamadas.length ?? 0 };
}

describe('recurrentes: las consultas del procesador y de la pantalla son válidas', () => {
  it('processSingleTemplate sin plantilla: consulta y sale limpio', async () => {
    const { prisma, llamadas } = arnes();
    const r = await processSingleTemplate(prisma, 'tpl-1', 'c1');
    expect(r.executed).toBe(false);
    expect(llamadas.length).toBeGreaterThan(0);
  });

  it('⭐ processDueItems — lo que corre el cron cada 30 minutos', async () => {
    const { prisma, llamadas } = arnes();
    const r = await processDueItems(prisma, 'c1');
    expect(r.processed).toBe(0);
    // El `include: { company: true }` de las plantillas vencidas es lo que se valida acá.
    expect(llamadas.some((l) => l.delegate === 'recurringTemplate')).toBe(true);
  });

  it('las rutas de la pantalla (listar, correr una, procesar ahora)', async () => {
    const listado = await pegar('/api/recurring');
    expect(listado.status).toBe(200);
    expect(listado.consultas).toBeGreaterThan(0);

    for (const ruta of ['/api/recurring/tpl-1/run', '/api/recurring/process']) {
      const { status, consultas } = await pegar(ruta, { method: 'POST' });
      expect([200, 400, 404, 409]).toContain(status);
      expect(consultas).toBeGreaterThan(0);
    }
  });
});

describe('cierre de año: las consultas del cierre son válidas', () => {
  it('computeYearBalances lee los saldos del año', async () => {
    const { prisma, llamadas } = arnes();
    const b = await computeYearBalances(prisma, 'c1', '2025');
    expect(b.utilidadNeta).toBe(0);
    expect(llamadas.length).toBeGreaterThan(0);
  });

  it('closeYear sin movimientos: termina en el error de negocio, no en una consulta rota', async () => {
    const { prisma, llamadas } = arnes();
    await expect(closeYear(prisma, 'c1', 'u1', '2025')).rejects.toMatchObject({ status: 400 });
    expect(llamadas.length).toBeGreaterThan(0);
  });

  it('las rutas del cierre (estado del año y cerrar)', async () => {
    const estado = await pegar('/api/year-close/2025');
    expect([200, 404]).toContain(estado.status);

    const cerrar = await pegar('/api/year-close/2025', { method: 'POST' });
    expect([200, 201, 400, 404, 409]).toContain(cerrar.status);
    expect(cerrar.consultas).toBeGreaterThan(0);
  });
});
