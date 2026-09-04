import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { requireAddon } from '../middleware/addon';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { logAudit } from '../services/audit-log';
import { buildFacturaPdf } from '../services/factura-pdf';
import { createFacturaSchema } from '../validation/schemas';
import { AccountingAgent } from '@agt-contador/agents';

export const facturasRouter = Router();

// TODO el módulo exige el add-on contratado (backend niega aunque el sidebar esté oculto)
facturasRouter.use(requireAddon('facturas-pdf'));

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Resuelve la cuenta de ventas: alias 'ventas' o primera cuenta 4.x. */
async function resolveSalesAccount(agent: AccountingAgent, prisma: any, companyId: string): Promise<string> {
  try {
    return agent.resolveAlias('ventas');
  } catch {
    const acc = await prisma.account.findFirst({
      where: { companyId, code: { startsWith: '4.' }, isActive: true },
      orderBy: { code: 'asc' },
      select: { id: true },
    });
    if (!acc) {
      throw Object.assign(new Error('Configura una cuenta de ventas (alias "ventas" o código 4.x) antes de emitir facturas.'), { status: 400 });
    }
    return acc.id;
  }
}

// ── Configuración de facturación (serie, resolución DGI, logo) ──

const configUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

facturasRouter.get('/config', async (req, res) => {
  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { facturaSerie: true, facturaResolucion: true, facturaResolucionFecha: true, logo: true },
  });
  res.json({
    facturaSerie: company?.facturaSerie || null,
    facturaResolucion: company?.facturaResolucion || null,
    facturaResolucionFecha: company?.facturaResolucionFecha || null,
    hasLogo: !!company?.logo,
  });
});

facturasRouter.post('/config', requireRole('admin', 'superadmin'), configUpload.fields([{ name: 'logo', maxCount: 1 }]), async (req: any, res) => {
  const { serie, resolucion, resolucionFecha, removeLogo } = req.body || {};
  if (serie !== undefined && !/^[A-Za-z0-9]{1,5}$/.test(String(serie))) {
    res.status(400).json({ error: 'Serie inválida (máx. 5 caracteres alfanuméricos)' });
    return;
  }
  const data: any = {};
  if (serie !== undefined) data.facturaSerie = String(serie).toUpperCase() || null;
  if (resolucion !== undefined) data.facturaResolucion = String(resolucion) || null;
  if (resolucionFecha !== undefined) data.facturaResolucionFecha = resolucionFecha ? new Date(String(resolucionFecha)) : null;

  const file = req.files?.logo?.[0];
  if (file) {
    try {
      // Redimensionar el logo (máx 800px) — el contenedor no persiste archivos, se guarda en BD
      data.logo = await sharp(file.buffer).resize({ width: 800, height: 200, fit: 'inside' }).toBuffer();
    } catch (e: any) {
      res.status(400).json({ error: 'Imagen de logo inválida' });
      return;
    }
  } else if (removeLogo === 'true') {
    data.logo = null;
  }

  if (Object.keys(data).length > 0) {
    await req.prisma.company.update({ where: { id: req.user!.companyId }, data });
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'FACTURAS_CONFIG_UPDATED',
      entity: 'Company',
      entityId: req.user!.companyId,
      after: { serie: data.facturaSerie ?? null, resolucion: data.facturaResolucion ?? null, logo: !!data.logo },
    }).catch(() => {});
  }

  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { facturaSerie: true, facturaResolucion: true, facturaResolucionFecha: true, logo: true },
  });
  res.json({
    facturaSerie: company?.facturaSerie || null,
    facturaResolucion: company?.facturaResolucion || null,
    facturaResolucionFecha: company?.facturaResolucionFecha || null,
    hasLogo: !!company?.logo,
  });
});

// ── Facturas ──

