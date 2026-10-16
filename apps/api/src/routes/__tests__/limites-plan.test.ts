/**
 * Los topes del plan, validados donde se consumen (PLANES.md §7 fase 2): no se puede
 * pasar de las empresas de la cuenta ni de los usuarios de la empresa, y el mensaje
 * dice cuántos hay y qué hacer.
 *
 * Lo que más puede romperse en silencio es la **regla del conteo de usuarios**: el
 * cupo es para la gente del cliente, no para el personal del despacho. Si alguien
 * cuenta membresías, un despacho con tres contadores deja a cada cliente sin poder
 * dar de alta a su propia gente — y eso no se ve hasta que un cliente lo pide.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { usersRouter } from '../users';
import { companiesRouter } from '../companies';

// El alta de empresas trae medio mundo (plan de cuentas, conceptos, plan Demo): acá
// se prueba el GUARDIA del tope, así que el alta se reemplaza por un espía.
const crearEmpresa = vi.fn(async (_tx: any, _datos: any, _opts: any) => ({ id: 'c-nueva', name: 'Cliente Nuevo', taxId: 'X' }));
vi.mock('../../services/crear-empresa', () => ({
  PLANTILLA_DEL_SISTEMA: 'demo-company',
  crearEmpresaConPlantilla: (tx: any, datos: any, opts: any) => crearEmpresa(tx, datos, opts),
  hacerAdministrador: async () => {},
}));

const sesion = { token: 't', user: { id: 'u-1' } };
vi.mock('../../services/empresas-usuario', () => ({
  esSuperadmin: async (_p: any, userId: string) => userId === 'u-super',
  empresasDeUsuario: async () => [{ id: 'c-1', name: 'Mi Empresa', role: 'admin' }],
  sesionEnEmpresa: async () => sesion,
  rolEnEmpresa: async () => 'admin',
}));

/** El plan que se le pone a la cuenta en cada caso, y lo que hay usado. */
function prismaFalso(opts: any = {}) {
  const creado = { usuarios: [] as any[], membresias: [] as any[], transacciones: 0 };
  const plan = opts.plan ?? { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 };
  const prisma: any = {
    subscription: {
      findFirst: async () => ('sinPlan' in opts && opts.sinPlan ? null : { id: 's1', cuentaId: 'cta-1', status: 'GRANTED', periodEnd: new Date(Date.now() + 86400000), plan }),
    },
    company: {
      // La empresa activa del creador y su cuenta
      findUnique: async ({ where }: any) => (where.id === 'c-1' ? { cuentaId: 'cta-1' } : null),
      count: async () => opts.empresasUsadas ?? 1,
    },
    user: {
      count: async () => opts.usuariosUsados ?? 0,
      findUnique: async ({ where }: any) =>
        where.email === 'contador@despacho.com'
          ? { id: 'u-externo', name: 'Contador', email: where.email, role: 'contador', isActive: true, companyId: 'c-otra' }
          : null,
      create: async ({ data }: any) => {
        creado.usuarios.push(data);
        return { id: 'u-nuevo', ...data };
      },
    },
    userCompany: {
      findUnique: async () => null,
      create: async ({ data }: any) => {
        creado.membresias.push(data);
        return data;
      },
    },
    auditLog: { create: async ({ data }: any) => data },
    $transaction: async (fn: any) => {
      creado.transacciones++;
      return fn(prisma);
    },
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
    req.user = actual.user;
    req.prisma = actual.prisma;
    next();
  });
  app.use('/api/users', usersRouter);
  app.use('/api/companies', companiesRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string, body: any): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const USUARIO = { userId: 'u-1', companyId: 'c-1', role: 'admin', name: 'Dueño', email: 'd@x.com' };
const NUEVO = { name: 'Nuevo', email: 'nuevo@cliente.com', password: 'secreta123', role: 'contador' };

