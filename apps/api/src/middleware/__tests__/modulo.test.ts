import { describe, it, expect } from 'vitest';
import { requireModulo } from '../modulo';

/**
 * El guardia de módulos es la mitad de la fase 3 que no se ve (PLANES.md §4): sin
 * él, esconder el menú sería decorativo, porque la pestaña abierta —o la URL a
 * mano— sigue entrando. Se prueba contra el middleware directo, que es donde vive
 * la decisión: plan, add-on contratado, suscripción vencida y sin suscripción.
 */

function respuesta() {
  const r: any = { status: null, body: null };
  r.status = (c: number) => ((r.status = c), r);
  r.json = (b: any) => ((r.body = b), r);
  return r;
}

/** Corre el middleware y devuelve si dejó pasar y qué respondió. */
async function correr(suscripcion: any, modulo = 'inventario') {
  const req: any = { user: { companyId: 'c-1' }, prisma: { subscription: { findFirst: async () => suscripcion } } };
  const res = respuesta();
  let paso = false;
  await requireModulo(modulo)(req, res, () => { paso = true; });
  return { paso, res };
}

const vigente = (extra: any = {}) => ({
  id: 's1',
  status: 'ACTIVE',
  periodEnd: new Date(Date.now() + 30 * 86400000),
  addons: [],
  plan: { name: 'Demo', modulos: [] },
  ...extra,
});

describe('requireModulo', () => {
  it('deja pasar cuando el PLAN incluye el módulo', async () => {
    const { paso } = await correr(vigente({ plan: { name: 'Pyme', modulos: ['inventario', 'planilla'] } }));
    expect(paso).toBe(true);
  });

  it('deja pasar cuando la cuenta lo tiene contratado como add-on', async () => {
    // PLANES.md §4: «el plan los incluye o la cuenta los mantiene contratados».
    const { paso } = await correr(vigente({ addons: ['inventario'] }));
    expect(paso).toBe(true);
  });

  it('⭐ 402 cuando el plan no lo incluye ni está contratado', async () => {
    const { paso, res } = await correr(vigente({ plan: { name: 'Emprendedor', modulos: ['planilla'] } }));

    expect(paso).toBe(false);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('MODULO_NO_INCLUIDO');
    expect(res.body).toMatchObject({ modulo: 'inventario', plan: 'Emprendedor' });
    expect(res.body.error).toContain('El módulo de Inventario no está incluido en tu plan Emprendedor');
  });

  it('el módulo de otro plan no sirve: cada uno se pide por su nombre', async () => {
    const { paso, res } = await correr(vigente({ plan: { name: 'Pyme', modulos: ['inventario'] } }), 'planilla');
    expect(paso).toBe(false);
    expect(res.body.modulo).toBe('planilla');
  });

  it('sin suscripción vigente responde 402 NO_SUBSCRIPTION', async () => {
    const { paso, res } = await correr(null);
    expect(paso).toBe(false);
    expect(res.body.code).toBe('NO_SUBSCRIPTION');
  });

  it('con el período vencido responde 402 SUBSCRIPTION_EXPIRED, aunque el plan lo incluya', async () => {
    const { paso, res } = await correr(
      vigente({ periodEnd: new Date(Date.now() - 86400000), plan: { name: 'Pyme', modulos: ['inventario'] } }),
    );
    expect(paso).toBe(false);
    expect(res.body.code).toBe('SUBSCRIPTION_EXPIRED');
  });
});
