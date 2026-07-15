import { DialogAgent } from './dialog-agent';
import { ClassificationAgent, type ClassificationAgentConfig } from './classification-agent';
import { AccountingAgent } from './accounting-agent';
import type { DialogResult, DialogContext } from './types';
import type { AccountingEntry } from './accounting-agent';

export interface PlanStep {
  agent: string;
  action: string;
  status: 'pending' | 'completed' | 'failed';
  result?: Record<string, unknown>;
  error?: string;
}

export interface ExecutionPlan {
  steps: PlanStep[];
  dialog: DialogResult;
  classification?: any;
  entry?: AccountingEntry;
}

export class OrchestratorAgent {
  private dialogAgent: DialogAgent;
  private classificationAgent: ClassificationAgent;
  private accountingAgent: AccountingAgent;
  private prisma: any;
  private companyId: string;
  private userId: string;

  constructor(config: ClassificationAgentConfig & { userId?: string }) {
    this.dialogAgent = new DialogAgent(config.deepseekApiKey);
    this.classificationAgent = new ClassificationAgent(config);
    this.accountingAgent = new AccountingAgent(config.prisma, config.companyId);
    this.prisma = config.prisma;
    this.companyId = config.companyId;
    this.userId = config.userId || 'demo-user';
  }

  async process(input: string, context?: DialogContext): Promise<{
    plan: ExecutionPlan;
    prompt?: string;
    needsConfirmation: boolean;
    result?: any;
  }> {
    const dialog = await this.dialogAgent.processInput(input, context);
    const plan: ExecutionPlan = {
      steps: [
        { agent: 'dialogo', action: 'extraer_informacion', status: 'completed', result: dialog as any },
      ],
      dialog,
    };

    if (dialog.missingFields.length > 0) {
      const prompt = this.dialogAgent.buildPrompt(dialog.missingFields);
      return { plan, prompt, needsConfirmation: false };
    }

    const classification = await this.classificationAgent.classify(dialog.concept, dialog.type);
    plan.steps.push({
      agent: 'clasificacion',
      action: 'clasificar_concepto',
      status: 'completed',
      result: classification as any,
    });
    plan.classification = classification;

    if (classification.confidence < 0.5) {
      return {
        plan,
        prompt: `No reconozco el concepto "${dialog.concept}". ¿Podrías clasificarlo manualmente?`,
        needsConfirmation: false,
      };
    }

    await this.accountingAgent.init();
    const raw = this.accountingAgent.generateEntry(dialog, classification);
    const entry: AccountingEntry = {
      debit: raw.debit.map((d: any) => ({ ...d, accountId: this.accountingAgent.resolveAlias(d.accountId) })),
      credit: raw.credit.map((c: any) => ({ ...c, accountId: this.accountingAgent.resolveAlias(c.accountId) })),
      description: raw.description,
    };
    const validation = this.accountingAgent.validateEntry(entry);
    plan.steps.push({
      agent: 'contable',
      action: 'generar_asiento',
      status: validation.valid ? 'completed' : 'failed',
      result: entry as any,
      error: validation.error,
    });
    plan.entry = entry;

    if (!validation.valid) {
      return { plan, prompt: `Error contable: ${validation.error}`, needsConfirmation: false };
    }

    const typeLabels: Record<string, string> = {
      VENTA: 'Venta', GASTO: 'Gasto', COMPRA: 'Compra',
      INGRESO: 'Ingreso', PRESTAMO: 'Préstamo',
      COBRO_CLIENTE: 'Cobro', PAGO_PROVEEDOR: 'Pago Proveedor',
      PAGO_ITBMS: 'Pago ITBMS',
    };
    const summaryParts = [
      `**${typeLabels[dialog.type] || dialog.type}**: ${dialog.concept} por **$${dialog.amount}**${dialog.itbmsAmount ? ` (+ ITBMS $${dialog.itbmsAmount})` : ''}`,
    ];
    if (dialog.provider) summaryParts.push(`Proveedor: **${dialog.provider}**`);
    if (dialog.paymentMethod) summaryParts.push(`Pago con: **${dialog.paymentMethod}**`);
    summaryParts.push('');
    summaryParts.push('**Asiento contable:**');
    for (const d of entry.debit) summaryParts.push(`  Débito: ${d.name} — $${d.amount}`);
    for (const c of entry.credit) summaryParts.push(`  Crédito: ${c.name} — $${c.amount}`);

    return {
      plan,
      prompt: summaryParts.join('\n'),
      needsConfirmation: true,
      result: { dialog, classification, entry },
    };
  }

  async confirm(result: any): Promise<{ journalEntry: any }> {
    const { dialog, entry } = result;
    const entryData = await this.prisma.journalEntry.create({
      data: {
        date: new Date(dialog.date),
        description: entry.description,
        status: 'BORRADOR',
        companyId: this.companyId,
        createdById: this.userId,
        lines: {
          create: [
            ...entry.debit.map((d: any) => ({ accountId: d.accountId, debit: d.amount, credit: 0 })),
            ...entry.credit.map((c: any) => ({ accountId: c.accountId, debit: 0, credit: c.amount })),
          ],
        },
      },
      include: { lines: { include: { account: true } } },
    });

    const metadata: Record<string, unknown> = {};
    if (dialog.provider) metadata.provider = dialog.provider;

    await this.prisma.transaction.create({
      data: {
        type: dialog.type, amount: dialog.amount, description: dialog.description,
        concept: dialog.concept, paymentMethod: dialog.paymentMethod,
        date: new Date(dialog.date), companyId: this.companyId,
        createdById: this.userId, journalEntryId: entryData.id,
        metadata: JSON.stringify(metadata),
      },
    });

    // ── Auto-crear cliente o proveedor si aplica ──
    let autoCreated: { type: string; name: string } | null = null;
    if (dialog.provider) {
      autoCreated = await this.autoCreateEntity(dialog, entryData.id);
    }

    return { journalEntry: entryData, autoCreated };
  }

