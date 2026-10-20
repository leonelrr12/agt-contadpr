import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { requireModulo } from '../middleware/modulo';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { logAudit } from '../services/audit-log';
import { buildFacturaPdf } from '../services/factura-pdf';
import { createFacturaSchema } from '../validation/schemas';
import { AccountingAgent } from '@agt-contador/agents';
import { findOrCreateClient } from '../services/counterparty';
import { retencionCobroInfo, marcarClienteAgente } from '../services/retencion-itbms';
import { checkNotBlocked } from '../services/journal-guard';
import { prepararSalidaVenta, confirmarSalidaVenta } from '../services/inventario';
import { emitInvoiceWithPac } from '../services/pac/emit-invoice';
import type { InvoiceEmission } from '../services/pac/emit-invoice';

export const facturasRouter = Router();

// TODO el módulo exige tenerlo: el plan lo incluye o la cuenta lo contrató como
// add-on. El backend niega aunque el sidebar esté oculto (PLANES.md §4).
facturasRouter.use(requireModulo('facturas-pdf'));

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Respuesta resumida de la emisión: sin el XML (se sirve por su endpoint). */
function resumenFacturaElectronica(e: InvoiceEmission) {
  return {
    status: e.status,
    message: e.message,
    cufe: e.cufe,
    documentNumber: e.documentNumber,
    authorizationNumber: e.authorizationNumber,
    pdfUrl: e.pdfUrl,
    messages: e.messages,
  };
}

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

// ── Facturas ──
// La configuración de facturación (serie, resolución DGI, logo) se mudó al
// perfil de la empresa (Administración → 🏢 Empresa): son datos de la EMPRESA,
// no del módulo. Este router solo emite, cobra y genera PDFs.

/** POST /api/facturas — emite factura con numeración correlativa y asiento BORRADOR. */
// El rol `inventario` emite ventas: es quien atiende el mostrador y descuenta stock.
// Cobrar (`PATCH /:id/pay`) y configurar NO: eso es tesorería y administración.
facturasRouter.post('/', requireRole('admin', 'contador', 'superadmin', 'inventario'), requireQuota, validate(createFacturaSchema), async (req, res) => {
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
        // Dedupe por RUC/nombre (higiene de duplicidad) — ver services/counterparty.ts
        client = await findOrCreateClient(tx, companyId, { name: clientName || 'CONSUMIDOR FINAL', taxId: clientTaxId });
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

      // Costo de lo vendido: solo los renglones que llevan producto del kardex. Un
      // servicio no entra acá y la factura sale igual que siempre.
      const salida = await prepararSalidaVenta(tx, companyId, itbmsItems);
      if (salida) lineas.push(...salida.lineasCosto);

      const desc = `Venta: ${client.name} - ${number} - $${Number(total).toFixed(2)}`;
      const blocked = await checkNotBlocked(tx, companyId, lineas.map((l: any) => l.accountId));
      if (blocked) throw Object.assign(new Error(blocked), { status: 400 });

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
          itbmsRate: tasa,
          dueDate: vence, date: fecha, description: desc, paymentMethod, journalEntryId: je.id,
          items: { create: itbmsItems.map((it: any) => ({ descripcion: it.descripcion, cantidad: it.cantidad, precio: it.precio, itbms: it.itbms, productId: it.productId || null })) },
        },
        include: { items: true, client: { select: { id: true, name: true, taxId: true } } },
      });

      // El kardex se mueve después de tener la factura, para dejar el vínculo. Sigue
      // dentro de la transacción: si algo falla, no queda ni stock ni asiento.
      let movimientos: any[] = [];
      if (salida) {
        movimientos = await confirmarSalidaVenta(tx, companyId, req.user!.userId, salida, {
          asientoId: je.id,
          invoiceId: invoice.id,
          fecha,
          referencia: number,
        });
      }

      return { invoice, txRow, movimientos, avisos: salida?.avisos || [] };
    });

    await incrementUsage(req);
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'FACTURA_CREATED',
      entity: 'Invoice',
      entityId: result.invoice.id,
      after: { number: result.invoice.number, total: result.invoice.total },
    }).catch(() => {});

    // La emisión electrónica va DESPUÉS del commit. Si el PAC falla, la factura
    // y el asiento ya existen: quedan marcados (ERROR/NO_CONFIGURADO) y se
    // reintentan desde POST /:id/emitir sin duplicar.
    let emision: InvoiceEmission;
    try {
      emision = await emitInvoiceWithPac(req.prisma, companyId, result.invoice.id);
    } catch (err: any) {
      console.error('[Facturas] Emisión PAC:', err?.message);
      emision = {
        status: 'ERROR',
        message: 'No se pudo emitir electrónicamente. La factura quedó guardada.',
        messages: [],
        invoice: result.invoice,
      };
    }

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: `FACTURA_PAC_${emision.status}`,
      entity: 'Invoice',
      entityId: result.invoice.id,
      after: { status: emision.status, cufe: emision.cufe || null },
    }).catch(() => {});

    const invoiceOut: any = { ...(emision.invoice || result.invoice) };
    delete invoiceOut.pacXml;
    res.status(201).json({
      ...invoiceOut,
      avisosInventario: result.avisos,
      facturaElectronica: resumenFacturaElectronica(emision),
    });
  } catch (e: any) {
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Número de factura duplicado, reintenta.', code: 'NUMBER_CONFLICT' });
      return;
    }
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

