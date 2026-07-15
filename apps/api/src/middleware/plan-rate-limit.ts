import rateLimit from 'express-rate-limit';

/**
 * Rate limiting por plan — SOLO para escrituras (POST/PUT/PATCH/DELETE).
 * Las lecturas (GET) no están limitadas por plan, solo por el rate limiter global.
 *
 * Límites por segundo según el plan contratado:
 * - Demo / sin plan:  5 req/s
 * - Emprendedor:      10 req/s
 * - Pyme:             25 req/s
 * - Despacho:         50 req/s
 */
const PLAN_RATE_LIMITS: Record<string, number> = {
  Demo: 5,
  Emprendedor: 10,
  Pyme: 25,
  Despacho: 50,
};

const DEFAULT_LIMIT = 5;

export const planRateLimiter = rateLimit({
  windowMs: 2000, // Ventana de 2 segundos para suavizar ráfagas
  skip: (req) => {
    // No limitar lecturas — solo escrituras
    return req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  },
  max: async (req) => {
    try {
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
  keyGenerator: (req) => req.user?.companyId || 'unauthenticated',
  message: {
    error: 'Demasiadas solicitudes de escritura. Has excedido el límite de tu plan.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});