describe('cupo de usuarios por empresa', () => {
  it('con el cupo lleno rechaza con 402 y dice cuántos hay y qué hacer', async () => {
    const { prisma, creado } = prismaFalso({ usuariosUsados: 2 });
    actual = { prisma, user: USUARIO };

    const r = await pedir('/users', NUEVO);

    expect(r.status).toBe(402);
    expect(r.body.code).toBe('PLAN_LIMIT_USUARIOS');
    expect(r.body).toMatchObject({ plan: 'Demo', usados: 2, max: 2 });
    expect(r.body.error).toContain('2 usuarios por empresa y esta ya tiene 2');
    expect(r.body.error).toContain('pasá a un plan con más usuarios');
    expect(creado.usuarios).toHaveLength(0); // no se creó nada
  });

  it('con lugar de sobra crea el usuario y su membresía', async () => {
    const { prisma, creado } = prismaFalso({ usuariosUsados: 1 });
    actual = { prisma, user: USUARIO };

    const r = await pedir('/users', NUEVO);

    expect(r.status).toBe(201);
    expect(creado.usuarios).toHaveLength(1);
    expect(creado.membresias).toEqual([{ userId: 'u-nuevo', companyId: 'c-1', role: 'contador' }]);
  });

  it('⭐ vincular al contador del despacho NO consume cupo aunque la empresa esté llena', async () => {
    // La regla fina de PLANES.md §3: el cupo es para la gente del cliente. El
    // contador que entra desde otra empresa es una membresía, no un usuario propio.
    const { prisma, creado } = prismaFalso({ usuariosUsados: 99 });
    actual = { prisma, user: USUARIO };

    const r = await pedir('/users/vincular', { email: 'contador@despacho.com', role: 'contador' });

    expect(r.status).toBe(201);
    expect(creado.membresias).toEqual([{ userId: 'u-externo', companyId: 'c-1', role: 'contador' }]);
  });

  it('sin suscripción vigente tampoco se crean usuarios', async () => {
    const { prisma, creado } = prismaFalso({ sinPlan: true });
    actual = { prisma, user: USUARIO };

    const r = await pedir('/users', NUEVO);

    expect(r.status).toBe(402);
    expect(r.body.code).toBe('NO_SUBSCRIPTION');
    expect(creado.usuarios).toHaveLength(0);
  });
});

describe('cupo de empresas por cuenta', () => {
  it('con la cuenta llena rechaza con 402 y no crea la empresa', async () => {
    const { prisma } = prismaFalso({ plan: { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 }, empresasUsadas: 1 });
    actual = { prisma, user: USUARIO };
    crearEmpresa.mockClear();

    const r = await pedir('/companies', { name: 'Cliente Nuevo' });

    expect(r.status).toBe(402);
    expect(r.body.code).toBe('PLAN_LIMIT_EMPRESAS');
    expect(r.body.error).toContain('1 empresa y tu cuenta ya tiene 1');
    expect(crearEmpresa).not.toHaveBeenCalled();
  });

  it('con lugar en el plan crea la empresa y devuelve la sesión en ella', async () => {
    const { prisma } = prismaFalso({ plan: { name: 'Despacho 3', maxEmpresas: 3, maxUsuariosPorEmpresa: 3 }, empresasUsadas: 1 });
    actual = { prisma, user: USUARIO };
    crearEmpresa.mockClear();

    const r = await pedir('/companies', { name: 'Cliente Nuevo' });

    expect(r.status).toBe(201);
    expect(r.body.company.id).toBe('c-nueva');
    expect(r.body.token).toBe('t');
    // El alta va a la cuenta del despacho (fase 1), y con eso el cupo se controla ahí.
    expect(crearEmpresa.mock.calls[0][2]).toMatchObject({ cuentaId: 'cta-1' });
  });

  it('el superadmin no tiene tope: lo que hace es abrir un cliente nuevo', async () => {
    const { prisma } = prismaFalso({ plan: { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 }, empresasUsadas: 99 });
    actual = { prisma, user: { ...USUARIO, userId: 'u-super', role: 'superadmin' } };
    crearEmpresa.mockClear();

    const r = await pedir('/companies', { name: 'Cliente Nuevo' });

    expect(r.status).toBe(201);
    // Sin `cuentaId`: nace con su propia cuenta y su Demo (fase 1).
    expect(crearEmpresa.mock.calls[0][2]).toMatchObject({ cuentaId: undefined });
  });
});
