/**
 * El guardia del DMMF (`test-utils/prisma-validador.ts`) apuntado a las rutas de lectura
 * pesadas: informes, inventario, presupuesto y salud.
 *
 * Son las que más consultas encadenan y las que nadie ejercita hasta que un contador
 * abre la pantalla — y como los servicios reciben `prisma: any`, un `include` con un
 * nombre que no existe **compila** y solo revienta en runtime (pasó el 28-09 en planilla).
 * Acá cada ruta se pega contra un Prisma de mentira que valida los `include`/`select`
 * contra el schema real: si alguno no existe, el test falla nombrándolo.
 *
 * No se afirma el contenido de los informes (para eso están sus tests de cálculo): lo
 * que se afirma es que las consultas que ejecutan sean consultas VÁLIDAS.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { reportsRouter } from '../reports';
import { journalRouter } from '../journal';
import { clientsRouter } from '../clients';
import { suppliersRouter } from '../suppliers';
import { reembolsosRouter } from '../reembolsos';
import { reconcileRouter } from '../reconcile';
import { inventarioRouter } from '../inventario';
import { saludRouter } from '../salud';
import { budgetsRouter } from '../budgets';
import { prismaValidador, type Arnés } from '../../test-utils/prisma-validador';

let server: any;
let base = '';
/** El arnés del último request: deja afirmar que la ruta CONSULTÓ (no que pasó de largo). */
let ultimo: Arnés | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    // El arnés se crea por request para que cada endpoint tenga el suyo, pero todos
    // validan igual contra el DMMF.
    ultimo = prismaValidador({
      // El plan trae los módulos que estas rutas exigen (`middleware/modulo.ts`):
      // acá se prueban las CONSULTAS, no los permisos. El arnés devuelve este objeto
      // tal cual en las consultas de lectura del delegate.
      subscription: {
        id: 's1',
        status: 'ACTIVE',
        periodEnd: new Date(Date.now() + 86400000),
        addons: [],
        plan: { modulos: ['inventario', 'planilla', 'facturas-pdf'] },
      },
    });
    req.prisma = ultimo.prisma;
    next();
  });
  app.use('/api/reports', reportsRouter);
  app.use('/api/inventario', inventarioRouter);
  app.use('/api/salud', saludRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/journal', journalRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/reembolsos', reembolsosRouter);
  app.use('/api/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

/**
 * Pega contra una ruta y falla si el cuerpo trae un error de include. Además devuelve
 * cuántas consultas se ejecutaron: un endpoint que responde sin consultar nada no
 * valida nada, y el test tiene que poder distinguirlo.
 */
async function pegar(ruta: string): Promise<{ status: number; texto: string; consultas: number }> {
  const res = await fetch(`${base}${ruta}`);
  const texto = await res.text();
  expect(texto).not.toMatch(/no existe en el modelo/); // el mensaje del guardia
  expect(texto).not.toMatch(/Unknown field .* for (include|select) statement/); // el de Prisma
  return { status: res.status, texto, consultas: ultimo?.llamadas.length ?? 0 };
}

describe('informes: las consultas de las rutas de lectura son válidas', () => {
  const rutas = [
    '/api/reports/balance-comprobacion',
    '/api/reports/balance-general',
    '/api/reports/estado-resultados',
    '/api/reports/flujo-caja',
    '/api/reports/dashboard',
    '/api/reports/proveedores',
    '/api/reports/borrador-430?year=2026&mes=1',
  ];
  for (const ruta of rutas) {
    it(`GET ${ruta}`, async () => {
      const { status, consultas } = await pegar(ruta);
      expect(status).toBe(200);
      expect(consultas).toBeGreaterThan(0); // validó consultas de verdad
    });
  }

  it('los auxiliares (diario, mayor, CxC, CxP, anexos) — las consultas que más encadenan', async () => {
    // 404 es válido acá: significa que la consulta corrió y no encontró la fila (el
    // stub devuelve null), no que la ruta no exista. Lo que NO puede pasar es un error
    // de include, y de eso se encarga `pegar`.
    for (const ruta of [
      '/api/journal',
      '/api/journal/pendientes',
      '/api/journal/mayor/acc-1',
      '/api/clients',
      '/api/clients/report/summary',
      '/api/suppliers',
      '/api/suppliers/report/summary',
      '/api/reports/proveedores?accountId=acc-1',
    ]) {
      const { status } = await pegar(ruta);
      expect([200, 400, 404]).toContain(status);
    }
  });
});

describe('inventario: las consultas de sus rutas son válidas', () => {
  for (const ruta of [
    '/api/inventario/productos',
    '/api/inventario/movimientos',
    '/api/inventario/valoracion',
    '/api/inventario/cuadre',
    '/api/inventario/alertas',
    '/api/inventario/productos/prod-1/kardex',
  ]) {
    it(`GET ${ruta}`, async () => {
      const { status, consultas } = await pegar(ruta);
      expect([200, 404]).toContain(status); // 404 = no encontró la fila, pero la consulta es válida
      expect(consultas).toBeGreaterThan(0);
    });
  }
});

describe('reembolsos y conciliación', () => {
  it('las consultas de sus pantallas son válidas', async () => {
    for (const ruta of [
      '/api/reembolsos/trabajadores',
      '/api/reembolsos/cuentas-pago',
      '/api/reembolsos/facturas',
      '/api/reconcile',
    ]) {
      const { status, consultas } = await pegar(ruta);
      expect([200, 400, 404]).toContain(status);
      expect(consultas).toBeGreaterThan(0);
    }
  });
});

describe('salud y presupuesto', () => {
  it('GET /api/salud (sin clave de LLM: degrada a las reglas)', async () => {
    const { status, consultas } = await pegar('/api/salud');
    expect(status).toBe(200);
    expect(consultas).toBeGreaterThan(0);
  });

  it('GET /api/budgets y la comparativa', async () => {
    for (const ruta of ['/api/budgets?year=2026', '/api/budgets/comparison?year=2026&tipos=resultado']) {
      const { status, consultas } = await pegar(ruta);
      expect([200, 400]).toContain(status);
      expect(consultas).toBeGreaterThan(0);
    }
  });
});
