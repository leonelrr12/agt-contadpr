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

    return { journalEntry: entryData };
  }
}
