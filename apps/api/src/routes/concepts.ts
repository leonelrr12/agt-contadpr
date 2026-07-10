import { Router } from 'express';

export const conceptsRouter = Router();

conceptsRouter.get('/', async (req, res) => {
  const concepts = await req.prisma.concept.findMany({
    where: { companyId: 'demo-company' },
    include: { account: true },
    orderBy: { name: 'asc' },
  });
  res.json(concepts);
});

conceptsRouter.post('/', async (req, res) => {
  const { name, accountId } = req.body;
  const concept = await req.prisma.concept.create({
    data: { name, accountId, companyId: 'demo-company' },
    include: { account: true },
  });
  res.status(201).json(concept);
});

conceptsRouter.put('/:id', async (req, res) => {
  const { name, accountId, isActive } = req.body;
  const concept = await req.prisma.concept.update({
    where: { id: req.params.id },
    data: { ...(name && { name }), ...(accountId && { accountId }), ...(isActive !== undefined && { isActive }) },
  });
  res.json(concept);
});
