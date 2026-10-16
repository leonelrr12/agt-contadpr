/**
 * El panel SaaS por cuenta (PLANES.md §7 fase 4): una fila por cliente que paga, con
 * lo que tiene contratado —sus empresas con los usuarios propios de cada una, la cuota
 * y los módulos—.
 *
 * Lo que puede romperse en silencio es **qué suscripción se muestra como la vigente**:
 * si el panel elige una vencida (o la primera que devuelve la BD), el dueño ve un plan
 * que el cliente ya no tiene y decide sobre eso. La regla es la misma que usa la app
 * (`services/suscripcion.ts`): la de período más largo entre las que pueden operar.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { adminRouter } from '../admin';

const CUENTAS = [
  {
    id: 'cta-1',
    name: 'Servicios Generales Odesa S.A',
    companies: [{ id: 'c-1', name: 'Odesa', taxId: '8-123', _count: { users: 5 } }],
    subscriptions: [
      { id: 's-nueva', status: 'GRANTED', periodEnd: new Date('2027-01-07'), movementsUsed: 1407, movementsLimit: 1500, addons: [], plan: { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2, modulos: ['inventario', 'planilla'] } },
      { id: 's-vieja', status: 'EXPIRED', periodEnd: new Date('2026-01-01'), movementsUsed: 50, movementsLimit: 50, addons: [], plan: { name: 'Despacho', maxEmpresas: 50, maxUsuariosPorEmpresa: 5, modulos: [] } },
    ],
  },
  {
    id: 'cta-2',
    name: 'Despacho Contable Istmeño',
    companies: [
      { id: 'c-2', name: 'Cliente Uno', taxId: '1-1', _count: { users: 3 } },
      { id: 'c-3', name: 'Cliente Dos', taxId: '2-2', _count: { users: 1 } },
    ],
    subscriptions: [
      { id: 's-3', status: 'ACTIVE', periodEnd: new Date('2026-12-01'), movementsUsed: 100, movementsLimit: 1000, addons: ['facturas-pdf'], plan: { name: 'Despacho 3', maxEmpresas: 3, maxUsuariosPorEmpresa: 3, modulos: [] } },
    ],
  },
  {
    id: 'cta-3',
    name: 'Cuenta sin plan',
    companies: [{ id: 'c-4', name: 'Sin Plan SA', taxId: '9-9', _count: { users: 1 } }],
    subscriptions: [{ id: 's-4', status: 'EXPIRED', periodEnd: new Date('2026-02-01'), movementsUsed: 0, movementsLimit: 50, addons: [], plan: { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2, modulos: [] } }],
  },
];

let server: any;
let base = '';
let rol = 'superadmin';
let ultimaConsulta: any = null;
/** Se cambia por test: cada bloque arma el Prisma que necesita. */
let prismaActual: any = null;
const parcheado: any = { data: null };

beforeAll(async () => {
  prismaActual = {
    cuenta: {
      findMany: async (args: any) => {
        ultimaConsulta = args;
        return CUENTAS;
      },
    },
    subscription: {
      findUnique: async () => ({ id: 's-sub', addons: [], planId: 'p1' }),
      update: async ({ data }: any) => {
        parcheado.data = data;
        return { id: 's-sub', ...data };
      },
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u-super', companyId: 'c-1', role: rol, name: 'Dueño', email: 'd@x.com' };
    req.prisma = prismaActual;
    next();
  });
  app.use('/api/admin', adminRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/admin`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${ruta}`);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/admin/cuentas', () => {
  it('una fila por cuenta, con sus empresas y los usuarios propios de cada una', async () => {
    rol = 'superadmin';
    const { status, body } = await pedir('/cuentas');

    expect(status).toBe(200);
    expect(body).toHaveLength(3);
    expect(body[1]).toMatchObject({
      name: 'Despacho Contable Istmeño',
      empresas: [
        { name: 'Cliente Uno', usuarios: 3 },
        { name: 'Cliente Dos', usuarios: 1 },
      ],
    });
    // El tope del plan viaja con la suscripción: el panel lo necesita para pintar
    // «1 / 1 empresas» y «5 / 2 usuarios» en rojo.
    expect(body[1].suscripcion.plan).toMatchObject({ maxEmpresas: 3, maxUsuariosPorEmpresa: 3 });
  });

  it('⭐ muestra la suscripción VIGENTE, no la vencida', async () => {
    rol = 'superadmin';
    const { body } = await pedir('/cuentas');
    const odesa = body.find((c: any) => c.id === 'cta-1');
    expect(odesa.suscripcion.id).toBe('s-nueva');
    expect(odesa.suscripcion.status).toBe('GRANTED');
    expect(odesa.historial).toBe(1); // la vencida queda contada como historial
  });

  it('una cuenta sin nada vigente llega con suscripción null (y se le puede asignar un plan)', async () => {
    rol = 'superadmin';
    const { body } = await pedir('/cuentas');
    const sinPlan = body.find((c: any) => c.id === 'cta-3');
    expect(sinPlan.suscripcion).toBeNull();
    expect(sinPlan.empresas).toHaveLength(1);
  });

  it('el filtro de estado deja solo las cuentas con ese estado vigente', async () => {
    rol = 'superadmin';
    const { body } = await pedir('/cuentas?status=ACTIVE');
    expect(body.map((c: any) => c.id)).toEqual(['cta-2']);
  });

  it('la búsqueda mira la cuenta Y sus empresas (el dueño busca por el nombre del cliente)', async () => {
    rol = 'superadmin';
    await pedir('/cuentas?search=odesa');
    expect(ultimaConsulta.where.OR).toEqual([
      { name: { contains: 'odesa', mode: 'insensitive' } },
      { companies: { some: { name: { contains: 'odesa', mode: 'insensitive' } } } },
    ]);
  });

  it('un admin de empresa NO entra al panel de la plataforma', async () => {
    rol = 'admin';
    const { status } = await pedir('/cuentas');
    expect(status).toBe(403);
    rol = 'superadmin';
  });
});

describe('PATCH /api/admin/subscriptions/:id — cortesías de cupo', () => {
  const parchar = async (body: any): Promise<{ status: number; body: any }> => {
    parcheado.data = null;
    const res = await fetch(`${base}/subscriptions/s-sub`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it('un entero sube el cupo de esa suscripción', async () => {
    const r = await parchar({ maxUsuariosPorEmpresa: 10, maxEmpresas: 3 });
    expect(r.status).toBe(200);
    expect(parcheado.data).toMatchObject({ maxUsuariosPorEmpresa: 10, maxEmpresas: 3 });
  });

  it('null lo devuelve al tope del plan', async () => {
    const r = await parchar({ maxUsuariosPorEmpresa: null });
    expect(r.status).toBe(200);
    expect(parcheado.data.maxUsuariosPorEmpresa).toBeNull();
    expect(parcheado.data.maxEmpresas).toBeUndefined(); // no se tocó
  });

  it('0 es «sin tope» (el guardia lo lee así)', async () => {
    const r = await parchar({ maxEmpresas: 0 });
    expect(r.status).toBe(200);
    expect(parcheado.data.maxEmpresas).toBe(0);
  });

  it('un valor que no es entero se rechaza en vez de llegar a la columna', async () => {
    const r = await parchar({ maxUsuariosPorEmpresa: 'muchos' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('entero');
    expect(parcheado.data).toBeNull(); // no se escribió nada
  });

  it('un add-on fuera del catálogo se rechaza', async () => {
    const r = await parchar({ addons: ['modulo-inventado'] });
    expect(r.status).toBe(400);
    expect(r.body.addonsValidos).toContain('facturas-pdf');
  });
});
