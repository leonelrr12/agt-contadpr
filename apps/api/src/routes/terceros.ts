import { Router } from 'express';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { requireRole } from '../middleware/auth';
import {
  parseTercerosFile,
  planificarTerceros,
  aplicarPlanTerceros,
  COLUMNAS_TEMPLATE,
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
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Terceros');
    ws.addRow(COLUMNAS_TEMPLATE);
    ws.getRow(1).font = { bold: true };
    ws.columns = COLUMNAS_TEMPLATE.map((h) => ({
      width: ['TIPO', 'DV', 'TIPO IDENTIFICACION'].includes(h) ? 20 : ['NOMBRE', 'RAZON SOCIAL', 'DIRECCION'].includes(h) ? 30 : 18,
    }));
    ws.addRow(['Proveedor', '46004-187-302083', '96', '+Movil Panama', 'CABLES & WIRELESS', 'RUC', '', '', '', '', '', '30']);
    ws.addRow(['Proveedor', '8-786-1842', '89', 'ALEJANDRO RODRIGUEZ ACEVEDO', '', 'CEDULA', '', '', '', '', '', '']);
    ws.addRow(['Cliente', '8-733-2267', '88', 'Ferretería El Tornillo', 'FERRETERÍA EL TORNILLO, S.A.', 'RUC', '+507 6000-0000', 'compras@tornillo.com', 'Calle 1, Ciudad', '8-8-8', 'Ejemplo de cliente', '']);

    const inst = wb.addWorksheet('Instrucciones');
    inst.addRows([
      ['Columna', 'Qué poner'],
      ['TIPO', 'Cliente o Proveedor (obligatorio)'],
      ['RAZON SOCIAL', 'Nombre legal. Es el nombre principal; si falta, se usa NOMBRE.'],
      ['NOMBRE', 'Nombre comercial (opcional).'],
      ['RUC', 'RUC o cédula SIN el dígito verificador.'],
      ['DV', 'Dígito verificador (1-2 dígitos). Si el RUC ya lo trae, no lo repitas.'],
      ['TIPO IDENTIFICACION', 'RUC, CEDULA o PASAPORTE.'],
      ['UBICACION', 'Código PP-DD-CC (ej. 8-8-8). Necesario para facturar a contribuyentes.'],
      ['PLAZO DE PAGO', 'Solo proveedores; días de crédito (ej. 30).'],
      ['', ''],
      ['Modo completar', 'Crea lo que falta y completa campos vacíos; NO pisa datos existentes.'],
      ['Modo actualizar', 'Sobrescribe con las celdas NO vacías del archivo; una celda vacía no borra.'],
    ]);
    inst.getRow(1).font = { bold: true };
    inst.columns = [{ width: 24 }, { width: 95 }];

    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-terceros.xlsx"');
    res.send(Buffer.from(buffer));
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
