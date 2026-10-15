import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { validate } from '../middleware/validate';
import { getAnioFiscal } from '../lib/fiscal-year';
import { loadCompanyAccounts, filterPayoutAccounts } from '../services/account-resolver';
import {
  crearDeclaracion,
  editarDeclaracion,
  presentarDeclaracion,
  pagarDeclaracion,
  anularDeclaracion,
  declaracionConDetalle,
  declaracionDelPeriodo,
  listarDeclaraciones,
  retencionesDelPeriodo,
  periodoDe,
} from '../services/declaracion-itbms';
import { dibujarDeclaracion430 } from '../services/declaracion-itbms-pdf';
import {
  crearDeclaracionItbmsSchema,
  editarDeclaracionItbmsSchema,
  presentarDeclaracionItbmsSchema,
  pagarDeclaracionItbmsSchema,
  anularDeclaracionItbmsSchema,
} from '../validation/schemas';

/**
 * Declaración mensual de ITBMS (Formulario 430) como dato.
 *
 * El borrador (`/api/reports/borrador-430`) sigue siendo la fuente de solo lectura; acá
 * se guarda lo que el contador **presenta**: renglones, número de formulario, estados y
 * los asientos que la declaración crea (compensación del R52 al presentar, pago contra
 * banco). Anular revierte todo y deja el período libre.
 */
export const declaracionesRouter = Router();

const ROLES = requireRole('admin', 'contador', 'superadmin');

/** Traduce los errores con `status` del servicio (Express 4 no enruta rechazos async). */
const responder = (res: any, e: any) => {
  const status = e?.status || (e?.code === 'P2002' ? 409 : 500);
  const mensaje = e?.code === 'P2002'
    ? 'Ya existe una declaración con ese número de formulario (o una viva para ese período).'
    : e?.message || 'Error inesperado';
  if (status >= 500) console.error('[Declaraciones] Error:', e);
  res.status(status).json({ error: mensaje });
};

// GET /api/declaraciones-itbms — listado (filtros: year, estado)
declaracionesRouter.get('/', async (req, res) => {
  try {
    const year = Number(req.query.year);
    const declaraciones = await listarDeclaraciones(req.prisma, req.user!.companyId, {
      year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : undefined,
      estado: typeof req.query.estado === 'string' ? req.query.estado : undefined,
    });
    res.json({ declaraciones });
  } catch (e: any) {
    responder(res, e);
  }
});

// GET /api/declaraciones-itbms/cuentas-pago — bancos y cajas para el pago
// (antes de `/:id`: Express 4 matchea por orden)
declaracionesRouter.get('/cuentas-pago', async (req, res) => {
  try {
    const cuentas = await loadCompanyAccounts(req.prisma, req.user!.companyId);
    res.json(filterPayoutAccounts(cuentas as any).map((c: any) => ({ id: c.id, code: c.code, name: c.name })));
  } catch (e: any) {
    responder(res, e);
  }
});

// GET /api/declaraciones-itbms/periodo/:period — la declaración viva de un período
// ("YYYY-MM") y lo que se puede aplicar al renglón 52 hoy.
declaracionesRouter.get('/periodo/:period', async (req, res) => {
  try {
    const period = String(req.params.period);
    const m = /^(\d{4})-(\d{2})$/.exec(period);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) {
      res.status(400).json({ error: 'El período va como YYYY-MM (mes entre 01 y 12)' });
      return;
    }
    const declaracion = await declaracionDelPeriodo(req.prisma, req.user!.companyId, period);
    const detalle = declaracion ? await declaracionConDetalle(req.prisma, req.user!.companyId, declaracion.id) : null;
    const retenciones = await retencionesDelPeriodo(req.prisma, req.user!.companyId, period);
    res.json({ period, declaracion: detalle, retenciones });
  } catch (e: any) {
    responder(res, e);
  }
});

// GET /api/declaraciones-itbms/:id — detalle
declaracionesRouter.get('/:id', async (req, res) => {
  try {
    const d = await declaracionConDetalle(req.prisma, req.user!.companyId, req.params.id);
    if (!d) {
      res.status(404).json({ error: 'Declaración no encontrada' });
      return;
    }
    res.json({ declaracion: d });
  } catch (e: any) {
    responder(res, e);
  }
});

