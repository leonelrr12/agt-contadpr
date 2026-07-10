import { Router } from 'express';
import multer from 'multer';
import { extractFromImage } from '../services/ocr';

export const ocrRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no soportado: ${file.mimetype}. Use JPEG, PNG o WebP.`));
    }
  },
});

ocrRouter.post('/extract', upload.single('image'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ninguna imagen' });
    return;
  }

  try {
    const result = await extractFromImage(req.file.buffer);
    res.json(result);
  } catch (error: any) {
    console.error('[OCR] Error:', error);
    res.status(500).json({
      error: 'Error al procesar la imagen',
      detail: error?.message || 'Unknown',
    });
  }
});

ocrRouter.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'La imagen es demasiado grande. Máximo 10MB.' });
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
