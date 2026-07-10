import type { ClassificationResult } from '@agt-contador/shared';

export interface ClassificationAgentConfig {
  prisma: any;
  companyId: string;
  deepseekApiKey?: string;
}

export class ClassificationAgent {
  private prisma: any;
  private companyId: string;

  constructor(config: ClassificationAgentConfig) {
    this.prisma = config.prisma;
    this.companyId = config.companyId;
  }

  private async loadAccounts(): Promise<any[]> {
    return this.prisma.account.findMany({
      where: { companyId: this.companyId, isActive: true },
    });
  }

  async classify(conceptName: string, transactionType?: string): Promise<ClassificationResult> {
    const allConcepts = await this.prisma.concept.findMany({
      where: { companyId: this.companyId, isActive: true },
      include: { account: true },
    });

    const lowerName = conceptName.toLowerCase();
    const exactMatch = allConcepts.find((c: any) => c.name.toLowerCase() === lowerName);

    if (exactMatch) {
      return {
        concept: exactMatch.name,
        accountId: exactMatch.accountId,
        confidence: exactMatch.confidence,
      };
    }

    const prefix = conceptName.substring(0, 4).toLowerCase();
    const partialMatch = allConcepts
      .filter((c: any) => c.name.toLowerCase().includes(prefix))
      .sort((a: any, b: any) => b.confidence - a.confidence)[0];

    if (partialMatch) {
      return {
        concept: partialMatch.name,
        accountId: partialMatch.accountId,
        confidence: partialMatch.confidence * 0.8,
      };
    }

    const accounts = await this.loadAccounts();
    const typeToGeneric: Record<string, string> = {
      INGRESO: 'Otros Ingresos',
      GASTO: 'Gastos Varios',
      COMPRA: 'Compra de mercancía',
      VENTA: 'Ventas',
      PAGO_PROVEEDOR: 'Proveedores',
      COBRO_CLIENTE: 'Clientes',
      PRESTAMO: 'Préstamos por Pagar LP',
    };
    const genericName = typeToGeneric[transactionType || ''] || 'Gastos Varios';
    const genericAccount = accounts.find((a: any) => a.name === genericName);

    if (genericAccount) {
      return {
        concept: conceptName,
        accountId: genericAccount.id,
        confidence: 0.5,
      };
    }

    return {
      concept: conceptName,
      accountId: '',
      confidence: 0,
    };
  }

  async learn(conceptName: string, accountId: string): Promise<void> {
    await this.prisma.concept.upsert({
      where: { name_companyId: { name: conceptName, companyId: this.companyId } },
      update: { accountId, confidence: 0.95 },
      create: { name: conceptName, accountId, companyId: this.companyId, confidence: 0.95 },
    });
  }
}
