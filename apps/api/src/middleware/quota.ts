import type { Request, Response, NextFunction } from 'express';

/**
 * Middleware que verifica que la empresa tenga una suscripción activa
 * y que no haya excedido su límite de movimientos.
 *
 * Estados permitidos: DEMO, ACTIVE, GRANTED, GRACE
 * Estados bloqueados: EXPIRED
 */
export async function requireQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = req.user!.companyId;

  // Obtener la suscripción activa más reciente
  const subscription = await req.prisma.subscription.findFirst({
    where: {
      companyId,
      status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
    },
    include: { plan: true },
  });

  // Sin suscripción activa
  if (!subscription) {
    res.status(402).json({
      error: 'No tienes una suscripción activa.',
      code: 'NO_SUBSCRIPTION',
    });
    return;
  }

  // Verificar si expiró por fecha
  if (new Date() > subscription.periodEnd) {
    // Marcar como expirada
    await req.prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: 'EXPIRED' },
    });

    res.status(402).json({
      error: 'Tu suscripción ha expirado.',
      code: 'SUBSCRIPTION_EXPIRED',
      expiredAt: subscription.periodEnd,
    });
    return;
  }

  // Verificar límite de movimientos
  if (subscription.movementsUsed >= subscription.movementsLimit) {
    res.status(429).json({
      error: 'Has alcanzado el límite de movimientos de tu plan.',
      code: 'QUOTA_EXCEEDED',
      limit: subscription.movementsLimit,
      used: subscription.movementsUsed,
    });
    return;
  }

  // Adjuntar info de suscripción al request
  (req as any).subscription = subscription;

  next();
}

/**
 * Incrementa el contador de movimientos usados para la suscripción activa.
 * Se llama DESPUÉS de crear un movimiento contable exitosamente.
 */
export async function incrementUsage(req: Request): Promise<void> {
  const companyId = req.user!.companyId;

  const subscription = await req.prisma.subscription.findFirst({
    where: {
      companyId,
      status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
    },
  });

  if (subscription) {
    await req.prisma.subscription.update({
      where: { id: subscription.id },
      data: { movementsUsed: { increment: 1 } },
    });
  }
}

/**
 * Obtiene info de la suscripción actual para mostrar en el frontend.
 */
export async function getSubscriptionInfo(req: Request) {
  const companyId = req.user!.companyId;

  const subscription = await req.prisma.subscription.findFirst({
    where: {
      companyId,
      status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] },
    },
    include: { plan: true },
  });

  if (!subscription) return null;

  return {
    status: subscription.status,
    plan: subscription.plan.name,
    movementsUsed: subscription.movementsUsed,
    movementsLimit: subscription.movementsLimit,
    periodEnd: subscription.periodEnd,
    daysLeft: Math.max(0, Math.ceil((new Date(subscription.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24))),
  };
}
