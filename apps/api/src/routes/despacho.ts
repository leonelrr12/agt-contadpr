import { Router } from 'express';
import { empresasDeUsuario, esSuperadmin } from '../services/empresas-usuario';
import { pendientesPorEmpresa } from '../services/despacho-pendientes';

/**
 * El tablero del despacho: qué está pendiente en cada empresa del usuario.
 *
 * Solo lectura y solo sobre las empresas a las que el usuario tiene acceso (las
 * membresías, o todas si es el dueño de la plataforma): el tablero no inventa
 * permisos, los usa. Los roles exclusivos (`inventario`, `planilla`) no llegan
 * acá: `limitarRolesExclusivos` los deja en su módulo.
 */
export const despachoRouter = Router();

// GET /api/despacho/pendientes — una fila por empresa con lo que pide atención
despachoRouter.get('/pendientes', async (req, res) => {
  const superadmin = await esSuperadmin(req.prisma, req.user!.userId);
  const empresas = await empresasDeUsuario(req.prisma, req.user!.userId, superadmin);
  // El dueño de la plataforma ve todas; un usuario normal, solo las suyas. Sin
  // empresas no hay tablero (y no es un error: es que no tiene acceso a ninguna).
  res.json({ empresas: await pendientesPorEmpresa(req.prisma, empresas), actual: req.user!.companyId });
});
