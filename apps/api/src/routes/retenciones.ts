import { Router } from 'express';
import PDFDocument from 'pdfkit';
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
    // APLICADA es cosa de la declaración del 430: es la única que crea el asiento de
    // compensación, deja el vínculo (`retention_itbms.declaracionId`) y sabe revertirlo.
    // Marcarla a mano dejaba una retención APLICADA sin declaración y sin vuelta atrás.
    if (estado === 'APLICADA') {
      res.status(400).json({
        error: 'El crédito del renglón 52 se aplica al PRESENTAR la declaración del 430 (pestaña 🧾 Form. 430), no desde acá: así queda el asiento, el vínculo con la retención y la posibilidad de anularla. Registra el certificado (📥) y preséntala desde ahí.',
        code: 'R52_SE_APLICA_AL_DECLARAR',
      });
      return;
    }
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

// GET /api/retenciones-itbms/report.pdf — auxiliar DGI en PDF (misma info que el CSV)
retencionesRouter.get('/report.pdf', async (req, res) => {
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

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="retenciones-itbms.pdf"');
  doc.pipe(res);

  const company = await req.prisma.company.findUnique({ where: { id: req.user!.companyId }, select: { name: true } });
  doc.fontSize(14).text(`Auxiliar de Retenciones ITBMS Sufridas`, { align: 'center' });
  doc.fontSize(10).text(`${company?.name || ''} — Período: ${desde || 'inicio'} a ${hasta || 'hoy'}`, { align: 'center' });
  doc.moveDown(0.6);

  const money = (n: number) => '$' + n.toFixed(2);
  const fmtFecha = (d: Date) => d.toISOString().slice(0, 10);

  // Columnas (landscape A4: ancho útil ≈ 770): anchos y alineación
  const cols = [
    { key: 'nro', w: 70 }, { key: 'fecha', w: 68 }, { key: 'cliente', w: 170 },
    { key: 'ruc', w: 100 }, { key: 'gravado', w: 76, right: true }, { key: 'itbms', w: 66, right: true },
    { key: 'pct', w: 42, right: true }, { key: 'retenido', w: 74, right: true }, { key: 'cert', w: 86 },
  ];
  const HEADER_H = 18, ROW_H = 15;
  let y = doc.y;

  const truncar = (s: string, maxW: number) => {
    doc.fontSize(7.5);
    let out = String(s);
    while (out.length > 1 && doc.widthOfString(out) > maxW - 4) out = out.slice(0, -1);
    return out;
  };
  const cell = (txt: string, x: number, w: number, yBase: number, opts: { right?: boolean; bold?: boolean; header?: boolean } = {}) => {
    doc.fontSize(opts.header ? 8 : 7.5).font('Helvetica' + (opts.bold || opts.header ? '-Bold' : ''));
    const label = truncar(txt, w - 6);
    const xText = opts.right ? x + w - 4 - doc.widthOfString(label) : x + 4;
    doc.fillColor(opts.header ? '#ffffff' : '#111111');
    doc.text(label, xText, yBase + (HEADER_H - 8) / 2, { width: w - 8, lineBreak: false, height: 8 });
    doc.font('Helvetica');
  };

  const drawHeader = () => {
    y = doc.y;
    cols.reduce((x, c) => {
      doc.rect(x, y, c.w, HEADER_H).fill('#1f2937');
      const labels: Record<string, string> = { nro: 'Factura', fecha: 'Fecha', cliente: 'Cliente', ruc: 'RUC', gravado: 'Gravado', itbms: 'ITBMS', pct: '%', retenido: 'Retenido', cert: 'Certificado' };
      cell(labels[c.key], x, c.w, y, { header: true, right: c.right });
      return x + c.w;
    }, 36);
    y += HEADER_H;
  };
  drawHeader();

  const rowValue = (r: any, key: string): string => {
    if (key === 'nro') return String(r.invoice?.number || '');
    if (key === 'fecha') return fmtFecha(r.fecha);
    if (key === 'cliente') return String(r.client?.name || '');
    if (key === 'ruc') return String(r.client?.taxId || '');
    if (key === 'gravado') return money(r.baseGravada);
    if (key === 'itbms') return money(r.itbmsFacturado);
    if (key === 'pct') return (Math.round((r.porcentaje || 0) * 10000) / 100) + '%';
    if (key === 'retenido') return money(r.montoRetencion);
    return String(r.numeroCertificado || '');
  };

  let totalRet = 0;
  for (const r of rows) {
    if (y > doc.page.height - 70) { doc.addPage(); y = 40; drawHeader(); }
    cols.reduce((x, c) => {
      doc.rect(x, y, c.w, ROW_H).fill(y % 2 === 0 ? '#ffffff' : '#f3f4f6');
      return x + c.w;
    }, 36);
    cols.forEach((c, i) => {
      const x = 36 + cols.slice(0, i).reduce((s, cc) => s + cc.w, 0);
      cell(rowValue(r, c.key), x, c.w, y, { right: c.right });
    });
    totalRet += r.montoRetencion;
    y += ROW_H;
  }
  doc.y = y + 8;
  doc.fontSize(9).font('Helvetica-Bold').text(`Total ITBMS retenido: ${money(totalRet)}`, { align: 'right' });
  doc.end();
});