// GET /api/declaraciones-itbms/:id/pdf — copia de la declaración
declaracionesRouter.get('/:id/pdf', async (req, res) => {
  try {
    const d = await declaracionConDetalle(req.prisma, req.user!.companyId, req.params.id);
    if (!d) {
      res.status(404).json({ error: 'Declaración no encontrada' });
      return;
    }
    const empresa = await req.prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: { name: true, taxId: true },
    });
    const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'portrait' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="declaracion-430-${d.period}.pdf"`);
    doc.pipe(res);
    dibujarDeclaracion430(doc, {
      empresa: { name: empresa?.name || '', taxId: empresa?.taxId },
      declaracion: d,
      generadoPor: req.user!.name || req.user!.email,
      ahora: new Date(),
    });
    doc.end();
  } catch (e: any) {
    responder(res, e);
  }
});

// POST /api/declaraciones-itbms — crear la declaración del período desde el borrador
declaracionesRouter.post('/', ROLES, validate(crearDeclaracionItbmsSchema), async (req, res) => {
  try {
    const { year, mes, notas } = req.body;
    const anioFiscal = await getAnioFiscal(req.prisma, req.user!.companyId);
    const declaracion = await crearDeclaracion(req.prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.userId,
      year,
      mes,
      anioFiscal,
      notas: notas ?? null,
    });
    res.status(201).json({ declaracion });
  } catch (e: any) {
    responder(res, e);
  }
});

// PATCH /api/declaraciones-itbms/:id — corregir los renglones (solo en BORRADOR)
declaracionesRouter.patch('/:id', ROLES, validate(editarDeclaracionItbmsSchema), async (req, res) => {
  try {
    const { notas, ...renglones } = req.body;
    const declaracion = await editarDeclaracion(req.prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.userId,
      id: req.params.id,
      renglones,
      notas,
    });
    res.json({ declaracion });
  } catch (e: any) {
    responder(res, e);
  }
});

// POST /api/declaraciones-itbms/:id/presentar — número, fecha y compensación del R52
declaracionesRouter.post('/:id/presentar', ROLES, requireQuota, validate(presentarDeclaracionItbmsSchema), async (req, res) => {
  try {
    const r = await presentarDeclaracion(req.prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.userId,
      id: req.params.id,
      numeroFormulario: req.body.numeroFormulario,
      fechaPresentacion: req.body.fechaPresentacion,
      retencionIds: req.body.retencionIds,
    });
    // La cuota se cuenta por movimiento: solo si nació un asiento (la mayoría de las
    // presentaciones de hoy no compensan nada porque las retenciones no tienen certificado).
    if (r.asientoCompensacion) await incrementUsage(req);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    responder(res, e);
  }
});

// POST /api/declaraciones-itbms/:id/pagar — asiento contra banco y estado PAGADA
declaracionesRouter.post('/:id/pagar', ROLES, requireQuota, validate(pagarDeclaracionItbmsSchema), async (req, res) => {
  try {
    const r = await pagarDeclaracion(req.prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.userId,
      id: req.params.id,
      cuentaBancoId: req.body.cuentaBancoId,
      monto: req.body.monto,
      fecha: req.body.fecha,
    });
    await incrementUsage(req);
    res.json({ ok: true, ...r });
  } catch (e: any) {
    responder(res, e);
  }
});

// POST /api/declaraciones-itbms/:id/anular — revierte asientos, retenciones y obligación
declaracionesRouter.post('/:id/anular', ROLES, validate(anularDeclaracionItbmsSchema), async (req, res) => {
  try {
    const r = await anularDeclaracion(req.prisma, {
      companyId: req.user!.companyId,
      userId: req.user!.userId,
      id: req.params.id,
      motivo: req.body.motivo,
    });
    res.json({ ok: true, ...r });
  } catch (e: any) {
    responder(res, e);
  }
});

/** Período de una declaración, para la UI (`YYYY-MM`). */
export { periodoDe };
