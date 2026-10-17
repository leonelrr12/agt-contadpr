/**
 * Ficha de la empresa (Administración → Empresa): perfil fiscal y logo/sello.
 *
 * Lo que más puede romperse en silencio es el DV: la ficha de la DGI imprime el
 * RUC y el DV separados, pero el mismo RUC llega pegado (`...-50`) por la carga
 * del contribuyente. Si el backend no lo separa, el RUC base deja de ser
 * comparable y vuelve el problema de las facturas duplicadas.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { companiesRouter } from '../companies';

// El alta de empresas trae medio mundo (plan de cuentas, conceptos, plan Demo).
// Acá solo se prueba la ficha, así que esos servicios se reemplazan por espías.
vi.mock('../../services/crear-empresa', () => ({
  PLANTILLA_DEL_SISTEMA: 'demo-company',
  crearEmpresaConPlantilla: async () => ({}),
  hacerAdministrador: async () => {},
}));
vi.mock('../../services/empresas-usuario', () => ({
  esSuperadmin: async () => false,
  empresasDeUsuario: async () => [],
  sesionEnEmpresa: async () => null,
}));

const ADMIN = { userId: 'u-1', companyId: 'c-1', role: 'admin', name: 'Dueño', email: 'd@x.com' };

function prismaFalso(company: any) {
  const state: any = { company: { ...company } };
  const prisma: any = {
    company: {
      findUnique: async () => state.company,
      update: async ({ data }: any) => {
        state.company = { ...state.company, ...data };
        return state.company;
      },
    },
    auditLog: { create: async ({ data }: any) => data },
  };
  return { prisma, state };
}

const EMPRESA = {
  id: 'c-1',
  name: 'Mi Empresa',
  taxId: 'SIN-RUC-abc',
  dv: null,
  tipoEntidad: 'Persona jurídica',
  actividadEconomica: 'Comercio al por menor',
  noPatronal: '123456-7',
  observaciones: null,
  fechaApertura: new Date(2026, 0, 15, 12),
  address: null,
  phone: null,
  email: null,
  logo: null,
  sello: null,
  facturaSerie: 'A',
  facturaResolucion: '123-2026',
  facturaResolucionFecha: new Date(2026, 0, 10, 12),
  facturaCorrelativo: 5,
};

// PNG de 1×1: lo mínimo que sharp acepta como imagen de verdad.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

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
  app.use('/api/companies', companiesRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(() => server?.close());

const pedir = async (ruta: string, init: any = {}): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${ruta}`, init);
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
};

const guardar = (campos: Record<string, string>, archivo?: { name: string; buffer: Buffer; type: string }) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, v);
  if (archivo) form.append(archivo.name, new Blob([archivo.buffer], { type: archivo.type }), `${archivo.name}.png`);
  return pedir('/companies/current', { method: 'PATCH', body: form });
};

describe('GET /companies/current', () => {
  it('no expone el marcador SIN-RUC como si fuera un RUC real', async () => {
    const { prisma } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await pedir('/companies/current');

    expect(r.status).toBe(200);
    expect(r.body.taxId).toBe('');
    expect(r.body.fechaApertura).toBe('2026-01-15');
    expect(r.body.tipoEntidad).toBe('Persona jurídica');
    expect(r.body.hasLogo).toBe(false);
    // La configuración DGI vive acá desde que se mudó del módulo Facturas.
    expect(r.body.facturaSerie).toBe('A');
    expect(r.body.facturaResolucion).toBe('123-2026');
    expect(r.body.facturaResolucionFecha).toBe('2026-01-10');
    // El correlativo no se edita: se muestra el próximo número a emitir.
    expect(r.body.proximoNumeroFactura).toBe('A-000006');
  });

  it('muestra bien la fecha vieja guardada a medianoche UTC (sin correrla un día)', async () => {
    // El endpoint anterior guardaba `new Date('2026-01-15')` = medianoche UTC;
    // leerla con getters locales en Panamá/NY mostraba el 14.
    const { prisma } = prismaFalso({ ...EMPRESA, facturaResolucionFecha: new Date('2026-01-15T00:00:00Z') });
    actual = { prisma, user: ADMIN };

    const r = await pedir('/companies/current');

    expect(r.body.facturaResolucionFecha).toBe('2026-01-15');
  });
});

describe('PATCH /companies/current', () => {
  it('separa el DV del RUC completo y guarda el RUC base', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({ name: 'RIBA SMITH S A', taxId: '342-240-75526-50', dv: '' });

    expect(r.status).toBe(200);
    expect(state.company.taxId).toBe('342-240-75526');
    expect(state.company.dv).toBe('50');
    expect(r.body.taxId).toBe('342-240-75526');
    expect(r.body.dv).toBe('50');
  });

  it('guarda la configuración DGI: serie en mayúsculas y fecha a mediodía', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({
      name: 'Mi Empresa',
      facturaSerie: 'ab',
      facturaResolucion: '456-2026',
      facturaResolucionFecha: '2026-02-15',
    });

    expect(r.status).toBe(200);
    expect(state.company.facturaSerie).toBe('AB');
    expect(state.company.facturaResolucion).toBe('456-2026');
    expect(state.company.facturaResolucionFecha.getHours()).toBe(12);
    expect(r.body.facturaResolucionFecha).toBe('2026-02-15');
  });

  it('rechaza una serie de más de 5 caracteres', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({ name: 'Mi Empresa', facturaSerie: 'ABCDEF' });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('serie');
    expect(state.company.facturaSerie).toBe('A');
  });

  it('rechaza un DV que no son 1–2 dígitos', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({ name: 'Mi Empresa', taxId: '8-733-2267', dv: 'ABC' });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('DV');
    expect(state.company.dv).toBeNull();
  });

  it('rechaza un email inválido sin guardar nada', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({ name: 'Mi Empresa', email: 'no-es-un-email' });

    expect(r.status).toBe(400);
    expect(r.body.error).toContain('email');
    expect(state.company.name).toBe('Mi Empresa');
  });

  it('sube el logo, lo guarda como PNG y lo devuelve para la vista previa', async () => {
    const { prisma, state } = prismaFalso(EMPRESA);
    actual = { prisma, user: ADMIN };

    const r = await guardar({ name: 'Mi Empresa' }, { name: 'logo', buffer: PNG, type: 'image/png' });

    expect(r.status).toBe(200);
    expect(Buffer.isBuffer(state.company.logo)).toBe(true);
    expect(r.body.hasLogo).toBe(true);
    expect(r.body.logoDataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('el contador no puede editar la ficha fiscal', async () => {
    const { prisma } = prismaFalso(EMPRESA);
    actual = { prisma, user: { ...ADMIN, role: 'contador' } };

    const r = await guardar({ name: 'Otro nombre' });

    expect(r.status).toBe(403);
  });
});
