export interface DialogContext {
  messages: { role: 'user' | 'assistant'; content: string }[];
  extractedData?: Partial<DialogResult>;
}

export interface DialogResult {
  type: 'INGRESO' | 'GASTO' | 'COMPRA' | 'VENTA' | 'PAGO_PROVEEDOR' | 'COBRO_CLIENTE' | 'PRESTAMO' | 'PAGO_ITBMS';
  amount: number;
  currency: string;
  description: string;
  concept: string;
  paymentMethod: string | null;
  date: string;
  confidence: number;
  missingFields: string[];
  suggestedResponse: string;
  itbms?: boolean;
  itbmsRate?: number;
  itbmsAmount?: number;
  provider: string | null;
  reference?: string | null;
  ruc?: string | null;
}

export interface AgentTask {
  task: string;
  data: Record<string, unknown>;
}

export interface AgentResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}
