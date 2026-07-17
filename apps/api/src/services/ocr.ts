import { createWorker, OEM, PSM } from 'tesseract.js';
import sharp from 'sharp';
import OpenAI from 'openai';
import { PrismaClient } from '@agt-contador/prisma-schema';

let workers: { worker: any; psm: any }[] | null = null;
let lastUsed = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos de inactividad → liberar workers

function getLLMClient(): OpenAI | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.deepseek.com',
  });
}

async function getWorkers(): Promise<{ worker: any; psm: number }[]> {
  if (!workers) {
    workers = await Promise.all(
      [PSM.AUTO, PSM.SINGLE_COLUMN, PSM.SINGLE_BLOCK].map(async (psm) => {
        const worker = await createWorker('spa', OEM.LSTM_ONLY);
        await worker.setParameters({
          tessedit_pageseg_mode: psm,
          tessedit_char_whitelist: '',
        });
        return { worker, psm };
      }),
    );
    console.log(`[OCR] ${workers.length} Tesseract workers inicializados`);
  }
  // Marcar actividad y posponer terminación por inactividad
  lastUsed = Date.now();
  scheduleIdleTermination();
  return workers;
}

/** Programa la terminación de workers tras IDLE_TIMEOUT_MS de inactividad */
function scheduleIdleTermination(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const idle = Date.now() - lastUsed;
    if (idle >= IDLE_TIMEOUT_MS && workers) {
      terminateWorkers().catch(() => {});
    }
  }, IDLE_TIMEOUT_MS);
}

/** Libera todos los workers de Tesseract explícitamente */
export async function terminateWorkers(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (!workers) return;

  const count = workers.length;
  await Promise.all(workers.map(w => w.worker.terminate().catch(() => {})));
  workers = null;
  console.log(`[OCR] ${count} Tesseract workers liberados (memoria recuperada)`);
}

// Liberar workers en shutdown del proceso (solo una vez)
let shutdownRegistered = false;
if (!shutdownRegistered) {
  shutdownRegistered = true;
  const cleanup = () => { terminateWorkers().catch(() => {}); };
  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
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
    .linear(1.5, -50)
    .sharpen({ sigma: 2, m1: 0, m2: 4, x1: 4, y2: 20, y3: 20 })
    .toBuffer();
}

