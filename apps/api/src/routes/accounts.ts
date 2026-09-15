import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { createAccountSchema, updateAccountSchema } from '../validation/schemas';

export const accountsRouter = Router();

// ?anexo=true → solo cuentas que llevan Anexo DGI (selector del informe Anexos-DGI)
// ?excludeBlocked=true → oculta cuentas bloqueadas (selectores de asientos)
accountsRouter.get('/', async (req, res) => {
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
});

accountsRouter.get('/tree', async (req, res) => {
  const accounts = await req.prisma.account.findMany({
    where: { companyId: req.user!.companyId, parentId: null },
    include: { children: { include: { children: true } } },
    orderBy: { code: 'asc' },
  });
  res.json(accounts);
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await req.prisma.account.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { children: true },
  });
  if (!account) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(account);
});

accountsRouter.post('/', requireRole('admin', 'superadmin'), validate(createAccountSchema), async (req, res) => {
  const { code, name, type, parentId, requiresAnexo, isBlocked } = req.body;
  const companyId = req.user!.companyId;
  if (parentId) {
    const parent = await req.prisma.account.findFirst({
      where: { id: parentId, companyId },
      select: { id: true },
    });
    if (!parent) { res.status(400).json({ error: 'Cuenta padre no encontrada' }); return; }
  }
  const account = await req.prisma.account.create({
    data: { code, name, type, parentId, requiresAnexo, isBlocked, companyId },
  });
  res.status(201).json(account);
});

accountsRouter.put('/:id', requireRole('admin', 'superadmin'), validate(updateAccountSchema), async (req, res) => {
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
});
