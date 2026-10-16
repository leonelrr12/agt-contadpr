import { describe, it, expect } from 'vitest';
import { rolEnEmpresa, empresasDeUsuario, esSuperadmin } from '../empresas-usuario';

/**
 * Las membresías son lo que hace posible el despacho: una cuenta, varias
 * empresas, **un rol distinto en cada una**. Si el rol saliera de `User.role` en
 * vez de la membresía, el contador que lleva los libros de un cliente entraría
 * como admin de esos libros — que es justo lo que no puede pasar.
 */

const prismaFalso = (opts: { membresias?: any[]; empresas?: any[]; userRole?: string } = {}) => ({
  userCompany: {
    findUnique: async ({ where }: any) =>
      (opts.membresias || []).find(
        (m) => m.userId === where.userId_companyId.userId && m.companyId === where.userId_companyId.companyId,
      ) || null,
    findMany: async ({ where }: any) => (opts.membresias || []).filter((m) => !where?.userId || m.userId === where.userId),
  },
  company: { findMany: async () => opts.empresas || [] },
  user: { findUnique: async () => ({ role: opts.userRole || 'contador' }) },
});

describe('rolEnEmpresa', () => {
  it('devuelve el rol de la MEMBRESÍA, no el de la cuenta', async () => {
    const prisma = prismaFalso({ membresias: [{ userId: 'u1', companyId: 'c2', role: 'contador' }] });
    expect(await rolEnEmpresa(prisma, 'u1', 'c2')).toBe('contador');
  });

  it('sin membresía no hay acceso', async () => {
    const prisma = prismaFalso({ membresias: [{ userId: 'u1', companyId: 'c1', role: 'admin' }] });
    expect(await rolEnEmpresa(prisma, 'u1', 'c2')).toBeNull();
  });

  it('el superadmin entra a cualquier empresa, con su propio rol', async () => {
    const prisma = prismaFalso({ membresias: [] });
    expect(await rolEnEmpresa(prisma, 'dueno', 'cualquiera', true)).toBe('superadmin');
  });
});

describe('empresasDeUsuario', () => {
  it('devuelve las empresas con su rol en cada una', async () => {
    const prisma = prismaFalso({
      membresias: [
        { userId: 'u1', companyId: 'c1', role: 'admin', company: { id: 'c1', name: 'Mi Empresa' } },
        { userId: 'u1', companyId: 'c2', role: 'contador', company: { id: 'c2', name: 'Cliente SA' } },
      ],
    });
    expect(await empresasDeUsuario(prisma, 'u1')).toEqual([
      { id: 'c1', name: 'Mi Empresa', role: 'admin' },
      { id: 'c2', name: 'Cliente SA', role: 'contador' },
    ]);
  });

  it('el superadmin ve todas las empresas de la plataforma', async () => {
    const prisma = prismaFalso({ empresas: [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }] });
    expect(await empresasDeUsuario(prisma, 'dueno', true)).toEqual([
      { id: 'c1', name: 'A', role: 'superadmin' },
      { id: 'c2', name: 'B', role: 'superadmin' },
    ]);
  });

  it('una membresía sin empresa (no debería pasar) no rompe la lista', async () => {
    const prisma = prismaFalso({ membresias: [{ userId: 'u1', companyId: 'c1', role: 'admin', company: null }] });
    expect(await empresasDeUsuario(prisma, 'u1')).toEqual([]);
  });
});

describe('esSuperadmin', () => {
  it('sale del rol de la cuenta', async () => {
    expect(await esSuperadmin(prismaFalso({ userRole: 'superadmin' }), 'u1')).toBe(true);
    expect(await esSuperadmin(prismaFalso({ userRole: 'admin' }), 'u1')).toBe(false);
  });
});
