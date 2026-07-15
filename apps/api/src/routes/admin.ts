import { Router } from 'express';
import { requireRole } from '../middleware/auth';

export const adminRouter = Router();

// Todas las rutas requieren rol admin
adminRouter.use(requireRole('admin'));

// ── Dashboard de administración ──

adminRouter.get('/stats', async (req, res) => {
  const [totalCompanies, activeSubs, demosExpiring, totalMovements] = await Promise.all([
    req.prisma.company.count(),
    req.prisma.subscription.count({ where: { status: { in: ['ACTIVE', 'GRANTED'] } } }),
    req.prisma.subscription.count({
      where: {
        status: 'DEMO',
        periodEnd: { lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) }, // expiran en ≤3 días
      },
    }),
    req.prisma.transaction.count(),
  ]);

  const paymentsMonth = await req.prisma.paymentRecord.aggregate({
    _sum: { amount: true },
    where: { paidAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
  });

  res.json({
    totalCompanies,
    activeSubscriptions: activeSubs,
    demosExpiringSoon: demosExpiring,
    totalMovements,
    revenueThisMonth: paymentsMonth._sum.amount || 0,
  });
});

// ── Suscripciones ──

adminRouter.get('/subscriptions', async (req, res) => {
  const { status, search } = req.query;

  const where: any = {};
  if (status) where.status = status;
  if (search) {
    where.company = { name: { contains: search as string, mode: 'insensitive' } };
  }

  const subscriptions = await req.prisma.subscription.findMany({
    where,
    include: {
      company: { select: { id: true, name: true, taxId: true, email: true } },
      plan: { select: { id: true, name: true, monthlyLimit: true, price: true } },
      payments: { orderBy: { paidAt: 'desc' }, take: 5 },
    },
    orderBy: { updatedAt: 'desc' },
  });

  res.json(subscriptions);
});

adminRouter.get('/subscriptions/:id', async (req, res) => {
  const sub = await req.prisma.subscription.findUnique({
    where: { id: req.params.id },
    include: {
      company: true,
      plan: true,
      payments: { orderBy: { paidAt: 'desc' } },
    },
  });
  if (!sub) { res.status(404).json({ error: 'Suscripción no encontrada' }); return; }
  res.json(sub);
});

adminRouter.post('/subscriptions', async (req, res) => {
  const { companyId, planId, status, movementsLimit, periodDays, note } = req.body;

  if (!companyId || !planId) {
    res.status(400).json({ error: 'companyId y planId son requeridos' });
    return;
  }

  const plan = await req.prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) { res.status(404).json({ error: 'Plan no encontrado' }); return; }

  const company = await req.prisma.company.findUnique({ where: { id: companyId } });
  if (!company) { res.status(404).json({ error: 'Empresa no encontrada' }); return; }

  const periodStart = new Date();
  const days = periodDays || 30;
  const periodEnd = new Date(periodStart);
  periodEnd.setDate(periodEnd.getDate() + days);

  // Si la empresa ya tiene una suscripción activa, la expiramos primero
  await req.prisma.subscription.updateMany({
    where: { companyId, status: { in: ['ACTIVE', 'DEMO', 'GRANTED', 'GRACE'] } },
    data: { status: 'EXPIRED' },
  });

  const subscription = await req.prisma.subscription.create({
    data: {
      companyId,
      planId,
      status: status || 'ACTIVE',
      movementsLimit: movementsLimit || plan.monthlyLimit,
      periodStart,
      periodEnd,
      grantedBy: req.user!.userId,
      grantedNote: note || null,
    },
    include: {
      company: { select: { name: true } },
      plan: { select: { name: true } },
    },
  });

  res.status(201).json(subscription);
});

adminRouter.patch('/subscriptions/:id', async (req, res) => {
  const { status, movementsLimit, periodEnd, note } = req.body;

  const existing = await req.prisma.subscription.findUnique({
    where: { id: req.params.id },
  });
  if (!existing) { res.status(404).json({ error: 'Suscripción no encontrada' }); return; }

  const data: any = {};
  if (status) data.status = status;
  if (movementsLimit !== undefined) data.movementsLimit = movementsLimit;
  if (periodEnd) data.periodEnd = new Date(periodEnd);
  if (note) data.grantedNote = note;

  const updated = await req.prisma.subscription.update({
    where: { id: req.params.id },
    data,
    include: {
      company: { select: { name: true } },
      plan: { select: { name: true } },
    },
  });

  res.json(updated);
});

// ── Pagos ──

adminRouter.get('/payments', async (req, res) => {
  const payments = await req.prisma.paymentRecord.findMany({
    include: {
      subscription: {
        select: {
          id: true,
          company: { select: { name: true } },
          plan: { select: { name: true } },
        },
      },
    },
    orderBy: { paidAt: 'desc' },
    take: 100,
  });
  res.json(payments);
});

adminRouter.post('/payments', async (req, res) => {
  const { subscriptionId, amount, method, reference, note } = req.body;

  if (!subscriptionId || !amount) {
    res.status(400).json({ error: 'subscriptionId y amount son requeridos' });
    return;
  }

  const subscription = await req.prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { plan: true },
  });
  if (!subscription) { res.status(404).json({ error: 'Suscripción no encontrada' }); return; }

  // Crear el registro de pago
  const payment = await req.prisma.paymentRecord.create({
    data: {
      subscriptionId,
      amount,
      method: method || 'TRANSFERENCIA',
      reference: reference || null,
      receivedBy: req.user!.userId,
      note: note || null,
    },
  });

  // Renovar la suscripción: extender desde hoy o desde el fin del período actual
  const now = new Date();
  const effectiveStart = subscription.periodEnd > now ? subscription.periodEnd : now;
  const newPeriodEnd = new Date(effectiveStart);
  newPeriodEnd.setDate(newPeriodEnd.getDate() + 30);

  await req.prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'ACTIVE',
      periodStart: effectiveStart,
      periodEnd: newPeriodEnd,
      movementsUsed: 0, // Reiniciar contador
      movementsLimit: subscription.plan.monthlyLimit,
    },
  });

  res.status(201).json({
    payment,
    subscription: {
      id: subscriptionId,
      status: 'ACTIVE',
      periodStart: effectiveStart,
      periodEnd: newPeriodEnd,
    },
  });
});

// ── Planes ──

adminRouter.get('/plans', async (req, res) => {
  const plans = await req.prisma.plan.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: 'asc' },
  });
  res.json(plans);
});
