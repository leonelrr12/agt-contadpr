import type { ClassificationResult } from '@agt-contador/shared';

export interface ClassificationAgentConfig {
  prisma: any;
  companyId: string;
}

export class ClassificationAgent {
  private prisma: any;
  private companyId: string;

  constructor(config: ClassificationAgentConfig) {
    this.prisma = config.prisma;
    this.companyId = config.companyId;
  }

  async classify(conceptName: string): Promise<ClassificationResult> {
    const allConcepts = await this.prisma.concept.findMany({
      where: { companyId: this.companyId, isActive: true },
      include: { account: true },
    });

    const lowerName = conceptName.toLowerCase();
    const concept = allConcepts.find((c: any) => c.name.toLowerCase() === lowerName);

    if (concept) {
      return {
        concept: concept.name,
        accountId: concept.accountId,
        confidence: concept.confidence,
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
