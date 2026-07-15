import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';

export const clientsRouter = Router();

// GET /api/clients — Listar clientes
clientsRouter.get('/', async (req, res) => {
  const { search } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (search) where.name = { contains: search as string, mode: 'insensitive' };

  const clients = await req.prisma.client.findMany({
    where,
    include: {
      invoices: { orderBy: { date: 'desc' }, take: 5 },
    },
    orderBy: { name: 'asc' },
  });

  const enriched = clients.map(c => {
    const totalDue = c.invoices
      .filter(i => i.status !== 'PAGADA')
      .reduce((s, i) => s + i.total, 0);
    return { ...c, totalDue, invoiceCount: c.invoices.length };
  });

  res.json(enriched);
});

// GET /api/clients/:id — Detalle de cliente con todas sus facturas
clientsRouter.get('/:id', async (req, res) => {
  const client = await req.prisma.client.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { invoices: { orderBy: { date: 'desc' } } },
  });
  if (!client) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }
  res.json(client);
});

// POST /api/clients — Crear cliente
clientsRouter.post('/', requireRole('admin', 'contador'), async (req, res) => {
  const { name, taxId, phone, email, address, notes } = req.body;
  if (!name) { res.status(400).json({ error: 'El nombre es requerido' }); return; }

  const client = await req.prisma.client.create({
    data: { name, taxId, phone, email, address, notes, companyId: req.user!.companyId },
  });
  res.status(201).json(client);
});

// PUT /api/clients/:id — Actualizar cliente
clientsRouter.put('/:id', requireRole('admin', 'contador'), async (req, res) => {
  const { name, taxId, phone, email, address, notes } = req.body;
  const existing = await req.prisma.client.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  const updated = await req.prisma.client.update({
    where: { id: req.params.id },
    data: { name, taxId, phone, email, address, notes },
  });
  res.json(updated);
});

// GET /api/clients/:id/invoices — Facturas de un cliente
clientsRouter.get('/:id/invoices', async (req, res) => {
  const invoices = await req.prisma.invoice.findMany({
    where: { clientId: req.params.id, companyId: req.user!.companyId },
    include: { client: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(invoices);
});

// POST /api/clients/:id/invoices — Crear factura para un cliente
clientsRouter.post('/:id/invoices', requireRole('admin', 'contador'), async (req, res) => {
  const { number, amount, itbms, dueDate, date, description } = req.body;
  if (!amount) { res.status(400).json({ error: 'El monto es requerido' }); return; }

  const client = await req.prisma.client.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!client) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  const itbmsAmount = itbms || 0;
  const total = amount + itbmsAmount;

  const invoice = await req.prisma.invoice.create({
    data: {
      companyId: req.user!.companyId,
      clientId: req.params.id,
      number: number || null,
      amount,
      itbms: itbmsAmount,
      total,
      dueDate: new Date(dueDate || Date.now() + 30 * 24 * 60 * 60 * 1000),
      date: new Date(date || Date.now()),
      description: description || null,
    },
  });
  res.status(201).json(invoice);
});

// PATCH /api/clients/:id/invoices/:invId/pay — Marcar factura como pagada
clientsRouter.patch('/:id/invoices/:invId/pay', requireRole('admin', 'contador'), async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.invId, clientId: req.params.id, companyId: req.user!.companyId },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

  const updated = await req.prisma.invoice.update({
    where: { id: invoice.id },
    data: { status: 'PAGADA', paidAt: new Date() },
  });
  res.json(updated);
});

// ── Reporte de antigüedad de saldos ──
clientsRouter.get('/report/aging', async (req, res) => {
  const clients = await req.prisma.client.findMany({
    where: { companyId: req.user!.companyId },
    include: { invoices: { where: { status: { not: 'PAGADA' } } } },
  });

  const now = new Date();
  const result = clients.map(c => {
    let current = 0, d30 = 0, d60 = 0, d90 = 0, over90 = 0;
    for (const inv of c.invoices) {
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue <= 0) current += inv.total;
      else if (daysOverdue <= 30) d30 += inv.total;
      else if (daysOverdue <= 60) d60 += inv.total;
      else if (daysOverdue <= 90) d90 += inv.total;
      else over90 += inv.total;
    }
    return {
      id: c.id, name: c.name, taxId: c.taxId,
      current, d30, d60, d90, over90,
      totalDue: current + d30 + d60 + d90 + over90,
    };
  }).filter(r => r.totalDue > 0).sort((a, b) => b.totalDue - a.totalDue);

  res.json(result);
});

// ── Resumen rápido (para el dashboard) ──
clientsRouter.get('/report/summary', async (req, res) => {
  const [totalClients, totalDue, overdueInvoices] = await Promise.all([
    req.prisma.client.count({ where: { companyId: req.user!.companyId } }),
    req.prisma.invoice.aggregate({
      _sum: { total: true },
      where: { companyId: req.user!.companyId, status: { not: 'PAGADA' } },
    }),
    req.prisma.invoice.count({
      where: {
        companyId: req.user!.companyId,
        status: { not: 'PAGADA' },
        dueDate: { lt: new Date() },
      },
    }),
  ]);

  res.json({
    totalClients,
    totalDue: totalDue._sum.total || 0,
    overdueInvoices,
  });
});
