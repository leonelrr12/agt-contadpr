import type { DialogResult, DialogContext } from './types';

function parseInput(input: string): {
  amount: number;
  date: string;
  type: string;
  concept: string;
  paymentMethod: string | null;
  missingFields: string[];
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
    } else if (lower.includes('compra') && (lower.includes('inventario') || lower.includes('mercancia') || lower.includes('mercaderia'))) {
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
  } else if (lower.includes('efectivo')) {
    paymentMethod = 'EFECTIVO';
  } else if (lower.includes('banco general') || lower.includes('transferencia')) {
    paymentMethod = 'TRANSFERENCIA';
  } else if (lower.includes('cheque')) {
    paymentMethod = 'CHEQUE';
  } else if (lower.includes('debito') || lower.includes('tarjeta de debito') || lower.includes('tarjeta débito')) {
    paymentMethod = 'TARJETA_DEBITO';
  }

  if (!concept) missingFields.push('concept');
  if (amount === 0) missingFields.push('amount');
  if (!paymentMethod) missingFields.push('paymentMethod');

  return { amount, date, type, concept, paymentMethod, missingFields };
}

export class DialogAgent {
  processInput(input: string, context?: DialogContext): DialogResult {
    const fresh = parseInput(input);
    const prev = context?.extractedData;

    let type = fresh.type as DialogResult['type'];
    let amount = fresh.amount;
    let concept = fresh.concept;
    let paymentMethod = fresh.paymentMethod;
    const missingFields: string[] = [];

    if (prev) {
      if (fresh.missingFields.includes('type') && prev.type) {
        type = prev.type;
      }
      const conceptUnset = fresh.missingFields.includes('concept') || fresh.missingFields.includes('concept_category');
      const noKeywordMatch = fresh.missingFields.includes('type');
      if ((conceptUnset || noKeywordMatch) && prev.concept) {
        concept = prev.concept;
      }
      if (fresh.amount === 0 && prev.amount && prev.amount > 0) {
        amount = prev.amount;
      }
      if (fresh.missingFields.includes('paymentMethod') && prev.paymentMethod) {
        paymentMethod = prev.paymentMethod;
      }
    }

    if (!concept) missingFields.push('concept');
    if (amount === 0) missingFields.push('amount');
    if (!paymentMethod) missingFields.push('paymentMethod');

    return {
      type,
      amount,
      currency: 'USD',
      description: input,
      concept,
      paymentMethod,
      date: fresh.date,
      confidence: missingFields.length === 0 ? 0.95 : 0.6,
      missingFields,
      suggestedResponse: missingFields.length === 0
        ? `He entendido: ${type === 'VENTA' ? 'Venta' : type === 'GASTO' ? 'Gasto' : type} de ${concept} por $${amount}${paymentMethod ? ` pagado con ${paymentMethod}` : ''}. ¿Confirmas?`
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
