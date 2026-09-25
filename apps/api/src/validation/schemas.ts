import { z } from 'zod';

// ── Helpers ──
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato esperado: YYYY-MM-DD');

// ── Accounts ──
export const createAccountSchema = z.object({
  code: z.string().min(1, 'Código requerido'),
  name: z.string().min(1, 'Nombre requerido'),
  type: z.enum(['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'GASTO', 'COSTO']),
  parentId: z.string().nullable().optional(),
  requiresAnexo: z.boolean().optional(),  // Lleva Anexo DGI
  isBlocked: z.boolean().optional(),      // Bloquear asientos
});

export const updateAccountSchema = z.object({
  name: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  requiresAnexo: z.boolean().optional(),
  isBlocked: z.boolean().optional(),
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

export const updateJournalEntrySchema = z.object({
  date: isoDate,
  description: z.string().min(1, 'Descripción requerida'),
  lines: z.array(z.object({
    accountId: z.string().min(1, 'accountId requerido'),
    debit: z.number().min(0).optional().default(0),
    credit: z.number().min(0).optional().default(0),
  })).min(2, 'Se requieren al menos 2 líneas de asiento'),
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
    reference: z.string().nullable().optional(),
    ruc: z.string().nullable().optional(),
    itbms: z.number().positive().nullable().optional(),  // impuesto por fila (neto en amount)
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

// ── Presupuestos ──
// El monto va SIEMPRE positivo (dirección natural de la cuenta); un 0 borra la celda.
export const saveBudgetsSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  items: z
    .array(
      z.object({
        accountId: z.string().min(1),
        month: z.number().int().min(1, 'Mes inválido').max(12, 'Mes inválido'),
        amount: z.number().min(0, 'El monto no puede ser negativo').max(1e12),
      }),
    )
    .min(1, 'Se requiere al menos una celda')
    .max(5000, 'Demasiadas celdas en un guardado'),
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
export type UpdateJournalEntryInput = z.infer<typeof updateJournalEntrySchema>;
export type OrchestrateInput = z.infer<typeof orchestrateSchema>;
export type OrchestrateConfirmInput = z.infer<typeof orchestrateConfirmSchema>;
export type OCRCorrectInput = z.infer<typeof ocrCorrectSchema>;
export type ImportExecuteInput = z.infer<typeof importExecuteSchema>;
export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;
export type ToggleRecurringInput = z.infer<typeof toggleRecurringSchema>;
export type ReconcileMatchInput = z.infer<typeof reconcileMatchSchema>;
export type ReconcileCreateEntryInput = z.infer<typeof reconcileCreateEntrySchema>;

// ── Facturas PDF (módulo add-on) ──
export const createFacturaSchema = z.object({
  clientId: z.string().optional(),
  clientName: z.string().min(1).optional(),
  clientTaxId: z.string().optional(),
  items: z.array(z.object({
    descripcion: z.string().min(1, 'Descripción requerida'),
    cantidad: z.number().int().min(1).default(1),
    precio: z.number().min(0, 'Precio inválido'),
    // Producto del kardex. Opcional: un servicio va sin producto, no mueve stock y
    // no genera línea de costo (ver INVENTARIO.md §3.5).
    productId: z.string().optional(),
  })).min(1, 'Se requiere al menos un item'),
  itbmsRate: z.number().min(0).max(0.2).optional(),
  date: isoDate.optional(),
  dueDate: isoDate.optional(),
  paymentMethod: z.enum(['EFECTIVO', 'CREDITO']).default('EFECTIVO'),
});

// ── Inventario ──
export const createProductoSchema = z.object({
  nombre: z.string().min(1, 'El nombre es requerido').max(200),
  sku: z.string().max(60).optional(),
  descripcion: z.string().max(500).optional(),
  unidad: z.string().max(10).optional(),
  stockMinimo: z.number().min(0).max(1e12).optional(),
  cuentaInventarioId: z.string().optional(),
  cuentaCostoId: z.string().optional(),
  // Apertura: si viene cantidad y costo, el alta deja también el movimiento inicial.
  cantidadInicial: z.number().positive('La cantidad debe ser mayor que cero').max(1e12).optional(),
  costoInicial: z.number().min(0).max(1e12).optional(),
  fechaInicial: isoDate.optional(),
});
export type CreateProductoInput = z.infer<typeof createProductoSchema>;

export const updateProductoSchema = z.object({
  nombre: z.string().min(1).max(200).optional(),
  sku: z.string().max(60).nullable().optional(),
  descripcion: z.string().max(500).nullable().optional(),
  unidad: z.string().max(10).optional(),
  stockMinimo: z.number().min(0).max(1e12).optional(),
  cuentaInventarioId: z.string().nullable().optional(),
  cuentaCostoId: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});
export type UpdateProductoInput = z.infer<typeof updateProductoSchema>;

const lineaEntradaSchema = z.object({
  productId: z.string().min(1),
  cantidad: z.number().positive('La cantidad debe ser mayor que cero').max(1e12),
  costoUnitario: z.number().min(0, 'El costo no puede ser negativo').max(1e12),
});

export const entradaInventarioSchema = z.object({
  lineas: z.array(lineaEntradaSchema).min(1, 'Se requiere al menos un producto').max(200),
  fecha: isoDate,
  paymentMethod: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'TARJETA_DEBITO', 'TARJETA_CREDITO', 'CREDITO']),
  bancoCuentaId: z.string().optional(),
  supplierId: z.string().optional(),
  referencia: z.string().max(100).optional(),
  notas: z.string().max(500).optional(),
  // Va a crédito fiscal y solo si la empresa declara ITBMS; si no, va dentro del costo.
  itbmsAmount: z.number().min(0).max(1e12).optional(),
  origen: z.enum(['COMPRA', 'APERTURA']).optional(),
  // Obligatoria en una APERTURA: contra qué cuenta se carga la existencia.
  cuentaContrapartidaId: z.string().optional(),
  dedupeKey: z.string().max(120).optional(),
});
export type EntradaInventarioInput = z.infer<typeof entradaInventarioSchema>;

export const salidaInventarioSchema = z.object({
  lineas: z.array(z.object({
    productId: z.string().min(1),
    cantidad: z.number().positive('La cantidad debe ser mayor que cero').max(1e12),
  })).min(1, 'Se requiere al menos un producto').max(200),
  fecha: isoDate,
  motivo: z.string().max(300).optional(),
  cuentaContrapartidaId: z.string().optional(),
  forzar: z.boolean().optional(),
  dedupeKey: z.string().max(120).optional(),
});
export type SalidaInventarioInput = z.infer<typeof salidaInventarioSchema>;
