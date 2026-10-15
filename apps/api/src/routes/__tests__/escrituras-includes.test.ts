/**
 * El guardia del DMMF (`test-utils/prisma-validador.ts`) apuntado a las rutas que
 * **escriben** y encadenan más consultas: la importación (preview, carga inicial,
 * ejecución) y la conciliación bancaria (subir extracto, vincular, crear asiento).
 *
 * Son las más peligrosas de este repo: nadie las ejercita hasta que el contador sube un
 * archivo, encadenan consultas con `include` sobre extractos, facturas y asientos, y
 * como los servicios reciben `prisma: any`, un `include` mal puesto **compila** y solo
 * revienta en producción (le pasó a planilla el 28-09).
 *
 * No se afirma el resultado del negocio —los stubs devuelven vacíos, así que un 404 de
 * «no encontrado» es un resultado esperado—: se afirma que las consultas que corren son
 * consultas VÁLIDAS y que la ruta llegó a consultar de verdad.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { importRouter } from '../import';
import { reconcileRouter } from '../reconcile';
import { prismaValidador, type Arnés } from '../../test-utils/prisma-validador';

let server: any;
let base = '';
let ultimo: Arnés | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    ultimo = prismaValidador({
      subscription: {
        findFirst: () => ({ id: 's1', status: 'ACTIVE', periodEnd: new Date(Date.now() + 86400000), movimientosUsados: 0, plan: {} }),
      },
    });
    req.prisma = ultimo.prisma;
    next();
  });
  app.use('/api/import', importRouter);
  app.use('/api/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => server?.close());

const archivo = (contenido: string, nombre = 'ENERO.csv', extra: Record<string, string> = {}) => {
  const fd = new FormData();
  fd.append('file', new Blob([contenido], { type: 'text/csv' }), nombre);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
};

/** Pega, exige que no haya error de include y devuelve cuántas consultas corrió. */
async function pegar(ruta: string, init?: any): Promise<{ status: number; texto: string; consultas: number }> {
  const res = await fetch(`${base}${ruta}`, init);
  const texto = await res.text();
  expect(texto).not.toMatch(/no existe en el modelo/);
  expect(texto).not.toMatch(/Unknown field .* for (include|select) statement/);
  return { status: res.status, texto, consultas: ultimo?.llamadas.length ?? 0 };
}

const json = (body: any) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('importación: las consultas de sus rutas son válidas', () => {
  it('POST /preview (Transacciones) resuelve conceptos y cuentas', async () => {
    const csv = 'Fecha,Descripción,Monto,Concepto,Tipo\n2026-01-15,Compra de prueba,100.00,Internet,GASTO\n';
    const { status, consultas } = await pegar('/api/import/preview', { method: 'POST', body: archivo(csv, 'ENERO.csv', { tipo: 'GASTO' }) });
    expect([200, 400, 422]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('POST /preview con cargaInicial busca las cuentas del balance', async () => {
    const csv = 'Categoria,Concepto,Monto\nActivo,Banco General,1000.00\n';
    const { status, consultas } = await pegar('/api/import/preview', { method: 'POST', body: archivo(csv, 'BALANCE.csv', { cargaInicial: 'true' }) });
    expect([200, 400, 422]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('POST /execute crea los asientos de las filas', async () => {
    const { status, consultas } = await pegar(
      '/api/import/execute',
      json({
        rows: [{ date: '2026-01-15', description: 'Compra de prueba', amount: 100, concept: 'Internet', type: 'GASTO', paymentMethod: 'EFECTIVO' }],
      }),
    );
    expect([200, 400, 422]).toContain(status);
    // El camino de escritura resuelve cuentas y crea el asiento: consulta seguro.
    expect(consultas).toBeGreaterThan(0);
  });

  it('POST /carga-inicial valida el archivo del balance', async () => {
    const csv = 'Categoria,Concepto,Monto\nActivo,Banco General,1000.00\n';
    const { status } = await pegar('/api/import/carga-inicial', { method: 'POST', body: archivo(csv, 'BALANCE.csv') });
    expect([200, 201, 400, 404, 409, 422]).toContain(status);
  });

  it('POST /cobros/execute-all procesa un archivo de cobros', async () => {
    const csv = 'Fecha de Pago,Cliente,Factura,Total,Cuenta\n2026-01-20,Cliente A,F-1,500.00,Banco General\n';
    const { status, consultas } = await pegar('/api/import/cobros/execute-all', { method: 'POST', body: archivo(csv, 'COBROS.csv') });
    expect([200, 201, 400, 404, 409, 422]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });
});

describe('conciliación bancaria: las consultas de sus rutas son válidas', () => {
  it('POST /upload lee el extracto', async () => {
    const csv = 'Fecha,Descripción,Monto\n01/01/2026,YAPPY KARLA,-50.00\n02/01/2026,ACH PROVEEDOR,120.00\n';
    const { status, consultas } = await pegar('/api/reconcile/upload', { method: 'POST', body: archivo(csv, 'ENERO.csv', { bankAccountId: 'acc-banco' }) });
    expect([200, 201, 400, 404, 422]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('GET / y GET /:id listan los extractos con sus filas', async () => {
    for (const ruta of ['/api/reconcile', '/api/reconcile/bs-1']) {
      const { status, consultas } = await pegar(ruta);
      expect([200, 404]).toContain(status);
      expect(consultas).toBeGreaterThan(0);
    }
  });

  it('⭐ POST /:id/match — el findFirst que trae el banco del extracto', async () => {
    const { status, consultas } = await pegar('/api/reconcile/bs-1/match', json({ rowId: 'row-1', entryId: 'je-1' }));
    expect([200, 400, 404, 409]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('POST /:id/create-entry — el asiento de una fila del extracto', async () => {
    const { status, consultas } = await pegar(
      '/api/reconcile/bs-1/create-entry',
      json({ rowId: 'row-1', description: 'Cargo bancario', debitAccountId: 'acc-gasto', creditAccountId: 'acc-banco', amount: 25 }),
    );
    expect([200, 201, 400, 404, 409]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('POST /:id/rematch vuelve a correr el matcher', async () => {
    const { status, consultas } = await pegar('/api/reconcile/bs-1/rematch', { method: 'POST' });
    expect([200, 400, 404, 409]).toContain(status);
    expect(consultas).toBeGreaterThan(0);
  });

  it('DELETE /:id borra el extracto', async () => {
    const { status } = await pegar('/api/reconcile/bs-1', { method: 'DELETE' });
    expect([200, 204, 404, 409]).toContain(status);
  });
});
