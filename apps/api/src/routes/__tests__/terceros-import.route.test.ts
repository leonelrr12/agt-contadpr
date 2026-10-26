import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { tercerosRouter } from '../terceros';

/**
 * Prueba de cableado HTTP real (Express + multer + ExcelJS) con un Prisma de
 * mentira: no toca la BD ni necesita auth. Cubre preview, apply y plantilla.
 */
function fakePrisma() {
  const client: any[] = [];
  const supplier: any[] = [];
  const model = (rows: any[], prefix: string) => ({
    findMany: async () => rows,
    create: async ({ data }: any) => {
      const row = { id: `${prefix}${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
  });
  return { client: model(client, 'c'), supplier: model(supplier, 's'), rows: { client, supplier } };
}

describe('rutas de importación de terceros', () => {
  let server: Server;
  let base = '';
  let prisma: any;

  beforeAll(async () => {
    prisma = fakePrisma();
    const app = express();
    app.use((req: any, _res, next) => {
      req.user = { userId: 'u1', companyId: 'co-1', role: 'admin', name: 'Test', email: 't@test.com' };
      req.prisma = prisma;
      next();
    });
    app.use('/api/terceros', tercerosRouter);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    const addr = server.address() as any;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const csv = [
    'TIPO,RUC,DV,NOMBRE,RAZON SOCIAL,TIPO IDENTIFICACION,TELEFONO,EMAIL,DIRECCION,NOTAS',
    'Proveedor,46004-187-302083,96,+Movil Panama,CABLES & WIRILESS,RUC,,,,',
  ].join('\n');

  it('preview devuelve el plan sin escribir', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'terceros.csv');
    fd.append('modo', 'completar');
    const res = await fetch(`${base}/api/terceros/import/preview`, { method: 'POST', body: fd });
    const data: any = await res.json();
    expect(res.status).toBe(200);
    expect(data.resumen.nuevo).toBe(1);
    expect(data.filas[0]).toMatchObject({ tipo: 'Proveedor', name: 'CABLES & WIRILESS', dv: '96' });
    expect(prisma.rows.supplier).toHaveLength(0);
  });

  it('apply crea el tercero con el perfil normalizado', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([csv], { type: 'text/csv' }), 'terceros.csv');
    fd.append('modo', 'completar');
    const res = await fetch(`${base}/api/terceros/import/apply`, { method: 'POST', body: fd });
    const data: any = await res.json();
    expect(res.status).toBe(200);
    expect(data.aplicadas).toBe(1);
    expect(prisma.rows.supplier).toHaveLength(1);
    expect(prisma.rows.supplier[0]).toMatchObject({
      companyId: 'co-1',
      name: 'CABLES & WIRILESS',
      tradeName: '+Movil Panama',
      taxId: '46004-187-302083',
      dv: '96',
      fiscalSource: 'IMPORT',
    });
  });

  it('template descarga un XLSX', async () => {
    const res = await fetch(`${base}/api/terceros/import/template`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(1000);
  });
});
