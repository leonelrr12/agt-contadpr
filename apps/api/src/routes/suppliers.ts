import { Router } from 'express';
import { requireRole } from '../middleware/auth';

export const suppliersRouter = Router();

// GET /api/suppliers — Listar proveedores
suppliersRouter.get('/', async (req, res) => {
  const { search } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (search) where.name = { contains: search as string, mode: 'insensitive' };

  const suppliers = await req.prisma.supplier.findMany({
    where,
    include: { bills: { orderBy: { date: 'desc' }, take: 5 } },
    orderBy: { name: 'asc' },
  });

  const enriched = suppliers.map(s => {
    const totalOwed = s.bills
      .filter(b => b.status !== 'PAGADA' && b.status !== 'RECHAZADA')
      .reduce((sum, b) => sum + b.total, 0);
    return { ...s, totalOwed, billCount: s.bills.length };
  });

  res.json(enriched);
});

// GET /api/suppliers/:id — Detalle
suppliersRouter.get('/:id', async (req, res) => {
  const supplier = await req.prisma.supplier.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { bills: { orderBy: { date: 'desc' } } },
  });
  if (!supplier) { res.status(404).json({ error: 'Proveedor no encontrado' }); return; }
  res.json(supplier);
});

// POST /api/suppliers — Crear proveedor
suppliersRouter.post('/', requireRole('admin', 'contador'), async (req, res) => {
  const { name, taxId, phone, email, paymentTerms, notes } = req.body;
  if (!name) { res.status(400).json({ error: 'El nombre es requerido' }); return; }

  try {
    const supplier = await req.prisma.supplier.create({
      data: { name, taxId, phone, email, paymentTerms: paymentTerms || '30', notes, companyId: req.user!.companyId },
    });
    res.status(201).json(supplier);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: `El proveedor "${name}" ya existe` });
    } else {
      throw error;
    }
  }
});

// PUT /api/suppliers/:id — Actualizar
suppliersRouter.put('/:id', requireRole('admin', 'contador'), async (req, res) => {
  const { name, taxId, phone, email, paymentTerms, notes } = req.body;
  const existing = await req.prisma.supplier.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Proveedor no encontrado' }); return; }

  const updated = await req.prisma.supplier.update({
    where: { id: req.params.id },
    data: { name, taxId, phone, email, paymentTerms, notes },
  });
  res.json(updated);
});

// GET /api/suppliers/:id/bills — Facturas de un proveedor
suppliersRouter.get('/:id/bills', async (req, res) => {
  const bills = await req.prisma.bill.findMany({
    where: { supplierId: req.params.id, companyId: req.user!.companyId },
    include: { supplier: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(bills);
});

// POST /api/suppliers/:id/bills — Registrar factura de proveedor
suppliersRouter.post('/:id/bills', requireRole('admin', 'contador'), async (req, res) => {
  const { number, amount, itbms, dueDate, date, description } = req.body;
  if (!amount) { res.status(400).json({ error: 'El monto es requerido' }); return; }

  const supplier = await req.prisma.supplier.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!supplier) { res.status(404).json({ error: 'Proveedor no encontrado' }); return; }

  const itbmsAmount = itbms || 0;
  const total = amount + itbmsAmount;

  const bill = await req.prisma.bill.create({
    data: {
      companyId: req.user!.companyId,
      supplierId: req.params.id,
      number: number || null,
      amount,
      itbms: itbmsAmount,
      total,
      dueDate: new Date(dueDate || Date.now() + 30 * 24 * 60 * 60 * 1000),
      date: new Date(date || Date.now()),
      description: description || null,
    },
  });
  res.status(201).json(bill);
});

// PATCH /api/suppliers/:id/bills/:billId/pay — Marcar como pagada
suppliersRouter.patch('/:id/bills/:billId/pay', requireRole('admin', 'contador'), async (req, res) => {
  const bill = await req.prisma.bill.findFirst({
    where: { id: req.params.billId, supplierId: req.params.id, companyId: req.user!.companyId },
  });
  if (!bill) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

  const updated = await req.prisma.bill.update({
    where: { id: bill.id },
    data: { status: 'PAGADA', paidAt: new Date() },
  });
  res.json(updated);
});

// ── Reportes ──

suppliersRouter.get('/report/aging', async (req, res) => {
  const suppliers = await req.prisma.supplier.findMany({
    where: { companyId: req.user!.companyId },
    include: { bills: { where: { status: { notIn: ['PAGADA', 'RECHAZADA'] } } } },
  });

  const now = new Date();
  const result = suppliers.map(s => {
    let current = 0, d30 = 0, d60 = 0, d90 = 0, over90 = 0;
    for (const b of s.bills) {
      const daysOverdue = Math.floor((now.getTime() - new Date(b.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue <= 0) current += b.total;
      else if (daysOverdue <= 30) d30 += b.total;
      else if (daysOverdue <= 60) d60 += b.total;
      else if (daysOverdue <= 90) d90 += b.total;
      else over90 += b.total;
    }
    return {
      id: s.id, name: s.name, taxId: s.taxId,
      current, d30, d60, d90, over90,
      totalOwed: current + d30 + d60 + d90 + over90,
    };
  }).filter(r => r.totalOwed > 0).sort((a, b) => b.totalOwed - a.totalOwed);

  res.json(result);
});

suppliersRouter.get('/report/summary', async (req, res) => {
  const [totalSuppliers, totalOwed, overdueBills] = await Promise.all([
    req.prisma.supplier.count({ where: { companyId: req.user!.companyId } }),
    req.prisma.bill.aggregate({
      _sum: { total: true },
      where: { companyId: req.user!.companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] } },
    }),
    req.prisma.bill.count({
      where: {
        companyId: req.user!.companyId,
        status: { notIn: ['PAGADA', 'RECHAZADA'] },
        dueDate: { lt: new Date() },
      },
    }),
  ]);

  res.json({
    totalSuppliers,
    totalOwed: totalOwed._sum.total || 0,
    overdueBills,
  });
});
