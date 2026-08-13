import type { Request, Response, NextFunction } from 'express';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Middleware global de errores — último en la pila de Express.
 * Captura errores pasados con next(err) o lanzados de forma síncrona
 * en rutas/middlewares que no tengan try/catch propio, y responde
 * siempre con JSON consistente: { status: 'error', message }.
 *
 * Los res.status(500) inline en rutas siguen intactos: este middleware
 * solo actúa sobre errores que lleguen hasta aquí.
 */
export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  console.error('[ErrorHandler]', err.message || err, err.stack);
  res.status(500).json({
    status: 'error',
    message: isProduction ? 'Error interno del servidor' : err.message || 'Error interno del servidor',
  });
}

/**
 * 404 JSON para rutas desconocidas — se registra después de todas las rutas.
 */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    status: 'error',
    message: `Ruta no encontrada: ${req.method} ${req.path}`,
  });
}
