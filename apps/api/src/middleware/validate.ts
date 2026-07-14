import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

/**
 * Middleware factory que valida req.body contra un schema de zod.
 * Si falla, devuelve 400 con los errores formateados en español.
 *
 * Uso:
 *   router.post('/ruta', validate(miSchema), handler);
 */
export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        campo: issue.path.join('.') || '(body)',
        error: issue.message,
      }));

      res.status(400).json({
        error: 'Datos inválidos',
        detalles: errors,
      });
      return;
    }

    // Reemplaza req.body con los datos parseados (aplica defaults, coerce, strip)
    req.body = result.data;
    next();
  };
}
