import type { DialogResult, DialogContext } from './types';
import { LLMService } from './llm-service';

function parseInput(input: string): {
  amount: number;
  date: string;
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

  const dateMatch = input.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  let date: string;
  if (dateMatch) {
    const d = new Date(parseInt(dateMatch[3] || String(new Date().getFullYear())), parseInt(dateMatch[2]) - 1, parseInt(dateMatch[1]));
    date = d.toISOString().split('T')[0];
  } else if (input.includes('ayer')) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    date = d.toISOString().split('T')[0];
  } else {
    date = new Date().toISOString().split('T')[0];
  }

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
      date: string;
      missingFields: string[];
      itbms?: boolean;
      provider?: string | null;
    } | null = null;

    if (this.llm.isEnabled) {
      const llmResult = await this.llm.extract(input);
      if (llmResult && !llmResult.missingFields.includes('type')) {
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
      date: extracted.date || new Date().toISOString().split('T')[0],
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