async function findSimilarExamples(prisma: PrismaClient, provider?: string | null): Promise<any[]> {
  if (!provider) {
    return prisma.oCRExample.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      where: { provider: { not: null } },
    });
  }

  const exact = await prisma.oCRExample.findMany({
    where: { provider: { equals: provider, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  if (exact.length >= 3) return exact;

  return prisma.oCRExample.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5 - exact.length,
    where: { provider: { not: null } },
  });
}

function buildFewShotPrompt(examples: any[]): string {
  if (!examples.length) return '';

  let block = '\n\n## Ejemplos de extracciones correctas anteriores\n\n';
  for (const ex of examples) {
    block += `### OCR raw:\n${ex.rawText.substring(0, 300)}\n\n`;
    block += `### Extracción corregida:\n`;
    block += `- text: "${ex.correctedText || ex.rawText.substring(0, 100)}"\n`;
    block += `- total: ${ex.total ?? 'null'}\n`;
    block += `- date: "${ex.date || 'null'}"\n`;
    block += `- provider: "${ex.provider || 'null'}"\n`;
    block += `- ruc: "${ex.ruc || 'null'}"\n`;
    block += `- itbms: ${ex.itbms ?? 'null'}\n\n`;
  }
  return block;
}

async function extractWithLLM(
  rawText: string,
  prisma?: PrismaClient,
): Promise<{
  text: string;
  total: number | null;
  date: string | null;
  provider: string | null;
  ruc: string | null;
  itbms: number | null;
} | null> {
  const client = getLLMClient();
  if (!client || !rawText.trim()) return null;

  const today = new Date().toISOString().split('T')[0];

  let fewShotContext = '';
  if (prisma) {
    const examples = await findSimilarExamples(prisma);
    fewShotContext = buildFewShotPrompt(examples);
  }

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente que extrae datos de facturas y recibos panameños a partir del texto de OCR.

Hoy es ${today}.

Recibes texto crudo de OCR (puede tener errores). Debes limpiarlo y extraer:

1. text: el texto limpio, corrigiendo errores obvios de OCR
2. total: monto total (número, sin $)
3. date: fecha en formato YYYY-MM-DD
4. provider: nombre del proveedor o empresa
5. ruc: número de RUC (formato ##-#####-##)
6. itbms: monto o tasa de ITBMS (número, sin %)

Si no encuentras un campo, pon null.
Responde SOLO con JSON, sin explicaciones ni markdown.${fewShotContext}`,
        },
        { role: 'user', content: rawText.substring(0, 2000) },
      ],
      temperature: 0.05,
      max_tokens: 500,
      response_format: { type: 'json_object' },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    return {
      text: parsed.text || rawText,
      total: typeof parsed.total === 'number' ? parsed.total : null,
      date: parsed.date || null,
      provider: parsed.provider || null,
      ruc: parsed.ruc || null,
      itbms: typeof parsed.itbms === 'number' ? parsed.itbms : null,
    };
  } catch (e) {
    console.error('[OCR LLM] Error:', e);
    return null;
  }
}

async function runTesseract(imageBuffer: Buffer): Promise<string> {
  const processed = await preprocessImage(imageBuffer);
  const allWorkers = await getWorkers();
  let bestText = '';
  let bestConfidence = 0;

  for (const { worker, psm } of allWorkers) {
    const { data } = await worker.recognize(processed);
    const conf = data.confidence ?? 0;
    if (conf > bestConfidence && data.text.trim().length > bestText.length) {
      bestConfidence = conf;
      bestText = data.text.trim();
    }
  }

  return bestText;
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
  source: 'tesseract' | 'tesseract+llm';
}

export async function extractFromImage(
  imageBuffer: Buffer,
  prisma?: PrismaClient,
): Promise<OCRResult> {
  const rawText = await runTesseract(imageBuffer);
  const confidence = rawText.length > 50 ? 0.6 : 0.3;

  const llmResult = await extractWithLLM(rawText, prisma);

  let result: OCRResult;

  if (llmResult) {
    result = {
      text: llmResult.text || rawText,
      date: llmResult.date || parsePanamanianDate(rawText),
      total: llmResult.total ?? parseTotal(rawText),
      provider: llmResult.provider || parseProvider(rawText),
      ruc: llmResult.ruc || parseRUC(rawText),
      itbms: llmResult.itbms ?? parseITBMS(rawText),
      confidence: 0.85,
      source: 'tesseract+llm',
    };
  } else {
    result = {
      text: rawText,
      date: parsePanamanianDate(rawText),
      total: parseTotal(rawText),
      provider: parseProvider(rawText),
      ruc: parseRUC(rawText),
      itbms: parseITBMS(rawText),
      confidence,
      source: 'tesseract',
    };
  }

  if (prisma) {
    try {
      await prisma.oCRExample.create({
        data: {
          rawText: rawText.substring(0, 5000),
          correctedText: result.text.substring(0, 500),
          total: result.total,
          date: result.date,
          provider: result.provider,
          ruc: result.ruc,
          itbms: result.itbms,
          confidence: result.confidence,
          source: result.source,
        },
      });
    } catch (e) {
      console.error('[OCR] Error saving example:', e);
    }
  }

  return result;
}

export async function saveCorrection(
  prisma: PrismaClient,
  data: {
    rawText: string;
    correctedText: string;
    total?: number | null;
    date?: string | null;
    provider?: string | null;
    ruc?: string | null;
    itbms?: number | null;
  },
) {
  return prisma.oCRExample.create({
    data: {
      rawText: data.rawText.substring(0, 5000),
      correctedText: data.correctedText?.substring(0, 500) || null,
      total: data.total ?? null,
      date: data.date || null,
      provider: data.provider || null,
      ruc: data.ruc || null,
      itbms: data.itbms ?? null,
      confidence: 0.95,
      source: 'user_correction',
    },
  });
}
