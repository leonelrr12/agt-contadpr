import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/auth';
import { logAudit } from '../services/audit-log';
import { fusionarTercero, type TipoFusion } from '../services/tercero-merge';
import {
  parseTercerosFile,
  planificarTerceros,
  aplicarPlanTerceros,
  construirPlantillaTerceros,
  type ModoImport,
} from '../services/terceros-import';

export const tercerosRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.xlsx')) cb(null, true);
    else cb(new Error(`Formato no soportado: ${file.mimetype}. Use CSV o XLSX.`));
  },
});

// Importar/actualizar el maestro de terceros es administración de datos: los
// mismos roles que pueden editar la ficha (no el rol inventario).
tercerosRouter.use(requireRole('admin', 'contador', 'superadmin'));

const modoDe = (v: unknown): ModoImport => (String(v || 'completar') === 'actualizar' ? 'actualizar' : 'completar');

/**
 * Fusiona un duplicado en un maestro. Mueve facturas/bills, retenciones,
 * inventario, cuentas de trabajador y la metadata de las Transactions; después
 * elimina el duplicado. Es irreversible: la UI pide confirmación.
 */
tercerosRouter.post('/fusionar', async (req, res) => {
  const tipoRaw = String(req.body?.tipo || '').toLowerCase();
  const tipo: TipoFusion | null =
    tipoRaw === 'cliente' ? 'cliente' : tipoRaw === 'proveedor' ? 'proveedor' : null;
  const origenId = String(req.body?.origenId || '').trim();
  const destinoId = String(req.body?.destinoId || '').trim();
  const forzar = req.body?.forzar === true;

  if (!tipo || !origenId || !destinoId) {
    res.status(400).json({ error: 'Indicá tipo, origenId y destinoId' });
    return;
  }

  try {
    const r = await fusionarTercero(req.prisma, req.user!.companyId, tipo, origenId, destinoId, { forzar });
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'TERCERO_FUSIONADO',
      entity: tipo === 'cliente' ? 'Client' : 'Supplier',
      entityId: destinoId,
      before: { origen: r.origen },
      after: { destino: r.destino, movidos: r.movidos },
    });
    res.json(r);
  } catch (e: any) {
    res.status(e.status || 500).json({
      error: e.message || 'No se pudo fusionar el tercero',
      ...(e.code ? { code: e.code } : {}),
    });
  }
});

async function cargarExistentes(prisma: any, companyId: string) {
  const campos = {
    id: true, name: true, taxId: true, dv: true, tradeName: true, contactName: true,
    taxIdType: true, phone: true, email: true, address: true, location: true, notes: true,
  } as const;
  const [client, supplier] = await Promise.all([
    prisma.client.findMany({ where: { companyId }, select: campos }),
    prisma.supplier.findMany({ where: { companyId }, select: { ...campos, paymentTerms: true } }),
  ]);
  return { client, supplier };
}

/** Plantilla Excel con encabezados, ejemplos e instrucciones. */
tercerosRouter.get('/import/template', async (_req, res, next) => {
  try {
    const buffer = await construirPlantillaTerceros();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-terceros.xlsx"');
    res.send(buffer);
  } catch (e) { next(e); }
});

/** Analiza el archivo y devuelve el plan sin escribir nada. */
tercerosRouter.post('/import/preview', upload.single('file'), async (req, res, next) => {
  if (!req.file) { res.status(400).json({ error: 'No se recibió ningún archivo' }); return; }
  try {
    const modo = modoDe(req.body?.modo);
    const filas = await parseTercerosFile(req.file.buffer, req.file.originalname);
    const existentes = await cargarExistentes(req.prisma, req.user!.companyId);
    const plan = planificarTerceros(filas, existentes, modo);
    res.json({
      modo,
      resumen: plan.resumen,
      filas: plan.filas.map(({ data, ...rest }) => rest),
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'No se pudo leer el archivo' });
  }
});

/** Recalcula el plan (por si cambió el modo o la BD) y aplica solo lo válido. */
tercerosRouter.post('/import/apply', upload.single('file'), async (req, res, next) => {
  if (!req.file) { res.status(400).json({ error: 'No se recibió ningún archivo' }); return; }
  try {
    const modo = modoDe(req.body?.modo);
    const companyId = req.user!.companyId;
    const filas = await parseTercerosFile(req.file.buffer, req.file.originalname);
    const existentes = await cargarExistentes(req.prisma, companyId);
    const plan = planificarTerceros(filas, existentes, modo);
    const resultado = await aplicarPlanTerceros(req.prisma, companyId, plan.filas);
    res.json({
      modo,
      aplicadas: resultado.aplicadas,
      resumen: resultado.resumen,
      filas: resultado.filas.map(({ data, ...rest }) => rest),
    });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'No se pudo importar el archivo' });
  }
});
