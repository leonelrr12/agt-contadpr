import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { empresasDeLaCuenta, modulosDeLaCuenta, suscripcionDeEmpresa, topesDeLaCuenta, usoDiarioPorDia } from '../services/suscripcion';
import { MODULOS_CONTRATABLES } from '../services/modulos';

export const billingRouter = Router();

/**
 * GET /api/plans — Público, lista los planes disponibles
 */
billingRouter.get('/plans', async (req, res) => {
  const plans = await req.prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    // La pantalla de precios se arma con los CAMPOS del plan (empresas, usuarios,
    // módulos, movimientos), no con el texto de `features`: así lo que se publica es
    // lo que se valida. `features` queda para lo que no es un campo (el soporte, las
    // API Keys).
    select: {
      id: true,
      name: true,
      description: true,
      monthlyLimit: true,
      maxEmpresas: true,
      maxUsuariosPorEmpresa: true,
      modulos: true,
      price: true,
      features: true,
    },
  });
  res.json(plans);
});

/**
 * GET /api/addons — Público: los módulos que se contratan aparte, con su precio.
 * La pantalla de precios los publica tal cual; el catálogo es uno solo
 * (`services/modulos.ts`), el mismo que valida el panel.
 */
billingRouter.get('/addons', async (_req, res) => {
  res.json(MODULOS_CONTRATABLES);
});

/**
 * GET /api/subscription — Info de la suscripción del usuario autenticado.
 *
 * El plan y la cuota son de la CUENTA que paga, así que el uso diario suma el de
 * todas sus empresas: el gráfico es de la cuenta, no de la empresa en la que el
 * usuario está parado.
 */
billingRouter.get('/subscription', requireAuth, async (req, res) => {
  const companyId = req.user!.companyId;

  const subscription = await suscripcionDeEmpresa(req.prisma, companyId);

  if (!subscription) {
    res.json({ subscription: null, plansUrl: '/planes.html' });
    return;
  }

  // Calcular uso diario dentro del período actual
  const [empresasDeLaCuentaIds, topes, cuenta] = await Promise.all([
    empresasDeLaCuenta(req.prisma, companyId),
    topesDeLaCuenta(req.prisma, companyId),
    modulosDeLaCuenta(req.prisma, companyId),
  ]);

  const dailyUsage = await req.prisma.transaction.groupBy({
    by: ['date'],
    where: {
      companyId: { in: empresasDeLaCuentaIds },
      date: { gte: subscription.periodStart, lte: new Date() },
    },
    _count: { id: true },
    orderBy: { date: 'asc' },
  });

  const info = {
    status: subscription.status,
    plan: subscription.plan.name,
    // Los topes con lo usado: los contadores de la UI («3 de 5 usuarios») salen de acá.
    topes,
    // Qué módulos puede usar esta cuenta (plan + add-ons contratados): el menú se
    // arma con esto, y por eso la misma respuesta sirve para esconder lo que la API
    // va a negar.
    modulos: cuenta?.modulos || [],
    addons: subscription.addons || [],
    movementsUsed: subscription.movementsUsed,
    movementsLimit: subscription.movementsLimit,
    usagePercent: Math.round((subscription.movementsUsed / subscription.movementsLimit) * 100),
    periodStart: subscription.periodStart,
    periodEnd: subscription.periodEnd,
    daysLeft: Math.max(0, Math.ceil((new Date(subscription.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
    daysTotal: Math.ceil((new Date(subscription.periodEnd).getTime() - new Date(subscription.periodStart).getTime()) / (1000 * 60 * 60 * 24)),
    // Un punto por DÍA calendario: el `groupBy` de arriba agrupa por timestamp, así que
    // el mismo día puede venir en varias filas (y la fecha se recorta en UTC). Ver
    // `usoDiarioPorDia`.
    dailyUsage: usoDiarioPorDia(dailyUsage.map(d => ({ date: d.date, count: d._count.id }))),
    rateLimit: subscription.plan.reqPorSegundo || 5,
  };

  res.json({ subscription: info });
});
