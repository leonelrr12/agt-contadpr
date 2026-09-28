import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { createAccountSchema, updateAccountSchema } from '../validation/schemas';

export const accountsRouter = Router();

/**
 * Express 4 NO enruta los rechazos de un handler `async` al middleware de errores:
 * un throw acá adentro no llega a nadie —el log queda con un `unhandledRejection` y
 * la petición se queda **sin respuesta, colgada para siempre**—. Todo handler de este
 * router va envuelto; es el mismo ayudante que usa el módulo de Planilla.
 */
const wrap =
  (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error('[Cuentas]', e?.message);
      res.status(e?.status || 500).json({ error: e?.message || 'Error al procesar la operación de cuentas' });
    }
  };

// ?anexo=true → solo cuentas que llevan Anexo DGI (selector del informe Anexos-DGI)
// ?excludeBlocked=true → oculta cuentas bloqueadas (selectores de asientos)
accountsRouter.get('/', wrap(async (req, res) => {
  const accounts = await req.prisma.account.findMany({
    where: {
      companyId: req.user!.companyId,
      ...(req.query.anexo === 'true' && { requiresAnexo: true }),
      ...(req.query.excludeBlocked === 'true' && { isBlocked: false }),
    },
    include: { children: true },
    orderBy: { code: 'asc' },
  });
  res.json(accounts);
}));

accountsRouter.get('/tree', wrap(async (req, res) => {
  const accounts = await req.prisma.account.findMany({
    where: { companyId: req.user!.companyId, parentId: null },
    include: { children: { include: { children: true } } },
    orderBy: { code: 'asc' },
  });
  res.json(accounts);
}));

accountsRouter.get('/:id', wrap(async (req, res) => {
  const account = await req.prisma.account.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { children: true },
  });
  if (!account) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(account);
}));

accountsRouter.post('/', requireRole('admin', 'superadmin'), validate(createAccountSchema), wrap(async (req, res) => {
  const { code, name, type, parentId, requiresAnexo, isBlocked } = req.body;
  const companyId = req.user!.companyId;
  if (parentId) {
    const parent = await req.prisma.account.findFirst({
      where: { id: parentId, companyId },
      select: { id: true },
    });
    if (!parent) { res.status(400).json({ error: 'Cuenta padre no encontrada' }); return; }
  }
  try {
    const account = await req.prisma.account.create({
      data: { code, name, type, parentId, requiresAnexo, isBlocked, companyId },
    });
    res.status(201).json(account);
  } catch (e: any) {
    // El índice único es (code, companyId): repetir un código no es un error del
    // servidor, es un dato que el usuario tiene que corregir — y decirlo es la
    // diferencia entre eso y una pantalla que gira para siempre.
    if (e?.code === 'P2002') {
      res.status(400).json({ error: `Ya existe una cuenta con el código ${code} en esta empresa.` });
      return;
    }
    throw e;
  }
}));

accountsRouter.put('/:id', requireRole('admin', 'superadmin'), validate(updateAccountSchema), wrap(async (req, res) => {
  const { name, isActive, requiresAnexo, isBlocked } = req.body;
  // updateMany (no update) para incluir companyId: evita editar cuentas de otra empresa
  const { count } = await req.prisma.account.updateMany({
    where: { id: req.params.id, companyId: req.user!.companyId },
    data: {
      ...(name && { name }),
      ...(isActive !== undefined && { isActive }),
      ...(requiresAnexo !== undefined && { requiresAnexo }),
      ...(isBlocked !== undefined && { isBlocked }),
    },
  });
  if (!count) { res.status(404).json({ error: 'Account not found' }); return; }
  const account = await req.prisma.account.findUnique({ where: { id: req.params.id } });
  res.json(account);
}));
