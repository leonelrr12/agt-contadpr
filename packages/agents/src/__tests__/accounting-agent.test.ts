import { describe, it, expect } from 'vitest';
import { AccountingAgent } from '../accounting-agent';
import { basePrismaStub } from './stubs';
import type { DialogResult } from '../types';
import type { ClassificationResult } from '@agt-contador/shared';

function makePrismaStub() {
  return {
    ...basePrismaStub(),
    company: {
      findUnique: async () => ({ declaraITBMS: true }),
    },
    account: {
      findMany: async () => [
        { code: '1.1.01', id: 'caja-id', aliases: ['caja'] },
        { code: '1.1.02.01', id: 'banco-general-id', aliases: ['banco-general'] },
        { code: '1.1.03.01', id: 'clientes-id', aliases: ['clientes'] },
        { code: '2.1.03', id: 'tarjeta-credito-id', aliases: ['tarjeta-credito'] },
        { code: '2.1.01', id: 'proveedores-id', aliases: ['proveedores'] },
        { code: '1.1.04.01', id: 'inventario-mercancia-id', aliases: ['inventario-mercancia'] },
        { code: '2.2.01', id: 'prestamos-lp-id', aliases: ['prestamos-lp'] },
        { code: '4.01.01', id: 'ventas-id', aliases: ['ventas'] },
        { code: '6.06.01', id: 'gasto-id', aliases: ['gasto'] },
        { code: '1.1.05', id: 'itbms-por-cobrar-id', aliases: [] },
        { code: '2.1.05', id: 'itbms-por-pagar-id', aliases: ['itbms-por-pagar'] },
        { code: '6.05.01', id: 'itbms-gastado-id', aliases: ['itbms-gastado'] },
      ],
    },
  };
}

