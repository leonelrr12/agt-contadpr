import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { createConceptSchema, updateConceptSchema } from '../validation/schemas';

export const conceptsRouter = Router();

conceptsRouter.get('/', async (req, res) => {
  const concepts = await req.prisma.concept.findMany({
    where: { companyId: req.user!.companyId },
    include: { account: true },
    orderBy: { name: 'asc' },
  });
  res.json(concepts);
});

conceptsRouter.post('/', requireRole('admin'), validate(createConceptSchema), async (req, res) => {
  const { name, accountId } = req.body;
  const concept = await req.prisma.concept.create({
    data: { name, accountId, companyId: req.user!.companyId },
    include: { account: true },
  });
  res.status(201).json(concept);
});

conceptsRouter.put('/:id', requireRole('admin'), validate(updateConceptSchema), async (req, res) => {
  const { name, accountId, isActive } = req.body;
  const concept = await req.prisma.concept.update({
    where: { id: req.params.id },
    data: { ...(name && { name }), ...(accountId && { accountId }), ...(isActive !== undefined && { isActive }) },
  });
  res.json(concept);
});
