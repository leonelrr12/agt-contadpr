import { Router } from 'express';

export const journalRouter = Router();

journalRouter.get('/', async (req, res) => {
  const { startDate, endDate, status, page: pageStr, pageSize: pageSizeStr } = req.query;
  const where: Record<string, unknown> = { companyId: 'demo-company' };
  if (status) where.status = status;
  if (startDate || endDate) {
    where.date = {};
    if (startDate) (where.date as Record<string, unknown>).gte = new Date(startDate as string + 'T00:00:00.000Z');
    if (endDate) (where.date as Record<string, unknown>).lte = new Date(endDate as string + 'T23:59:59.999Z');
  }

  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr as string) || 50));
  const skip = (page - 1) * pageSize;

  const [entries, total] = await Promise.all([
    req.prisma.journalEntry.findMany({
      where,
      include: { lines: { include: { account: true } }, createdBy: { select: { name: true } } },
      orderBy: { date: 'desc' },
      skip,
      take: pageSize,
    }),
    req.prisma.journalEntry.count({ where }),
  ]);
  res.json({ entries, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
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

journalRouter.post('/:id/anular', async (req, res) => {
  const entryId = req.params.id;

  try {
    const result = await req.prisma.$transaction(async (tx) => {
      const original = await tx.journalEntry.findFirst({
        where: { id: entryId, companyId: 'demo-company' },
        include: { lines: true, transactions: true },
      });
      if (!original) throw Object.assign(new Error('Asiento no encontrado'), { status: 404 });
      if (original.status === 'ANULADO') throw Object.assign(new Error('El asiento ya está anulado'), { status: 400 });
      if (original.description.startsWith('ANULACIÓN:')) throw Object.assign(new Error('No se puede anular un asiento de reversión'), { status: 400 });

      const reversal = await tx.journalEntry.create({
        data: {
          date: new Date(),
          description: `ANULACIÓN: ${original.description}`,
          status: 'CONFIRMADO',
          companyId: 'demo-company',
          createdById: 'demo-user',
          lines: {
            create: original.lines.map(l => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
            })),
          },
        },
        include: { lines: { include: { account: true } } },
      });

      await tx.journalEntry.update({
        where: { id: original.id },
        data: { status: 'ANULADO' },
      });

      if (original.transactions?.length > 0) {
        await tx.transaction.updateMany({
          where: { journalEntryId: original.id },
          data: { journalEntryId: reversal.id },
        });
      }

      return { original: { ...original, status: 'ANULADO' }, reversal };
    });

    res.json(result);
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
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
