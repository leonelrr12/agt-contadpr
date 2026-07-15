import rateLimit from 'express-rate-limit';

/**
 * Rate limiting dinámico por plan.
 *
 * Límites por segundo según el plan contratado:
 * - Demo / sin plan: 3 req/s
 * - Emprendedor:      5 req/s
 * - Pyme:            15 req/s
 * - Despacho:        30 req/s
 */
const PLAN_RATE_LIMITS: Record<string, number> = {
  Demo: 3,
  Emprendedor: 5,
  Pyme: 15,
  Despacho: 30,
};

const DEFAULT_LIMIT = 3;

export const planRateLimiter = rateLimit({
  windowMs: 1000, // 1 segundo
  max: async (req) => {
    try {
      // Buscar la suscripción activa del usuario
      const companyId = req.user?.companyId;
      if (!companyId) return DEFAULT_LIMIT;

      const subscription = await req.prisma.subscription.findFirst({
        where: {
          companyId,
          status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
        },
        include: { plan: true },
      });

      if (!subscription) return DEFAULT_LIMIT;

      return PLAN_RATE_LIMITS[subscription.plan.name] || DEFAULT_LIMIT;
    } catch {
      return DEFAULT_LIMIT;
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.companyId || req.ip || 'unknown',
  message: {
    error: 'Demasiadas solicitudes. Has excedido el límite de tu plan.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});