// GET /api/retenciones-itbms/resumen-r52 — resumen del período para la
// declaración (Form. 430, renglón 52: retenciones sufridas como crédito).
retencionesRouter.get('/resumen-r52', async (req, res) => {
  const { desde, hasta } = req.query;
  const where: any = { companyId: req.user!.companyId };
  if (desde || hasta) {
    where.fecha = {};
    if (desde) where.fecha.gte = new Date(String(desde) + 'T00:00:00');
    if (hasta) where.fecha.lte = new Date(String(hasta) + 'T23:59:59');
  }
  const rows = await req.prisma.retentionItbms.findMany({ where, select: { estado: true, montoRetencion: true, itbmsFacturado: true, baseGravada: true, numeroCertificado: true } });
  const sum = (sel: (r: any) => boolean) => rows.filter(sel).reduce((s, r) => s + r.montoRetencion, 0);
  const disponible = sum(r => r.estado === 'RECIBIDA');          // con certificado, aún no usada
  const aplicado = sum(r => r.estado === 'APLICADA');
  res.json({
    periodo: { desde: desde || null, hasta: hasta || null },
    registros: rows.length,
    totalRetenido: Math.round((sum(() => true)) * 100) / 100,
    disponibleR52: Math.round(disponible * 100) / 100, // crédito para renglón 52
    yaAplicado: Math.round(aplicado * 100) / 100,
    pendienteCertificado: Math.round(sum(r => r.estado === 'PENDIENTE') * 100) / 100,
  });
});

// POST /api/retenciones-itbms/compensar — RETIRADO.
//
// El crédito del renglón 52 se aplica al presentar la declaración del 430 (pestaña
// 🧾 Form. 430): ahí el asiento queda vinculado a la retención (`declaracionId`), la
// declaración tiene número y fecha, y anularla devuelve las retenciones a RECIBIDA.
// El botón viejo hacía lo mismo pero sin vínculo consultable y sin vuelta atrás, así
// que quedaba una retención APLICADA que nadie podía deshacer (Tuning.md §4.1).
//
// Se deja el 410 (y no un 404) para que un navegador con el JS viejo en caché reciba
// la guía en vez de un error críptico — mismo idioma que el stub de Honorarios.
retencionesRouter.post('/compensar', (_req, res) => {
  res.status(410).json({
    error: 'El crédito del renglón 52 ya no se compensa desde acá: se aplica al PRESENTAR la declaración del 430 (pestaña 🧾 Form. 430 del panel de Informes). Ahí queda el asiento, el vínculo con las retenciones y la posibilidad de anularla.',
    code: 'COMPENSAR_R52_RETIRADO',
  });
});
