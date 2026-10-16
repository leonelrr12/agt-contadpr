import type { Request, Response, NextFunction } from 'express';
import { modulosDeLaCuenta } from '../services/suscripcion';

/** Catálogo de add-ons contratables (v1: hardcodeado — migrar a tabla si crece). */
export const KNOWN_ADDONS = ['facturas-pdf'] as const;

/** Los módulos que existen. Es el vocabulario de `Plan.modulos` y de los add-ons. */
export const MODULOS = ['inventario', 'planilla', 'facturas-pdf'] as const;

/** Cómo se llama cada módulo cuando hay que explicárselo a una persona. */
const NOMBRE: Record<string, string> = {
  inventario: 'Inventario',
  planilla: 'Planilla',
  'facturas-pdf': 'Facturas PDF',
};

/**
 * Middleware que exige que la CUENTA tenga el módulo: o el plan lo incluye, o lo
 * tiene contratado como add-on (`Subscription.addons`).
 * Debe ejecutarse DESPUÉS de requireAuth.
 *
 * El módulo es de la cuenta que paga (como el plan y la cuota): incluido o
 * contratado una vez, lo usan todas sus empresas.
 *
 * Esto **no es cosmético**: es la mitad de la fase 3 de PLANES.md §4. Si el menú
 * esconde Inventario pero la API lo sigue sirviendo, el módulo no está realmente
 * fuera del plan — cualquiera con la pestaña abierta (o con la URL a mano) lo usa.
 *
 * Uso:
 *   router.use(requireModulo('inventario'));
 */
export function requireModulo(modulo: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cuenta = await modulosDeLaCuenta(req.prisma, req.user!.companyId);
      if (!cuenta) {
        res.status(402).json({ error: 'No tienes una suscripción activa.', code: 'NO_SUBSCRIPTION' });
        return;
      }
      if (cuenta.vencida) {
        res.status(402).json({ error: 'Tu suscripción ha expirado.', code: 'SUBSCRIPTION_EXPIRED' });
        return;
      }
      if (!cuenta.modulos.includes(modulo)) {
        const nombre = NOMBRE[modulo] || modulo;
        res.status(402).json({
          error:
            `El módulo de ${nombre} no está incluido en tu plan ${cuenta.plan}. ` +
            `Pasá a un plan que lo incluya, o contratálo por separado y lo activamos.`,
          code: 'MODULO_NO_INCLUIDO',
          modulo,
          plan: cuenta.plan,
        });
        return;
      }
      next();
    } catch (err: any) {
      console.error('[Modulo] Error:', err?.message);
      res.status(500).json({ error: 'Error al verificar el módulo' });
    }
  };
}
