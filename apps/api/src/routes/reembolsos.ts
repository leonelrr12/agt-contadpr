/**
 * Reembolsos a trabajadores.
 *
 * Un trabajador no tiene usuario: su identidad es el celular. Acá se administra
 * esa identidad (crear, renombrar, activar/desactivar) y se consultan las
 * facturas que adelantó. El vínculo con WhatsApp se engancha por número:
 *   · al crear el trabajador, si su celular YA está vinculado a la empresa;
 *   · al verificar el código de vinculación, si el trabajador ya existe.
 *
 * El pago del reembolso (marcar PAGADO + asiento contra 2.1.02.02) es otra fase.
 */

import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { parseLocalDate } from '../lib/dates';
import { saldoPendiente, pagarReembolso } from '../services/reembolsos';
import { loadCompanyAccounts, filterPayoutAccounts } from '../services/account-resolver';

export const reembolsosRouter = Router();

/** El gateway manda el número como "50761234567"; se guarda solo con dígitos. */
function normalizarCelular(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

/** Enlaza el celular del trabajador a su vínculo de WhatsApp, si existe. */
async function engancharLink(prisma: any, companyId: string, phoneNumber: string, workerId: string): Promise<boolean> {
  const link = await prisma.whatsAppLink.findFirst({
    where: { phoneNumber, OR: [{ companyId }, { companyId: null }] },
  });
  if (!link) return false;
  // Un vínculo verificado de OTRA empresa no se toca: el phoneNumber es único
  // global y robarlo dejaría a la otra empresa sin su número.
  if (link.companyId && link.companyId !== companyId) return false;
  await prisma.whatsAppLink.update({ where: { id: link.id }, data: { workerAccountId: workerId } });
  return true;
}

// GET /api/reembolsos/trabajadores — Listar con su saldo pendiente
reembolsosRouter.get('/trabajadores', async (req, res) => {
  const companyId = req.user!.companyId;
  const trabajadores = await req.prisma.workerAccount.findMany({
    where: { companyId },
    include: {
      employee: { select: { id: true, nombre: true } },
      supplier: { select: { id: true, name: true } },
      links: { select: { phoneNumber: true, verifiedAt: true, isActive: true } },
    },
    orderBy: { nombre: 'asc' },
  });

  const conSaldo = await Promise.all(
    trabajadores.map(async (t: any) => ({
      ...t,
      saldoPendiente: await saldoPendiente(req.prisma, companyId, t.id),
    })),
  );
  res.json(conSaldo);
});

// POST /api/reembolsos/trabajadores — Crear trabajador y enganchar su celular
reembolsosRouter.post('/trabajadores', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const companyId = req.user!.companyId;
  const { nombre, phoneNumber, employeeId, supplierId } = req.body || {};
  const celular = normalizarCelular(phoneNumber);

  if (!nombre || !String(nombre).trim()) { res.status(400).json({ error: 'El nombre es requerido' }); return; }
  if (celular.length < 8) { res.status(400).json({ error: 'El celular es requerido (ej. 50761234567)' }); return; }

  try {
    const trabajador = await req.prisma.workerAccount.create({
      data: {
        companyId,
        phoneNumber: celular,
        nombre: String(nombre).trim(),
        employeeId: employeeId || null,
        supplierId: supplierId || null,
      },
    });
    const enlazado = await engancharLink(req.prisma, companyId, celular, trabajador.id);
    res.status(201).json({ ...trabajador, celularEnlazado: enlazado });
  } catch (e: any) {
    if (e?.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe un trabajador con ese celular en esta empresa' });
      return;
    }
    throw e;
  }
});

