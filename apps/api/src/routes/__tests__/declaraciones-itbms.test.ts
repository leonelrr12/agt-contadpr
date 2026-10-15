/**
 * Rutas de la declaración de ITBMS: cableado, validación y —lo que más puede romperse
 * en silencio— que el PDF se dibuje de verdad (pdfkit no avisa: si una coordenada sale
 * mal, el archivo sale vacío o cortado).
 *
 * La lógica de negocio está en `services/__tests__/declaracion-itbms.test.ts`; acá se
 * prueba que las rutas la expongan bien.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { declaracionesRouter } from '../declaraciones';

const DECLARACION = {
  id: 'dec-1',
  companyId: 'c1',
  period: '2026-01',
  year: 2026,
  mes: 1,
  estado: 'PRESENTADA',
  baseVentas: 1000,
  debitoFiscal: 70,
  baseCompras: 500,
  creditoFiscal: 35,
  retencionAplicada: 35,
  saldoAnterior: -430,
  saldoAPagar: -430,
  saldoAFavor: true,
  numeroFormulario: '430-2026-01-9',
  fechaPresentacion: new Date(2026, 1, 10, 12, 0, 0),
  presentadaAt: new Date(2026, 1, 10, 15, 0, 0),
  montoPagado: null,
  fechaPago: null,
  anuladaAt: null,
  anuladoPorId: null,
  motivoAnulacion: null,
  asientoCompensacionId: 'je-1',
  asientoPagoId: null,
  notas: 'Presentada sin retenciones con certificado',
  borradorJson: JSON.stringify({ cuadre: { cuadra: true }, avisos: [] }),
};

const prisma: any = {
  declaracionItbms: {
    findFirst: async ({ where }: any) => {
      if (where.id) return where.id === DECLARACION.id ? DECLARACION : null;
      // La consulta del período: `{ companyId, period, estado: { not: 'ANULADA' } }`.
      if (where.period && where.period !== DECLARACION.period) return null;
      if (where.estado?.not === DECLARACION.estado) return null;
      return DECLARACION;
    },
    findMany: async () => [DECLARACION],
  },
  retentionItbms: {
    findMany: async () => [
      {
        id: 'r1', fecha: new Date(2026, 0, 20), montoRetencion: 35, baseGravada: 500, itbmsFacturado: 35,
        numeroCertificado: 'C-77', estado: 'APLICADA', client: { name: 'Inmobiliaria Don Antonio, S.A.' },
      },
    ],
  },
  journalEntry: {
    findMany: async () => [
      { id: 'je-1', date: new Date(2026, 1, 10, 12, 0, 0), description: 'Compensación R52 al presentar la declaración 430 Enero 2026', status: 'BORRADOR', anuladoPorId: null },
    ],
  },
  company: { findUnique: async () => ({ name: 'Servicios Generales Odesa S.A', taxId: '8-123-456' }) },
  auditLog: { create: async () => ({}) },
  // Lo que `requireQuota` mira: suscripción vigente con su plan.
  subscription: {
    findFirst: async () => ({
      id: 'sub-1',
      status: 'ACTIVE',
      periodEnd: new Date(Date.now() + 30 * 86400000),
      movimientosUsados: 0,
      plan: { id: 'p1', name: 'Pro', maxMovimientos: 10000, precio: 29 },
    }),
    update: async () => ({}),
  },
};

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin', name: 'Contador', email: 'c@x.com' };
    req.prisma = prisma;
    next();
  });
  app.use('/api/declaraciones-itbms', declaracionesRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/declaraciones-itbms`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string, init?: any): Promise<{ status: number; tipo: string; body: any }> => {
  const res = await fetch(`${base}${ruta}`, init);
  const tipo = res.headers.get('content-type') || '';
  return { status: res.status, tipo, body: tipo.includes('json') ? await res.json() : await res.arrayBuffer() };
};

describe('declaraciones-itbms', () => {
  it('GET /periodo/:period devuelve la declaración viva y lo aplicable al renglón 52', async () => {
    const r = await pedir('/periodo/2026-01');
    expect(r.status).toBe(200);
    expect(r.body.declaracion.estado).toBe('PRESENTADA');
    expect(r.body.retenciones).toBeTruthy();
  });

  it('un período mal formado se rechaza con 400', async () => {
    const r = await pedir('/periodo/2026-13');
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('YYYY-MM');
  });

  it('crear con un cuerpo inválido no llega al servicio', async () => {
    const r = await pedir('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: 2026, mes: 13 }),
    });
    expect(r.status).toBe(400);
  });

  it('presentar sin número de formulario se rechaza con 400', async () => {
    const r = await pedir('/dec-1/presentar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it('anular sin motivo se rechaza con 400', async () => {
    const r = await pedir('/dec-1/anular', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'x' }),
    });
    expect(r.status).toBe(400);
  });

  it('una declaración que no existe da 404', async () => {
    const r = await pedir('/no-existe');
    expect(r.status).toBe(404);
  });

  it('⭐ el PDF se genera de verdad (cabecera %PDF y tamaño razonable)', async () => {
    const r = await pedir('/dec-1/pdf');
    expect(r.status).toBe(200);
    expect(r.tipo).toContain('application/pdf');
    const bytes = Buffer.from(r.body);
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(bytes.length).toBeGreaterThan(2000); // con encabezado, renglones, retenciones y asientos
  });

  it('el PDF de una declaración que no existe da 404', async () => {
    const r = await pedir('/no-existe/pdf');
    expect(r.status).toBe(404);
  });
});
