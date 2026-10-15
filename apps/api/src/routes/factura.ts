import { Router } from 'express';
import multer from 'multer';
import { extractFromPDF } from '../services/pdf-extractor';
import { descargarFacturaDgi, DgiError } from '../services/dgi-cute';
import { quickClassify } from '../services/pre-clasificador';

export const facturaRouter = Router();

/** Guarda items clasificados en el concepto para aprendizaje futuro. */
async function learnItems(prisma: any, companyId: string, items: string[], conceptName: string) {
  if (!items.length || !conceptName) return;
  try {
    const concept = await prisma.concept.findFirst({
      where: { name: conceptName, companyId },
    });
    if (concept) {
      const existing = JSON.parse(concept.keywords || '[]');
      const newWords = items.flatMap(i => i.toLowerCase().split(/\s+/)).filter(w => w.length >= 3 && !existing.includes(w));
      if (newWords.length > 0) {
        await prisma.concept.update({
          where: { id: concept.id },
          data: { keywords: JSON.stringify([...existing, ...newWords].slice(0, 500)) },
        });
      }
    }
  } catch {}
}

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
    const concept = await quickClassify(result.text, req.prisma, req.user!.companyId)
      || await quickClassify(result.provider || '', req.prisma, req.user!.companyId);
    res.json({ ...result, concept });
  } catch (error: any) {
    console.error('[Factura] Error:', error);
    res.status(500).json({
      error: 'Error al procesar el PDF',
      detail: error?.message || 'Unknown',
    });
  }
});

facturaRouter.post('/extract-url', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    res.status(400).json({ error: 'URL del PDF es requerida' });
    return;
  }

  try {
    // Validar que sea una URL válida
    new URL(url);

    // El visor de la DGI y la descarga del PDF viven en `dgi-cute.ts`. Sin
    // User-Agent de navegador, tal como se hacía acá (WhatsApp sí lo manda).
    const { pdf } = await descargarFacturaDgi(url, { timeoutMs: 30000, userAgent: null });

    const result = await extractFromPDF(pdf, req.prisma);
    const concept = await quickClassify(result.text, req.prisma, req.user!.companyId)
      || await quickClassify(result.provider || '', req.prisma, req.user!.companyId);
    res.json({ ...result, concept });
  } catch (error: any) {
    // Los códigos de `descargarFacturaDgi` se traducen acá: el servicio no sabe
    // de HTTP ni de mensajes de usuario.
    if (error instanceof DgiError) {
      if (error.code === 'DGI_TIMEOUT') {
        res.status(504).json({ error: 'Tiempo de espera agotado al descargar el PDF (30s)' });
        return;
      }
      if (error.code === 'DGI_HTTP' && error.status) {
        res.status(400).json({
          error:
            error.etapa === 'POST'
              ? `No se pudo descargar el PDF de la DGI: HTTP ${error.status}`
              : `No se pudo acceder a la URL: HTTP ${error.status}`,
        });
        return;
      }
      if (error.code === 'DGI_QR_INVALIDO') {
        res.status(400).json({ error: 'No se pudo extraer el XML de la factura del visor DGI.' });
        return;
      }
      if (error.code === 'DGI_NO_PDF' || error.code === 'DGI_DETERIORADO') {
        res.status(400).json({
          error: error.eraHtml
            ? 'La URL abrió una página web, no un PDF. Usa OCR con captura de pantalla.'
            : 'El archivo descargado no es un PDF válido.',
        });
        return;
      }
      // DGI_HTTP sin status = fallo de red: cae al 500 genérico de abajo.
    }
    if (error.code === 'ERR_INVALID_URL') {
      res.status(400).json({ error: 'La URL proporcionada no es válida' });
      return;
    }
    console.error('[Factura URL] Error:', error);
    res.status(500).json({
      error: 'Error al procesar el PDF desde URL',
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
