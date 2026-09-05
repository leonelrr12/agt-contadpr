import crypto from 'crypto';
import { DialogAgent } from './dialog-agent';
import { ClassificationAgent, type ClassificationAgentConfig } from './classification-agent';
import { AccountingAgent } from './accounting-agent';
import type { DialogResult, DialogContext, PrismaLike } from './types';
import type { AccountingEntry } from './accounting-agent';

/**
 * Hash determinista del RUC (HMAC-SHA256) para dedupe sin filtrar el valor
 * cifrado. Duplicada de apps/api/src/services/crypto-fields.ts porque este
 * paquete no puede importar código de la API; la derivación es idéntica.
 * Los registros se guardan con taxIdHash al escribir (extensión en main.ts).
 */
function hashRuc(plain: string): string {
  const keyB64 = process.env.FIELD_ENC_KEY || '';
  const key = keyB64 ? Buffer.from(keyB64, 'base64') : null;
  if (!key || key.length !== 32) return '';
  const searchKey = crypto.createHmac('sha256', key).update('search').digest();
  return crypto.createHmac('sha256', searchKey).update(String(plain)).digest('hex');
}

/** Parsea una fecha YYYY-MM-DD usando mediodía local para evitar
 *  desplazamientos de zona horaria (medianoche UTC-4 → día anterior en UTC-5).
 *  Si la fecha es inválida o nula, usa la fecha actual como fallback. */
