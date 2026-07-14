import { Router } from 'express';
import multer from 'multer';
import { extractFromImage, saveCorrection } from '../services/ocr';
import { validate } from '../middleware/validate';
import { ocrCorrectSchema } from '../validation/schemas';

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
    const result = await extractFromImage(req.file.buffer, req.prisma);
    res.json(result);
  } catch (error: any) {
    console.error('[OCR] Error:', error);
    res.status(500).json({
      error: 'Error al procesar la imagen',
      detail: error?.message || 'Unknown',
    });
  }
});

ocrRouter.post('/correct', validate(ocrCorrectSchema), async (req, res) => {
  try {
    const { rawText, correctedText, total, date, provider, ruc, itbms } = req.body;

    const example = await saveCorrection(req.prisma, {
      rawText,
      correctedText,
      total,
      date,
      provider,
      ruc,
      itbms,
    });

    res.json({ success: true, id: example.id });
  } catch (error: any) {
    console.error('[OCR] Error saving correction:', error);
    res.status(500).json({ error: 'Error al guardar corrección' });
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
