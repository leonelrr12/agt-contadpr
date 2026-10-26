import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { findSupplier } from '../services/counterparty';

export const suppliersRouter = Router();

// GET /api/suppliers — Listar proveedores
suppliersRouter.get('/', async (req, res) => {
  const { search } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (search) where.name = { contains: search as string, mode: 'insensitive' };

  const suppliers = await req.prisma.supplier.findMany({
    where,
    include: { bills: { orderBy: { date: 'desc' } } }, // todas — el total y el conteo deben considerar facturas viejas
    orderBy: { name: 'asc' },
  });

  const enriched = suppliers.map(s => {
    // Solo facturas activas: ni pagadas ni rechazadas cuentan en CxP
    const activas = s.bills.filter(b => b.status !== 'PAGADA' && b.status !== 'RECHAZADA');
    const totalOwed = activas.reduce((sum, b) => sum + b.total, 0);
    return { ...s, totalOwed, billCount: activas.length };
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

// POST /api/suppliers — Crear proveedor (dedupe por RUC/nombre: higiene de duplicidad)
// Crear un proveedor es parte de cargar una compra: lo hace quien la carga.
// Registrar la factura del proveedor (`POST /:id/bills`) NO: esa vía no genera asiento.
suppliersRouter.post('/', requireRole('admin', 'contador', 'superadmin', 'inventario'), async (req, res) => {
  const { name, taxId, phone, email, paymentTerms, notes, dv, address, location, tradeName, contactName, taxIdType } = req.body;
  if (!name) { res.status(400).json({ error: 'El nombre es requerido' }); return; }

  const dvLimpio = dv === undefined ? undefined : (String(dv).trim() || null);
  if (dvLimpio && !/^\d{1,2}$/.test(dvLimpio)) {
    res.status(400).json({ error: 'El DV debe ser de 1 o 2 dígitos.' });
    return;
  }
  const locationLimpia = location === undefined ? undefined : (String(location).trim() || null);
  if (locationLimpia && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(locationLimpia)) {
    res.status(400).json({ error: 'La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).' });
    return;
  }

  const existing = await findSupplier(req.prisma, req.user!.companyId, { name, taxId });
  if (existing) {
    res.status(409).json({ error: `El proveedor ya existe como "${existing.name}". ¿Quieres editarlo en vez de crearlo?` });
    return;
  }

  try {
    const supplier = await req.prisma.supplier.create({
      // `as any`: ver la nota de clients.ts (migración 0049 pendiente de aplicar).
      data: {
        name, taxId, phone, email, paymentTerms: paymentTerms || '30', notes,
        dv: dvLimpio, address, location: locationLimpia,
        tradeName, contactName, taxIdType,
        fiscalSource: 'MANUAL', fiscalUpdatedAt: new Date(),
        companyId: req.user!.companyId,
      } as any,
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
suppliersRouter.put('/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const { name, taxId, phone, email, paymentTerms, notes, dv, address, location, tradeName, contactName, taxIdType } = req.body;
  const existing = await req.prisma.supplier.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Proveedor no encontrado' }); return; }

  const dvLimpio = dv === undefined ? undefined : (String(dv).trim() || null);
  if (dvLimpio && !/^\d{1,2}$/.test(dvLimpio)) {
    res.status(400).json({ error: 'El DV debe ser de 1 o 2 dígitos.' });
    return;
  }
  const locationLimpia = location === undefined ? undefined : (String(location).trim() || null);
  if (locationLimpia && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(locationLimpia)) {
    res.status(400).json({ error: 'La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).' });
    return;
  }

  const data: any = { name, taxId, phone, email, paymentTerms, notes, address };
  if (dv !== undefined) data.dv = dvLimpio;
  if (location !== undefined) data.location = locationLimpia;
  if (tradeName !== undefined) data.tradeName = String(tradeName ?? '').trim() || null;
  if (contactName !== undefined) data.contactName = String(contactName ?? '').trim() || null;
  if (taxIdType !== undefined) data.taxIdType = String(taxIdType ?? '').trim() || null;
  data.fiscalSource = 'MANUAL';
  data.fiscalUpdatedAt = new Date();

  const updated = await req.prisma.supplier.update({
    where: { id: req.params.id },
    data,
  });
  res.json(updated);
});

// DELETE /api/suppliers/:id — borrar solo si no tiene historia.
suppliersRouter.delete('/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const companyId = req.user!.companyId;
  const supplier = await req.prisma.supplier.findFirst({
    where: { id: req.params.id, companyId },
  });
  if (!supplier) { res.status(404).json({ error: 'Proveedor no encontrado' }); return; }

  const [bills, workerAccounts] = await Promise.all([
    req.prisma.bill.count({ where: { supplierId: supplier.id, companyId } }),
    req.prisma.workerAccount.count({ where: { supplierId: supplier.id, companyId } }),
  ]);
  if (bills || workerAccounts) {
    res.status(409).json({
      error: `No se puede eliminar a "${supplier.name}": tiene ${bills} factura(s) y ${workerAccounts} cuenta(s) de trabajador asociadas.`,
    });
    return;
  }

  try {
    await req.prisma.supplier.delete({ where: { id: supplier.id } });
    res.json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'P2003') {
      res.status(409).json({ error: 'No se puede eliminar: tiene movimientos asociados.' });
      return;
    }
    throw error;
  }
});

// GET /api/suppliers/:id/bills — Facturas de un proveedor (con saldo real)
suppliersRouter.get('/:id/bills', async (req, res) => {
  const bills = await req.prisma.bill.findMany({
    where: { supplierId: req.params.id, companyId: req.user!.companyId, status: { notIn: ['RECHAZADA'] } },
    include: { supplier: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  // Bill aún no soporta abonos: saldo = total pendiente o 0 si está pagada
  res.json(bills.map(b => ({ ...b, saldo: b.status === 'PAGADA' ? 0 : b.total })));
});

// POST /api/suppliers/:id/bills — Registrar factura de proveedor
suppliersRouter.post('/:id/bills', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
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
suppliersRouter.patch('/:id/bills/:billId/pay', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
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
    let current = 0, d30 = 0, d60 = 0, d90 = 0, d120 = 0, over120 = 0;
    for (const b of s.bills) {
      const daysOverdue = Math.floor((now.getTime() - new Date(b.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue <= 0) current += b.total;
      else if (daysOverdue <= 30) d30 += b.total;
      else if (daysOverdue <= 60) d60 += b.total;
      else if (daysOverdue <= 90) d90 += b.total;
      else if (daysOverdue <= 120) d120 += b.total;
      else over120 += b.total;
    }
    return {
      id: s.id, name: s.name, taxId: s.taxId,
      current, d30, d60, d90, d120, over120,
      over90: d120 + over120, // compat: los consumidores viejos ven el tramo >90 completo
      totalOwed: current + d30 + d60 + d90 + d120 + over120,
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
