/**
 * Los roles exclusivos y el plan (PLANES.md §8 trampa 5): `inventario` y `planilla`
 * son roles que solo ven y operan SU módulo, así que en un plan que no lo incluye
 * dejarían a un usuario encerrado en una pantalla que responde 402. Se rechazan al
 * asignarlos —al crear, al vincular y al cambiar el rol— con ese motivo.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { usersRouter } from '../users';

const PLAN_SIN_MODULOS = { name: 'Emprendedor', modulos: [], maxEmpresas: 1, maxUsuariosPorEmpresa: 3 };
const PLAN_CON_PLANILLA = { name: 'Pyme', modulos: ['inventario', 'planilla'], maxEmpresas: 1, maxUsuariosPorEmpresa: 10 };

function prismaFalso(plan: any) {
  const creado = { usuarios: [] as any[], membresias: [] as any[], roles: [] as any[] };
  const prisma: any = {
    subscription: {
      findFirst: async () => ({ id: 's1', cuentaId: 'cta-1', status: 'ACTIVE', periodEnd: new Date(Date.now() + 86400000), addons: [], plan }),
    },
    user: {
      count: async () => 1,
      create: async ({ data }: any) => {
        creado.usuarios.push(data);
        return { id: 'u-nuevo', ...data };
      },
      findUnique: async ({ where }: any) =>
        where.email === 'nuevo@cliente.com'
          ? { id: 'u-externo', name: 'Nuevo', email: where.email, role: 'contador', isActive: true, companyId: 'c-otra' }
          : null,
      update: async ({ data }: any) => ({ id: 'u-2', name: 'Otro', email: 'o@x.com', role: 'contador', isActive: true, ...data }),
    },
    company: { count: async () => 1 },
    userCompany: {
      findUnique: async () => ({ role: 'contador', user: { id: 'u-2', name: 'Otro', email: 'o@x.com', role: 'contador', isActive: true } }),
      create: async ({ data }: any) => {
        creado.membresias.push(data);
        return data;
      },
      update: async ({ data }: any) => {
        creado.roles.push(data);
        return data;
      },
    },
    auditLog: { create: async ({ data }: any) => data },
    $transaction: async (fn: any) => fn(prisma),
  };
  return { prisma, creado };
}

let server: any;
let base = '';
let actual: any = {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u-1', companyId: 'c-1', role: 'admin', name: 'Dueño', email: 'd@x.com' };
    req.prisma = actual.prisma;
    next();
  });
  app.use('/api/users', usersRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/users`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string, body: any, method = 'POST'): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${ruta}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const NUEVO = (role: string) => ({ name: 'Nuevo', email: 'nuevo@cliente.com', password: 'secreta123', role });

describe('roles exclusivos contra los módulos del plan', () => {
  it('⭐ crear un usuario de planilla en un plan sin planilla se rechaza con el motivo', async () => {
    const { prisma, creado } = prismaFalso(PLAN_SIN_MODULOS);
    actual = { prisma };

    const r = await pedir('/', NUEVO('planilla'));

    expect(r.status).toBe(402);
    expect(r.body.code).toBe('ROL_REQUIERE_MODULO');
    expect(r.body).toMatchObject({ modulo: 'planilla', plan: 'Emprendedor' });
    expect(r.body.error).toContain('no incluye el módulo de Planilla');
    expect(r.body.error).toContain('creá el usuario con otro rol');
    expect(creado.usuarios).toHaveLength(0);
  });

  it('con el módulo en el plan, el usuario de planilla se crea normal', async () => {
    const { prisma, creado } = prismaFalso(PLAN_CON_PLANILLA);
    actual = { prisma };

    const r = await pedir('/', NUEVO('planilla'));

    expect(r.status).toBe(201);
    expect(creado.usuarios).toHaveLength(1);
  });

  it('un rol normal no depende de los módulos', async () => {
    const { prisma, creado } = prismaFalso(PLAN_SIN_MODULOS);
    actual = { prisma };

    const r = await pedir('/', NUEVO('contador'));

    expect(r.status).toBe(201);
    expect(creado.usuarios).toHaveLength(1);
  });

  it('vincular con un rol exclusivo sin el módulo también se rechaza', async () => {
    const { prisma, creado } = prismaFalso(PLAN_SIN_MODULOS);
    actual = { prisma };

    const r = await pedir('/vincular', { email: 'nuevo@cliente.com', role: 'inventario' });

    expect(r.status).toBe(402);
    expect(r.body.modulo).toBe('inventario');
    expect(creado.membresias).toHaveLength(0);
  });

  it('cambiar el rol a uno exclusivo sin el módulo se rechaza igual que crearlo', async () => {
    const { prisma, creado } = prismaFalso(PLAN_SIN_MODULOS);
    actual = { prisma };

    const r = await pedir('/u-2', { role: 'inventario' }, 'PATCH');

    expect(r.status).toBe(402);
    expect(r.body.code).toBe('ROL_REQUIERE_MODULO');
    expect(creado.roles).toHaveLength(0); // no se cambió nada
  });

  it('cambiar el rol a uno exclusivo con el módulo incluido sí pasa', async () => {
    const { prisma, creado } = prismaFalso(PLAN_CON_PLANILLA);
    actual = { prisma };

    const r = await pedir('/u-2', { role: 'inventario' }, 'PATCH');

    expect(r.status).toBe(200);
    expect(creado.roles).toEqual([{ role: 'inventario' }]);
  });
});
