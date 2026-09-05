import { Router } from 'express';
import { requireRole } from '../middleware/auth';

/**
 * Retenciones de ITBMS SUFRIDAS (crédito fiscal del vendedor).
 * Registro por factura/pago con certificado del agente como soporte.
 * Estados: PENDIENTE (cobro registrado) → RECIBIDA (certificado en mano) →
 *          APLICADA (usada en la declaración, Form. 430 renglón 52).
 *          PENDIENTE/RECIBIDA → ANULADA (error/ajuste).
 * Todo scoped por req.user.companyId.
 */
export const retencionesRouter = Router();

const ESTADOS = ['PENDIENTE', 'RECIBIDA', 'APLICADA', 'ANULADA'] as const;

/** Transiciones válidas de estado (no se retrocede desde terminales). */
function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  if (from === 'PENDIENTE') return to === 'RECIBIDA' || to === 'ANULADA';
  if (from === 'RECIBIDA') return to === 'APLICADA' || to === 'ANULADA' || to === 'PENDIENTE';
  return false; // APLICADA y ANULADA son terminales
}

// GET /api/retenciones-itbms — listado (filtros: estado, clienteId, desde/hasta por fecha)
retencionesRouter.get('/', async (req, res) => {
  const { estado, clienteId, desde, hasta } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (estado) where.estado = String(estado);
  if (clienteId) where.clientId = String(clienteId);
  if (desde || hasta) {
    where.fecha = {};
    if (desde) where.fecha.gte = new Date(String(desde) + 'T00:00:00');
    if (hasta) where.fecha.lte = new Date(String(hasta) + 'T23:59:59');
  }

  const rows = await req.prisma.retentionItbms.findMany({
    where,
    include: {
      invoice: { select: { number: true } },
      client: { select: { name: true, taxId: true } },
    },
    orderBy: { fecha: 'desc' },
  });

  res.json(rows.map(r => ({
    id: r.id,
    factura: r.invoice?.number || null,
    cliente: r.client?.name || null,
    ruc: r.client?.taxId || null,
    fecha: r.fecha,
    baseGravada: r.baseGravada,
    itbmsFacturado: r.itbmsFacturado,
    porcentaje: r.porcentaje,
    montoRetencion: r.montoRetencion,
    estado: r.estado,
    numeroCertificado: r.numeroCertificado,
    fechaCertificado: r.fechaCertificado,
    notas: r.notas,
    createdAt: r.createdAt,
  })));
});

// PATCH /api/retenciones-itbms/:id — certificado y/o estado
retencionesRouter.patch('/:id', requireRole('admin', 'contador', 'superadmin'), async (req, res) => {
  const { estado, numeroCertificado, fechaCertificado, notas } = req.body || {};
  const row = await req.prisma.retentionItbms.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });
  if (!row) { res.status(404).json({ error: 'Retención no encontrada' }); return; }

  const data: any = {};
  if (estado !== undefined) {
    if (!ESTADOS.includes(estado)) { res.status(400).json({ error: `Estado inválido. Válidos: ${ESTADOS.join(', ')}` }); return; }
    if (!canTransition(row.estado, estado)) {
      res.status(400).json({ error: `No se puede pasar de "${row.estado}" a "${estado}".` });
      return;
    }
    data.estado = estado;
  }
  if (numeroCertificado !== undefined) data.numeroCertificado = String(numeroCertificado).trim() || null;
  if (fechaCertificado !== undefined) data.fechaCertificado = fechaCertificado ? new Date(String(fechaCertificado) + 'T12:00:00') : null;
  if (notas !== undefined) data.notas = String(notas).trim() || null;

  // RECIBIDA/APLICADA exigen el certificado (soporte del crédito R52)
  const nuevoEstado = data.estado || row.estado;
  const cert = data.numeroCertificado ?? row.numeroCertificado;
  if ((nuevoEstado === 'RECIBIDA' || nuevoEstado === 'APLICADA') && !cert) {
    res.status(400).json({ error: 'Para marcar la retención como recibida/aplicada debe registrar el número del certificado del agente.' });
    return;
  }
  if (Object.keys(data).length === 0) { res.json(row); return; }
  const updated = await req.prisma.retentionItbms.update({ where: { id: row.id }, data });
  res.json(updated);
});

// GET /api/retenciones-itbms/report.csv — auxiliar DGI (factura, gravado, ITBMS, retenido, total)
retencionesRouter.get('/report.csv', async (req, res) => {
  const { desde, hasta, estado } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (estado) where.estado = String(estado);
  if (desde || hasta) {
    where.fecha = {};
    if (desde) where.fecha.gte = new Date(String(desde) + 'T00:00:00');
    if (hasta) where.fecha.lte = new Date(String(hasta) + 'T23:59:59');
  }
  const rows = await req.prisma.retentionItbms.findMany({
    where,
    include: { invoice: { select: { number: true } }, client: { select: { name: true, taxId: true } } },
    orderBy: { fecha: 'asc' },
  });

  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const fmt = (n: number) => n.toFixed(2);
  const lines = [
    ['Nro Factura', 'Fecha', 'Cliente', 'RUC', 'Monto Gravado', 'ITBMS Causado', '% Retencion', 'ITBMS Retenido', 'Nro Certificado', 'Estado'].join(';'),
    ...rows.map(r => [
      esc(r.invoice?.number || ''), esc(r.fecha.toISOString().slice(0, 10)), esc(r.client?.name || ''),
      esc(r.client?.taxId || ''), fmt(r.baseGravada), fmt(r.itbmsFacturado), String(Math.round(r.porcentaje * 10000) / 100),
      fmt(r.montoRetencion), esc(r.numeroCertificado || ''), esc(r.estado),
    ].join(';')),
  ];

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="retenciones-itbms.csv"');
  res.send('﻿' + lines.join('\r\n'));
});