/** POST /api/facturas — emite factura con numeración correlativa y asiento BORRADOR. */
facturasRouter.post('/', requireRole('admin', 'contador', 'superadmin'), requireQuota, validate(createFacturaSchema), async (req, res) => {
  const { clientId, clientName, clientTaxId, items, itbmsRate, date, dueDate, paymentMethod } = req.body;
  const tasa = itbmsRate ?? 0.07;
  const companyId = req.user!.companyId;

  try {
    const result = await req.prisma.$transaction(async (tx: any) => {
      // 1) Cliente (o consumidor final singleton)
      let client: any = null;
      if (clientId) {
        client = await tx.client.findFirst({ where: { id: clientId, companyId } });
        if (!client) throw Object.assign(new Error('Cliente no encontrado'), { status: 404 });
      } else {
        const nombre = (clientName || 'CONSUMIDOR FINAL').trim();
        client = await tx.client.findFirst({ where: { companyId, name: { equals: nombre, mode: 'insensitive' } } });
        if (!client) {
          client = await tx.client.create({ data: { companyId, name: nombre, taxId: clientTaxId || null } });
        }
      }

      // 2) Número correlativo atómico (serie + increment)
      const c = await tx.company.update({
        where: { id: companyId },
        data: { facturaCorrelativo: { increment: 1 } },
        select: { facturaCorrelativo: true, facturaSerie: true },
      });
      const number = `${c.facturaSerie || 'A'}-${String(c.facturaCorrelativo).padStart(6, '0')}`;

      // 3) Totales
      const subtotal = r2(items.reduce((s: number, it: any) => s + (it.cantidad || 1) * (it.precio || 0), 0));
      const itbmsItems = items.map((it: any) => ({ ...it, itbms: r2((it.cantidad || 1) * (it.precio || 0) * tasa) }));
      const itbms = r2(itbmsItems.reduce((s: number, it: any) => s + it.itbms, 0));
      const total = r2(subtotal + itbms);

      // 4) Asiento BORRADOR (journal-first): Débito Caja/Clientes, Crédito Ventas + ITBMS por Pagar
      const agent = new AccountingAgent(tx, companyId);
      await agent.init();
      const ventasId = await resolveSalesAccount(agent, tx, companyId);
      const cajaId = agent.resolveAlias('caja');
      const clientesId = agent.resolveAlias('clientes');
      const itbmsPorPagarId = agent.resolveAlias('itbms-por-pagar');
      const lineas = paymentMethod === 'EFECTIVO'
        ? [{ accountId: cajaId, debit: total, credit: 0 }]
        : [{ accountId: clientesId, debit: total, credit: 0 }];
      lineas.push({ accountId: ventasId, debit: 0, credit: subtotal });
      if (itbms > 0) lineas.push({ accountId: itbmsPorPagarId, debit: 0, credit: itbms });

      const desc = `Venta: ${client.name} - ${number} - $${total}`;
      const je = await tx.journalEntry.create({
        data: {
          date: new Date(date ? date + 'T12:00:00' : new Date().toISOString().slice(0, 10) + 'T12:00:00'),
          description: desc,
          status: 'BORRADOR',
          companyId,
          createdById: req.user!.userId,
          lines: { create: lineas },
        },
      });

      // 5) Transaction (metadatos iguales al flujo del chat)
      const fecha = date ? new Date(date + 'T12:00:00') : new Date();
      const vence = dueDate ? new Date(dueDate + 'T12:00:00') : new Date(fecha.getTime() + 30 * 86400000);
      const txRow = await tx.transaction.create({
        data: {
          type: 'VENTA', amount: subtotal, description: desc, concept: 'Ventas',
          paymentMethod, date: fecha, companyId, createdById: req.user!.userId, journalEntryId: je.id,
          metadata: JSON.stringify({ provider: client.name, invoiceNumber: number, itbmsAmount: itbms, source: 'factura-pdf' }),
        },
      });

      // 6) Invoice + items
      const invoice = await tx.invoice.create({
        data: {
          companyId, clientId: client.id, number, amount: subtotal, itbms, total,
          dueDate: vence, date: fecha, description: desc, paymentMethod, journalEntryId: je.id,
          items: { create: itbmsItems.map((it: any) => ({ descripcion: it.descripcion, cantidad: it.cantidad, precio: it.precio, itbms: it.itbms })) },
        },
        include: { items: true, client: { select: { id: true, name: true, taxId: true } } },
      });

      return { invoice, txRow };
    });

    await incrementUsage(req);
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'FACTURA_CREATED',
      entity: 'Invoice',
      entityId: result.invoice.id,
      after: { number: result.invoice.number, total: result.invoice.total },
    }).catch(() => {});

    res.status(201).json(result.invoice);
  } catch (e: any) {
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Número de factura duplicado, reintenta.', code: 'NUMBER_CONFLICT' });
      return;
    }
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

