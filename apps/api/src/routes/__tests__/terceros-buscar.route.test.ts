/**
 * GET /api/terceros/buscar — autocompletado del tercero del Asiento Manual.
 *
 * Además del 200, el arnés valida el `select` contra el DMMF: los servicios
 * reciben `prisma: any` y un campo mal nombrado no lo vería `tsc`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { tercerosRouter } from '../terceros';
import { prismaValidador } from '../../test-utils/prisma-validador';

const proveedor = { id: 'sup-1', name: 'FERRETERÍA XYZ', taxId: '8-733-2267', dv: '88', taxIdType: 'RUC' };
const cliente = { id: 'cli-1', name: 'FERRETERIA XYZ, S.A.', taxId: '8-777-1', dv: '45', taxIdType: 'RUC' };

describe('GET /api/terceros/buscar', () => {
  let server: Server;
  let base = '';
  let llamadas: any[] = [];

  beforeAll(async () => {
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { userId: 'u1', companyId: 'co-1', role: 'admin', name: 'Test', email: 't@test.com' };
      const arnes = prismaValidador({
        'supplier.findMany': () => [proveedor],
        'client.findMany': () => [cliente],
      });
      llamadas = arnes.llamadas;
      req.prisma = arnes.prisma;
      next();
    });
    app.use('/api/terceros', tercerosRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('busca en los dos maestros y devuelve el tipo de cada fila', async () => {
    llamadas = [];
    const res = await fetch(`${base}/api/terceros/buscar?q=ferre`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body.find((t: any) => t.id === 'sup-1')).toEqual({ ...proveedor, tipo: 'PROVEEDOR' });
    expect(body.find((t: any) => t.id === 'cli-1')).toEqual({ ...cliente, tipo: 'CLIENTE' });

    // Scoped a la empresa y con el nombre como criterio, sin traer facturas/bills.
    const sup = llamadas.find((c) => c.delegate === 'supplier' && c.metodo === 'findMany');
    expect(sup.args.where).toEqual({ companyId: 'co-1', name: { contains: 'ferre', mode: 'insensitive' } });
    expect(sup.args.select).toEqual({ id: true, name: true, taxId: true, dv: true, taxIdType: true });
    expect(sup.args.take).toBe(8);
  });

  it('con menos de dos letras devuelve vacío sin consultar el maestro', async () => {
    llamadas = [];
    const res = await fetch(`${base}/api/terceros/buscar?q=f`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });
});
