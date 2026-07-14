import { Router } from 'express';
import { validate } from '../middleware/validate';
import { createTransactionSchema } from '../validation/schemas';

export const transactionsRouter = Router();

transactionsRouter.get('/', async (req, res) => {
  const transactions = await req.prisma.transaction.findMany({
    where: { companyId: req.user!.companyId },
    include: { journalEntry: true },
    orderBy: { date: 'desc' },
  });
  res.json(transactions);
});

transactionsRouter.post('/', validate(createTransactionSchema), async (req, res) => {
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
      companyId: req.user!.companyId,
      createdById: req.user!.userId,
    },
  });
  res.status(201).json(transaction);
});
