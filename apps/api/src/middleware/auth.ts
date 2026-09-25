import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

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
 * Middleware que verifica:
 * - JWT (sesión web): token de 24h
 * - API Key (sk_live_...): acceso programático, SHA-256 hasheado
 *
 * Adjunta el usuario a req.user en ambos casos.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  // Permitir token por query param (para exports que abren nueva pestaña)
  let token: string | undefined;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.query.token) {
    token = req.query.token as string;
  } else {
    res.status(401).json({ error: 'Token de acceso requerido. Usa Authorization: Bearer <token>' });
    return;
  }

  // ── Modo 1: API Key (prefijo "sk_live_") ──
  if (token.startsWith('sk_live_')) {
    try {
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');

      const apiKey = await req.prisma.apiKey.findUnique({
        where: { keyHash },
        include: {
          company: {
            select: {
              id: true,
              name: true,
              users: {
                where: { role: 'admin' },
                select: { id: true, email: true, name: true, role: true },
                take: 1,
              },
            },
          },
        },
      });

      // Key no existe o está revocada
      if (!apiKey || apiKey.isRevoked) {
        res.status(401).json({ error: 'API Key inválida o revocada.' });
        return;
      }

      // Key expirada
      if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
        res.status(401).json({ error: 'API Key expirada.' });
        return;
      }

      // Actualizar lastUsedAt (asíncrono, no bloquea la respuesta)
      req.prisma.apiKey.update({
        where: { id: apiKey.id },
        data: { lastUsedAt: new Date() },
      }).catch(() => {});

      // Construir req.user desde la empresa asociada
      const adminUser = apiKey.company.users[0];
      req.user = {
        userId: adminUser?.id || '',
        companyId: apiKey.companyId,
        role: adminUser?.role || 'admin',
        name: `[API] ${apiKey.company.name}`,
        email: adminUser?.email || '',
      };

      next();
      return;
    } catch (err: any) {
      res.status(500).json({ error: 'Error al validar API Key.' });
      return;
    }
  }

  // ── Modo 2: JWT (sesión web) ──
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado. Vuelve a iniciar sesión.' });
  }
}

// superadmin = dueño de la plataforma (AdminSaaS). Solo esa cuenta puede
// ver/operar el panel SaaS. admin = administrador de UNA empresa (ámbito empresa).
// inventario = usuario de depósito/mostrador: solo inventario, facturas de venta y
// el catálogo de clientes y proveedores (ver `ROLES_EXCLUSIVOS`).
// planilla = usuario de nómina: solo planilla y el registro de empleados.
type Role = 'superadmin' | 'admin' | 'contador' | 'asistente' | 'inventario' | 'planilla';

/**
 * Roles EXCLUSIVOS: ven y operan un solo módulo, y todo lo demás se les niega.
 *
 * El resto de la API es permisivo por defecto (casi ningún router usa `requireRole`),
 * así que un rol restringido necesita una barrera que niegue por defecto. Estas
 * listas son la única puerta: si algo no está acá, ese usuario no lo ve — ni el
 * diario, ni los informes, ni la salud financiera.
 *
 * Están juntas en un mapa y no en una función por rol a propósito: con una barrera
 * por rol, agregar el segundo es copiar el archivo equivocado y dejar el nuevo sin
 * puerta —que es peor que no tenerlo, porque el rol nace con acceso a todo—.
 */
const ROLES_EXCLUSIVOS: Record<string, { modulo: string; rutas: string[] }> = {
  inventario: {
    modulo: 'Inventario',
    rutas: [
      '/api/inventario',
      '/api/facturas',   // emite las ventas que descuentan stock
      '/api/clients',    // los necesita para facturar
      '/api/suppliers',  // los necesita para cargar compras
      '/api/auth',
      '/api/health',
    ],
  },
  planilla: {
    modulo: 'Planilla',
    rutas: [
      '/api/planilla',
      // El catálogo de cuentas: los selectores de banco y de cuentas del módulo lo
      // necesitan para mostrar NOMBRES. Sin esto el desplegable llega vacío y el
      // usuario ve un 403 silencioso, que es lo que hoy le pasa al rol de inventario.
      '/api/accounts',
      '/api/auth',
      '/api/health',
    ],
  },
};

/**
 * Deja pasar a un rol exclusivo solo por SU lista blanca; al resto, sin cambios.
 *
 * Va montado una sola vez después de `requireAuth`, no en cada router: así el rol
 * restringido no depende de que veinte archivos de rutas se acuerden de filtrarlo.
 */
export function limitarRolesExclusivos(req: Request, res: Response, next: NextFunction): void {
  const rol = ROLES_EXCLUSIVOS[req.user?.role ?? ''];
  if (!rol) {
    next();
    return;
  }
  // `originalUrl` y no `path`: montado en /api, `path` viene sin el prefijo y la
  // lista no coincidiría con nada.
  const ruta = (req.originalUrl || '').split('?')[0];
  const permitido = rol.rutas.some((base) => ruta === base || ruta.startsWith(`${base}/`));
  if (!permitido) {
    res.status(403).json({ error: `Tu usuario solo tiene acceso al módulo de ${rol.modulo}.` });
    return;
  }
  next();
}

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
