import { describe, it, expect } from 'vitest';
import { AccountingAgent } from '../accounting-agent';
import type { DialogResult } from '../types';
import type { ClassificationResult } from '@agt-contador/shared';

function makePrismaStub() {
  return {
    account: {
      findMany: async () => [
        { code: '1.1.01', id: 'caja-id' },
        { code: '1.1.02.01', id: 'banco-general-id' },
        { code: '1.1.03.01', id: 'clientes-id' },
        { code: '2.1.03', id: 'tarjeta-credito-id' },
        { code: '2.1.01', id: 'proveedores-id' },
        { code: '1.1.04.01', id: 'inventario-mercancia-id' },
        { code: '2.2.01', id: 'prestamos-lp-id' },
        { code: '4.01.01', id: 'ventas-id' },
        { code: '6.06.01', id: 'gasto-id' },
        { code: '1.1.05', id: 'itbms-por-cobrar-id' },
        { code: '2.1.05', id: 'itbms-por-pagar-id' },
        { code: '6.05.01', id: 'itbms-gastado-id' },
      ],
    },
  };
}

describe('AccountingAgent', () => {
  describe('validateEntry', () => {
    const agent = new AccountingAgent(makePrismaStub());

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
    const agent = new AccountingAgent(makePrismaStub());

    const dialog: DialogResult = {
      type: 'GASTO',
      amount: 40,
      currency: 'USD',
      description: 'Compré combustible por $40 con efectivo',
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
  });

  describe('generateEntry - VENTA', () => {
    const agent = new AccountingAgent(makePrismaStub());

    const dialog: DialogResult = {
      type: 'VENTA',
      amount: 250,
      currency: 'USD',
      description: 'Vendí $250 en efectivo',
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
    const agent = new AccountingAgent(makePrismaStub());

    const dialog: DialogResult = {
      type: 'COMPRA',
      amount: 100,
      currency: 'USD',
      description: 'Compra de mercancía por $100 con ITBMS',
      concept: 'Compra de mercancía',
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

    it('splits debit into inventory and ITBMS por Cobrar', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.debit).toHaveLength(2);
      expect(entry.debit[0].accountId).toBe('inventario-mercancia');
      expect(entry.debit[0].amount).toBe(100);
      expect(entry.debit[1].accountId).toBe('itbms-por-cobrar');
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

    it('credits proveedores by default for COMPRA (null, TRANSFERENCIA, CHEQUE)', () => {
      const entry = agent.generateEntry(dialog, classification);
      expect(entry.credit[0].accountId).toBe('proveedores');
    });

    it('credits tarjeta-credito when payment is TARJETA_CREDITO for COMPRA', () => {
      const cardDialog = { ...dialog, paymentMethod: 'TARJETA_CREDITO' };
      const entry = agent.generateEntry(cardDialog, classification);
      expect(entry.credit[0].accountId).toBe('tarjeta-credito');
    });
  });

  describe('generateEntry - VENTA con ITBMS', () => {
    const agent = new AccountingAgent(makePrismaStub());

    const dialog: DialogResult = {
      type: 'VENTA',
      amount: 200,
      currency: 'USD',
      description: 'Venta de producto por $200 con ITBMS',
      concept: 'Ventas',
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
    const agent = new AccountingAgent(makePrismaStub());

    const dialog: DialogResult = {
      type: 'PAGO_ITBMS',
      amount: 150,
      currency: 'USD',
      description: 'Pago de ITBMS a DGI',
      concept: 'Pago de ITBMS',
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

  describe('resolveAlias', () => {
    it('resolves known aliases after init', async () => {
      const agent = new AccountingAgent(makePrismaStub());
      await agent.init();
      expect(agent.resolveAlias('caja')).toBe('caja-id');
      expect(agent.resolveAlias('clientes')).toBe('clientes-id');
    });

    it('throws for unknown alias', async () => {
      const agent = new AccountingAgent(makePrismaStub());
      await agent.init();
      expect(() => agent.resolveAlias('unknown')).toThrow('Cuenta contable no encontrada');
    });
  });
});
