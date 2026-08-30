import type { Request, Response, NextFunction } from 'express';

/** Catálogo de add-ons contratables (v1: hardcodeado — migrar a tabla si crece). */
export const KNOWN_ADDONS = ['facturas-pdf'] as const;

/**
 * Middleware que exige un add-on contratado en la suscripción activa.
 * Debe ejecutarse DESPUÉS de requireAuth.
 *
 * Uso:
 *   router.use(requireAddon('facturas-pdf'));
 */
export function requireAddon(addon: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sub = await req.prisma.subscription.findFirst({
        where: { companyId: req.user!.companyId, status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] } },
        select: { status: true, periodEnd: true, addons: true },
      });
      if (!sub) {
        res.status(402).json({ error: 'No tienes una suscripción activa.', code: 'NO_SUBSCRIPTION' });
        return;
      }
      if (new Date() > sub.periodEnd) {
        res.status(402).json({ error: 'Tu suscripción ha expirado.', code: 'SUBSCRIPTION_EXPIRED' });
        return;
      }
      if (!sub.addons.includes(addon)) {
        res.status(402).json({
          error: `El módulo "${addon}" no está contratado. Contáctanos por WhatsApp para activarlo.`,
          code: 'ADDON_REQUIRED',
          addon,
        });
        return;
      }
      next();
    } catch (err: any) {
      console.error('[Addon] Error:', err?.message);
      res.status(500).json({ error: 'Error al verificar el módulo' });
    }
  };
}
