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

/** Tope de retención para un cobro (duplicado local de services/retencion-itbms).
 *  Usa el % del perfil si el cliente es agente vigente en la fecha de la
 *  factura; si no, el 50% estándar (la evidencia marca al cliente después). */
function retencionCobroInfoLocal(client: any, itbms: number, fechaFactura: Date): { cap: number; pct: number; esAgente: boolean } {
  if (!itbms || itbms <= 0) return { cap: 0, pct: 0, esAgente: false };
  const f = new Date(fechaFactura);
  const esAgente = !!(client?.esAgenteRetenedor) &&
    (!client.vigenciaRetencionDesde || f >= new Date(client.vigenciaRetencionDesde)) &&
    (!client.vigenciaRetencionHasta || f <= new Date(client.vigenciaRetencionHasta));
  const pct = esAgente ? (client?.porcentajeRetencionItbms ?? 0.5) : 0.5;
  return { cap: Math.round(itbms * pct * 100) / 100, pct, esAgente };
}
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

    // Banco mencionado ("... ACH Banco de Panama", "... Banco General"): se
    // extrae del texto crudo (el LLM no siempre lo propaga) para acreditar la
    // cuenta real del catálogo en lugar del banco por defecto.
    if (!(dialog as any).cuentaBanco) {
      const bi = input.search(/\bbanco\b/i);
      if (bi >= 0) {
        const tail = input.slice(bi).replace(/^[^A-ZÁÉÍÓÚÑ]*/, '');
        const nm = tail.match(/^([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑ .'’]{1,45})/);
        if (nm) {
          const rawName = nm[1].trim().replace(/\s{2,}/g, ' ');
          (dialog as any).cuentaBanco = rawName.replace(/\s+(?:por|con|itbms|iva|impuesto|factura|compra|venta|pago|del|el|la)\s+.*$/i, '') || null;
        }
      }
    }

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

    // COBRO de factura EXISTENTE: flujo dedicado — valida el Nº en BD, el
    // saldo y la retención ITBMS (sugerida y confirmada explícitamente).
    // Web, WhatsApp y batch confluyen aquí (process → confirm).
    if (dialog.type === 'COBRO_CLIENTE') {
      return this.procesarCobroFactura(dialog, plan);
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
    // Banco mencionado / default configurado / 1.1.02.01 → línea con código
    await this.aplicarBancoMencionado(dialog, raw);
    // Resolución alias → id; si el valor es un CÓDIGO (p.ej. 1.1.02.03) se
    // busca por código en el catálogo (no por alias)
    const resolveRef = async (ref: string): Promise<string> => {
      try { return this.accountingAgent.resolveAlias(ref); } catch { /* intentar por código */ }
      if (/^\d+(\.\d+)+$/.test(ref)) {
        const accs = await this.prisma.account.findMany({
          where: { companyId: this.companyId, code: ref },
          select: { id: true },
        });
        if (accs?.[0]) return accs[0].id;
      }
      throw new Error(`Cuenta contable no encontrada: ${ref}`);
    };
    const entry: AccountingEntry = {
      debit: await Promise.all(raw.debit.map(async (d: any) => ({ ...d, accountId: await resolveRef(d.accountId) }))),
      credit: await Promise.all(raw.credit.map(async (c: any) => ({ ...c, accountId: await resolveRef(c.accountId) }))),
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

  /**
   * Resuelve la cuenta bancaria de un pago por banco/transferencia (chat/WS).
   * Cadena: (1) banco mencionado por nombre en el texto → (2) cuenta default
   * configurada en Panel Admin (Company.bancoDefaultId) → (3) cuenta 1.1.02.01
   * (existe en todos los catálogos) → si nada, se mantiene la línea con el
   * alias 'banco-general' (resuelto por AccountingAgent).
   * Muta las líneas crudas ANTES de mapear aliases/códigos a ids reales.
   */
  private async aplicarBancoMencionado(dialog: any, raw: { debit: any[]; credit: any[] }): Promise<void> {
    const metodo = (dialog.paymentMethod || '').toUpperCase();
    if (!['TRANSFERENCIA', 'BANCO', 'CHEQUE', 'TARJETA_DEBITO'].includes(metodo)) return;

    const bancos = await this.prisma.account.findMany({
      where: { companyId: this.companyId, code: { startsWith: '1.1.02' }, isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    });
    if (!bancos.length) return;

    const elegir = (b: { code: string; name: string }) => b;

    // 1) Banco mencionado por nombre
    const nombre = (dialog.cuentaBanco || '').trim();
    let target: { code: string; name: string } | null = null;
    if (nombre) {
      const want = this.normalizeName(nombre);
      if (want.length >= 3) {
        let best: { code: string; name: string; score: number } | null = null;
        for (const b of bancos) {
          const bn = this.normalizeName(b.name);
          const score = bn === want ? 2 : (bn.includes(want) || want.includes(bn)) && want.length >= 4 ? 1 : 0;
          if (score === 0) continue;
          if (!best || score > best.score || (score === best.score && b.name.length < best.name.length)) {
            best = { code: b.code, name: b.name, score };
          }
        }
        target = best ? elegir(best) : null;
      }
    }

    // 2) Cuenta default configurada (Panel Admin → Configuración)
    if (!target) {
      const company: any = await (this.prisma as any).company.findUnique({
        where: { id: this.companyId },
        select: { bancoDefaultId: true },
      });
      if (company?.bancoDefaultId) {
        const cfg = bancos.find(b => b.id === company.bancoDefaultId);
        if (cfg) target = elegir(cfg);
      }
    }

    // 3) Cuenta 1.1.02.01 como respaldo universal
    if (!target) {
      const code1 = bancos.find(b => b.code === '1.1.02.01');
      if (code1) target = elegir(code1);
    }

    if (!target) return;
    // Reemplaza la línea de banco genérica por la cuenta elegida (se emite su
    // código; la resolución a id real ocurre al mapear las líneas)
    for (const l of [...raw.debit, ...raw.credit]) {
      if (l.accountId === 'banco-general') {
        l.accountId = target.code;
        l.name = target.name;
      }
    }
  }

  /** Cuenta de crédito fiscal por retención: alias → código 1.1.07 → nombre. */
  private async cuentaRetencionId(): Promise<string | null> {
    await this.accountingAgent.init();
    try { return this.accountingAgent.resolveAlias('itbms-retenido-terceros'); } catch { /* fallback */ }
    const accs = await this.prisma.account.findMany({
      where: { companyId: this.companyId },
      select: { id: true, code: true, name: true },
    });
    const hit = accs.find(a => (a.code || '').trim() === '1.1.07')
      || accs.find(a => (a.name || '').toLowerCase().includes('retenido por terceros'));
    return hit?.id || null;
  }

  /**
   * Flujo dedicado para "cobré la factura Nº X por $Y": valida que la factura
   * exista, calcula saldo/retención y arma el asiento split para confirmar.
   * El Nº es obligatorio (decisión: solo facturas existentes); el RUC/razón
   * social se valida si el usuario los menciona.
   */
  private async procesarCobroFactura(dialog: any, plan: ExecutionPlan): Promise<{
    plan: ExecutionPlan; prompt?: string; needsConfirmation: boolean; result?: any;
  }> {
    const numero = (dialog.invoiceNumber || '').toString().trim();
    if (!numero) {
      return {
        plan,
        prompt: '¿Cuál es el Nº de la factura que te pagaron? Ej: "cobré la factura 1005 por $500"',
        needsConfirmation: false,
      };
    }

    const invoice = await (this.prisma as any).invoice.findFirst({
      where: { companyId: this.companyId, number: numero },
      include: {
        client: {
          select: {
            id: true, name: true, taxId: true, esAgenteRetenedor: true,
            porcentajeRetencionItbms: true, vigenciaRetencionDesde: true, vigenciaRetencionHasta: true,
          },
        },
      },
    });
    if (!invoice) {
      return { plan, prompt: `No encontré la factura Nº "${numero}". Verifica el número (ej. 1005 o A-000123).`, needsConfirmation: false };
    }

    const saldo = Math.round((invoice.total - (invoice.paidAmount || 0)) * 100) / 100;
    if (saldo <= 0.01) {
      return { plan, prompt: `La factura Nº ${invoice.number} ya está pagada (saldo $0.00).`, needsConfirmation: false };
    }

    const efectivo = Math.round((Number(dialog.amount) || 0) * 100) / 100;
    if (efectivo <= 0) {
      return { plan, prompt: '¿Cuánto efectivo recibiste por esta factura?', needsConfirmation: false };
    }
    if (efectivo > saldo + 0.01) {
      return { plan, prompt: `El efectivo $${efectivo.toFixed(2)} excede el saldo de la factura Nº ${invoice.number} ($${saldo.toFixed(2)}).`, needsConfirmation: false };
    }

    // RUC/razón social opcionales: si el usuario los menciona, deben coincidir
    const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
    const rucFactura = digits(invoice.client?.taxId);
    if (dialog.ruc && rucFactura && digits(dialog.ruc) !== rucFactura) {
      return { plan, prompt: `El RUC no corresponde a la factura Nº ${invoice.number} (cliente: ${invoice.client?.name || '—'}). Revisa el número o el RUC.`, needsConfirmation: false };
    }
    if (dialog.provider && invoice.client?.name &&
        this.normalizeName(dialog.provider) !== this.normalizeName(invoice.client.name)) {
      return { plan, prompt: `La factura Nº ${invoice.number} es de "${invoice.client.name}", no de "${dialog.provider}".`, needsConfirmation: false };
    }

    // Retención ITBMS: sugerida cuando el efectivo cierra el neto
    const fechaFactura = invoice.date instanceof Date ? invoice.date : new Date(invoice.date);
    const info = retencionCobroInfoLocal(invoice.client, invoice.itbms, fechaFactura);
    const diff = Math.round((saldo - efectivo) * 100);
    const capCents = Math.round(info.cap * 100);
    let ret = 0;
    if (capCents > 0 && Math.abs(diff - capCents) <= 1) {
      ret = Math.min(info.cap, Math.round((saldo - efectivo) * 100) / 100);
    }
    const aplicado = Math.round((efectivo + ret) * 100) / 100;
    const autoMarcar = ret > 0 && !info.esAgente;

    // Cuentas del asiento split
    await this.accountingAgent.init();
    let cajaId: string, clientesId: string;
    try {
      cajaId = this.accountingAgent.resolveAlias('caja');
      clientesId = this.accountingAgent.resolveAlias('clientes');
    } catch {
      return { plan, prompt: 'Faltan cuentas en el catálogo (caja/clientes). Configúralas en el panel.', needsConfirmation: false };
    }
    let retAcctId: string | null = null;
    if (ret > 0) {
      retAcctId = await this.cuentaRetencionId();
      if (!retAcctId) {
        return { plan, prompt: 'Para registrar la retención crea la cuenta "ITBMS Retenido por Terceros" (código 1.1.07) en el catálogo.', needsConfirmation: false };
      }
    }

    const accs = await this.prisma.account.findMany({
      where: { id: { in: [cajaId, clientesId, ...(retAcctId ? [retAcctId] : [])] }, companyId: this.companyId },
      select: { id: true, name: true },
    });
    const nameOf = (id: string) => accs.find(a => a.id === id)?.name || 'Cuenta';

    const debit: any[] = [{ accountId: cajaId, name: nameOf(cajaId), amount: efectivo }];
    if (ret > 0 && retAcctId) debit.push({ accountId: retAcctId, name: nameOf(retAcctId), amount: ret });
    const credit: any[] = [{ accountId: clientesId, name: nameOf(clientesId), amount: aplicado }];
    const descSuffix = ret > 0 ? ` (efectivo $${efectivo.toFixed(2)} + retención ITBMS $${ret.toFixed(2)})` : '';
    const entry: AccountingEntry = {
      debit, credit,
      description: `Cobro de factura ${invoice.number} — $${aplicado.toFixed(2)}${descSuffix}`.trim(),
    };

    // Datos de decisión viajan en dialog (passthrough) para materializar en confirm()
    const dd = dialog as any;
    dd.invoiceNumber = invoice.number;
    dd.facturaId = invoice.id;
    dd.saldoFactura = saldo;
    dd.efectivoFactura = efectivo;
    dd.retencionItbms = ret;
    dd.aplicadoFactura = aplicado;
    dd.autoMarcarAgente = autoMarcar;
    dd.clienteFactura = invoice.client?.name || null;

    const lines = [
      `**Cobro de factura Nº ${invoice.number}** — ${invoice.client?.name || ''}`,
      `Saldo: **$${saldo.toFixed(2)}** · Efectivo recibido: **$${efectivo.toFixed(2)}**`,
    ];
    if (ret > 0) {
      lines.push(`🔖 Retención ITBMS: **$${ret.toFixed(2)}** (crédito fiscal${autoMarcar ? ' — el cliente quedará marcado como agente de retención' : ''})`);
    }
    lines.push('', '**Asiento contable:**');
    for (const d of entry.debit) lines.push(`  Débito: ${d.name} — $${d.amount}`);
    for (const c of entry.credit) lines.push(`  Crédito: ${c.name} — $${c.amount}`);
    lines.push('', '¿Confirmas? Responde **OK** o cancela con **XX**.');

    plan.entry = entry;
    return { plan, prompt: lines.join('\n'), needsConfirmation: true, result: { dialog, entry } };
  }

  /**
   * Materializa el cobro de factura al confirmar: re-valida en frío dentro de
   * la transacción y crea JE BORRADOR + InvoicePayment + Retención ITBMS
   * (misma lógica que el import/PATCH pay). Sin InvoicePayment no hay
   * duplicado: la re-subida por import lo omitiría por dedupe idéntico.
   */
  private async confirmarCobroFactura(dialog: any): Promise<{ journalEntry: any; autoCreated?: null }> {
    const d = dialog as any;
    const efectivo = Math.round((Number(d.efectivoFactura ?? d.amount) || 0) * 100) / 100;
    const ret = Math.round((Number(d.retencionItbms) || 0) * 100) / 100;
    const aplicado = Math.round((Number(d.aplicadoFactura ?? efectivo + ret) || 0) * 100) / 100;
    const numero = String(d.invoiceNumber || '').trim();

    const entryData: any = await (this.prisma as any).$transaction(async (tx: any) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: d.facturaId, companyId: this.companyId },
        include: {
          client: {
            select: { id: true, esAgenteRetenedor: true, porcentajeRetencionItbms: true, vigenciaRetencionDesde: true },
          },
        },
      });
      if (!invoice || String(invoice.number) !== numero) {
        throw Object.assign(new Error(`La factura Nº "${numero}" ya no existe.`), { status: 404 });
      }
      const saldo = Math.round((invoice.total - (invoice.paidAmount || 0)) * 100) / 100;
      if (saldo <= 0.01) throw Object.assign(new Error(`La factura Nº ${invoice.number} ya está pagada.`), { status: 400 });
      if (aplicado > saldo + 0.01) {
        throw Object.assign(new Error(`El total aplicado $${aplicado.toFixed(2)} excede el saldo de la factura Nº ${invoice.number} ($${saldo.toFixed(2)}).`), { status: 400 });
      }
      if (ret > 0) {
        const fechaFactura = invoice.date instanceof Date ? invoice.date : new Date(invoice.date);
        const info = retencionCobroInfoLocal(invoice.client, invoice.itbms, fechaFactura);
        if (info.cap <= 0) throw Object.assign(new Error(`La factura Nº ${invoice.number} no tiene ITBMS para retener.`), { status: 400 });
        if (ret > info.cap + 0.01) {
          throw Object.assign(new Error(`La retención $${ret.toFixed(2)} excede el ${Math.round(info.pct * 100)}% del ITBMS ($${info.cap.toFixed(2)}).`), { status: 400 });
        }
      }

      await this.accountingAgent.init();
      const cajaId = this.accountingAgent.resolveAlias('caja');
      const clientesId = this.accountingAgent.resolveAlias('clientes');
      const retAcctId = ret > 0 ? await this.cuentaRetencionId() : null;

      const lines: any[] = [{ accountId: cajaId, debit: efectivo, credit: 0 }];
      if (ret > 0 && retAcctId) lines.push({ accountId: retAcctId, debit: ret, credit: 0 });
      lines.push({ accountId: clientesId, debit: 0, credit: aplicado });
      const descSuffix = ret > 0 ? ` (efectivo $${efectivo.toFixed(2)} + retención ITBMS $${ret.toFixed(2)})` : '';
      const desc = `Cobro de factura ${invoice.number} — $${aplicado.toFixed(2)}${descSuffix}`.trim();

      const je = await tx.journalEntry.create({
        data: {
          date: parseLocalDate(d.date),
          description: desc,
          status: 'BORRADOR',
          companyId: this.companyId,
          createdById: this.userId,
          lines: { create: lines },
        },
      });

      const metadata: Record<string, unknown> = {
        source: 'chat-cobro', invoiceNumber: invoice.number,
        appliedAmount: aplicado, retentionAmount: ret,
      };
      if (d.ruc) metadata.ruc = d.ruc;
      if (d.provider) metadata.provider = d.provider;
      if (d.clienteFactura) metadata.clientName = d.clienteFactura;

      await tx.transaction.create({
        data: {
          type: 'COBRO_CLIENTE', amount: efectivo, description: desc, concept: d.concept || 'Cobro de factura',
          paymentMethod: d.paymentMethod || 'EFECTIVO', date: parseLocalDate(d.date),
          companyId: this.companyId, createdById: this.userId, journalEntryId: je.id,
          metadata: JSON.stringify(metadata),
        },
      });

      const payment = await tx.invoicePayment.create({
        data: {
          companyId: this.companyId, invoiceId: invoice.id, amount: efectivo,
          retentionAmount: ret, date: parseLocalDate(d.date), accountId: cajaId,
          accountName: null, journalEntryId: je.id,
        },
      });

      if (ret > 0) {
        await tx.retentionItbms.create({
          data: {
            companyId: this.companyId, clientId: invoice.clientId, invoiceId: invoice.id,
            invoicePaymentId: payment.id, fecha: parseLocalDate(d.date),
            baseGravada: invoice.amount, itbmsFacturado: invoice.itbms,
            porcentaje: invoice.itbms > 0 ? ret / invoice.itbms : 0.5,
            montoRetencion: ret, journalEntryId: je.id, estado: 'PENDIENTE',
          },
        });
      }
      // Evidencia de retención en cliente sin perfil → marcarlo como agente
      if (ret > 0 && d.autoMarcarAgente && invoice.client && !invoice.client.esAgenteRetenedor) {
        const clientData: any = { esAgenteRetenedor: true };
        if ((invoice.client.porcentajeRetencionItbms ?? 0.5) === 0.5 && invoice.itbms > 0) {
          clientData.porcentajeRetencionItbms = Math.min(1, Math.max(0, ret / invoice.itbms));
        }
        if (!invoice.client.vigenciaRetencionDesde) {
          const fechaFactura = invoice.date instanceof Date ? invoice.date : new Date(invoice.date);
          clientData.vigenciaRetencionDesde = new Date(fechaFactura);
        }
        await tx.client.update({ where: { id: invoice.clientId }, data: clientData });
      }

      const quedaPagada = saldo - aplicado <= 0.01;
      const updated = await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          paidAmount: Math.round(((invoice.paidAmount || 0) + aplicado) * 100) / 100,
          ...(quedaPagada ? { status: 'PAGADA', paidAt: parseLocalDate(d.date) } : {}),
        },
      });

      return {
        id: je.id, status: 'BORRADOR', // mismo contrato que el confirm genérico
        number: updated.number,
        saldo: Math.max(0, Math.round((updated.total - updated.paidAmount) * 100) / 100),
        invoiceStatus: updated.status,
        description: desc,
      };
    });

    return { journalEntry: entryData, autoCreated: null };
  }

  async confirm(result: any): Promise<{ journalEntry: any; autoCreated?: { type: string; name: string } | null }> {
    const { dialog, entry, selectedEntityId } = result;

    // Cobro de factura existente → materializar con el motor de cobros
    if (dialog?.type === 'COBRO_CLIENTE' && dialog.invoiceNumber) {
      return this.confirmarCobroFactura(dialog);
    }

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
