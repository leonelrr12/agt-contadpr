import { Router } from 'express';

export const journalRouter = Router();

journalRouter.get('/', async (req, res) => {
  const { startDate, endDate, status } = req.query;
  const where: Record<string, unknown> = { companyId: 'demo-company' };
  if (status) where.status = status;
  if (startDate || endDate) {
    where.date = {};
    if (startDate) (where.date as Record<string, unknown>).gte = new Date(startDate as string);
    if (endDate) (where.date as Record<string, unknown>).lte = new Date(endDate as string);
  }

  const entries = await req.prisma.journalEntry.findMany({
    where,
    include: { lines: { include: { account: true } }, createdBy: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(entries);
});

journalRouter.get('/:id', async (req, res) => {
  const entry = await req.prisma.journalEntry.findFirst({
    where: { id: req.params.id, companyId: 'demo-company' },
    include: { lines: { include: { account: true } }, createdBy: { select: { name: true } } },
  });
  if (!entry) { res.status(404).json({ error: 'Journal entry not found' }); return; }
  res.json(entry);
});

journalRouter.post('/', async (req, res) => {
  const { date, description, lines } = req.body;
  const totalDebit = lines.reduce((s: number, l: { debit: number }) => s + (l.debit || 0), 0);
  const totalCredit = lines.reduce((s: number, l: { credit: number }) => s + (l.credit || 0), 0);

  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    res.status(400).json({ error: `Debit (${totalDebit}) != Credit (${totalCredit})` });
    return;
  }

  const entry = await req.prisma.journalEntry.create({
    data: {
      date: new Date(date),
      description,
      companyId: 'demo-company',
      createdById: 'demo-user',
      lines: {
        create: lines.map((l: { accountId: string; debit?: number; credit?: number }) => ({
          accountId: l.accountId,
          debit: l.debit || 0,
          credit: l.credit || 0,
        })),
      },
    },
    include: { lines: { include: { account: true } } },
  });
  res.status(201).json(entry);
});

journalRouter.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  const entry = await req.prisma.journalEntry.update({
    where: { id: req.params.id },
    data: { status },
  });
  res.json(entry);
});

journalRouter.get('/mayor/:accountId', async (req, res) => {
  const { startDate, endDate } = req.query;
  const where: Record<string, unknown> = {
    accountId: req.params.accountId,
    journalEntry: { companyId: 'demo-company' },
  };
  if (startDate) where.journalEntry = { ...where.journalEntry as Record<string, unknown>, date: { gte: new Date(startDate as string) } };
  if (endDate) where.journalEntry = { ...where.journalEntry as Record<string, unknown>, date: { lte: new Date(endDate as string) } };

  const lines = await req.prisma.journalLine.findMany({
    where,
    include: { journalEntry: { select: { date: true, description: true } } },
    orderBy: { journalEntry: { date: 'asc' } },
  });
  res.json(lines);
});
