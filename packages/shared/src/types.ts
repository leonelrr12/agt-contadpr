export enum AccountType {
  ACTIVO = 'ACTIVO',
  PASIVO = 'PASIVO',
  PATRIMONIO = 'PATRIMONIO',
  INGRESO = 'INGRESO',
  GASTO = 'GASTO',
  COSTO = 'COSTO',
}

export enum TransactionType {
  INGRESO = 'INGRESO',
  GASTO = 'GASTO',
  COMPRA = 'COMPRA',
  VENTA = 'VENTA',
  PAGO_PROVEEDOR = 'PAGO_PROVEEDOR',
  COBRO_CLIENTE = 'COBRO_CLIENTE',
  PRESTAMO = 'PRESTAMO',
  INTERES = 'INTERES',
  ACTIVO = 'ACTIVO',
  DEPRECIACION = 'DEPRECIACION',
}

export enum PaymentMethod {
  EFECTIVO = 'EFECTIVO',
  TARJETA_CREDITO = 'TARJETA_CREDITO',
  TARJETA_DEBITO = 'TARJETA_DEBITO',
  TRANSFERENCIA = 'TRANSFERENCIA',
  CHEQUE = 'CHEQUE',
  BANCO = 'BANCO',
}

export enum JournalEntryStatus {
  BORRADOR = 'BORRADOR',
  CONFIRMADO = 'CONFIRMADO',
  ANULADO = 'ANULADO',
}

export interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface JournalLine {
  id: string;
  journalEntryId: string;
  accountId: string;
  account?: Account;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  id: string;
  date: Date;
  description: string;
  status: JournalEntryStatus;
  lines: JournalLine[];
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Concept {
  id: string;
  name: string;
  accountId: string;
  account?: Account;
  confidence: number;
  isActive: boolean;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  amount: number;
  currency: string;
  description: string;
  concept: string;
  paymentMethod: PaymentMethod | null;
  date: Date;
  metadata: Record<string, unknown>;
  companyId: string;
  createdById: string;
}

export interface ClassificationResult {
  concept: string;
  accountId: string;
  confidence: number;
}

export interface AccountingRule {
  id: string;
  name: string;
  condition: Record<string, unknown>;
  entries: AccountingRuleEntry[];
}

export interface AccountingRuleEntry {
  accountId: string;
  type: 'DEBIT' | 'CREDIT';
}
