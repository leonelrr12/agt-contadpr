import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { getSubscriptionInfo } from '../middleware/quota';

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
 * GET /api/subscription — Info de la suscripción del usuario autenticado
 */
billingRouter.get('/subscription', requireAuth, async (req, res) => {
  const info = await getSubscriptionInfo(req);
  if (!info) {
    // Si no tiene suscripción, devolvemos null (el frontend muestra mensaje adecuado)
    res.json({ subscription: null, plansUrl: '/planes.html' });
    return;
  }
  res.json({ subscription: info });
});
