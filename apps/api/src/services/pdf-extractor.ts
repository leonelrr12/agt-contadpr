import { PDFParse } from 'pdf-parse';
import OpenAI from 'openai';
import { PrismaClient } from '@agt-contador/prisma-schema';

function getLLMClient(): OpenAI | null {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: 'https://api.deepseek.com',
  });
}

async function findSimilarExamples(prisma: PrismaClient, provider?: string | null): Promise<any[]> {
  try {
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
  } catch {
    return [];
  }
}

function buildFewShotPrompt(examples: any[]): string {
  if (!examples.length) return '';
  let block = '\n\n## Ejemplos de extracciones correctas anteriores\n\n';
  for (const ex of examples) {
    block += `### Texto factura:\n${(ex.rawText || '').substring(0, 300)}\n\n`;
    block += `### Extracción corregida:\n`;
    block += `- provider: "${ex.provider || 'null'}"\n`;
    block += `- ruc: "${ex.ruc || 'null'}"\n`;
    block += `- total: ${ex.total ?? 'null'}\n`;
    block += `- date: "${ex.date || 'null'}"\n`;
    block += `- itbms: ${ex.itbms ?? 'null'}\n`;
    block += `- invoiceNumber: "${(ex as any).invoiceNumber || 'null'}"\n\n`;
  }
  return block;
}

async function extractWithLLM(
  pdfText: string,
  prisma?: PrismaClient,
  providerHint?: string | null,
): Promise<{
  provider: string | null;
  ruc: string | null;
  invoiceNumber: string | null;
  date: string | null;
  total: number | null;
  subtotal: number | null;
  itbms: number | null;
  itbmsRate: number | null;
  clientName: string | null;
  clientRuc: string | null;
} | null> {
  const client = getLLMClient();
  if (!client || !pdfText.trim()) return null;

  const today = new Date().toISOString().split('T')[0];
  let fewShotContext = '';
  if (prisma) {
    const examples = await findSimilarExamples(prisma, providerHint);
    fewShotContext = buildFewShotPrompt(examples);
  }

  try {
    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: `Eres un asistente que extrae datos de facturas electrónicas panameñas (DGI) a partir del texto extraído de un PDF.
Hoy es ${today}.

Recibes texto crudo extraído de un PDF de factura fiscal panameña. Debes extraer:

1. provider: nombre del proveedor/emisor
2. ruc: RUC del proveedor (formato ##-#####-## o similar)
3. invoiceNumber: número de factura
4. date: fecha de emisión en formato YYYY-MM-DD
5. total: monto total (número, sin $ ni comas)
6. subtotal: subtotal antes de ITBMS (número, sin $)
7. itbms: monto de ITBMS (número, sin $)
8. itbmsRate: tasa de ITBMS (número, ej: 7)
9. clientName: nombre del cliente (si aparece)
10. clientRuc: RUC del cliente (si aparece)

Si no encuentras un campo, pon null.
Responde SOLO con JSON, sin explicaciones ni markdown.${fewShotContext}`,
        },
        { role: 'user', content: pdfText.substring(0, 4000) },
      ],
      temperature: 0.05,
      max_tokens: 800,
      response_format: { type: 'json_object' },
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    return {
      provider: parsed.provider || null,
      ruc: parsed.ruc || null,
      invoiceNumber: parsed.invoiceNumber || null,
      date: parsed.date || null,
      total: typeof parsed.total === 'number' ? parsed.total : null,
      subtotal: typeof parsed.subtotal === 'number' ? parsed.subtotal : null,
      itbms: typeof parsed.itbms === 'number' ? parsed.itbms : null,
      itbmsRate: typeof parsed.itbmsRate === 'number' ? parsed.itbmsRate : null,
      clientName: parsed.clientName || null,
      clientRuc: parsed.clientRuc || null,
    };
  } catch (e) {
    console.error('[PDF LLM] Error:', e);
    return null;
  }
}

