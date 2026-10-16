import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireRole } from '../middleware/auth';
import { modulosDeLaCuenta, topesDeLaCuenta } from '../services/suscripcion';

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

/**
 * Los roles `inventario` y `planilla` son **exclusivos de un módulo**: ese usuario
 * solo ve y opera ese módulo (`middleware/auth.ts`). Si el plan no lo incluye, el
 * rol no tiene sentido —quedaría un usuario encerrado en una pantalla que responde
 * 402—, así que se rechaza con ese motivo (PLANES.md §8 trampa 5).
 *
 * Devuelve el cuerpo del error, o null si el rol se puede asignar.
 */
async function rolRequiereModuloFaltante(prisma: any, companyId: string, role: string): Promise<any | null> {
  const modulo = { inventario: 'inventario', planilla: 'planilla' }[role as string];
  if (!modulo) return null;

  const cuenta = await modulosDeLaCuenta(prisma, companyId);
  if (!cuenta) return { error: 'No tienes una suscripción activa.', code: 'NO_SUBSCRIPTION' };
  if (cuenta.modulos.includes(modulo)) return null;

  return {
    error:
      `Tu plan ${cuenta.plan} no incluye el módulo de ${modulo === 'planilla' ? 'Planilla' : 'Inventario'}, ` +
      `así que un usuario con ese rol no tendría a qué entrar. Pasá a un plan que lo incluya, o creá el usuario con otro rol.`,
    code: 'ROL_REQUIERE_MODULO',
    modulo,
    plan: cuenta.plan,
  };
}

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
    // El rol exclusivo necesita su módulo en el plan (antes que el cupo: si el rol
    // no tiene sentido, no importa cuánto lugar quede).
    const faltaModulo = await rolRequiereModuloFaltante(req.prisma, req.user!.companyId, role);
    if (faltaModulo) {
      res.status(402).json(faltaModulo);
      return;
    }

    // Cupo de usuarios del plan. Cuenta los PROPIOS (los que tienen acá su empresa
    // casa): el contador del despacho que entra como miembro no gasta cupo ajeno.
    // Va dentro del try: un throw de la consulta tiene que caer en el catch.
    const topes = await topesDeLaCuenta(req.prisma, req.user!.companyId);
    if (!topes) {
      res.status(402).json({ error: 'No tienes una suscripción activa.', code: 'NO_SUBSCRIPTION' });
      return;
    }
    if (topes.usuarios.max > 0 && topes.usuarios.usados >= topes.usuarios.max) {
      const { usados, max } = topes.usuarios;
      res.status(402).json({
        error:
          `Tu plan ${topes.plan} incluye ${max} usuario${max === 1 ? '' : 's'} por empresa y esta ya tiene ${usados}. ` +
          `Para sumar otro, pasá a un plan con más usuarios — el personal de otra empresa que solo tiene acceso acá no ocupa cupo.`,
        code: 'PLAN_LIMIT_USUARIOS',
        plan: topes.plan,
        usados,
        max,
      });
      return;
    }

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

/**
 * POST /api/users/vincular — dar acceso a esta empresa a un usuario que YA existe.
 *
 * **No valida el cupo de usuarios a propósito**: vincular no cambia la empresa casa
 * de nadie, así que no suma cupo. El caso típico es el contador del despacho que
 * entra a los libros de un cliente — justo el que el cupo no tiene que contar, o un
 * despacho con tres contadores dejaría a cada cliente sin poder dar de alta a su
 * propia gente (PLANES.md §3).
 */
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

  // Un rol exclusivo sin su módulo no tiene a qué entrar (PLANES.md §8 trampa 5).
  const faltaModulo = await rolRequiereModuloFaltante(req.prisma, req.user!.companyId, role);
  if (faltaModulo) {
    res.status(402).json(faltaModulo);
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
    // Cambiar el rol a uno exclusivo pasa por el mismo control que crearlo: el
    // módulo tiene que estar en el plan (PLANES.md §8 trampa 5).
    const faltaModulo = await rolRequiereModuloFaltante(req.prisma, req.user!.companyId, role);
    if (faltaModulo) {
      res.status(402).json(faltaModulo);
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
