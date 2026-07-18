import OpenAI from 'openai';

export interface LLMExtraction {
  type: string;
  amount: number;
  concept: string;
  paymentMethod: string | null;
  date: string | null;
  missingFields: string[];
  itbms?: boolean;
  provider?: string | null;
}

const EXTRACTION_SYSTEM_PROMPT = (today: string) => `Eres un extractor de datos contables. Hoy es ${today}. Analiza el texto del usuario y extrae la información estructurada de la transacción.

Tipos de transacción válidos: INGRESO, GASTO, COMPRA, VENTA, PAGO_PROVEEDOR, COBRO_CLIENTE, PRESTAMO

Métodos de pago válidos (opcional): EFECTIVO, TARJETA_CREDITO, TARJETA_DEBITO, TRANSFERENCIA, CHEQUE, BANCO, CREDITO
- "tarjeta de crédito", "tarjeta", "tc" → TARJETA_CREDITO
- "crédito" (sin "tarjeta") → CREDITO (crédito con proveedor, no tarjeta)
IMPORTANTE: NO inventes ni infieras el método de pago. Si el texto no menciona EXPLÍCITAMENTE cómo se pagó, pon paymentMethod como null.

Reglas:
- Si el texto menciona "compré", "compre", "gasto" → type: GASTO
- Si menciona "vendí", "venta", "facturé", "cobré" → type: VENTA
  - Si menciona "cobro", "cobre", "me pagaron", "recibi pago", "abono" CON nombre de persona/empresa → type: COBRO_CLIENTE
- Si menciona "pago a proveedor", "pagué a", "pague a", "aboné a" CON nombre de empresa → type: PAGO_PROVEEDOR
- Si menciona "compra de mercancía", "inventario" → type: COMPRA
- Si menciona "préstamo", "prestamo", "prstamo" → type: PRESTAMO
  - Si menciona "ingreso", "deposito", "abono bancario", "recibi" SIN nombre de persona/empresa → type: INGRESO

	IMPORTANTE — Cómo distinguir GASTO vs PAGO_PROVEEDOR:
	- "Pagué electricidad $50" → GASTO (no menciona a quién, es un gasto nuevo)
	- "Pagué $100 a IMPORTADORA RICAMAR" → PAGO_PROVEEDOR (menciona a quién, es pagar una deuda)
	- "Pagué a Distribuidora ABC $200" → PAGO_PROVEEDOR
	- "Compré gasolina $30" → GASTO
- Si menciona "itbms", "pago de itbms", "declaración itbms", "dgi" → type: PAGO_ITBMS

	IMPORTANTE para distinguir COBRO_CLIENTE vs INGRESO:
	- "Abono Clinica San Jose $150" → COBRO_CLIENTE (tiene nombre de cliente, reduce cuenta por cobrar)
	- "Abono bancario $150" o "Deposito $150" → INGRESO (no tiene cliente, es ingreso general)
	- "Me pagaron Los Gonzalez $200" → COBRO_CLIENTE
	- "Recibi $100 de dividendos" → INGRESO

ITBMS: Si la transacción menciona "itbms", "iva", "impuesto", "7%" o "incluye itbms", añade "itbms": true en el JSON. Para compras de inventario y ventas, detecta si el monto incluye o excluye ITBMS.

Conceptos comunes:
- "combustible", "gasolina", "gas" → Combustible
- "electricidad", "luz" → Electricidad
- "internet" → Internet
- "teléfono", "celular" → Teléfono
- "agua" → Agua
- "papelería", "oficina", "útiles" → Papelería
- "alimentación", "comida", "almuerzo" → Alimentación
- "alquiler", "renta" → Alquiler
- "seguro" → Seguros
- "publicidad", "marketing" → Publicidad
- "combustible" (si type=Venta) → Venta de combustible

Para el concepto, usa el nombre más específico posible. Si no reconoces el concepto exacto,
usa el término que el usuario mencionó (ej: "hosting", "dominio", "fletes").

Proveedor/Cliente: Extrae el nombre del proveedor o cliente SIEMPRE que el texto mencione a quién se compró, a quién se vendió, a quién se pagó, o de quién se cobró. Usa el campo "provider" para el nombre.
  Ejemplos:
  - "compré a Distribuidora XYZ" → provider: "Distribuidora XYZ"
  - "vendí a Clínica San José" → provider: "Clínica San José"
  - "pagué a Cable & Wireless" → provider: "Cable & Wireless"
  - "cobré a Inmobiliaria del Este" → provider: "Inmobiliaria del Este"
  - "compré en Supermercado Rey" → provider: "Supermercado Rey"
  - "servicios a Juan Pérez" → provider: "Juan Pérez"
  NO importa si es compra, venta, gasto o cobro. SIEMPRE extrae el nombre si hay una entidad externa mencionada. Si el texto no menciona ninguna entidad externa, pon null.

Moneda: Siempre USD. La fecha debe estar en formato YYYY-MM-DD.
Hoy es ${today}. Si no se menciona fecha, usa ${today}. Si se menciona "ayer", usa el día anterior a ${today}. Si se menciona "anteayer", usa dos días antes de ${today}.

Responde SOLO con un JSON válido con esta estructura:
{
  "type": "tipo de transacción",
  "amount": número (sin símbolos),
  "concept": "nombre del concepto",
  "paymentMethod": "método de pago o null",
  "date": "YYYY-MM-DD (hoy es ${today})",
  "missingFields": ["lista de campos faltantes - solo si no se pudo determinar"],
  "itbms": true|false,
  "provider": "nombre del proveedor o null"
}

Campos opcionales: paymentMethod. Si no se menciona, ponlo como null.
Si el monto no se encuentra, pon amount: 0 y añade "amount" a missingFields.
Si el concepto no se puede determinar, pon concept: "" y añade "concept".`;

export class LLMService {
  private client: OpenAI | null = null;
  private enabled: boolean;

  constructor(apiKey: string | undefined) {
    this.enabled = !!apiKey;
    if (apiKey) {
      this.client = new OpenAI({
        apiKey,
        baseURL: 'https://api.deepseek.com',
      });
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  async extract(input: string): Promise<LLMExtraction | null> {
    if (!this.client || !this.enabled) return null;

    try {
      const today = new Date().toISOString().split('T')[0];
      const response = await this.client.chat.completions.create({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT(today) },
          { role: 'user', content: input },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 300,
      });

      const content = response.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed = JSON.parse(content) as LLMExtraction;
      return {
        type: parsed.type || '',
        amount: typeof parsed.amount === 'number' ? parsed.amount : 0,
        concept: parsed.concept || '',
        paymentMethod: parsed.paymentMethod || null,
        date: parsed.date || null as any,
        missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields : [],
        itbms: parsed.itbms === true,
        provider: parsed.provider || null,
      };
    } catch (error: any) {
      console.error('[LLM] Extraction error:', error?.message || error);
      return null;
    }
  }
}
