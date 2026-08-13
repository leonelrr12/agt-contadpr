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
  source?: string | null;
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


/** Interfaz estructural mínima del PrismaClient que usan los agents.
 *  El cliente extendido (middleware de cifrado) la satisface sin problemas;
 *  los métodos devuelven any porque los datos son dinámicos por diseño. */
export interface PrismaLike {
  account: { findMany(args?: any): Promise<any[]> };
  concept: { findMany(args?: any): Promise<any[]>; upsert(args: any): Promise<any> };
  company: { findUnique(args?: any): Promise<any | null> };
  client: {
    findMany(args?: any): Promise<any[]>;
    findFirst(args?: any): Promise<any | null>;
    create(args: any): Promise<any>;
  };
  supplier: {
    findMany(args?: any): Promise<any[]>;
    findFirst(args?: any): Promise<any | null>;
    create(args: any): Promise<any>;
  };
  invoice: { findMany(args?: any): Promise<any[]>; create(args: any): Promise<any>; update(args: any): Promise<any> };
  bill: { findMany(args?: any): Promise<any[]>; create(args: any): Promise<any>; update(args: any): Promise<any> };
  journalEntry: { create(args: any): Promise<any> };
  transaction: { create(args: any): Promise<any> };
}