/** GET /api/facturas — listar con cliente (paginado). */
facturasRouter.get('/', async (req, res) => {
  const { page: pageStr, pageSize: pageSizeStr, status, search } = req.query;
  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(pageSizeStr as string) || 20));
  const where: Record<string, unknown> = { companyId: req.user!.companyId };
  if (status) where.status = status;
  if (search) where.client = { name: { contains: String(search), mode: 'insensitive' } };

  const [total, items] = await Promise.all([
    req.prisma.invoice.count({ where }),
    req.prisma.invoice.findMany({
      where,
      include: { client: { select: { id: true, name: true, taxId: true } } },
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  res.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
});

/** GET /api/facturas/:id — detalle con items. */
facturasRouter.get('/:id', async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { items: true, client: { select: { id: true, name: true, taxId: true } } },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
  res.json(invoice);
});

/** GET /api/facturas/:id/pdf — descarga el PDF. */
facturasRouter.get('/:id/pdf', async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    include: { items: true, client: true },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
  const company = await req.prisma.company.findUnique({ where: { id: req.user!.companyId } });

  const doc = buildFacturaPdf({ company, invoice, items: invoice.items || [], client: invoice.client });
  const nombre = `Factura-${(invoice.number || invoice.id.slice(0, 8)).replace(/[^A-Za-z0-9_-]/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  doc.pipe(res);
});

/**
 * PATCH /api/facturas/:id/pay — abona el SALDO restante de la factura.
 * Consistente con el import de cobros (InvoicePayment + paidAmount): si la
 * factura ya recibió abonos parciales, solo se asienta el saldo que falta;
 * cuando el saldo llega a ≈ 0 la factura pasa a PAGADA.
 */
facturasRouter.patch('/:id/pay', requireRole('admin', 'contador', 'superadmin'), requireQuota, async (req, res) => {
  try {
    const result = await req.prisma.$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
        include: { client: { select: { name: true } } },
      });
      if (!invoice) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });

      const saldo = Math.round((invoice.total - (invoice.paidAmount || 0)) * 100) / 100;
      if (saldo <= 0.01) throw Object.assign(new Error('La factura ya está pagada'), { status: 400 });

      let journalEntryId = invoice.journalEntryId;
      let cajaId: string | null = null;
      if (invoice.paymentMethod === 'CREDITO') {
        const agent = new AccountingAgent(tx, req.user!.companyId);
        await agent.init();
        cajaId = agent.resolveAlias('caja');
        const clientesId = agent.resolveAlias('clientes');
        const desc = `Cobro de factura ${invoice.number || ''} — $${saldo.toFixed(2)}`.trim();
        const je = await tx.journalEntry.create({
          data: {
            date: new Date(),
            description: desc,
            status: 'BORRADOR',
            companyId: req.user!.companyId,
            createdById: req.user!.userId,
            lines: { create: [
              { accountId: cajaId, debit: saldo, credit: 0 },
              { accountId: clientesId, debit: 0, credit: saldo },
            ] },
          },
        });
        await tx.transaction.create({
          data: {
            type: 'COBRO_CLIENTE', amount: saldo, description: desc, concept: 'Cobro de factura',
            paymentMethod: 'EFECTIVO', date: new Date(), companyId: req.user!.companyId,
            createdById: req.user!.userId, journalEntryId: je.id,
            metadata: JSON.stringify({ source: 'factura-pdf', invoiceNumber: invoice.number || null }),
          },
        });
        journalEntryId = je.id;
      }

      const updated = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidAmount: Math.round((invoice.paidAmount + saldo) * 100) / 100,
          status: 'PAGADA',
          paidAt: new Date(),
        },
      });

      // Registrar el abono (pago manual de caja) con la misma estructura
      // que los abonos del import de cobros
      await tx.invoicePayment.create({
        data: {
          companyId: req.user!.companyId,
          invoiceId: invoice.id,
          amount: saldo,
          date: new Date(),
          accountId: cajaId, // null en ventas de contado (sin asiento de cobro)
          accountName: null,
          journalEntryId: invoice.paymentMethod === 'CREDITO' ? journalEntryId : null,
        },
      });

      return { updated, journalEntryId };
    });

    await incrementUsage(req);
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'FACTURA_PAID',
      entity: 'Invoice',
      entityId: result.updated.id,
      before: { status: 'PENDIENTE' },
      after: { status: 'PAGADA' },
    }).catch(() => {});
    res.json({ id: result.updated.id, status: result.updated.status, paidAt: result.updated.paidAt, journalEntryId: result.journalEntryId });
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});
