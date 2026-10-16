import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/auth';

/**
 * Quiénes tienen acceso a esta empresa.
 *
 * Desde las membresías (`user_company`) el acceso no es lo mismo que la
 * pertenencia: un usuario puede ser de otra empresa y estar acá como contador
 * del despacho. Por eso la lista sale de las membresías y **el rol que se ve y
 * se edita es el de ESTA empresa** — el mismo contador puede ser admin en la
 * suya y contador acá.
 *
 * Scoped por `req.user.companyId`; solo admin (o superadmin) gestiona. El rol
 * 'admin' no se puede asignar ni autodescender (ser admin de una empresa es del
 * dueño; el superadmin lo es por plataforma).
 */
export const usersRouter = Router();

const COMPANY_ROLES = ['contador', 'asistente', 'inventario', 'planilla'];

const CAMPOS_USUARIO = { id: true, name: true, email: true, role: true, isActive: true, emailVerified: true, createdAt: true };

// GET /api/users — quiénes tienen acceso a esta empresa, con su rol acá
usersRouter.get('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const membresias = await req.prisma.userCompany.findMany({
    where: { companyId: req.user!.companyId },
    select: { role: true, createdAt: true, user: { select: CAMPOS_USUARIO } },
    orderBy: { createdAt: 'asc' },
  });
  const miembros = membresias
    .filter((m: any) => m.user)
    .map((m: any) => ({
      ...m.user,
      // El rol que manda acá es el de la membresía, no el de la casa del usuario.
      role: m.role,
      // Se marca quién es de otra empresa: es un contador del despacho, no un
      // usuario propio, y no se lo puede desactivar desde acá sin dejarlo afuera
      // de todas sus empresas.
      deOtraEmpresa: m.user.companyId !== req.user!.companyId,
    }));
  res.json(miembros);
});

// POST /api/users — crear un usuario NUEVO, con acceso a esta empresa
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
    const user = await req.prisma.$transaction(async (tx: any) => {
      const creado = await tx.user.create({
        data: { companyId: req.user!.companyId, name: nombre, email: correo, password: hash, role, isActive: true },
        select: CAMPOS_USUARIO,
      });
      // La membresía es lo que da el acceso: sin ella el usuario existiría y no
      // podría entrar a ninguna empresa.
      await tx.userCompany.create({ data: { userId: creado.id, companyId: req.user!.companyId, role } });
      return creado;
    });
    res.status(201).json(user);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({
        error: 'Ese correo ya tiene cuenta. Si es un contador que lleva otra empresa, usá «Vincular usuario existente».',
      });
      return;
    }
    throw error;
  }
});

// POST /api/users/vincular — dar acceso a esta empresa a un usuario que YA existe
usersRouter.post('/vincular', requireRole('admin', 'superadmin'), async (req, res) => {
  const correo = String(req.body?.email || '').trim().toLowerCase();
  const { role } = req.body || {};
  if (!correo) {
    res.status(400).json({ error: 'Falta el correo del usuario' });
    return;
  }
  if (!COMPANY_ROLES.includes(role)) {
    res.status(400).json({ error: `Rol inválido. Roles disponibles: ${COMPANY_ROLES.join(', ')}` });
    return;
  }

  const user = await req.prisma.user.findUnique({ where: { email: correo }, select: { ...CAMPOS_USUARIO, companyId: true } });
  if (!user) {
    res.status(404).json({ error: 'No existe un usuario con ese correo. Creá la cuenta y después vinculala.' });
    return;
  }

  const yaEs = await req.prisma.userCompany.findUnique({
    where: { userId_companyId: { userId: user.id, companyId: req.user!.companyId } },
  });
  if (yaEs) {
    res.status(409).json({ error: 'Ese usuario ya tiene acceso a esta empresa.' });
    return;
  }

  await req.prisma.userCompany.create({ data: { userId: user.id, companyId: req.user!.companyId, role } });

  // Dar acceso a los libros de una empresa es una decisión que tiene que quedar
  // registrada: quién la tomó, para quién y con qué rol.
  await req.prisma.auditLog
    .create({
      data: {
        userId: req.user!.userId,
        action: 'VINCULAR_USUARIO',
        entity: 'User',
        entityId: user.id,
        // `AuditLog` no tiene companyId: la empresa va en el detalle junto al rol.
        after: JSON.stringify({ empresa: req.user!.companyId, email: user.email, rol: role }),
      },
    })
    .catch(() => {}); // el log no puede tumbar el alta

  res.status(201).json({ ...user, role });
});

// PATCH /api/users/:id — nombre, rol EN ESTA EMPRESA, o estado de la cuenta
usersRouter.patch('/:id', requireRole('admin', 'superadmin'), async (req, res) => {
  const { name, role, isActive } = req.body || {};
  const membresia = await req.prisma.userCompany.findUnique({
    where: { userId_companyId: { userId: String(req.params.id), companyId: req.user!.companyId } },
    include: { user: true },
  });
  if (!membresia?.user) {
    res.status(404).json({ error: 'Usuario no encontrado en esta empresa' });
    return;
  }
  const target = membresia.user;

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
  }

  if (isActive !== undefined) {
    if (target.id === req.user!.userId && isActive === false) {
      res.status(400).json({ error: 'No puedes desactivar tu propio usuario' });
      return;
    }
    // `isActive` es de la CUENTA, no de la membresía: desactivarla la deja sin
    // entrar en ninguna de sus empresas. Si el usuario trabaja en otra, se avisa.
    if (isActive === false) {
      const otras = await req.prisma.userCompany.count({
        where: { userId: target.id, companyId: { not: req.user!.companyId } },
      });
      if (otras > 0) {
        res.status(400).json({
          error: 'Ese usuario también trabaja en otra empresa: desactivarlo lo dejaría sin entrar en todas. Quitá su acceso acá en vez de desactivarlo.',
        });
        return;
      }
    }
    data.isActive = !!isActive;
  }

  const actualizado = await req.prisma.$transaction(async (tx: any) => {
    // El rol se cambia EN ESTA EMPRESA (la membresía), no en la cuenta: el mismo
    // contador puede ser admin donde es dueño y contador donde solo revisa.
    if (role !== undefined) {
      await tx.userCompany.update({
        where: { userId_companyId: { userId: target.id, companyId: req.user!.companyId } },
        data: { role },
      });
    }
    return tx.user.update({
      where: { id: target.id },
      data: Object.keys(data).length ? data : {},
      select: CAMPOS_USUARIO,
    });
  });

  res.json({ ...actualizado, role: role !== undefined ? role : membresia.role });
});
