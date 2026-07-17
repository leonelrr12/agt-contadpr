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

facturaRouter.post('/extract-url', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    res.status(400).json({ error: 'URL del PDF es requerida' });
    return;
  }

  try {
    // Validar que sea una URL válida
    new URL(url);

    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });

    if (!response.ok) {
      res.status(400).json({ error: `No se pudo acceder a la URL: HTTP ${response.status}` });
      return;
    }

    let buffer = Buffer.from(await response.arrayBuffer());
    const header = buffer.slice(0, 15).toString();

    // Detectar si es visor web DGI (FacturasPorQR) → extraer facturaXML y descargar PDF real
    if (header.startsWith('<!DOCTYPE') || header.startsWith('<html')) {
      const html = buffer.toString();

      if (html.includes('facturaXML') && html.includes('DescargarFacturaPDF')) {
        const match = html.match(/id="facturaXML"[^>]*value="([^"]*)"/);
        if (!match || !match[1]) {
          res.status(400).json({ error: 'No se pudo extraer el XML de la factura del visor DGI.' });
          return;
        }
        const facturaXML = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

        const baseUrl = new URL(url);
        const descargarUrl = `${baseUrl.protocol}//${baseUrl.host}/Consultas/DescargarFacturaPDF`;

        const pdfResponse = await fetch(descargarUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': url,
          },
          body: `facturaXML=${encodeURIComponent(facturaXML)}`,
          signal: AbortSignal.timeout(30000),
        });

        if (!pdfResponse.ok) {
          res.status(400).json({ error: `No se pudo descargar el PDF de la DGI: HTTP ${pdfResponse.status}` });
          return;
        }

        buffer = Buffer.from(await pdfResponse.arrayBuffer());
      } else {
        res.status(400).json({ error: 'La URL abrió una página web, no un PDF. Usa OCR con captura de pantalla.' });
        return;
      }
    }

    // Verificar que sea un PDF válido (magic bytes %PDF)
    const pdfHeader = buffer.slice(0, 5).toString();
    if (!pdfHeader.startsWith('%PDF')) {
      res.status(400).json({ error: 'El archivo descargado no es un PDF válido.' });
      return;
    }

    const result = await extractFromPDF(buffer, req.prisma);
    res.json(result);
  } catch (error: any) {
    if (error.code === 'ERR_INVALID_URL') {
      res.status(400).json({ error: 'La URL proporcionada no es válida' });
      return;
    }
    if (error.name === 'TimeoutError' || error.code === 'ABORT_ERR') {
      res.status(504).json({ error: 'Tiempo de espera agotado al descargar el PDF (30s)' });
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
