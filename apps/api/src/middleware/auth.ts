import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'agt-contador-dev-secret-change-in-production';

export interface AuthUser {
  userId: string;
  companyId: string;
  role: string;
  name: string;
  email: string;
}

/**
 * Genera un token JWT para un usuario autenticado.
 */
export function generateToken(user: AuthUser): string {
  return jwt.sign(
    {
      userId: user.userId,
      companyId: user.companyId,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
}

/**
 * Middleware que verifica el token JWT y adjunta el usuario a req.user.
 * Si no hay token, devuelve 401.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token de acceso requerido. Usa Authorization: Bearer <token>' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
  }
}

type Role = 'admin' | 'contador' | 'asistente';

/**
 * Middleware que restringe acceso según roles permitidos.
 * Debe ejecutarse DESPUÉS de requireAuth.
 *
 * Uso:
 *   router.post('/ruta', requireRole('admin'), handler);        // solo admin
 *   router.get('/ruta', requireRole('admin', 'contador'), ...);  // admin o contador
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Autenticación requerida' });
      return;
    }

    if (!roles.includes(req.user.role as Role)) {
      res.status(403).json({
        error: `Acceso denegado. Se requiere rol: ${roles.join(' o ')}. Tu rol: ${req.user.role}`,
      });
      return;
    }

    next();
  };
}
