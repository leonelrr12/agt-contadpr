import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { empresasDeLaCuenta, suscripcionDeEmpresa } from '../services/suscripcion';

export const billingRouter = Router();

/**
 * GET /api/plans — Público, lista los planes disponibles
 */
billingRouter.get('/plans', async (req, res) => {
  const plans = await req.prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true,
      name: true,
      description: true,
      monthlyLimit: true,
      price: true,
      features: true,
    },
  });
  res.json(plans);
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
  const dailyUsage = await req.prisma.transaction.groupBy({
    by: ['date'],
    where: {
      companyId: { in: await empresasDeLaCuenta(req.prisma, companyId) },
      date: { gte: subscription.periodStart, lte: new Date() },
    },
    _count: { id: true },
    orderBy: { date: 'asc' },
  });

  const info = {
    status: subscription.status,
    plan: subscription.plan.name,
    addons: subscription.addons || [],
    movementsUsed: subscription.movementsUsed,
    movementsLimit: subscription.movementsLimit,
    usagePercent: Math.round((subscription.movementsUsed / subscription.movementsLimit) * 100),
    periodStart: subscription.periodStart,
    periodEnd: subscription.periodEnd,
    daysLeft: Math.max(0, Math.ceil((new Date(subscription.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
    daysTotal: Math.ceil((new Date(subscription.periodEnd).getTime() - new Date(subscription.periodStart).getTime()) / (1000 * 60 * 60 * 24)),
    dailyUsage: dailyUsage.map(d => ({ date: d.date.toISOString().split('T')[0], count: d._count.id })),
    rateLimit: subscription.plan.reqPorSegundo || 5,
  };

  res.json({ subscription: info });
});
