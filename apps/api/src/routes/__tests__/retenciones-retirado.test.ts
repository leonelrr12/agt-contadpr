/**
 * El retiro del botón viejo de compensar el R52.
 *
 * El crédito del renglón 52 ahora se aplica al PRESENTAR la declaración del 430: ahí el
 * asiento queda vinculado a la retención (`retencion_itbms.declaracionId`) y anular la
 * declaración las devuelve a RECIBIDA. El camino viejo marcaba APLICADA sin declaración
 * y sin vuelta atrás — una retención que ya no se podía deshacer.
 *
 * Los dos caminos viejos quedan cerrados con la guía en el mensaje: el POST devuelve 410
 * (para el JS que quede en caché) y el PATCH rechaza `APLICADA` con 400.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { retencionesRouter } from '../retenciones';

const RETENCION = {
  id: 'ret-1',
  companyId: 'c1',
  clientId: 'cli-1',
  invoiceId: 'inv-1',
  fecha: new Date(2026, 0, 20, 12, 0, 0),
  baseGravada: 500,
  itbmsFacturado: 35,
  porcentaje: 0.5,
  montoRetencion: 35,
  numeroCertificado: null,
  estado: 'PENDIENTE',
};

const prisma: any = {
  retentionItbms: {
    findFirst: async ({ where }: any) => (where.id === RETENCION.id ? { ...RETENCION } : null),
    update: async ({ data }: any) => ({ ...RETENCION, ...data }),
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
  app.use('/api/retenciones-itbms', retencionesRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/retenciones-itbms`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string, init?: any) => {
  const res = await fetch(`${base}${ruta}`, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const json = (body: any, method = 'POST') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('compensar el R52: los caminos viejos quedan cerrados con guía', () => {
  it('POST /compensar responde 410 y dice dónde se aplica ahora', async () => {
    const { status, body } = await pedir('/compensar', json({ retencionIds: ['ret-1'] }));
    expect(status).toBe(410);
    expect(body.code).toBe('COMPENSAR_R52_RETIRADO');
    expect(body.error).toContain('PRESENTAR');
    expect(body.error).toContain('430');
  });

  it('⭐ PATCH a APLICADA se rechaza: ese estado lo pone la declaración', async () => {
    const { status, body } = await pedir('/ret-1', json({ estado: 'APLICADA' }, 'PATCH'));
    expect(status).toBe(400);
    expect(body.code).toBe('R52_SE_APLICA_AL_DECLARAR');
    expect(body.error).toContain('declaración');
  });

  it('el resto del PATCH sigue funcionando (recibir con certificado)', async () => {
    // El «📥 Recibir» de la pantalla manda las dos cosas juntas, y el certificado sigue
    // siendo obligatorio para pasar a RECIBIDA.
    const { status } = await pedir('/ret-1', json({ estado: 'RECIBIDA', numeroCertificado: 'C-77' }, 'PATCH'));
    expect(status).toBe(200);
  });

  it('RECIBIDA sin certificado sigue rechazándose', async () => {
    const { status } = await pedir('/ret-1', json({ estado: 'RECIBIDA' }, 'PATCH'));
    expect(status).toBe(400);
  });

  it('una retención que no existe sigue dando 404 (no la guía)', async () => {
    const { status } = await pedir('/no-existe', json({ estado: 'APLICADA' }, 'PATCH'));
    expect(status).toBe(404);
  });
});
