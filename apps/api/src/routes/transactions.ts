import { Router } from 'express';

export const transactionsRouter = Router();

transactionsRouter.get('/', async (req, res) => {
  const transactions = await req.prisma.transaction.findMany({
    where: { companyId: 'demo-company' },
    include: { journalEntry: true },
    orderBy: { date: 'desc' },
  });
  res.json(transactions);
});

transactionsRouter.post('/', async (req, res) => {
  const { type, amount, description, concept, paymentMethod, date, metadata } = req.body;
  const transaction = await req.prisma.transaction.create({
    data: {
      type,
      amount,
      description,
      concept,
      paymentMethod,
      date: new Date(date),
      metadata: JSON.stringify(metadata || {}),
      companyId: 'demo-company',
      createdById: 'demo-user',
    },
  });
  res.status(201).json(transaction);
});
