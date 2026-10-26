import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { findClient } from '../services/counterparty';

export const clientsRouter = Router();

/**
 * Saldo real de una factura de cliente: 0 cuando está pagada/rechazada;
 * con abonos parciales (InvoicePayment → paidAmount) queda el restante.
 */
function invoiceSaldo(i: { total: number; paidAmount?: number | null; status: string }): number {
  if (i.status === 'PAGADA' || i.status === 'RECHAZADA') return 0;
  return Math.max(0, Math.round((i.total - (i.paidAmount || 0)) * 100) / 100);
}

// GET /api/clients — Listar clientes
clientsRouter.get('/', async (req, res) => {
  const { search } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (search) where.name = { contains: search as string, mode: 'insensitive' };

  const clients = await req.prisma.client.findMany({
    where,
    include: {
      invoices: { orderBy: { date: 'desc' } }, // todas — el total y el conteo deben considerar facturas viejas
    },
    orderBy: { name: 'asc' },
  });

  const enriched = clients.map(c => {
    // Activas = con saldo real > 0 (un parcial pagado del 100% sin PAGADA ya no cuenta)
    const activas = c.invoices.filter(i => invoiceSaldo(i) > 0.01);
    const totalDue = activas.reduce((s, i) => s + invoiceSaldo(i), 0);
    return { ...c, totalDue, invoiceCount: activas.length };
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

// POST /api/clients — Crear cliente (dedupe por RUC/nombre: higiene de duplicidad)
// Crear un cliente es parte de facturar: lo hace quien emite la venta.
clientsRouter.post('/', requireRole('admin', 'contador', 'superadmin', 'inventario'), async (req, res) => {
  const { name, taxId, phone, email, address, dv, location, notes, tradeName, contactName, taxIdType } = req.body;
  if (!name) { res.status(400).json({ error: 'El nombre es requerido' }); return; }

  const dvLimpio = dv === undefined ? undefined : (dv == null ? null : (String(dv).trim() || null));
  if (dvLimpio && !/^\d{1,2}$/.test(dvLimpio)) {
    res.status(400).json({ error: 'El DV debe ser de 1 o 2 dígitos.' });
    return;
  }
  const locationLimpia = location === undefined ? undefined : (location == null ? null : (String(location).trim() || null));
  if (locationLimpia && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(locationLimpia)) {
    res.status(400).json({ error: 'La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).' });
    return;
  }

  const existing = await findClient(req.prisma, req.user!.companyId, { name, taxId });
  if (existing) {
    res.status(409).json({ error: `El cliente ya existe como "${existing.name}". ¿Quieres editarlo en vez de crearlo?` });
    return;
  }

  try {
    const client = await req.prisma.client.create({
      // `as any`: el cliente Prisma generado se actualiza al aplicar la migración
      // 0049; el código va adelante para no regenerar contra una BD sin columnas.
      data: {
        name, taxId, phone, email, address, dv: dvLimpio, location: locationLimpia, notes,
        tradeName, contactName, taxIdType,
        fiscalSource: 'MANUAL', fiscalUpdatedAt: new Date(),
        companyId: req.user!.companyId,
      } as any,
    });
    res.status(201).json(client);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: `El cliente "${name}" ya existe` });
    } else {
      throw error;
    }
  }
});

// PUT /api/clients/:id — Actualizar cliente (incluye perfil de agente de retención ITBMS)
clientsRouter.put('/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const {
    name, taxId, phone, email, address, notes,
    dv, location,
    tradeName, contactName, taxIdType,
    esAgenteRetenedor, porcentajeRetencionItbms, vigenciaRetencionDesde, vigenciaRetencionHasta,
  } = req.body;
  const existing = await req.prisma.client.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!existing) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  const dvLimpio = dv === undefined ? undefined : (dv == null ? null : (String(dv).trim() || null));
  if (dvLimpio && !/^\d{1,2}$/.test(dvLimpio)) {
    res.status(400).json({ error: 'El DV debe ser de 1 o 2 dígitos.' });
    return;
  }
  const locationLimpia = location === undefined ? undefined : (location == null ? null : (String(location).trim() || null));
  if (locationLimpia && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(locationLimpia)) {
    res.status(400).json({ error: 'La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).' });
    return;
  }

  const data: any = { name, taxId, phone, email, address, notes };
  if (dv !== undefined) data.dv = dvLimpio;
  if (location !== undefined) data.location = locationLimpia;
  if (tradeName !== undefined) data.tradeName = String(tradeName ?? '').trim() || null;
  if (contactName !== undefined) data.contactName = String(contactName ?? '').trim() || null;
  if (taxIdType !== undefined) data.taxIdType = String(taxIdType ?? '').trim() || null;
  // La edición desde la ficha es manual: deja la trazabilidad del perfil.
  data.fiscalSource = 'MANUAL';
  data.fiscalUpdatedAt = new Date();
  if (esAgenteRetenedor !== undefined) data.esAgenteRetenedor = !!esAgenteRetenedor;
  if (porcentajeRetencionItbms !== undefined) {
    const pct = Number(porcentajeRetencionItbms);
    if (!(pct >= 0 && pct <= 1)) { res.status(400).json({ error: 'El porcentaje de retención debe estar entre 0 y 1 (ej. 0.5 = 50%)' }); return; }
    data.porcentajeRetencionItbms = pct;
  }
  if (vigenciaRetencionDesde !== undefined) data.vigenciaRetencionDesde = vigenciaRetencionDesde ? new Date(String(vigenciaRetencionDesde) + 'T12:00:00') : null;
  if (vigenciaRetencionHasta !== undefined) data.vigenciaRetencionHasta = vigenciaRetencionHasta ? new Date(String(vigenciaRetencionHasta) + 'T12:00:00') : null;

  try {
    const updated = await req.prisma.client.update({
      where: { id: req.params.id },
      data,
    });
    res.json(updated);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe otro cliente con ese nombre o RUC.' });
      return;
    }
    throw error;
  }
});

