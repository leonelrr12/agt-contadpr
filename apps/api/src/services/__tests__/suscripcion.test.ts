import { describe, it, expect } from 'vitest';
import { ESTADOS_VIGENTES, empresasDeLaCuenta, incrementarUsoDeEmpresa, suscripcionDeEmpresa } from '../suscripcion';

/**
 * El salto «empresa → cuenta → suscripción» (PLANES.md §2) es la pieza que sostiene
 * toda la fase: si alguien vuelve a filtrar por `companyId`, la cuota de un despacho
 * se parte en una por cliente y nadie se entera hasta que una empresa se queda sin
 * cupo con el plan pagado. Por eso se fija acá la FORMA de la consulta.
 */

function prismaFalso(opts: any = {}) {
  const visto: any = { suscripcion: null, incremento: null, empresa: null };
  const prisma: any = {
    subscription: {
      findFirst: async (args: any) => {
        visto.suscripcion = args;
        return opts.suscripcion ?? null;
      },
      updateMany: async (args: any) => {
        visto.incremento = args;
        return { count: 1 };
      },
    },
    company: {
      findUnique: async (args: any) => {
        visto.empresa = args;
        return 'company' in opts ? opts.company : { cuenta: { companies: [{ id: 'c-1' }, { id: 'c-2' }] } };
      },
    },
  };
  return { prisma, visto };
}

describe('suscripcionDeEmpresa', () => {
  it('resuelve la suscripción por la CUENTA de la empresa, no por la empresa', async () => {
    const { prisma, visto } = prismaFalso();
    await suscripcionDeEmpresa(prisma, 'c-1');

    expect(visto.suscripcion.where.cuenta).toEqual({ companies: { some: { id: 'c-1' } } });
    expect(visto.suscripcion.where.companyId).toBeUndefined();
    expect(visto.suscripcion.where.status).toEqual({ in: ESTADOS_VIGENTES });
    expect(visto.suscripcion.include).toEqual({ plan: true });
  });

  it('sin empresa no consulta nada (y devuelve null)', async () => {
    const { prisma, visto } = prismaFalso();
    expect(await suscripcionDeEmpresa(prisma, '')).toBeNull();
    expect(visto.suscripcion).toBeNull();
  });

  it('sin suscripción vigente devuelve null (la ruta responde 402)', async () => {
    const { prisma } = prismaFalso({ suscripcion: null });
    expect(await suscripcionDeEmpresa(prisma, 'c-1')).toBeNull();
  });
});

describe('incrementarUsoDeEmpresa', () => {
  it('suma el consumo a la suscripción de la cuenta (una sola cuota para todas sus empresas)', async () => {
    const { prisma, visto } = prismaFalso();
    await incrementarUsoDeEmpresa(prisma, 'c-2', 0.5);

    expect(visto.incremento.where.cuenta).toEqual({ companies: { some: { id: 'c-2' } } });
    expect(visto.incremento.where.companyId).toBeUndefined();
    expect(visto.incremento.data).toEqual({ movementsUsed: { increment: 0.5 } }); // la planilla semanal cobra media
  });
});

describe('empresasDeLaCuenta', () => {
  it('devuelve todas las empresas de la cuenta, para sumarles el uso diario', async () => {
    const { prisma } = prismaFalso();
    expect(await empresasDeLaCuenta(prisma, 'c-1')).toEqual(['c-1', 'c-2']);
  });

  it('sin empresa devuelve vacío (el gráfico no inventa datos)', async () => {
    const { prisma } = prismaFalso({ company: null });
    expect(await empresasDeLaCuenta(prisma, 'c-9')).toEqual([]);
  });
});
