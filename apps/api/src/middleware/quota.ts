import type { Request, Response, NextFunction } from 'express';
import { incrementarUsoDeEmpresa, suscripcionDeEmpresa } from '../services/suscripcion';

/**
 * Middleware que verifica que la empresa tenga una suscripción activa
 * y que no haya excedido su límite de movimientos.
 *
 * Estados permitidos: DEMO, ACTIVE, GRANTED, GRACE
 * Estados bloqueados: EXPIRED
 *
 * La suscripción es de la **cuenta** que paga, no de la empresa: acá se sube de una
 * a la otra (`services/suscripcion.ts`). La cuota es una sola para toda la cuenta,
 * así que lo que consume una empresa del despacho descuenta el cupo de todas.
 */
export async function requireQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
  const companyId = req.user!.companyId;

  // Obtener la suscripción vigente de la cuenta dueña de esta empresa
  const subscription = await suscripcionDeEmpresa(req.prisma, companyId);

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
 * Incrementa el contador de movimientos usados para la suscripción de la cuenta.
 * Se llama DESPUÉS de crear un movimiento contable exitosamente.
 *
 * `cantidad` es fraccionaria para la planilla semanal, que consume media cuota: 52
 * corridas al año contra 24 de la quincenal. El contador es un Float justamente por
 * eso — con un entero, media cuota no existe y la única salida sería cobrar una cada
 * dos corridas, que es más difícil de explicar en la factura.
 */
export async function incrementUsage(req: Request, cantidad = 1): Promise<void> {
  await incrementUsageForCompany(req.prisma, req.user!.companyId, cantidad);
}

/**
 * Igual que `incrementUsage`, pero sin request: lo usan los procesos que no
 * nacen de una petición HTTP (el barrido del correo, el cron de recurrentes).
 */
export async function incrementUsageForCompany(prisma: any, companyId: string, cantidad = 1): Promise<void> {
  await incrementarUsoDeEmpresa(prisma, companyId, cantidad);
}