// DELETE /api/clients/:id — borrar solo si no tiene historia contable.
// Un cliente con facturas o retenciones no se borra: se rompería la trazabilidad
// de CxC y del 430. El mensaje dice exactamente qué lo bloquea.
clientsRouter.delete('/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const companyId = req.user!.companyId;
  const client = await req.prisma.client.findFirst({
    where: { id: req.params.id, companyId },
  });
  if (!client) { res.status(404).json({ error: 'Cliente no encontrado' }); return; }

  const [invoices, retenciones] = await Promise.all([
    req.prisma.invoice.count({ where: { clientId: client.id, companyId } }),
    req.prisma.retentionItbms.count({ where: { clientId: client.id, companyId } }),
  ]);
  if (invoices || retenciones) {
    res.status(409).json({
      error: `No se puede eliminar a "${client.name}": tiene ${invoices} factura(s) y ${retenciones} retención(es) asociadas. Anula o reasigna antes de borrarlo.`,
    });
    return;
  }

  try {
    await req.prisma.client.delete({ where: { id: client.id } });
    res.json({ ok: true });
  } catch (error: any) {
    if (error?.code === 'P2003') {
      res.status(409).json({ error: 'No se puede eliminar: tiene movimientos asociados.' });
      return;
    }
    throw error;
  }
});

// GET /api/clients/:id/invoices — Facturas de un cliente (con saldo real)
clientsRouter.get('/:id/invoices', async (req, res) => {
  const invoices = await req.prisma.invoice.findMany({
    where: { clientId: req.params.id, companyId: req.user!.companyId, status: { notIn: ['RECHAZADA'] } },
    omit: { pacXml: true },
    include: { client: { select: { name: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(invoices.map(i => ({ ...i, saldo: invoiceSaldo(i) })));
});

// POST /api/clients/:id/invoices — Crear factura para un cliente
clientsRouter.post('/:id/invoices', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
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
clientsRouter.patch('/:id/invoices/:invId/pay', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.invId, clientId: req.params.id, companyId: req.user!.companyId },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }

  const updated = await req.prisma.invoice.update({
    where: { id: invoice.id },
    // paidAmount = saldo completo: mantiene la invariante saldo = total − paidAmount
    data: {
      status: 'PAGADA',
      paidAt: new Date(),
      paidAmount: Math.max(0, Math.round((invoice.total - (invoice.paidAmount || 0)) * 100) / 100) + (invoice.paidAmount || 0),
    },
  });
  res.json(updated);
});

// ── Reporte de antigüedad de saldos ──
clientsRouter.get('/report/aging', async (req, res) => {
  const clients = await req.prisma.client.findMany({
    where: { companyId: req.user!.companyId },
    include: { invoices: { where: { status: { notIn: ['PAGADA', 'RECHAZADA'] } } } },
  });

  const now = new Date();
  const result = clients.map(c => {
    let current = 0, d30 = 0, d60 = 0, d90 = 0, d120 = 0, over120 = 0;
    for (const inv of c.invoices) {
      const saldo = invoiceSaldo(inv);
      if (saldo <= 0.01) continue; // pagadas (aunque status no lo diga) y parciales al 100%
      const daysOverdue = Math.floor((now.getTime() - new Date(inv.dueDate).getTime()) / (1000 * 60 * 60 * 24));
      if (daysOverdue <= 0) current += saldo;
      else if (daysOverdue <= 30) d30 += saldo;
      else if (daysOverdue <= 60) d60 += saldo;
      else if (daysOverdue <= 90) d90 += saldo;
      else if (daysOverdue <= 120) d120 += saldo;
      else over120 += saldo;
    }
    return {
      id: c.id, name: c.name, taxId: c.taxId,
      current, d30, d60, d90, d120, over120,
      over90: d120 + over120, // compat: los consumidores viejos ven el tramo >90 completo
      totalDue: current + d30 + d60 + d90 + d120 + over120,
    };
  }).filter(r => r.totalDue > 0).sort((a, b) => b.totalDue - a.totalDue);

  res.json(result);
});

// ── Resumen rápido (para el dashboard) ──
clientsRouter.get('/report/summary', async (req, res) => {
  const [totalClients, aggr, overdueInvoices] = await Promise.all([
    req.prisma.client.count({ where: { companyId: req.user!.companyId } }),
    req.prisma.invoice.aggregate({
      _sum: { total: true, paidAmount: true },
      where: { companyId: req.user!.companyId, status: { notIn: ['PAGADA', 'RECHAZADA'] } },
    }),
    req.prisma.invoice.count({
      where: {
        companyId: req.user!.companyId,
        status: { notIn: ['PAGADA', 'RECHAZADA'] },
        dueDate: { lt: new Date() },
      },
    }),
  ]);

  // totalDue = suma de saldos (resta abonos parciales; clamp ≥ 0)
  const totalDue = Math.max(0, Math.round(((aggr._sum.total || 0) - (aggr._sum.paidAmount || 0)) * 100) / 100);

  res.json({
    totalClients,
    totalDue,
    overdueInvoices,
  });
});
