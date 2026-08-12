import type { DialogResult } from './types';
import type { ClassificationResult } from '@agt-contador/shared';

export interface AccountingEntry {
  debit: { accountId: string; name: string; amount: number }[];
  credit: { accountId: string; name: string; amount: number }[];
  description: string;
}

const ALIAS_TO_CODE: Record<string, string> = {
  caja: '1.1.01',
  'banco-general': '1.1.02.01',
  'banco-nacional': '1.1.02.02',
  clientes: '1.1.03.01',
  proveedores: '2.1.01',
  'tarjeta-credito': '2.1.03',
  'inventario-mercancia': '1.1.04.01',
  'prestamos-lp': '2.2.01',
  ventas: '4.01.01',
  gasto: '6.06.01',
  'itbms-por-pagar': '2.1.05',  // Cuenta única de ITBMS (pasivo) — neteo
  'itbms-gastado': '6.05.01',   // ITBMS no recuperable (gasto)
};

function getItbmsRate(): number {
  return parseFloat(process.env.ITBMS_RATE || '') || 0.07;
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

export class AccountingAgent {
  private prisma: any;
  private companyId: string;
  private declaraITBMS: boolean;
  private codeToId: Record<string, string> = {};

  constructor(prisma: any, companyId: string, declaraITBMS = true) {
    this.prisma = prisma;
    this.companyId = companyId;
    this.declaraITBMS = declaraITBMS;
  }

  async init(): Promise<void> {
    const accounts = await this.prisma.account.findMany({
      where: { companyId: this.companyId },
      select: { code: true, id: true },
    });
    for (const a of accounts) this.codeToId[a.code] = a.id;
    // Leer si la empresa declara ITBMS
    const company = await this.prisma.company.findUnique({
      where: { id: this.companyId },
      select: { declaraITBMS: true },
    });
    if (company) this.declaraITBMS = company.declaraITBMS;
  }

  resolveAlias(alias: string): string {
    if (ALIAS_TO_CODE[alias] && this.codeToId[ALIAS_TO_CODE[alias]]) return this.codeToId[ALIAS_TO_CODE[alias]];
    if (this.codeToId[alias]) return this.codeToId[alias];
    if (Object.values(this.codeToId).includes(alias)) return alias;
    throw new Error(`Cuenta contable no encontrada: "${alias}"`);
  }

  generateEntry(dialog: DialogResult, classification: ClassificationResult): AccountingEntry {
    const entry: AccountingEntry = {
      debit: [],
      credit: [],
      description: `${dialog.concept || dialog.description} — $${dialog.amount}`,
    };
    const itbmsRate = dialog.itbmsRate ?? getItbmsRate();
    const useItbms = dialog.itbmsRate !== undefined || (process.env.ITBMS_ENABLED === 'true');
    const itbmsAmount = useItbms && (dialog.type === 'COMPRA' || dialog.type === 'VENTA')
      ? Math.round(dialog.amount * itbmsRate * 100) / 100
      : 0;

    switch (dialog.type) {
      case 'GASTO': {
        const hasItbms = this.declaraITBMS && dialog.itbmsAmount && dialog.itbmsAmount > 0;
        // amount es neto (sin ITBMS) para texto, total (incluye ITBMS) para PDF/OCR
        const amountIsTotal = !!(dialog as any).source; // PDF/OCR
        const netAmount = amountIsTotal && hasItbms ? r2(dialog.amount - dialog.itbmsAmount!) : dialog.amount;
        const totalAmount = hasItbms && !amountIsTotal ? r2(dialog.amount + dialog.itbmsAmount!) : dialog.amount;
        entry.debit.push({ accountId: classification.accountId, name: classification.concept, amount: netAmount });
        if (hasItbms) {
          entry.debit.push({ accountId: 'itbms-por-pagar', name: 'ITBMS por Pagar', amount: dialog.itbmsAmount! });
          entry.description = `${dialog.concept || dialog.description} — $${dialog.amount} + ITBMS $${dialog.itbmsAmount}`;
        }
        if (dialog.paymentMethod === 'TARJETA_CREDITO') {
          entry.credit.push({ accountId: 'tarjeta-credito', name: 'Tarjetas de Crédito', amount: totalAmount });
        } else if (dialog.paymentMethod === 'CREDITO') {
          entry.credit.push({ accountId: 'proveedores', name: 'Proveedores', amount: totalAmount });
        } else if (dialog.paymentMethod === 'EFECTIVO') {
          entry.credit.push({ accountId: 'caja', name: 'Caja', amount: totalAmount });
        } else {
          entry.credit.push({ accountId: 'banco-general', name: 'Bancos', amount: totalAmount });
        }
        break;
      }
      case 'VENTA': {
        const totalAmount = r2(dialog.amount + itbmsAmount);
        if (dialog.paymentMethod === 'EFECTIVO') {
          entry.debit.push({ accountId: 'caja', name: 'Caja', amount: totalAmount });
        } else {
          entry.debit.push({ accountId: 'clientes', name: 'Clientes', amount: totalAmount });
        }
        entry.credit.push({ accountId: classification.accountId, name: classification.concept, amount: dialog.amount });
        if (itbmsAmount > 0) {
          entry.credit.push({ accountId: 'itbms-por-pagar', name: 'ITBMS por Pagar', amount: itbmsAmount });
          entry.description = `${dialog.type}: ${dialog.concept || dialog.description} - $${dialog.amount} + ITBMS $${itbmsAmount}`;
        }
        break;
      }
      case 'COMPRA': {
        const netAmount = dialog.amount;
        if (this.declaraITBMS && itbmsAmount > 0) {
          // Declara: ITBMS separado como crédito fiscal
          entry.debit.push({ accountId: 'inventario-mercancia', name: 'Inventario de Mercancía', amount: netAmount });
          entry.debit.push({ accountId: 'itbms-por-pagar', name: 'ITBMS por Pagar', amount: itbmsAmount });
          entry.description = `${dialog.type}: ${dialog.concept || dialog.description} - $${netAmount} + ITBMS $${itbmsAmount}`;
        } else {
          // No declara: ITBMS como parte del costo
          entry.debit.push({ accountId: 'inventario-mercancia', name: 'Inventario de Mercancía', amount: r2(netAmount + itbmsAmount) });
        }
        const totalAmount = r2(netAmount + itbmsAmount);
        if (dialog.paymentMethod === 'TARJETA_CREDITO') {
          entry.credit.push({ accountId: 'tarjeta-credito', name: 'Tarjetas de Crédito', amount: totalAmount });
        } else if (dialog.paymentMethod === 'EFECTIVO') {
          entry.credit.push({ accountId: 'caja', name: 'Caja', amount: totalAmount });
        } else if (dialog.paymentMethod === 'CREDITO') {
          entry.credit.push({ accountId: 'proveedores', name: 'Proveedores', amount: totalAmount });
        } else {
          entry.credit.push({ accountId: 'proveedores', name: 'Proveedores', amount: totalAmount });
        }
        break;
      }
      case 'COBRO_CLIENTE': {
        entry.debit.push({ accountId: 'caja', name: 'Caja', amount: dialog.amount });
        entry.credit.push({ accountId: 'clientes', name: 'Clientes', amount: dialog.amount });
        break;
      }
      case 'PAGO_PROVEEDOR': {
        entry.debit.push({ accountId: 'proveedores', name: 'Proveedores', amount: dialog.amount });
        entry.credit.push({ accountId: 'banco-general', name: 'Bancos', amount: dialog.amount });
        break;
      }
      case 'INGRESO': {
        entry.debit.push({ accountId: 'caja', name: 'Caja', amount: dialog.amount });
        entry.credit.push({ accountId: classification.accountId, name: classification.concept, amount: dialog.amount });
        break;
      }
      case 'PRESTAMO': {
        entry.debit.push({ accountId: 'caja', name: 'Caja', amount: dialog.amount });
        entry.credit.push({ accountId: 'prestamos-lp', name: 'Préstamos Bancarios LP', amount: dialog.amount });
        break;
      }
      case 'PAGO_ITBMS': {
        entry.debit.push({ accountId: 'itbms-por-pagar', name: 'ITBMS por Pagar', amount: dialog.amount });
        entry.credit.push({ accountId: 'banco-general', name: 'Bancos', amount: dialog.amount });
        entry.description = `Pago de ITBMS a DGI - $${dialog.amount}`;
        break;
      }
    }

    return entry;
  }

  validateEntry(entry: AccountingEntry): { valid: boolean; error?: string } {
    const totalDebit = entry.debit.reduce((s, l) => s + l.amount, 0);
    const totalCredit = entry.credit.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return { valid: false, error: `Desbalance: Débito (${totalDebit}) ≠ Crédito (${totalCredit})` };
    }
    if (entry.debit.length === 0 || entry.credit.length === 0) {
      return { valid: false, error: 'Debe tener al menos un débito y un crédito' };
    }
    return { valid: true };
  }
}
