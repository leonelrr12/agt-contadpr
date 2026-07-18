import type { DialogResult, DialogContext } from './types';
import { LLMService } from './llm-service';

/** Retorna true si día, mes, año forman una fecha válida y el año está en rango. */
function isValidDate(d: number, m: number, y: number): boolean {
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > 31) return false;
  const daysInMonth = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Año bisiesto
  const isLeap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const maxDay = m === 2 ? (isLeap ? 29 : 28) : daysInMonth[m - 1];
  if (d > maxDay) return false;
  return true;
}

/** Retorna true si el año está en el rango aceptable (año actual ± 1). */
function isYearInRange(y: number): boolean {
  const currentYear = new Date().getFullYear();
  return y >= currentYear - 1 && y <= currentYear + 1;
}

/** Intenta parsear una fecha de un texto. Usa lookbehind/lookahead para evitar
 *  falsos positivos con RUCs (#12345-67890 → "5-6") o números de factura. */
function tryParseDate(text: string): string | null {
  // Regex con lookbehind/lookahead: la fecha NO debe estar rodeada de dígitos
  const m = text.match(/(?<!\d)(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?(?!\d)/);
  if (!m) return null;
  const d = parseInt(m[1]);
  const month = parseInt(m[2]);
  const y = parseInt(m[3] || String(new Date().getFullYear()));
  if (!isValidDate(d, month, y)) return null;
  if (!isYearInRange(y)) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function parseInput(input: string): {
  amount: number;
  date: string | null;
  type: string;
  concept: string;
  paymentMethod: string | null;
  missingFields: string[];
  itbms: boolean;
  provider: string | null;
} {
  const lower = input.toLowerCase();

  const amountMatch = input.match(/\$?(\d+(?:[.,]\d+)?)/);
  const amount = amountMatch ? parseFloat(amountMatch[1].replace(',', '.')) : 0;

  let date: string | null = tryParseDate(input);
  if (!date && input.includes('ayer')) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    date = `${y}-${m}-${day}`;
  }
  // Si no se menciona fecha en el texto, retornamos null para que el caller use el contexto

  let type = 'GASTO';
  let concept = '';
  let paymentMethod: string | null = null;
  const missingFields: string[] = [];

  if (lower.includes('compr') || lower.includes('compra') || lower.includes('compre')) {
    type = 'GASTO';
    if (lower.includes('combustible') || lower.includes('gasolina') || lower.includes('gas')) {
      concept = 'Combustible';
    } else if (lower.includes('comida') || lower.includes('almuerzo') || lower.includes('almor')) {
      concept = 'Alimentación';
    } else if (lower.includes('luz') || lower.includes('electricidad')) {
      concept = 'Electricidad';
    } else if (lower.includes('internet')) {
      concept = 'Internet';
    } else if (lower.includes('papel') || lower.includes('oficina')) {
      concept = 'Papelería';
    } else if (lower.includes('agua')) {
      concept = 'Agua';
    } else if (lower.includes('compra') && (lower.includes('inventario') || lower.includes('mercancia') || lower.includes('mercancía') || lower.includes('mercaderia'))) {
      type = 'COMPRA';
      concept = 'Compra de mercancía';
    } else {
      const match = input.match(/compr[ée]\s+(.+?)(?:\s+por|\s+con|\s+en|\s*$)/i);
      concept = match ? match[1].trim() : input.replace(/compr[ée]\s+/i, '').trim();
      missingFields.push('concept_category');
    }
  } else if (lower.includes('vend') || lower.includes('venta') || lower.includes('factur')) {
    type = 'VENTA';
    concept = 'Ventas';
  } else if (lower.includes('itbms') || lower.includes('dgi') || (lower.includes('pago') && lower.includes('impuesto'))) {
    type = 'PAGO_ITBMS';
    concept = 'Pago de ITBMS';
  } else if (lower.includes('pag') || lower.includes('pague')) {
    type = 'GASTO';
    if (lower.includes('luz') || lower.includes('electricidad')) concept = 'Electricidad';
    else if (lower.includes('internet')) concept = 'Internet';
    else if (lower.includes('agua')) concept = 'Agua';
    else if (lower.includes('telefono') || lower.includes('celular')) concept = 'Teléfono';
    else {
      const match = input.match(/pagu[ée]\s+(.+?)(?:\s+por|\s+con|\s+en|\s*$)/i);
      concept = match ? match[1].trim() : 'Gasto Varios';
    }
  } else if (lower.includes('cobre') || lower.includes('cobr') || lower.includes('cliente')) {
    type = 'COBRO_CLIENTE';
    concept = 'Clientes';
  } else if (lower.includes('transfir') || lower.includes('transfere')) {
    type = 'GASTO';
    concept = 'Gasto Varios';
  } else {
    missingFields.push('type');
    concept = input.trim();
  }

  if (lower.includes('tarjeta') || lower.includes('tc') || lower.includes('tarjeta de credito') || lower.includes('tarjeta crédito')) {
    paymentMethod = 'TARJETA_CREDITO';
  } else if (lower.includes('credito') || lower.includes('crédito')) {
    paymentMethod = 'CREDITO';
  } else if (lower.includes('efectivo')) {
    paymentMethod = 'EFECTIVO';
  } else if (lower.includes('banco general') || lower.includes('transferencia')) {
    paymentMethod = 'TRANSFERENCIA';
  } else if (lower.includes('cheque')) {
    paymentMethod = 'CHEQUE';
  } else if (lower.includes('debito') || lower.includes('tarjeta de debito') || lower.includes('tarjeta débito')) {
    paymentMethod = 'TARJETA_DEBITO';
  }

  const itbms = lower.includes('itbms') || lower.includes('iva') || lower.includes('impuesto') || lower.includes('7%');

  let provider: string | null = null;
  // Busca patrón "a [Nombre]", "proveedor [Nombre]", "de [Nombre]" con nombre propio
  // Cubre compras (compré a X), ventas (vendí a X, cliente X), y gastos (pagué a X)
  const providerPatterns = [
    // "a Distribuidora XYZ", "proveedor XYZ", "cliente XYZ" seguido de fin o preposición
    /\b(?:a|proveedor|proveedora|cliente|de)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ]{1,58}?(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ]{0,58}){0,3}?)(?:\s+por\b|\s+con\b|\s+itbms\b|\s+iva\b|\s+crédito\b|\s+cr[eé]dito\b|\s*,\s*|\s*$)/,
    // "compré/vendí/pagué/cobré a/en X"
    /\b(?:compr[ée]|vend[ií]|pag[uü][ée]|cobr[ée])\s+(?:a|en)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ\s.,#&-]{1,58}?)(?:\s+por\b|\s+con\b|\s+itbms\b|\s*,\s*|\s*$)/i,
  ];
  for (const pattern of providerPatterns) {
    const m = input.match(pattern);
    if (m) {
      const p = m[1].trim();
      if (p.length > 1 && p.length < 60) { provider = p; break; }
    }
  }

  if (!concept) missingFields.push('concept');
  if (amount === 0) missingFields.push('amount');
  if (!paymentMethod) missingFields.push('paymentMethod');

  return { amount, date, type, concept, paymentMethod, missingFields, itbms, provider };
}