function parseDate(text: string): string | null {
  const patterns = [
    /(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*de\s*(\d{4})/i,
    /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/,
    /(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/,
    /fe[sc]ha[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i,
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
    } else if (p === patterns[1] || p === patterns[3]) {
      const d = new Date(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    } else {
      const d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return null;
}

function parseRUC(text: string): string | null {
  const m = text.match(/\b(\d{1,3}[-\/]\d{1,6}[-\/]\d{1,6})\b/);
  return m ? m[1] : null;
}

function parseProvider(text: string): string | null {
  const patterns = [
    /proveedor[:\s]+([^\n]+)/i,
    /raz[oó]n social[:\s]+([^\n]+)/i,
    /(?:^|\n)\s*emisor[:\s]+([^\n]+)/im,
    /nombre\s+(?:del\s+)?(?:proveedor|emisor|comercio)[:\s]+([^\n]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = m[1].trim().substring(0, 100);
      if (v.length > 2) return v;
    }
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.length > 5 && line.length < 80
        && /^[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(line)
        && !/factura|electr[oó]nica|ruc|fecha|cliente|subtotal|itbms|total|gracias|datos|detalle|emisor|dv|direcci[oó]n/i.test(line)) {
      return line;
    }
  }
  return null;
}

function parseInvoiceNumber(text: string): string | null {
  const patterns = [
    /factura\s*(?:n[°º]?|#|no\.?|número)?[:\s]*([A-Z]+[\-\s]?\d[\w\d\-]*)/i,
    /(?:fe|factura)[\-\s]*(\d+[\-\s]+\d+)/i,
    /serie[:\s]*([\w\d\-]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const v = (m[1] || m[0]).trim();
      if (/\d/.test(v)) return v;
    }
  }
  return null;
}

function parseTotal(text: string): number | null {
  const patterns = [
    /\btotal\b[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
    /monto[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
    /neto[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
    /pagar[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  const numRegex = /(?:^|\s)[-+]?(?:\$|b[\/. ]*)?\s*(\d[\d,]*\.\d{1,2})\b/g;
  const nums: number[] = [];
  let match;
  while ((match = numRegex.exec(text)) !== null) {
    const val = parseFloat(match[1].replace(/,/g, ''));
    if (val > 0) nums.push(val);
  }
  if (nums.length > 0) return Math.max(...nums);
  return null;
}

function parseITBMS(text: string): { amount: number | null; rate: number | null } {
  const rateMatch = text.match(/(?:itbms|iva|impuesto)[:\s]*(\d+(?:\.\d{1,2})?)\s*%/i);
  const rate = rateMatch ? parseFloat(rateMatch[1]) : null;
  const amountMatch = text.match(/(?:itbms|iva|impuesto)[:\s]*\d+(?:\.\d{1,2})?\s*%[:\s]*[^\d]*?(\d+(?:\.\d{1,2})?)/i);
  const amount = amountMatch ? parseFloat(amountMatch[1]) : null;
  return { amount, rate };
}

function parseSubtotal(text: string): number | null {
  const patterns = [
    /subtotal[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
    /base[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
    /grav[áa]ble[:\s]*[^\d]*?([\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

export interface PDFExtractResult {
  text: string;
  provider: string | null;
  ruc: string | null;
  invoiceNumber: string | null;
  date: string | null;
  total: number | null;
  subtotal: number | null;
  itbms: number | null;
  itbmsRate: number | null;
  clientName: string | null;
  clientRuc: string | null;
  confidence: number;
  source: 'pdf-parse' | 'pdf-parse+llm';
}

export async function extractFromPDF(
  pdfBuffer: Buffer,
  prisma?: PrismaClient,
): Promise<PDFExtractResult> {
  const parser = new PDFParse({ data: pdfBuffer });
  const data = await parser.getText();
  const rawText = data?.text || '';

  if (!rawText.trim()) {
    return {
      text: '',
      provider: null,
      ruc: null,
      invoiceNumber: null,
      date: null,
      total: null,
      subtotal: null,
      itbms: null,
      itbmsRate: null,
      clientName: null,
      clientRuc: null,
      confidence: 0,
      source: 'pdf-parse',
    };
  }

  const fallbackProvider = parseProvider(rawText);
  const llmResult = await extractWithLLM(rawText, prisma, fallbackProvider);

  let result: PDFExtractResult;

  if (llmResult) {
    const itbms = llmResult.itbms ?? parseITBMS(rawText).amount;
    result = {
      text: rawText.substring(0, 2000),
      provider: llmResult.provider || fallbackProvider,
      ruc: llmResult.ruc || parseRUC(rawText),
      invoiceNumber: llmResult.invoiceNumber || parseInvoiceNumber(rawText),
      date: llmResult.date || parseDate(rawText),
      total: llmResult.total ?? parseTotal(rawText),
      subtotal: llmResult.subtotal ?? parseSubtotal(rawText),
      itbms,
      itbmsRate: llmResult.itbmsRate ?? parseITBMS(rawText).rate,
      clientName: llmResult.clientName || null,
      clientRuc: llmResult.clientRuc || null,
      confidence: 0.85,
      source: 'pdf-parse+llm',
    };
  } else {
    const { amount: itbms, rate: itbmsRate } = parseITBMS(rawText);
    result = {
      text: rawText.substring(0, 2000),
      provider: fallbackProvider,
      ruc: parseRUC(rawText),
      invoiceNumber: parseInvoiceNumber(rawText),
      date: parseDate(rawText),
      total: parseTotal(rawText),
      subtotal: parseSubtotal(rawText),
      itbms,
      itbmsRate,
      clientName: null,
      clientRuc: null,
      confidence: rawText.length > 100 ? 0.6 : 0.3,
      source: 'pdf-parse',
    };
  }

  return result;
}
