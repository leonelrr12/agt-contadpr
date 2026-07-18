import { z } from 'zod';

// ── Helpers ──
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD');

// ── Accounts ──
export const createAccountSchema = z.object({
  code: z.string().min(1, 'Código requerido'),
  name: z.string().min(1, 'Nombre requerido'),
  type: z.enum(['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'COSTO']),
  parentId: z.string().nullable().optional(),
});

export const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// ── Concepts ──
export const createConceptSchema = z.object({
  name: z.string().min(1, 'Nombre del concepto requerido'),
  accountId: z.string().min(1, 'ID de cuenta requerido'),
});

export const updateConceptSchema = z.object({
  name: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

// ── Transactions ──
export const createTransactionSchema = z.object({
  type: z.enum([
    'INGRESO', 'GASTO', 'COMPRA', 'VENTA',
    'PAGO_PROVEEDOR', 'COBRO_CLIENTE', 'PRESTAMO', 'PAGO_ITBMS',
  ]),
  amount: z.number().positive('El monto debe ser positivo'),
  description: z.string().min(1, 'Descripción requerida'),
  concept: z.string().optional(),
  paymentMethod: z.enum([
    'EFECTIVO', 'TARJETA_CREDITO', 'TARJETA_DEBITO',
    'TRANSFERENCIA', 'CHEQUE', 'BANCO', 'CREDITO',
  ]).nullable().optional(),
  date: isoDate,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── Journal ──
export const createJournalEntrySchema = z.object({
  date: isoDate,
  description: z.string().min(1, 'Descripción requerida'),
  lines: z.array(z.object({
    accountId: z.string().min(1, 'accountId requerido'),
    debit: z.number().min(0).optional().default(0),
    credit: z.number().min(0).optional().default(0),
  })).min(2, 'Se requieren al menos 2 líneas de asiento'),
});

export const reviewJournalSchema = z.object({
  action: z.enum(['aprobar', 'rechazar']),
  notes: z.string().optional(),
});

export const updateJournalStatusSchema = z.object({
  status: z.enum(['BORRADOR', 'RECHAZADO']),
});

// ── Orchestrate ──
export const orchestrateSchema = z.object({
  input: z.string().min(1, 'El texto de la transacción es requerido'),
  context: z.object({
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).optional(),
    extractedData: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

export const orchestrateConfirmSchema = z.object({
  result: z.object({
    dialog: z.object({
      type: z.string(),
      amount: z.number(),
      concept: z.string(),
      date: z.string(),
      description: z.string().optional(),
      paymentMethod: z.string().nullable().optional(),
      currency: z.string().optional(),
      itbmsAmount: z.number().optional(),
      provider: z.string().nullable().optional(),
    }).passthrough(),
    entry: z.object({
      debit: z.array(z.object({
        accountId: z.string(),
        name: z.string(),
        amount: z.number(),
      })),
      credit: z.array(z.object({
        accountId: z.string(),
        name: z.string(),
        amount: z.number(),
      })),
      description: z.string(),
    }),
    classification: z.record(z.string(), z.unknown()).optional(),
    selectedEntityId: z.string().optional(),
  }),
});

// ── OCR ──
export const ocrCorrectSchema = z.object({
  rawText: z.string().min(1, 'rawText es requerido'),
  correctedText: z.string().min(1, 'correctedText es requerido'),
  total: z.number().nullable().optional(),
  date: isoDate.nullable().optional(),
  provider: z.string().nullable().optional(),
  ruc: z.string().nullable().optional(),
  itbms: z.number().nullable().optional(),
});

// ── Import ──
export const importExecuteSchema = z.object({
  rows: z.array(z.object({
    date: isoDate,
    description: z.string().min(1, 'Descripción requerida'),
    amount: z.number().positive('El monto debe ser positivo'),
    concept: z.string().optional(),
    paymentMethod: z.enum([
      'EFECTIVO', 'TARJETA_CREDITO', 'TARJETA_DEBITO',
      'TRANSFERENCIA', 'CHEQUE', 'BANCO', 'CREDITO',
    ]).nullable().optional(),
    type: z.enum([
      'INGRESO', 'GASTO', 'COMPRA', 'VENTA',
      'PAGO_PROVEEDOR', 'COBRO_CLIENTE', 'PRESTAMO', 'PAGO_ITBMS',
    ]),
    provider: z.string().nullable().optional(),
    debitAccountId: z.string().optional(),
    creditAccountId: z.string().optional(),
  })).min(1, 'Se requiere al menos una fila'),
});

// ── Recurring ──
export const createRecurringSchema = z.object({
  description: z.string().min(1, 'Descripción requerida'),
  amount: z.number().positive('El monto debe ser positivo'),
  concept: z.string().optional(),
  type: z.enum([
    'INGRESO', 'GASTO', 'COMPRA', 'VENTA',
    'PAGO_PROVEEDOR', 'COBRO_CLIENTE', 'PRESTAMO',
  ]),
  paymentMethod: z.enum([
    'EFECTIVO', 'TARJETA_CREDITO', 'TARJETA_DEBITO',
    'TRANSFERENCIA', 'CHEQUE', 'BANCO', 'CREDITO',
  ]).nullable().optional(),
  debitAccountId: z.string().optional(),
  creditAccountId: z.string().optional(),
  frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  dayOfWeek: z.number().int().min(0).max(6).optional(),
  requireConfirmation: z.boolean().optional().default(true),
});

export const updateRecurringSchema = createRecurringSchema.partial();

export const toggleRecurringSchema = z.object({
  isActive: z.boolean(),
});

// ── Reconcile ──
export const reconcileMatchSchema = z.object({
  rowId: z.string().min(1),
  entryId: z.string().nullable(), // null para desvincular
});

export const reconcileCreateEntrySchema = z.object({
  rowId: z.string().min(1),
  description: z.string().optional(),
  debitAccountId: z.string().min(1, 'Cuenta de débito requerida'),
  creditAccountId: z.string().min(1, 'Cuenta de crédito requerida'),
  amount: z.number().positive('El monto debe ser positivo'),
});

// ── Type exports ──
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type CreateConceptInput = z.infer<typeof createConceptSchema>;
export type UpdateConceptInput = z.infer<typeof updateConceptSchema>;
export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;
export type ReviewJournalInput = z.infer<typeof reviewJournalSchema>;
export type UpdateJournalStatusInput = z.infer<typeof updateJournalStatusSchema>;
export type OrchestrateInput = z.infer<typeof orchestrateSchema>;
export type OrchestrateConfirmInput = z.infer<typeof orchestrateConfirmSchema>;
export type OCRCorrectInput = z.infer<typeof ocrCorrectSchema>;
export type ImportExecuteInput = z.infer<typeof importExecuteSchema>;
export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;
export type ToggleRecurringInput = z.infer<typeof toggleRecurringSchema>;
export type ReconcileMatchInput = z.infer<typeof reconcileMatchSchema>;
export type ReconcileCreateEntryInput = z.infer<typeof reconcileCreateEntrySchema>;
