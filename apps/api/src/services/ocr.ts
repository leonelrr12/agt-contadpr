import { createWorker } from 'tesseract.js';
import sharp from 'sharp';
import OpenAI from 'openai';

let workerPromise: Promise<any> | null = null;

async function getWorker(): Promise<any> {
  if (!workerPromise) {
    workerPromise = createWorker('spa', 1, {
      logger: () => {},
    });
  }
  return workerPromise;
}

function getVisionClient(): OpenAI | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.deepseek.com',
  });
}

async function preprocessImage(buffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(buffer).metadata();
  const img = sharp(buffer);

  const maxDim = 2000;
  if (metadata.width && metadata.width > maxDim) {
    img.resize({ width: maxDim });
  } else if (metadata.height && metadata.height > maxDim) {
    img.resize({ height: maxDim });
  }

  return img
    .grayscale()
    .normalise()
    .linear(1.4, -40)
    .sharpen({ sigma: 1.5, m1: 0, m2: 3, x1: 3, y2: 15, y3: 15 })
    .toBuffer();
}

async function extractWithVision(imageBuffer: Buffer): Promise<{
  text: string;
  total: number | null;
  date: string | null;
  provider: string | null;
  ruc: string | null;
  itbms: number | null;
  confidence: number;
} | null> {
  const client = getVisionClient();
  if (!client) return null;

  const b64 = imageBuffer.toString('base64');
  const dataUrl = `data:image/jpeg;base64,${b64}`;

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `Eres un extractor de datos de facturas y recibos panameños. Analiza la imagen y extrae la información en JSON.

Campos a extraer:
- text: transcripción completa del texto visible
- total: monto total (número, sin símbolo $)
- date: fecha en formato YYYY-MM-DD
- provider: nombre del proveedor o empresa
- ruc: número de RUC si aparece
- itbms: porcentaje o monto de ITBMS si aparece
- confidence: porcentaje de confianza (0-100)

Si un campo no se encuentra, usa null.
Si el texto es manuscrito, haz tu mejor esfuerzo por transcribirlo.
Responde SOLO con JSON, sin explicaciones.`,
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: dataUrl, detail: 'high' },
            },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return null;

    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return null;

    const parsed = JSON.parse(content.substring(jsonStart, jsonEnd + 1));
    return {
      text: parsed.text || '',
      total: typeof parsed.total === 'number' ? parsed.total : null,
      date: parsed.date || null,
      provider: parsed.provider || null,
      ruc: parsed.ruc || null,
      itbms: typeof parsed.itbms === 'number' ? parsed.itbms : null,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence / 100 : 0.7,
    };
  } catch (e) {
    console.error('[OCR Vision] Error:', e);
    return null;
  }
}

async function extractWithTesseract(imageBuffer: Buffer): Promise<{
  text: string;
  total: number | null;
  date: string | null;
  provider: string | null;
  ruc: string | null;
  itbms: number | null;
  confidence: number;
}> {
  const processed = await preprocessImage(imageBuffer);
  const worker = await getWorker();
  const { data } = await worker.recognize(processed);
  const text = data.text.trim();
  const confidence = data.confidence !== undefined ? data.confidence / 100 : 0;

  return {
    text,
    date: parsePanamanianDate(text),
    total: parseTotal(text),
    provider: parseProvider(text),
    ruc: parseRUC(text),
    itbms: parseITBMS(text),
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}

function parsePanamanianDate(text: string): string | null {
  const patterns = [
    /(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*de\s*(\d{4})/i,
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
  ];
  const months: Record<string, number> = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  };
  for (const p of patterns) {
    const m = text.match(p);
    if (!m) continue;
    if (p === patterns[0]) {
      const d = new Date(parseInt(m[3]), months[m[2].toLowerCase()], parseInt(m[1]));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } else if (p === patterns[1]) {
      const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } else {
      const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return null;
}

function parseTotal(text: string): number | null {
  const patterns = [
    /total[:\s]*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /monto[:\s]*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /\$?([\d,]+(?:\.\d{1,2})?)\s*(?:total|monto)/i,
    /subtotal[:\s]*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /neto[:\s]*\$?([\d,]+(?:\.\d{1,2})?)/i,
    /pagar[:\s]*\$?([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  const nums = text.match(/\$?\b(\d[\d,]*\.\d{2})\b/g);
  if (nums) {
    const amounts = nums.map(n => parseFloat(n.replace(/[\$,]/g, ''))).filter(n => n > 0);
    if (amounts.length > 0) return Math.max(...amounts);
  }
  return null;
}

function parseProvider(text: string): string | null {
  const patterns = [
    /(?:proveedor|proveedora|empresa|raz[oó]n social|nombre|cliente)[:\s]+(.+)/i,
    /factura\s*(?:de|a|#|n[°º])?[:\s]*([^\n]+)/i,
    /recibo\s*(?:de|#)?[:\s]*([^\n]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().replace(/^[:\s]+/, '').substring(0, 100);
  }
  return null;
}

function parseRUC(text: string): string | null {
  const m = text.match(/\b(\d{1,3}[-\/]\d{1,6}[-\/]\d{1,6})\b/);
  return m ? m[1] : null;
}

function parseITBMS(text: string): number | null {
  const m = text.match(/(?:itbms|iva|impuesto)[:\s]*(\d+(?:\.\d{1,2})?)\s*%/i);
  if (m) return parseFloat(m[1]);
  const m2 = text.match(/(?:itbms|iva|impuesto)[:\s]*\$?(\d+(?:\.\d{1,2})?)/i);
  if (m2) return parseFloat(m2[1]);
  return null;
}

export interface OCRResult {
  text: string;
  date: string | null;
  total: number | null;
  provider: string | null;
  ruc: string | null;
  itbms: number | null;
  confidence: number;
  source: 'vision' | 'tesseract';
}

export async function extractFromImage(imageBuffer: Buffer): Promise<OCRResult> {
  const visionResult = await extractWithVision(imageBuffer);

  if (visionResult) {
    return { ...visionResult, source: 'vision' };
  }

  const tesseractResult = await extractWithTesseract(imageBuffer);
  return { ...tesseractResult, source: 'tesseract' };
}