  /**
   * Auto-crea un Client o Supplier según el tipo de transacción.
   * Si ya existe, lo reutiliza. Crea la factura/cuenta por pagar automáticamente.
   */
  private async autoCreateEntity(dialog: any, journalEntryId: string): Promise<{ type: string; name: string } | null> {
    const name = dialog.provider?.trim();
    if (!name) return null;

    const isCustomer = dialog.type === 'VENTA' || dialog.type === 'COBRO_CLIENTE';
    const isSupplier = dialog.type === 'GASTO' || dialog.type === 'COMPRA' || dialog.type === 'PAGO_PROVEEDOR';
    const isPayment = dialog.type === 'COBRO_CLIENTE' || dialog.type === 'PAGO_PROVEEDOR';

    try {
      if (isCustomer) {
        let client = await this.prisma.client.findFirst({
          where: { companyId: this.companyId, name: { equals: name, mode: 'insensitive' } },
        });
        const isNew = !client;
        if (!client) {
          client = await this.prisma.client.create({
            data: { companyId: this.companyId, name },
          });
        }

        if (isPayment) {
          // COBRO_CLIENTE: abonar a facturas pendientes (FIFO)
          await this.applyPaymentToInvoices(client.id, dialog.amount);
        } else {
          // VENTA: crear nueva factura por cobrar
          const itbms = dialog.itbmsAmount || (dialog.itbms ? Math.round(dialog.amount * 0.07 * 100) / 100 : 0);
          await this.prisma.invoice.create({
            data: {
              companyId: this.companyId, clientId: client.id,
              amount: dialog.amount, itbms, total: dialog.amount + itbms,
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              date: new Date(dialog.date), description: dialog.description, journalEntryId,
            },
          });
        }
        return { type: isNew ? 'cliente_nuevo' : isPayment ? 'cliente_abono' : 'cliente_existente', name };
      } else if (isSupplier) {
        let supplier = await this.prisma.supplier.findFirst({
          where: { companyId: this.companyId, name: { equals: name, mode: 'insensitive' } },
        });
        const isNew = !supplier;
        if (!supplier) {
          supplier = await this.prisma.supplier.create({
            data: { companyId: this.companyId, name },
          });
        }

        if (isPayment) {
          // PAGO_PROVEEDOR: abonar a facturas pendientes (FIFO)
          await this.applyPaymentToBills(supplier.id, dialog.amount);
        } else {
          // COMPRA/GASTO: crear nueva factura por pagar
          const itbms = dialog.itbmsAmount || (dialog.itbms ? Math.round(dialog.amount * 0.07 * 100) / 100 : 0);
          await this.prisma.bill.create({
            data: {
              companyId: this.companyId, supplierId: supplier.id,
              amount: dialog.amount, itbms, total: dialog.amount + itbms,
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              date: new Date(dialog.date), description: dialog.description, journalEntryId,
            },
          });
        }
        return { type: isNew ? 'proveedor_nuevo' : isPayment ? 'proveedor_abono' : 'proveedor_existente', name };
      }
    } catch (err) {
      console.error('[Orchestrator] Error auto-creando entidad:', err);
    }
    return null;
  }

  /** Aplica un abono a las facturas pendientes de un cliente (FIFO) */
  private async applyPaymentToInvoices(clientId: string, amount: number): Promise<void> {
    const pending = await this.prisma.invoice.findMany({
      where: { clientId, status: { not: 'PAGADA' } },
      orderBy: { dueDate: 'asc' },
    });

    let remaining = amount;
    for (const inv of pending) {
      if (remaining <= 0) break;
      const toPay = Math.min(remaining, inv.total);
      if (toPay >= inv.total - 0.01) {
        await this.prisma.invoice.update({
          where: { id: inv.id },
          data: { status: 'PAGADA', paidAt: new Date() },
        });
      }
      remaining -= toPay;
    }
  }

  /** Aplica un pago a las facturas pendientes de un proveedor (FIFO) */
  private async applyPaymentToBills(supplierId: string, amount: number): Promise<void> {
    const pending = await this.prisma.bill.findMany({
      where: { supplierId, status: { not: 'PAGADA' } },
      orderBy: { dueDate: 'asc' },
    });

    let remaining = amount;
    for (const b of pending) {
      if (remaining <= 0) break;
      const toPay = Math.min(remaining, b.total);
      if (toPay >= b.total - 0.01) {
        await this.prisma.bill.update({
          where: { id: b.id },
          data: { status: 'PAGADA', paidAt: new Date() },
        });
      }
      remaining -= toPay;
    }
  }
}