function parseLocalDate(isoDate: string | null | undefined): Date {
  if (!isoDate) return new Date();
  const parts = isoDate.split('-').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return new Date();
  const [y, m, d] = parts;
  return new Date(y, m - 1, d, 12, 0, 0);
}

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
  private prisma: PrismaLike;
  private companyId: string;
  private userId: string;

  constructor(config: ClassificationAgentConfig & { userId: string }) {
    if (!config.userId) {
      throw new Error('OrchestratorAgent: userId es requerido (FK createdById en asiento/transacción)');
    }
    this.dialogAgent = new DialogAgent(config.deepseekApiKey);
    this.classificationAgent = new ClassificationAgent(config);
    this.accountingAgent = new AccountingAgent(config.prisma, config.companyId);
    this.prisma = config.prisma;
    this.companyId = config.companyId;
    this.userId = config.userId;
  }

  async process(input: string, context?: DialogContext): Promise<{
    plan: ExecutionPlan;
    prompt?: string;
    needsConfirmation: boolean;
    result?: any;
    entityMatches?: any[];
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

    // Buscar coincidencias de proveedor/cliente antes de generar el asiento.
    // Solo si el usuario NO ha pasado ya por el selector de entidad.
    // selectedEntityId puede ser: string (ID existente), null (eligió "crear nuevo"),
    // o la key no existe (primera vez que se procesa este input).
    // Entity matching solo para CRÉDITO (cuentas por cobrar/pagar).
    // Para otros métodos de pago (efectivo, tarjeta, transferencia) no se necesita relacionar entidad.
    if (dialog.provider && dialog.paymentMethod === 'CREDITO' && !((context as any)?.extractedData && 'selectedEntityId' in (context as any).extractedData)) {
      const matches = await this.findEntityMatches(dialog.provider, dialog.ruc);
      if (matches.length > 0) {
        // Generar entry también para que el frontend tenga el result completo
        await this.accountingAgent.init();
        const raw = this.accountingAgent.generateEntry(dialog, classification);
        const entry: AccountingEntry = {
          debit: raw.debit.map((d: any) => ({ ...d, accountId: this.accountingAgent.resolveAlias(d.accountId) })),
          credit: raw.credit.map((c: any) => ({ ...c, accountId: this.accountingAgent.resolveAlias(c.accountId) })),
          description: raw.description,
        };
        return {
          plan,
          entityMatches: matches,
          result: { dialog, entry, classification },
          prompt: `Encontré estas coincidencias para "${dialog.provider}". ¿Cuál es?`,
          needsConfirmation: false,
        };
      }
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
    // Mostrar concepto clasificado si difiere del texto crudo
    const classifiedLabel = classification.concept &&
      classification.concept.toLowerCase() !== dialog.concept.toLowerCase()
      ? ` (${classification.concept})` : '';
    const summaryParts = [
      `**${typeLabels[dialog.type] || dialog.type}**: ${dialog.concept}${classifiedLabel} por **$${dialog.amount}**${dialog.itbmsAmount ? ` (+ ITBMS $${dialog.itbmsAmount})` : ''}`,
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

  async confirm(result: any): Promise<{ journalEntry: any; autoCreated?: { type: string; name: string } | null }> {
    const { dialog, entry, selectedEntityId } = result;

    const entryData = await this.prisma.journalEntry.create({
      data: {
        date: parseLocalDate(dialog.date),
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
    if (dialog.ruc) metadata.ruc = dialog.ruc;
    if (dialog.invoiceNumber) metadata.invoiceNumber = dialog.invoiceNumber;
    if (dialog.itbmsAmount) metadata.itbmsAmount = dialog.itbmsAmount;
    if ((dialog as any).source) metadata.source = (dialog as any).source;

    await this.prisma.transaction.create({
      data: {
        type: dialog.type, amount: dialog.amount, description: dialog.description,
        concept: dialog.concept, paymentMethod: dialog.paymentMethod,
        date: parseLocalDate(dialog.date), companyId: this.companyId,
        createdById: this.userId, journalEntryId: entryData.id,
        metadata: JSON.stringify(metadata),
      },
    });

    // ── Auto-crear cliente o proveedor ──
    // Solo se crea cuando el método de pago es CRÉDITO (genera cuenta por cobrar/pagar).
    // Para pagos al contado (efectivo, tarjeta, transferencia) no se crea entidad.
    let autoCreated: { type: string; name: string } | null = null;
    if (dialog.provider && dialog.paymentMethod === 'CREDITO') {
      autoCreated = await this.autoCreateEntity(dialog, entryData.id, result.selectedEntityId);
    }

    return { journalEntry: entryData, autoCreated };
  }

  /**
   * Busca coincidencias de un nombre en clientes y proveedores existentes.
   * Retorna una lista para que el usuario elija, con opción de crear nuevo.
   */
  private async findEntityMatches(name: string, ruc?: string | null): Promise<any[]> {
    const normalized = this.normalizeName(name);
    if (normalized.length < 3 && !ruc) return [];

    const matches: any[] = [];

    // Coincidencia por RUC (si se suministra): identifica de forma única
    // (el valor está cifrado en BD — se compara por taxIdHash determinista)
    if (ruc) {
      const hash = hashRuc(ruc);
      if (hash) {
        const byRucC = await this.prisma.client.findFirst({ where: { companyId: this.companyId, taxIdHash: hash }, select: { id: true, name: true } });
        if (byRucC) matches.push({ id: byRucC.id, name: byRucC.name, type: 'cliente' });
        const byRucS = await this.prisma.supplier.findFirst({ where: { companyId: this.companyId, taxIdHash: hash }, select: { id: true, name: true } });
        if (byRucS && !matches.find(m => m.id === byRucS.id)) matches.push({ id: byRucS.id, name: byRucS.name, type: 'proveedor' });
      }
      return matches; // el RUC es determinante — no mezclar con coincidencias parciales de nombre
    }

    // Buscar clientes por nombre
    const clients = await this.prisma.client.findMany({
      where: { companyId: this.companyId },
      select: { id: true, name: true },
    });
    for (const c of clients) {
      const cNorm = this.normalizeName(c.name);
      if (cNorm === normalized || cNorm.includes(normalized) || normalized.includes(cNorm)) {
        matches.push({ id: c.id, name: c.name, type: 'cliente' });
      }
    }

    // Buscar proveedores por nombre
    const suppliers = await this.prisma.supplier.findMany({
      where: { companyId: this.companyId },
      select: { id: true, name: true },
    });
    for (const s of suppliers) {
      const sNorm = this.normalizeName(s.name);
      if (sNorm === normalized || sNorm.includes(normalized) || normalized.includes(sNorm)) {
        if (!matches.find(m => m.id === s.id)) {
          matches.push({ id: s.id, name: s.name, type: 'proveedor' });
        }
      }
    }

    return matches;
  }

  /**
   * Normaliza un nombre para comparación difusa:
   * - Elimina sufijos legales (S A, S.A., SA, S DE R L, etc.)
   * - Elimina puntuación y colapsa espacios
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/\./g, ' ')                         // S.A. → S A
      .replace(/\bs\s*a\b/g, '')                   // S A → ''
      .replace(/\bsa\b/g, '')                      // SA → ''
      .replace(/\bs\s*de\s*r\s*l\b/g, '')          // S DE R L → ''
      .replace(/\bc\s*por\s*a\b/g, '')             // C POR A → ''
      .replace(/\binc\b/g, '')                     // Inc → ''
      .replace(/\bltda\b/g, '')                    // Ltda → ''
      .replace(/\bcorp\b/g, '')                    // Corp → ''
      .replace(/\bco\b/g, '')                      // Co → ''
      .replace(/[,;]/g, ' ')                       // puntuación → espacio
      .replace(/\s+/g, ' ')                        // colapsar espacios
      .trim();
  }

  /**
   * Busca un cliente existente por nombre normalizado.
   */
  private async findClientByName(name: string, ruc?: string | null): Promise<any> {
    // 0. Coincidencia por RUC (taxIdHash determinista — el valor está cifrado)
    if (ruc) {
      const hash = hashRuc(ruc);
      if (hash) {
        const byRuc = await this.prisma.client.findFirst({
          where: { companyId: this.companyId, taxIdHash: hash },
        });
        if (byRuc) return byRuc;
      }
    }
    // 1. Coincidencia exacta case-insensitive
    let match = await this.prisma.client.findFirst({
      where: { companyId: this.companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (match) return match;

    // 2. Coincidencia parcial: el nombre normalizado contiene o es contenido
    const normalized = this.normalizeName(name);
    if (normalized.length < 3) return null;

    const clients = await this.prisma.client.findMany({
      where: { companyId: this.companyId },
      select: { id: true, name: true },
    });

    for (const c of clients) {
      const cNorm = this.normalizeName(c.name);
      if (cNorm === normalized || cNorm.includes(normalized) || normalized.includes(cNorm)) {
        return c;
      }
    }

    return null;
  }

  /**
   * Busca un proveedor existente por nombre normalizado.
   */
  private async findSupplierByName(name: string, ruc?: string | null): Promise<any> {
    // 0. Coincidencia por RUC (taxIdHash determinista — el valor está cifrado)
    if (ruc) {
      const hash = hashRuc(ruc);
      if (hash) {
        const byRuc = await this.prisma.supplier.findFirst({
          where: { companyId: this.companyId, taxIdHash: hash },
        });
        if (byRuc) return byRuc;
      }
    }
    let match = await this.prisma.supplier.findFirst({
      where: { companyId: this.companyId, name: { equals: name, mode: 'insensitive' } },
    });
    if (match) return match;

    const normalized = this.normalizeName(name);
    if (normalized.length < 3) return null;

    const suppliers = await this.prisma.supplier.findMany({
      where: { companyId: this.companyId },
      select: { id: true, name: true },
    });

    for (const c of suppliers) {
      const cNorm = this.normalizeName(c.name);
      if (cNorm === normalized || cNorm.includes(normalized) || normalized.includes(cNorm)) {
        return c;
      }
    }

    return null;
  }

  /**
   * Auto-crea un Client o Supplier según el tipo de transacción.
   * Si ya existe (incluso con nombre similar), lo reutiliza.
   */
  private async autoCreateEntity(dialog: any, journalEntryId: string, selectedEntityId?: string): Promise<{ type: string; name: string } | null> {
    const name = dialog.provider?.trim();
    if (!name) return null;

    const isCustomer = dialog.type === 'VENTA' || dialog.type === 'COBRO_CLIENTE';
    const isSupplier = dialog.type === 'GASTO' || dialog.type === 'COMPRA' || dialog.type === 'PAGO_PROVEEDOR';
    const isPayment = dialog.type === 'COBRO_CLIENTE' || dialog.type === 'PAGO_PROVEEDOR';

    try {
      if (isCustomer) {
        // Si el usuario seleccionó una entidad existente, usarla directamente
        let client = selectedEntityId
          ? await this.prisma.client.findFirst({ where: { id: selectedEntityId, companyId: this.companyId } })
          : await this.findClientByName(name, dialog.ruc);
        const isNew = !client;
        if (!client) {
          client = await this.prisma.client.create({
            data: { companyId: this.companyId, name, taxId: dialog.ruc || null },
          });
        } else if (!client.taxId && dialog.ruc) {
          // Cliente existente sin RUC: completarlo con el del texto
          client = await this.prisma.client.update({ where: { id: client.id }, data: { taxId: dialog.ruc } });
        }

        if (isPayment) {
          // COBRO_CLIENTE: abonar a facturas pendientes (FIFO)
          await this.applyPaymentToInvoices(client.id, dialog.amount);
        } else {
          // VENTA: crear nueva factura por cobrar
          const itbms = dialog.itbmsAmount || (dialog.itbms ? Math.round(dialog.amount * 0.07 * 100) / 100 : 0);
          try {
            await this.prisma.invoice.create({
              data: {
                companyId: this.companyId, clientId: client.id,
                number: dialog.invoiceNumber || null, // "Factura: 993" → número de la factura emitida
                amount: dialog.amount, itbms, total: dialog.amount + itbms,
                dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                date: parseLocalDate(dialog.date), description: dialog.description, journalEntryId,
              },
            });
          } catch (e: any) {
            if (e.code === 'P2002') {
              throw new Error(`El número de factura "${dialog.invoiceNumber}" ya fue registrado en otra venta. Usa un número distinto o no lo indiques.`);
            }
            throw e;
          }
        }
        return { type: isNew ? 'cliente_nuevo' : isPayment ? 'cliente_abono' : 'cliente_existente', name };
      } else if (isSupplier) {
        let supplier = selectedEntityId
          ? await this.prisma.supplier.findFirst({ where: { id: selectedEntityId, companyId: this.companyId } })
          : await this.findSupplierByName(name, dialog.ruc);
        const isNew = !supplier;
        if (!supplier) {
          supplier = await this.prisma.supplier.create({
            data: { companyId: this.companyId, name, taxId: dialog.ruc || null },
          });
        } else if (!supplier.taxId && dialog.ruc) {
          // Proveedor existente sin RUC: completarlo con el del texto
          supplier = await this.prisma.supplier.update({ where: { id: supplier.id }, data: { taxId: dialog.ruc } });
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
              number: dialog.invoiceNumber || null, // "Factura: 993" → número de la factura recibida
              amount: dialog.amount, itbms, total: dialog.amount + itbms,
              dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
              date: parseLocalDate(dialog.date), description: dialog.description, journalEntryId,
            },
          });
        }
        return { type: isNew ? 'proveedor_nuevo' : isPayment ? 'proveedor_abono' : 'proveedor_existente', name };
      }
    } catch (err: any) {
      console.error('[Orchestrator] Error auto-creando entidad:', err);
      // El error de entidad/factura NO debe tragarse: la venta quedaría sin
      // cuenta por cobrar. Se propaga para que el usuario sepa y corrija
      // (p.ej. número de factura duplicado).
      if (err?.message?.includes('ya fue registrado') || err?.code === 'P2002') throw err;
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
