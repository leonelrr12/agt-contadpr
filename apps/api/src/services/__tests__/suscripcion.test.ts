import { describe, it, expect } from 'vitest';
import { ESTADOS_VIGENTES, empresasDeLaCuenta, incrementarUsoDeEmpresa, modulosDeLaCuenta, suscripcionDeEmpresa, topesDeLaCuenta, usoDiarioPorDia } from '../suscripcion';

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

/** Para los topes: además de la suscripción, los dos conteos. */
function prismaFalsoTopes(opts: any = {}) {
  const visto: any = {};
  const prisma: any = {
    subscription: { findFirst: async () => ('suscripcion' in opts ? opts.suscripcion : null) },
    company: {
      count: async (args: any) => {
        visto.empresas = args;
        return opts.empresas ?? 0;
      },
    },
    user: {
      count: async (args: any) => {
        visto.usuarios = args;
        return opts.usuarios ?? 0;
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

describe('modulosDeLaCuenta', () => {
  const conPlan = (sub: any) => ({ prisma: { subscription: { findFirst: async () => sub } } }) as any;

  it('junta los módulos del PLAN con los add-ons contratados, sin repetidos', async () => {
    // El módulo se tiene por cualquiera de los dos caminos (PLANES.md §4), y el que
    // está en los dos no puede aparecer dos veces: el menú lo lee tal cual.
    const { prisma } = conPlan({
      periodEnd: new Date(Date.now() + 86400000),
      addons: ['facturas-pdf', 'inventario'],
      plan: { name: 'Despacho', modulos: ['inventario', 'planilla'] },
    });

    const cuenta = await modulosDeLaCuenta(prisma, 'c-1');

    expect(cuenta).toMatchObject({ plan: 'Despacho', vencida: false });
    expect(cuenta!.modulos.sort()).toEqual(['facturas-pdf', 'inventario', 'planilla']);
  });

  it('sin suscripción vigente devuelve null', async () => {
    const { prisma } = conPlan(null);
    expect(await modulosDeLaCuenta(prisma, 'c-1')).toBeNull();
  });

  it('marca la suscripción vencida (el guardia responde 402 y no «falta el módulo»)', async () => {
    const { prisma } = conPlan({ periodEnd: new Date(Date.now() - 1000), addons: [], plan: { name: 'Pyme', modulos: ['inventario'] } });
    expect((await modulosDeLaCuenta(prisma, 'c-1'))!.vencida).toBe(true);
  });
});

describe('topesDeLaCuenta', () => {
  const conPlan = (plan: any, empresas = 2, usuarios = 5) =>
    prismaFalsoTopes({ suscripcion: { id: 's1', cuentaId: 'cta-1', plan }, empresas, usuarios });

  it('devuelve el tope del plan con lo usado: empresas de la CUENTA, usuarios de ESTA empresa', async () => {
    const { prisma, visto } = conPlan({ name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 }, 2, 5);
    const topes = await topesDeLaCuenta(prisma, 'c-1');

    expect(topes).toEqual({
      plan: 'Demo',
      empresas: { usados: 2, max: 1 },
      usuarios: { usados: 5, max: 2 },
    });
    // El cupo de usuarios se cuenta por empresa casa (`User.companyId`), NO por
    // membresías: si contara membresías, el personal del despacho agotaría el cupo
    // de cada cliente (PLANES.md §3).
    expect(visto.usuarios).toEqual({ where: { companyId: 'c-1' } });
    expect(visto.empresas).toEqual({ where: { cuentaId: 'cta-1' } });
  });

  it('sin suscripción vigente devuelve null (las altas responden 402)', async () => {
    const { prisma } = prismaFalsoTopes({ suscripcion: null });
    expect(await topesDeLaCuenta(prisma, 'c-1')).toBeNull();
  });

  it('⭐ la cortesía de la SUSCRIPCIÓN gana sobre el tope del plan', async () => {
    // El cliente que no encaja en ningún plan (Odesa: 5 usuarios contra un tope de 2)
    // se resuelve con un cupo a medida, sin inventar un plan nuevo.
    const { prisma } = prismaFalsoTopes({
      suscripcion: { id: 's1', cuentaId: 'cta-1', maxEmpresas: 3, maxUsuariosPorEmpresa: 10, plan: { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 } },
      empresas: 2,
      usuarios: 5,
    });

    const topes = await topesDeLaCuenta(prisma, 'c-1');
    expect(topes!.empresas).toEqual({ usados: 2, max: 3 });
    expect(topes!.usuarios).toEqual({ usados: 5, max: 10 });
  });

  it('sin cortesía (null) manda el plan, y `0` es sin tope', async () => {
    const plan = { name: 'Demo', maxEmpresas: 1, maxUsuariosPorEmpresa: 2 };
    const sinCortesia = await topesDeLaCuenta(prismaFalsoTopes({ suscripcion: { cuentaId: 'cta-1', maxEmpresas: null, maxUsuariosPorEmpresa: null, plan } }).prisma, 'c-1');
    expect(sinCortesia!.usuarios.max).toBe(2);

    const sinTope = await topesDeLaCuenta(prismaFalsoTopes({ suscripcion: { cuentaId: 'cta-1', maxEmpresas: 0, maxUsuariosPorEmpresa: 0, plan } }).prisma, 'c-1');
    expect(sinTope!.empresas.max).toBe(0); // las rutas lo leen como «sin tope»
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

describe('usoDiarioPorDia', () => {
  it('⭐ junta en UN punto los movimientos del mismo día a distintas horas', () => {
    // El `groupBy` de Prisma agrupa por timestamp: el 17-09 llegaba en cuatro filas y
    // el gráfico dibujaba el mismo día cuatro veces.
    const filas = [
      { date: new Date(2026, 8, 17, 9, 15), count: 3 },
      { date: new Date(2026, 8, 17, 12, 0), count: 1 },
      { date: new Date(2026, 8, 17, 18, 40), count: 2 },
    ];

    expect(usoDiarioPorDia(filas)).toEqual([{ date: '2026-09-17', count: 6 }]);
  });

  it('⭐ un movimiento de la noche queda en SU día, no en el siguiente por UTC', () => {
    // 21:00 en Panamá es 01:00 UTC del día siguiente: con `toISOString()` el punto
    // caía en el día equivocado.
    const filas = [{ date: new Date(2026, 8, 17, 21, 0), count: 1 }];

    expect(usoDiarioPorDia(filas)).toEqual([{ date: '2026-09-17', count: 1 }]);
  });

  it('mantiene los días en orden ascendente (el gráfico los dibuja así)', () => {
    const filas = [
      { date: new Date(2026, 8, 16, 12, 0), count: 4 },
      { date: new Date(2026, 8, 17, 9, 0), count: 1 },
      { date: new Date(2026, 8, 17, 15, 0), count: 1 },
      { date: new Date(2026, 9, 2, 12, 0), count: 7 },
    ];

    expect(usoDiarioPorDia(filas).map(d => d.date)).toEqual(['2026-09-16', '2026-09-17', '2026-10-02']);
    expect(usoDiarioPorDia(filas)[1].count).toBe(2);
  });

  it('sin movimientos devuelve una lista vacía (no un punto en cero)', () => {
    expect(usoDiarioPorDia([])).toEqual([]);
  });
});
