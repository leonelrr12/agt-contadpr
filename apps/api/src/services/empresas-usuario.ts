/**
 * Qué empresas puede usar un usuario y con qué rol en cada una.
 *
 * Es la pieza que hace posible el despacho: una sola cuenta (`User.email` es
 * único global) con acceso a varias empresas, **con un rol distinto en cada una**
 * —el mismo contador es `contador` en los libros del cliente y `admin` en los
 * propios—. El rol que viaja en el token sale de acá, no de `User.role`: si
 * saliera del usuario, un despacho terminaría siendo admin de todo lo que toca.
 *
 * El **superadmin** (dueño de la plataforma) tiene acceso a todas las empresas
 * por definición: ya las ve todas por `/api/admin`, y su rol en cualquiera sigue
 * siendo `superadmin`. No hace falta crearle membresías.
 */

import { generateToken } from '../middleware/auth';

export interface EmpresaAccesible {
  id: string;
  name: string;
  role: string;
}

/** El rol del usuario en esa empresa, o null si no tiene acceso. */
export async function rolEnEmpresa(
  prisma: any,
  userId: string,
  companyId: string,
  esSuperadmin = false,
): Promise<string | null> {
  if (esSuperadmin) return 'superadmin';
  const membresia = await prisma.userCompany.findUnique({
    where: { userId_companyId: { userId, companyId } },
    select: { role: true },
  });
  return membresia?.role ?? null;
}

/** Todas las empresas a las que el usuario puede entrar, con su rol en cada una. */
export async function empresasDeUsuario(
  prisma: any,
  userId: string,
  esSuperadmin = false,
): Promise<EmpresaAccesible[]> {
  if (esSuperadmin) {
    const empresas = await prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return empresas.map((c: any) => ({ id: c.id, name: c.name, role: 'superadmin' }));
  }

  const membresias = await prisma.userCompany.findMany({
    where: { userId },
    select: { role: true, company: { select: { id: true, name: true } } },
    orderBy: { company: { name: 'asc' } },
  });
  return membresias
    .filter((m: any) => m.company)
    .map((m: any) => ({ id: m.company.id, name: m.company.name, role: m.role }));
}

/** ¿Este usuario es el dueño de la plataforma? (el rol vive en `User.role`) */
export async function esSuperadmin(prisma: any, userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  return u?.role === 'superadmin';
}

/**
 * La sesión de un usuario EN UNA EMPRESA: token + lo que el frontend guarda.
 *
 * La empresa y el rol salen de la membresía, no de `User`: es lo que permite que
 * la misma cuenta tenga un rol distinto en cada empresa, y que el superadmin
 * entre a cualquiera con su propio rol. Devuelve null si no tiene acceso.
 *
 * Vive acá y no en las rutas porque la usan tres: el login, el cambio de empresa
 * y el alta de una empresa nueva (que entra directo a la recién creada).
 */
export async function sesionEnEmpresa(prisma: any, userId: string, companyId: string): Promise<any | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { company: true } });
  if (!user || !user.isActive) return null;

  const rol = await rolEnEmpresa(prisma, userId, companyId, user.role === 'superadmin');
  if (!rol) return null;

  const company =
    companyId === user.companyId || !rol
      ? user.company
      : await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return null;

  return {
    token: generateToken({ userId: user.id, companyId, role: rol, name: user.name, email: user.email }),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: rol,
      company: { id: company.id, name: company.name, taxId: company.taxId },
    },
  };
}
