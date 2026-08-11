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
  // DGI format: "Fecha de Emisión: 19/06/2026"
  const dgiMatch = text.match(/Fecha\s*de\s*Emisi[oó]n[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
  if (dgiMatch) {
    const d = new Date(parseInt(dgiMatch[3]), parseInt(dgiMatch[2]) - 1, parseInt(dgiMatch[1]));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  // Generic patterns (avoid matching RUC numbers like 356-19-77860)
  const generic = text.match(/(?<!\d)(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?!\d)/);
  if (generic) {
    const y = parseInt(generic[3]);
    const m = parseInt(generic[2]);
    const d = parseInt(generic[1]);
    if (y >= 2020 && y <= 2030 && m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const date = new Date(y, m - 1, d);
      if (!isNaN(date.getTime())) return date.toISOString().split('T')[0];
    }
  }
  // Spanish month name
  const months: Record<string, number> = {
    enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
    julio: 6, agosto: 7, septiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  };
  const spanish = text.match(/(\d{1,2})\s*de\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s*de\s*(\d{4})/i);
  if (spanish) {
    const d = new Date(parseInt(spanish[3]), months[spanish[2].toLowerCase()], parseInt(spanish[1]));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  return null;
}

function parseRUC(text: string): string | null {
  // DGI: "RUC: 356-19-77860"
  const dgiMatch = text.match(/(?:RUC|RUC\/C[eé]dula)[:\s]+(\d{1,3}[-\/]\d{1,6}[-\/]\d{1,6})/i);
  if (dgiMatch) return dgiMatch[1];
  // Generic RUC pattern (with word boundaries to avoid matching dates)
  const m = text.match(/\b(\d{1,4}-\d{1,6}-\d{1,10})\b/);
  return m ? m[1] : null;
}

function parseProvider(text: string): string | null {
  // DGI: "Emisor: SUPERMERCADOS XTRA, S.A."
  const emisorMatch = text.match(/Emisor[:\s]+([^\n]+)/i);
  if (emisorMatch) return emisorMatch[1].trim().substring(0, 100);
  // Fallback
  const m = text.match(/(?:proveedor|raz[oó]n social)[:\s]+([^\n]+)/i);
  if (m) return m[1].trim().substring(0, 100);
  return null;
}

function parseInvoiceNumber(text: string): string | null {
  // DGI: "Número: 0000221106"
  const dgiMatch = text.match(/N[uú]mero[:\s]+(\d+)/i);
  if (dgiMatch) return dgiMatch[1];
  // Generic
  const m = text.match(/[Ff]actura\s*(?:n[°º]?|#|No\.?)?[:\s]*([A-Z]?[\d][\w\d\-]*)/i);
  if (m) return m[1].trim();
  // "Punto de Facturación: 003 Protocolo de autorización: 20260000000937125743"
  const protoMatch = text.match(/Protocolo de autorizaci[oó]n[:\s]*PAC[:\s]*(\d+)/i);
  if (protoMatch) return protoMatch[1];
  return null;
}

function parseTotal(text: string): number | null {
  // DGI: buscar el ÚLTIMO "Total X.XX" (el final, no el del desglose ITBMS)
  const totalMatches = text.match(/^Total\s+([\d,]+\.?\d*)\s*$/gim);
  if (totalMatches && totalMatches.length > 0) {
    // Tomar el último Total (es el total real después del desglose)
    const last = totalMatches[totalMatches.length - 1];
    const m = last.match(/([\d,]+\.?\d*)/);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  // "Valor Total X.XX" o "Total Neto X.XX"
  const valorMatch = text.match(/Valor\s*Total\s+([\d,]+\.?\d*)/i)
    || text.match(/Total\s*Neto\s+([\d,]+\.?\d*)/i)
    || text.match(/TOTAL\s*PAGADO\s+([\d,]+\.?\d*)/i);
  if (valorMatch) return parseFloat(valorMatch[1].replace(/,/g, ''));
  // Fallback: último número con formato moneda
  const amounts = [...text.matchAll(/\b(\d[\d,]*\.\d{2})\b/g)].map(m => parseFloat(m[1].replace(/,/g, ''))).filter(n => n > 0);
  if (amounts.length > 0) return amounts[amounts.length - 1]; // último monto
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

  // Fallback: calcular ITBMS = total - subtotal si no se detectó
  if (result.itbms == null && result.total != null && result.subtotal != null && result.total > result.subtotal) {
    result.itbms = Math.round((result.total - result.subtotal) * 100) / 100;
  }

  return result;
}