// PATCH /api/reembolsos/trabajadores/:id — Nombre, estado o enlaces
reembolsosRouter.patch('/trabajadores/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const companyId = req.user!.companyId;
  const actual = await req.prisma.workerAccount.findFirst({ where: { id: req.params.id, companyId } });
  if (!actual) { res.status(404).json({ error: 'Trabajador no encontrado' }); return; }

  const { nombre, isActive, employeeId, supplierId, phoneNumber } = req.body || {};
  const data: any = {};
  if (nombre !== undefined) data.nombre = String(nombre).trim();
  if (isActive !== undefined) data.isActive = !!isActive;
  if (employeeId !== undefined) data.employeeId = employeeId || null;
  if (supplierId !== undefined) data.supplierId = supplierId || null;
  if (phoneNumber !== undefined) data.phoneNumber = normalizarCelular(phoneNumber);

  try {
    const actualizado = await req.prisma.workerAccount.update({ where: { id: actual.id }, data });

    // Cambió el celular: el vínculo viejo se suelta (el nuevo se engancha abajo).
    if (data.phoneNumber && data.phoneNumber !== actual.phoneNumber) {
      await req.prisma.whatsAppLink.updateMany({ where: { workerAccountId: actual.id }, data: { workerAccountId: null } });
    }

    // Desactivar DEVUELVE EL CELULAR A LA EMPRESA. Sin esto, el número seguiría
    // apuntando a un trabajador inactivo y sus gastos seguirían naciendo como
    // reembolso — con el agravante de que ya no aparece en la lista para notarlo.
    // Reactivar lo vuelve a enganchar, así que desactivar es reversible desde el panel.
    if (data.isActive === false) {
      await req.prisma.whatsAppLink.updateMany({ where: { workerAccountId: actual.id }, data: { workerAccountId: null } });
    } else if (actualizado.isActive) {
      await engancharLink(req.prisma, companyId, actualizado.phoneNumber, actual.id);
    }

    res.json(actualizado);
  } catch (e: any) {
    if (e?.code === 'P2002') { res.status(409).json({ error: 'Ese celular ya está asignado a otro trabajador' }); return; }
    throw e;
  }
});

// GET /api/reembolsos/cuentas-pago — Bancos y cajas para pagar el reembolso
reembolsosRouter.get('/cuentas-pago', async (req, res) => {
  const cuentas = filterPayoutAccounts(await loadCompanyAccounts(req.prisma, req.user!.companyId));
  res.json(cuentas.map(c => ({ id: c.id, code: c.code, name: c.name })));
});

// POST /api/reembolsos/pagar — Paga (agrupadas) las facturas elegidas
reembolsosRouter.post('/pagar', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const { workerId, claimIds, cuentaBancoId, fecha, notas } = req.body || {};
  if (!workerId || !Array.isArray(claimIds) || !claimIds.length || !cuentaBancoId || !fecha) {
    res.status(400).json({ error: 'Faltan datos: trabajador, facturas, cuenta y fecha son requeridos' });
    return;
  }
  try {
    const r = await pagarReembolso(req.prisma, {
      companyId: req.user!.companyId,
      workerId,
      claimIds,
      cuentaBancoId,
      fecha,
      userId: req.user!.userId,
      notas: notas || null,
    });
    res.json({
      ok: true,
      total: r.total,
      facturas: r.facturas,
      aprobadas: r.aprobadas,
      reimbursementId: r.reembolso.id,
      journalEntryId: r.asiento.id,
    });
  } catch (e: any) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * GET /api/reembolsos/facturas — Archivo de facturas recibidas, con búsqueda.
 *
 * Son TODAS las que entraron con datos propios (las del trabajador y las de la
 * empresa): cada una con su URL del CUTE, su XML y el asiento que la registró.
 * Filtros: `workerId`, `soloEmpresa=true`, `status`, `desde`/`hasta` y `texto`
 * (busca en proveedor, número de factura y RUC — para encontrar "esa factura de
 * la ferretería de marzo" sin acordarse del número).
 */
reembolsosRouter.get('/facturas', async (req, res) => {
  const companyId = req.user!.companyId;
  const { workerId, status, desde, hasta, texto, soloEmpresa, limit } = req.query;

  const where: any = { companyId };
  if (soloEmpresa === 'true') where.workerId = null;
  else if (workerId) where.workerId = String(workerId);
  if (status) where.status = String(status);

  const rango: any = {};
  if (desde && /^\d{4}-\d{2}-\d{2}$/.test(String(desde))) rango.gte = parseLocalDate(String(desde));
  if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(String(hasta))) rango.lte = parseLocalDate(String(hasta));
  if (Object.keys(rango).length) where.fecha = rango;

  const t = String(texto || '').trim();
  if (t) {
    where.OR = [
      { proveedor: { contains: t, mode: 'insensitive' } },
      { numeroFactura: { contains: t, mode: 'insensitive' } },
      { rucEmisor: { contains: t, mode: 'insensitive' } },
    ];
  }

  const facturas = await req.prisma.expenseClaim.findMany({
    where,
    include: {
      worker: { select: { id: true, nombre: true, phoneNumber: true } },
      journalEntry: { select: { id: true, date: true, description: true, status: true } },
      reimbursement: { select: { id: true, fecha: true, monto: true } },
    },
    orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(Number(limit) || 300, 1000),
  });
  res.json(facturas);
});