/**
 * POST /api/facturas/:id/emitir — emite o reintenta la factura electrónica.
 * Si ya está AUTORIZADA devuelve el documento guardado sin llamar al PAC.
 */
facturasRouter.post('/:id/emitir', requireRole('admin', 'contador', 'superadmin', 'inventario'), async (req, res) => {
  try {
    const emision = await emitInvoiceWithPac(req.prisma, req.user!.companyId, req.params.id);
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: `FACTURA_PAC_RETRY_${emision.status}`,
      entity: 'Invoice',
      entityId: req.params.id,
      after: { status: emision.status, cufe: emision.cufe || null },
    }).catch(() => {});

    const invoiceOut: any = { ...emision.invoice };
    delete invoiceOut.pacXml;
    res.json({
      ...invoiceOut,
      facturaElectronica: resumenFacturaElectronica(emision),
    });
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message || 'No se pudo emitir la factura electrónica.' });
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
      // El XML puede ser grande: se sirve por GET /:id/xml y no viaja en la lista.
      omit: { pacXml: true },
      include: { client: { select: { id: true, name: true, taxId: true } } },
      orderBy: { date: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  res.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
});

/** GET /api/facturas/:id — detalle con items y perfil de retención del cliente. */
facturasRouter.get('/:id', async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    omit: { pacXml: true },
    include: {
      items: true,
      client: {
        select: {
          id: true, name: true, taxId: true,
          esAgenteRetenedor: true, porcentajeRetencionItbms: true,
          vigenciaRetencionDesde: true, vigenciaRetencionHasta: true,
        },
      },
    },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
  res.json(invoice);
});

/** GET /api/facturas/:id/xml — XML autorizado (o rechazado) guardado. */
facturasRouter.get('/:id/xml', async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    select: { number: true, pacXml: true },
  });
  if (!invoice) { res.status(404).json({ error: 'Factura no encontrada' }); return; }
  if (!invoice.pacXml) { res.status(404).json({ error: 'La factura no tiene XML autorizado.' }); return; }

  const nombre = `Factura-${(invoice.number || req.params.id).replace(/[^A-Za-z0-9_-]/g, '-')}.xml`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.send(invoice.pacXml);
});

