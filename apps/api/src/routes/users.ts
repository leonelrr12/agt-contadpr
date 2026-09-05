import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/auth';

/**
 * Usuarios de la empresa (dueño admin + contadores/asistentes).
 * Scoped por req.user.companyId; solo admin (o superadmin) gestiona.
 * El rol 'admin' (dueño) no se puede asignar ni autodescender.
 */
export const usersRouter = Router();

const COMPANY_ROLES = ['contador', 'asistente'];

// GET /api/users — listar usuarios de la empresa
usersRouter.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const users = await req.prisma.user.findMany({
    where: { companyId: req.user!.companyId },
    select: {
      id: true, name: true, email: true, role: true, isActive: true,
      emailVerified: true, createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json(users);
});

// POST /api/users — crear contador/asistente de la empresa
usersRouter.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const { name, email, password, role } = req.body || {};
  const nombre = String(name || '').trim();
  const correo = String(email || '').trim().toLowerCase();
  if (!nombre || !correo || !password) {
    res.status(400).json({ error: 'Nombre, email y contraseña son requeridos' });
    return;
  }
  if (String(password).length < 6) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    return;
  }
  if (!COMPANY_ROLES.includes(role)) {
    res.status(400).json({ error: `Rol inválido. Roles disponibles: ${COMPANY_ROLES.join(', ')}` });
    return;
  }
  try {
    const hash = await bcrypt.hash(String(password), 10);
    const user = await req.prisma.user.create({
      data: {
        companyId: req.user!.companyId,
        name: nombre,
        email: correo,
        password: hash,
        role,
        isActive: true,
      },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });
    res.status(201).json(user);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe un usuario con ese email en esta empresa' });
      return;
    }
    throw error;
  }
});

// PATCH /api/users/:id — nombre, rol (contador/asistente) o estado
usersRouter.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const { name, role, isActive } = req.body || {};
  const target = await req.prisma.user.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!target) { res.status(404).json({ error: 'Usuario no encontrado' }); return; }
  if (target.role === 'superadmin' && (role !== undefined || isActive !== undefined)) {
    res.status(400).json({ error: 'No puedes modificar el rol o estado del usuario superadmin' });
    return;
  }

  const data: any = {};
  if (name !== undefined) data.name = String(name).trim() || target.name;
  if (role !== undefined) {
    if (!COMPANY_ROLES.includes(role)) {
      res.status(400).json({ error: `Rol inválido. Roles disponibles: ${COMPANY_ROLES.join(', ')}` });
      return;
    }
    if (target.id === req.user!.userId) {
      res.status(400).json({ error: 'No puedes cambiar tu propio rol' });
      return;
    }
    data.role = role;
  }
  if (isActive !== undefined) {
    if (target.id === req.user!.userId && isActive === false) {
      res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
      return;
    }
    data.isActive = !!isActive;
  }

  const updated = await req.prisma.user.update({
    where: { id: target.id },
    data,
    select: { id: true, name: true, email: true, role: true, isActive: true },
  });
  res.json(updated);
});
