import { createWorker } from 'tesseract.js';

const WORKER_CACHE: { worker: any; lang: string } | null = null;

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
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  const nums = text.match(/\$?(\d[\d,]*\.\d{2})\b/g);
  if (nums) {
    const amounts = nums.map(n => parseFloat(n.replace(/[\$,]/g, ''))).filter(n => n > 0);
    if (amounts.length > 0) return Math.max(...amounts);
  }
  return null;
}

function parseProvider(text: string): string | null {
  const patterns = [
    /(?:proveedor|proveedora|empresa|raz[oó]n social|nombre)[:\s]+(.+)/i,
    /factura\s*(?:de|a|#)?[:\s]*([^\n]+)/i,
    /recibo\s*(?:de|#)?[:\s]*([^\n]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].trim().substring(0, 100);
  }
  return null;
}

function parseRUC(text: string): string | null {
  const m = text.match(/(\d{1,3}[-\/]\d{1,6}[-\/]\d{1,6})/);
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
}

export async function extractFromImage(imageBuffer: Buffer): Promise<OCRResult> {
  const worker = await createWorker('spa');

  try {
    const { data } = await worker.recognize(imageBuffer);
    const text = data.text.trim();
    const confidence = data.confidence !== undefined
      ? Math.round(data.confidence * 100) / 10000
      : 0.5;

    return {
      text,
      date: parsePanamanianDate(text),
      total: parseTotal(text),
      provider: parseProvider(text),
      ruc: parseRUC(text),
      itbms: parseITBMS(text),
      confidence: Math.min(1, Math.max(0, confidence)),
    };
  } finally {
    await worker.terminate();
  }
}