/** GET /api/facturas/:id/pdf — descarga el PDF. */
facturasRouter.get('/:id/pdf', async (req, res) => {
  const invoice = await req.prisma.invoice.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
    omit: { pacXml: true },
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
 * PATCH /api/facturas/:id/pay — registra un cobro con posible retención ITBMS.
 *
 * Body opcional: { efectivo?, retencionItbms?, cuentaId?, fecha? }
 * - Sin body: comportamiento histórico — paga el saldo restante en efectivo
 *   (caja) y salda la factura.
 * - `efectivo`: monto recibido (default: saldo restante). Menor al saldo = abono
 *   parcial (la factura queda PENDIENTE).
 * - `retencionItbms`: retención sufrida (crédito fiscal). Se valida contra el
 *   perfil del cliente (agente + vigencia en la fecha de la factura) y nunca
 *   supera el porcentaje del ITBMS. El asiento divide: débito cuenta efectivo
 *   + débito `itbms-retenido-terceros` / crédito Clientes por el total aplicado.
 * - `cuentaId`: cuenta contable del depósito (default: alias 'caja').
 */
facturasRouter.patch('/:id/pay', requireRole('admin', 'contador', 'superadmin'), requireQuota, async (req, res) => {
  try {
    const { efectivo, retencionItbms, cuentaId } = req.body || {};
    const result = await req.prisma.$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: req.params.id, companyId: req.user!.companyId },
        include: { client: { select: { name: true, esAgenteRetenedor: true, porcentajeRetencionItbms: true, vigenciaRetencionDesde: true, vigenciaRetencionHasta: true } } },
      });
      if (!invoice) throw Object.assign(new Error('Factura no encontrada'), { status: 404 });

      const saldo = Math.round((invoice.total - (invoice.paidAmount || 0)) * 100) / 100;
      if (saldo <= 0.01) throw Object.assign(new Error('La factura ya está pagada'), { status: 400 });

      const r2v = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
      const cash = efectivo == null ? saldo : r2v(efectivo);
      const ret = r2v(retencionItbms || 0);
      if (cash < 0 || ret < 0) throw Object.assign(new Error('Montos inválidos'), { status: 400 });
      const aplicado = r2v(cash + ret);
      if (aplicado > saldo + 0.01) {
        throw Object.assign(new Error(`El total aplicado $${aplicado.toFixed(2)} excede el saldo de la factura ($${saldo.toFixed(2)}).`), { status: 400 });
      }
      const quedaPagada = saldo - aplicado <= 0.01;

      // Retención: tope del porcentaje del ITBMS. Si el cliente no está
      // marcado como agente se tolera hasta el 50% estándar y se marca
      // automáticamente al cobrar (evidencia del cobro) — ver retencionCobroInfo.
      const fechaFactura = invoice.date instanceof Date ? invoice.date : new Date(invoice.date);
      let retencionId: string | null = null;
      let retAccountId: string | null = null;
      let autoMarcadoAgente = false;
      if (ret > 0) {
        if (invoice.paymentMethod !== 'CREDITO') {
          throw Object.assign(new Error('La retención solo aplica a facturas a crédito (CxC).'), { status: 400 });
        }
        const info = retencionCobroInfo(invoice.client, invoice.itbms, fechaFactura);
        if (info.cap <= 0) {
          throw Object.assign(new Error('La factura no tiene ITBMS para retener.'), { status: 400 });
        }
        if (ret > info.cap + 0.01) {
          throw Object.assign(new Error(`La retención $${ret.toFixed(2)} excede el ${Math.round(info.pct * 100)}% del ITBMS de la factura ($${info.cap.toFixed(2)}).`), { status: 400 });
        }
        autoMarcadoAgente = !info.esAgente;
      }

      let jeId = invoice.journalEntryId;
      // Cuenta del depósito (solo relevante en crédito): cuentaId explícita o alias 'caja'
      let cuentaIdResuelta: string | null = null;
      if (invoice.paymentMethod === 'CREDITO') {
        const agent = new AccountingAgent(tx, req.user!.companyId);
        await agent.init();
        const clientesId = agent.resolveAlias('clientes');
        if (cuentaId) {
          const acc = await tx.account.findFirst({ where: { id: cuentaId, companyId: req.user!.companyId } });
          if (!acc) throw Object.assign(new Error('Cuenta contable no encontrada'), { status: 400 });
          cuentaIdResuelta = acc.id;
        } else {
          try { cuentaIdResuelta = agent.resolveAlias('caja'); } catch {
            throw Object.assign(new Error('No se encontró la cuenta Caja (alias "caja") en el catálogo.'), { status: 400 });
          }
        }
        if (ret > 0) {
          // Resolución tolerante: alias, código 1.1.07 o nombre (cuentas
          // creadas a mano desde el panel no llevan alias)
          const acc = await tx.account.findFirst({
            where: {
              companyId: req.user!.companyId,
              OR: [
                { aliases: { has: 'itbms-retenido-terceros' } },
                { code: '1.1.07' },
                { name: { contains: 'retenido por terceros', mode: 'insensitive' } },
              ],
            },
            select: { id: true },
          });
          if (!acc) {
            throw Object.assign(new Error('No se encontró la cuenta "ITBMS Retenido por Terceros" (código 1.1.07) en el catálogo. Créela para registrar la retención.'), { status: 400 });
          }
          retAccountId = acc.id;
        }
        const descSuffix = ret > 0 ? ` (efectivo $${cash.toFixed(2)} + retención ITBMS $${ret.toFixed(2)})` : '';
        const desc = `Cobro de factura ${invoice.number || ''} — $${aplicado.toFixed(2)}${descSuffix}`.trim();
        const lines: any[] = [
          { accountId: cuentaIdResuelta!, debit: cash > 0 ? cash : 0, credit: 0 },
        ];
        if (ret > 0) lines.push({ accountId: retAccountId!, debit: ret, credit: 0 });
        lines.push({ accountId: clientesId, debit: 0, credit: aplicado });
        const blocked = await checkNotBlocked(tx, req.user!.companyId, lines.map((l: any) => l.accountId));
        if (blocked) throw Object.assign(new Error(blocked), { status: 400 });

        const je = await tx.journalEntry.create({
          data: {
            date: new Date(),
            description: desc,
            status: 'BORRADOR',
            companyId: req.user!.companyId,
            createdById: req.user!.userId,
            lines: { create: lines },
          },
        });
        await tx.transaction.create({
          data: {
            type: 'COBRO_CLIENTE', amount: cash, description: desc, concept: 'Cobro de factura',
            paymentMethod: 'EFECTIVO', date: new Date(), companyId: req.user!.companyId,
            createdById: req.user!.userId, journalEntryId: je.id,
            metadata: JSON.stringify({
              source: 'factura-pdf', invoiceNumber: invoice.number || null,
              appliedAmount: aplicado, retentionAmount: ret,
            }),
          },
        });
        jeId = je.id;
      }

      const updated = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidAmount: r2v((invoice.paidAmount || 0) + aplicado),
          ...(quedaPagada ? { status: 'PAGADA', paidAt: new Date() } : {}),
        },
      });

      // Registrar el abono: amount = efectivo recibido; retentionAmount = crédito fiscal
      const payment = await tx.invoicePayment.create({
        data: {
          companyId: req.user!.companyId,
          invoiceId: invoice.id,
          amount: cash,
          retentionAmount: ret,
          date: new Date(),
          accountId: invoice.paymentMethod === 'CREDITO' ? cuentaIdResuelta : null,
          accountName: null,
          journalEntryId: invoice.paymentMethod === 'CREDITO' ? jeId : null,
        },
      });

      // Retención sufrida → registro de crédito fiscal (estado PENDIENTE hasta el certificado)
      if (ret > 0) {
        const created = await tx.retentionItbms.create({
          data: {
            companyId: req.user!.companyId,
            clientId: invoice.clientId,
            invoiceId: invoice.id,
            invoicePaymentId: payment.id,
            fecha: new Date(),
            baseGravada: invoice.amount,
            itbmsFacturado: invoice.itbms,
            porcentaje: invoice.itbms > 0 ? ret / invoice.itbms : 0.5,
            montoRetencion: ret,
            journalEntryId: jeId,
            estado: 'PENDIENTE',
          },
        });
        retencionId = created.id;
        // Evidencia de retención en cliente sin perfil → marcarlo como agente
        if (autoMarcadoAgente) {
          await marcarClienteAgente(tx, invoice.clientId, fechaFactura, ret, invoice.itbms || 0);
        }
      }

      return { updated, journalEntryId: jeId, retencionId, aplicado, ret, autoMarcadoAgente };
    });

    await incrementUsage(req);
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'FACTURA_PAID',
      entity: 'Invoice',
      entityId: result.updated.id,
      before: { status: 'PENDIENTE' },
      after: { status: result.updated.status },
    }).catch(() => {});
    res.json({
      id: result.updated.id, status: result.updated.status, paidAt: result.updated.paidAt,
      journalEntryId: result.journalEntryId, aplicado: result.aplicado, retencionItbms: result.ret,
      retencionId: result.retencionId, autoMarcadoAgente: result.autoMarcadoAgente,
    });
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});
