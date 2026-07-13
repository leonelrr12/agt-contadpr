import { Router } from 'express';
import multer from 'multer';
import { extractFromPDF } from '../services/pdf-extractor';

export const facturaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['application/pdf'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no soportado: ${file.mimetype}. Use PDF.`));
    }
  },
});

facturaRouter.post('/extract', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún PDF' });
    return;
  }

  try {
    const result = await extractFromPDF(req.file.buffer, req.prisma);
    res.json(result);
  } catch (error: any) {
    console.error('[Factura] Error:', error);
    res.status(500).json({
      error: 'Error al procesar el PDF',
      detail: error?.message || 'Unknown',
    });
  }
});

facturaRouter.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'El PDF es demasiado grande. Máximo 10MB.' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message });
    return;
  }
});
