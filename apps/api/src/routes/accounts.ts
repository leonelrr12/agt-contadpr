import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { createAccountSchema, updateAccountSchema } from '../validation/schemas';

export const accountsRouter = Router();

accountsRouter.get('/', async (req, res) => {
  const accounts = await req.prisma.account.findMany({
    where: { companyId: req.user!.companyId },
    include: { children: true },
    orderBy: { code: 'asc' },
  });
  res.json(accounts);
});

accountsRouter.get('/tree', async (req, res) => {
  const accounts = await req.prisma.account.findMany({
    where: { companyId: 'demo-company', parentId: null },
    include: { children: { include: { children: true } } },
    orderBy: { code: 'asc' },
  });
  res.json(accounts);
});

accountsRouter.get('/:id', async (req, res) => {
  const account = await req.prisma.account.findFirst({
    where: { id: req.params.id, companyId: 'demo-company' },
    include: { children: true },
  });
  if (!account) { res.status(404).json({ error: 'Account not found' }); return; }
  res.json(account);
});

accountsRouter.post('/', requireRole('admin'), validate(createAccountSchema), async (req, res) => {
  const { code, name, type, parentId } = req.body;
  const account = await req.prisma.account.create({
    data: { code, name, type, parentId, companyId: req.user!.companyId },
  });
  res.status(201).json(account);
});

accountsRouter.put('/:id', requireRole('admin'), validate(updateAccountSchema), async (req, res) => {
  const { name, isActive } = req.body;
  const account = await req.prisma.account.update({
    where: { id: req.params.id },
    data: { ...(name && { name }), ...(isActive !== undefined && { isActive }) },
  });
  res.json(account);
});