describe('AccountingAgent', () => {
  describe('validateEntry', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    it('accepts a balanced entry', () => {
      const result = agent.validateEntry({
        debit: [{ accountId: 'a', name: 'Gasto', amount: 100 }],
        credit: [{ accountId: 'b', name: 'Caja', amount: 100 }],
        description: 'test',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects unbalanced entry', () => {
      const result = agent.validateEntry({
        debit: [{ accountId: 'a', name: 'Gasto', amount: 100 }],
        credit: [{ accountId: 'b', name: 'Caja', amount: 50 }],
        description: 'test',
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Desbalance');
    });

    it('rejects entry with no credit lines', () => {
      const result = agent.validateEntry({
        debit: [{ accountId: 'a', name: 'Gasto', amount: 100 }],
        credit: [],
        description: 'test',
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('generateEntry - GASTO', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'GASTO',
      amount: 40,
      currency: 'USD',
      description: 'Compré combustible por $40 con efectivo',
      provider: null,
      concept: 'Combustible',
      paymentMethod: 'EFECTIVO',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
    };

    const classification: ClassificationResult = {
      concept: 'Combustible',
      accountId: 'gasto-id',
      confidence: 0.95,
    };

    it('creates debit for the expense account', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toHaveLength(1);
      expect(entry.debit[0].accountId).toBe('gasto-id');
      expect(entry.debit[0].amount).toBe(40);
    });

    it('creates credit for cash when payment is EFECTIVO', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit).toHaveLength(1);
      expect(entry.credit[0].accountId).toBe('caja');
      expect(entry.credit[0].amount).toBe(40);
    });

    it('uses tarjeta-credito alias when payment is TARJETA_CREDITO', () => {
      const cardDialog = { ...dialog, paymentMethod: 'TARJETA_CREDITO' };
      const entry = agent.generateEntry(cardDialog, classification);
      expect(entry.credit[0].accountId).toBe('tarjeta-credito');
    });

    it('uses banco-general alias for other payment methods', () => {
      const transferDialog = { ...dialog, paymentMethod: 'TRANSFERENCIA' };
      const entry = agent.generateEntry(transferDialog, classification);
      expect(entry.credit[0].accountId).toBe('banco-general');
    });

    it('credits proveedores when payment is CREDITO (supplier credit)', () => {
      const creditDialog = { ...dialog, paymentMethod: 'CREDITO' };
      const entry = agent.generateEntry(creditDialog, classification);
      expect(entry.credit[0].accountId).toBe('proveedores');
    });

    // El asiento se describe con el Detalle del movimiento (lo que decía el
    // archivo importado); la clasificación se ve en la cuenta de cada línea.
    it('describe el asiento con el detalle, no con el concepto clasificado', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.description).toBe('Compré combustible por $40 con efectivo — $40.00');
    });

    it('cae al concepto cuando el movimiento no trae detalle', () => {
      const sinDetalle = { ...dialog, description: '' };
      const entry = agent.generateEntry(sinDetalle, classification);
      expect(entry.description).toBe('Combustible — $40.00');
    });
  });

  describe('generateEntry - VENTA', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'VENTA',
      amount: 250,
      currency: 'USD',
      description: 'Vendí $250 en efectivo',
      provider: null,
      concept: 'Ventas',
      paymentMethod: 'EFECTIVO',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
    };

    const classification: ClassificationResult = {
      concept: 'Ventas',
      accountId: 'ventas-id',
      confidence: 0.95,
    };

    it('debits cash for cash sales', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit[0].accountId).toBe('caja');
    });

    it('debits clientes for non-cash sales', () => {
      const creditDialog = { ...dialog, paymentMethod: 'TARJETA_CREDITO' };
      const entry = agent.generateEntry(creditDialog, classification);
      expect(entry.debit[0].accountId).toBe('clientes');
    });

    it('credits the sales account', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit).toHaveLength(1);
      expect(entry.credit[0].accountId).toBe('ventas-id');
      expect(entry.credit[0].amount).toBe(250);
    });

    it('is balanced', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(agent.validateEntry(entry).valid).toBe(true);
    });
  });

  describe('generateEntry - COMPRA con ITBMS', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'COMPRA',
      amount: 100,
      currency: 'USD',
      description: 'Compra de mercancía por $100 con ITBMS',
      concept: 'Compra de mercancía',
      provider: null,
      paymentMethod: 'TRANSFERENCIA',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
      itbmsRate: 0.07,
      itbmsAmount: 7,
    };

    const classification: ClassificationResult = {
      concept: 'Compra de mercancía',
      accountId: 'inventario-mercancia-id',
      confidence: 0.95,
    };

    it('splits debit into inventory and ITBMS por Pagar', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toHaveLength(2);
      expect(entry.debit[0].accountId).toBe('inventario-mercancia');
      expect(entry.debit[0].amount).toBe(100);
      expect(entry.debit[1].accountId).toBe('itbms-por-pagar');
      expect(entry.debit[1].amount).toBe(7);
    });

    it('total credit equals total debit (balanced)', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit[0].amount).toBe(107);
      expect(agent.validateEntry(entry).valid).toBe(true);
    });

    it('generates correct description with ITBMS', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.description).toContain('+ ITBMS $7');
    });

    it('credits caja when payment is EFECTIVO for COMPRA', () => {
      const cashDialog = { ...dialog, paymentMethod: 'EFECTIVO' };
      const entry = agent.generateEntry(cashDialog, classification);
      expect(entry.credit[0].accountId).toBe('caja');
      expect(entry.credit[0].name).toBe('Caja');
    });

    it('credits proveedores when payment is CREDITO (supplier credit)', () => {
      const creditDialog = { ...dialog, paymentMethod: 'CREDITO' };
      const entry = agent.generateEntry(creditDialog, classification);
      expect(entry.credit[0].accountId).toBe('proveedores');
      expect(entry.credit[0].name).toBe('Proveedores');
    });

    // Pago por banco (no a crédito): el crédito va a la cuenta bancaria, no a
    // proveedores — una compra pagada por transferencia/cheque no genera deuda.
    it('credits banco for COMPRA paid by TRANSFERENCIA', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit[0].accountId).toBe('banco-general');
      expect(entry.credit[0].name).toBe('Bancos');
    });

    it('credits banco for COMPRA paid by CHEQUE', () => {
      const chequeDialog = { ...dialog, paymentMethod: 'CHEQUE' };
      const entry = agent.generateEntry(chequeDialog, classification);
      expect(entry.credit[0].accountId).toBe('banco-general');
    });

    it('credits banco when COMPRA has no payment method (banco por defecto)', () => {
      const noMethodDialog = { ...dialog, paymentMethod: null };
      const entry = agent.generateEntry(noMethodDialog, classification);
      expect(entry.credit[0].accountId).toBe('banco-general');
    });

    it('credits tarjeta-credito when payment is TARJETA_CREDITO for COMPRA', () => {
      const cardDialog = { ...dialog, paymentMethod: 'TARJETA_CREDITO' };
      const entry = agent.generateEntry(cardDialog, classification);
      expect(entry.credit[0].accountId).toBe('tarjeta-credito');
    });
  });

  describe('generateEntry - VENTA con ITBMS', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'VENTA',
      amount: 200,
      currency: 'USD',
      description: 'Venta de producto por $200 con ITBMS',
      concept: 'Ventas',
      provider: null,
      paymentMethod: 'EFECTIVO',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
      itbmsRate: 0.07,
      itbmsAmount: 14,
    };

    const classification: ClassificationResult = {
      concept: 'Ventas',
      accountId: 'ventas-id',
      confidence: 0.95,
    };

    it('debits total (sale + ITBMS) to cash', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toHaveLength(1);
      expect(entry.debit[0].accountId).toBe('caja');
      expect(entry.debit[0].amount).toBe(214);
    });

    it('credits sales account and ITBMS por Pagar', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit).toHaveLength(2);
      expect(entry.credit[0].accountId).toBe('ventas-id');
      expect(entry.credit[0].amount).toBe(200);
      expect(entry.credit[1].accountId).toBe('itbms-por-pagar');
      expect(entry.credit[1].amount).toBe(14);
    });

    it('is balanced', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(agent.validateEntry(entry).valid).toBe(true);
    });
  });

  describe('generateEntry - PAGO_ITBMS', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'PAGO_ITBMS',
      amount: 150,
      currency: 'USD',
      description: 'Pago de ITBMS a DGI',
      concept: 'Pago de ITBMS',
      provider: null,
      paymentMethod: 'TRANSFERENCIA',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
    };

    const classification: ClassificationResult = {
      concept: 'Pago de ITBMS',
      accountId: '',
      confidence: 0,
    };

    it('debits ITBMS por Pagar and credits bank', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toHaveLength(1);
      expect(entry.debit[0].accountId).toBe('itbms-por-pagar');
      expect(entry.debit[0].amount).toBe(150);
      expect(entry.credit).toHaveLength(1);
      expect(entry.credit[0].accountId).toBe('banco-general');
      expect(entry.credit[0].amount).toBe(150);
    });

    it('is balanced', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(agent.validateEntry(entry).valid).toBe(true);
    });
  });

  // Espejo de PRESTAMO: la cuota baja el pasivo en vez de registrar que el
  // préstamo entró (antes "pago de préstamo" debitaba Caja).
  describe('generateEntry - PAGO_PRESTAMO', () => {
    const agent = new AccountingAgent(makePrismaStub(), 'demo-company');

    const dialog: DialogResult = {
      type: 'PAGO_PRESTAMO',
      amount: 320.5,
      currency: 'USD',
      description: 'Cuota del préstamo Banco Nacional',
      concept: 'Préstamos Bancarios LP',
      provider: null,
      paymentMethod: 'TRANSFERENCIA',
      date: '2026-07-10',
      confidence: 0.95,
      missingFields: [],
      suggestedResponse: '',
    };

    const classification: ClassificationResult = {
      concept: 'Préstamos Bancarios LP',
      accountId: 'prestamos-id',
      confidence: 0.9,
    };

    it('debita el pasivo y acredita el banco', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toEqual([{ accountId: 'prestamos-lp', name: 'Préstamos Bancarios LP', amount: 320.5 }]);
      expect(entry.credit).toEqual([{ accountId: 'banco-general', name: 'Bancos', amount: 320.5 }]);
      expect(agent.validateEntry(entry).valid).toBe(true);
    });

    it('sale de Caja si la cuota se pagó en efectivo', () => {
      const entry = agent.generateEntry({ ...dialog, paymentMethod: 'EFECTIVO' }, classification);
      expect(entry.credit[0].accountId).toBe('caja');
    });
  });

  describe('resolveAlias', () => {
    it('resolves known aliases after init', async () => {
      const agent = new AccountingAgent(makePrismaStub(), 'demo-company');
      await agent.init();
      expect(agent.resolveAlias('caja')).toBe('caja-id');
      expect(agent.resolveAlias('clientes')).toBe('clientes-id');
    });

    it('throws for unknown alias', async () => {
      const agent = new AccountingAgent(makePrismaStub(), 'demo-company');
      await agent.init();
      expect(() => agent.resolveAlias('unknown')).toThrow('Cuenta contable no encontrada');
    });
  });
});
