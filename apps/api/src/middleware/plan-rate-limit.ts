import rateLimit from 'express-rate-limit';
import { suscripcionDeEmpresa } from '../services/suscripcion';

/**
 * Rate limiting por plan — SOLO para escrituras (POST/PUT/PATCH/DELETE).
 * Las lecturas (GET) no están limitadas por plan, solo por el rate limiter global.
 *
 * El límite sale de **`Plan.reqPorSegundo`**, un campo del plan. Antes era una tabla
 * por NOMBRE de plan en este archivo, y eso era una trampa: renombrar un plan o
 * crear uno nuevo lo dejaba en el piso de 5 req/s sin que nadie se enterara.
 */
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

      const subscription = await suscripcionDeEmpresa(req.prisma, companyId);
      if (!subscription) return DEFAULT_LIMIT;

      return subscription.plan.reqPorSegundo || DEFAULT_LIMIT;
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