/** Detecta si el usuario mencionó explícitamente una fecha válida en el mensaje.
 *  Usa la misma lógica que tryParseDate para evitar falsos positivos con RUCs. */
function hasDateInText(input: string): boolean {
  return tryParseDate(input) !== null || /\bayer\b/i.test(input);
}

/** Retorna la fecha de hoy en YYYY-MM-DD usando la zona horaria local (no UTC). */
function todayLocal(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class DialogAgent {
  private llm: LLMService;

  constructor(apiKey?: string) {
    this.llm = new LLMService(apiKey);
  }

  async processInput(input: string, context?: DialogContext): Promise<DialogResult> {
    let extracted: {
      type: string;
      amount: number;
      concept: string;
      paymentMethod: string | null;
      date: string | null;
      missingFields: string[];
      itbms?: boolean;
      provider?: string | null;
    } | null = null;

    if (this.llm.isEnabled) {
      const llmResult = await this.llm.extract(input);
      // Solo usar resultado del LLM si type es válido (no vacío) y no está en missingFields.
      // Evita que el LLM devuelva type="" y se tome como válido.
      if (llmResult && llmResult.type && !llmResult.missingFields.includes('type')) {
        extracted = llmResult;
      }
    }

    if (!extracted) {
      extracted = parseInput(input);
    }

    const prev = context?.extractedData;

    let type = extracted.type as DialogResult['type'];
    let amount = extracted.amount;
    let concept = extracted.concept;
    let paymentMethod = extracted.paymentMethod;
    let itbms = extracted.itbms === true;
    let provider = extracted.provider || null;
    const missingFields: string[] = [];

    if (prev) {
      // Si es una respuesta corta de follow-up (método de pago), preservar TODO del contexto
      const inputLower = input.toLowerCase().trim();
      const isFollowUp = ['crédito','credito','efectivo','cash','tarjeta','tarjeta de crédito','tarjeta de debito','tarjeta crédito','tarjeta débito','transferencia','banco','cheque','yappy'].includes(inputLower);

      if (isFollowUp) {
        // Preservar completamente el tipo, concepto, monto y proveedor del contexto
        type = prev.type || type;
        concept = prev.concept || concept;
        amount = prev.amount || amount;
        provider = prev.provider || provider;
        itbms = prev.itbms || itbms;
      } else {
        // Merge normal: solo rellenar lo que falta
        if (extracted.missingFields.includes('type') && prev.type) {
          type = prev.type;
        }
        const conceptUnset = extracted.missingFields.includes('concept') || extracted.missingFields.includes('concept_category');
        const noKeywordMatch = extracted.missingFields.includes('type');
        if ((conceptUnset || noKeywordMatch) && prev.concept) {
          concept = prev.concept;
        }
        if (extracted.amount === 0 && prev.amount && prev.amount > 0) {
          amount = prev.amount;
        }
        if (!extracted.itbms && prev.itbms) {
          itbms = prev.itbms;
        }
        if (!extracted.provider && prev.provider) {
          provider = prev.provider;
        }
      }
      if (prev?.paymentMethod) {
        paymentMethod = prev.paymentMethod;
      }
    }

    // Safety: si después del merge type/concept siguen vacíos, rellenar de prev
    if (!type && prev?.type) type = prev.type;
    if (!concept && prev?.concept) concept = prev.concept;

    if (!concept) missingFields.push('concept');
    if (amount === 0) missingFields.push('amount');
    if (!paymentMethod) missingFields.push('paymentMethod');

    const itbmsRate = itbms ? (parseFloat(process.env.ITBMS_RATE || '') || 0.07) : undefined;
    const itbmsAmount = itbms && (type === 'COMPRA' || type === 'VENTA')
      ? Math.round(amount * itbmsRate! * 100) / 100
      : undefined;

    return {
      type,
      amount,
      currency: 'USD',
      description: input,
      concept,
      paymentMethod,
      date: (() => {
        const hasDate = hasDateInText(input);
        const extDate = extracted?.date ?? null;
        const prevDate = prev?.date ?? null;
        const prevDateValid = prevDate && (() => {
          const parts = prevDate.split('-').map(Number);
          return parts.length === 3 && isYearInRange(parts[0]);
        })() ? prevDate : null;
        const fallback = todayLocal();
        return hasDate ? (extDate || fallback) : (prevDateValid || fallback);
      })(),
      confidence: missingFields.length === 0 ? (this.llm.isEnabled ? 0.98 : 0.95) : 0.6,
      missingFields,
      itbms,
      itbmsRate,
      itbmsAmount,
      provider,
      ruc: (prev as any)?.ruc || (extracted as any).ruc || null,
      suggestedResponse: missingFields.length === 0
        ? `He entendido: ${type === 'VENTA' ? 'Venta' : type === 'GASTO' ? 'Gasto' : type} de ${concept} por $${amount}${paymentMethod ? ` pagado con ${paymentMethod}` : ''}${itbms ? ` (ITBMS ${(itbmsRate! * 100).toFixed(0)}% incluido)` : ''}. ¿Confirmas?`
        : `Necesito más información: ${missingFields.join(', ')}`,
    };
  }

  buildPrompt(pendingInfo: string[]): string {
    if (pendingInfo.includes('amount')) return '¿Cuánto fue el monto?';
    if (pendingInfo.includes('concept') || pendingInfo.includes('concept_category')) return '¿A qué categoría pertenece?';
    if (pendingInfo.includes('paymentMethod')) return '¿Cómo se pagó? (Efectivo, Tarjeta, Banco, Transferencia)';
    if (pendingInfo.includes('type')) return '¿Qué tipo de transacción es? (Gasto, Venta, Compra)';
    return '¿Podrías darme más detalles?';
  }
}
