import { describe, it, expect } from 'vitest';
import { DialogAgent } from '../dialog-agent';

const agent = new DialogAgent();

describe('DialogAgent', () => {
  describe('processInput - GASTO', () => {
    it('detects combustible purchase with cash', () => {
      const result = agent.processInput('Compré combustible por $40 con efectivo');
      expect(result.type).toBe('GASTO');
      expect(result.concept).toBe('Combustible');
      expect(result.amount).toBe(40);
      expect(result.paymentMethod).toBe('EFECTIVO');
      expect(result.missingFields).toHaveLength(0);
    });

    it('detects electricity payment with card', () => {
      const result = agent.processInput('Pagué la electricidad por $23 con tarjeta');
      expect(result.type).toBe('GASTO');
      expect(result.concept).toBe('Electricidad');
      expect(result.amount).toBe(23);
      expect(result.paymentMethod).toBe('TARJETA_CREDITO');
    });

    it('detects internet expense', () => {
      const result = agent.processInput('Compré internet por $80');
      expect(result.type).toBe('GASTO');
      expect(result.concept).toBe('Internet');
      expect(result.amount).toBe(80);
      expect(result.paymentMethod).toBeNull();
      expect(result.missingFields).toContain('paymentMethod');
    });
  });

  describe('processInput - VENTA', () => {
    it('detects a sale in cash', () => {
      const result = agent.processInput('Vendí $250 en efectivo');
      expect(result.type).toBe('VENTA');
      expect(result.concept).toBe('Ventas');
      expect(result.amount).toBe(250);
      expect(result.paymentMethod).toBe('EFECTIVO');
    });

    it('detects a sale without payment method', () => {
      const result = agent.processInput('Vendí $356');
      expect(result.type).toBe('VENTA');
      expect(result.amount).toBe(356);
      expect(result.missingFields).toContain('paymentMethod');
    });
  });

  describe('processInput - date parsing', () => {
    it('uses today when no date is given', () => {
      const result = agent.processInput('Compré comida por $10');
      const today = new Date().toISOString().split('T')[0];
      expect(result.date).toBe(today);
    });

    it('parses "ayer" as yesterday', () => {
      const result = agent.processInput('Compré comida por $10 ayer');
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      expect(result.date).toBe(yesterday.toISOString().split('T')[0]);
    });
  });

  describe('processInput - missing fields', () => {
    it('reports missing amount', () => {
      const result = agent.processInput('Compré combustible con tarjeta');
      expect(result.missingFields).toContain('amount');
      expect(result.confidence).toBeLessThan(0.95);
    });

    it('reports missing fields when input is vague', () => {
      const result = agent.processInput('Hola');
      expect(result.missingFields.length).toBeGreaterThan(0);
    });
  });

  describe('buildPrompt', () => {
    it('asks for amount', () => {
      expect(agent.buildPrompt(['amount'])).toBe('¿Cuánto fue el monto?');
    });
    it('asks for concept', () => {
      expect(agent.buildPrompt(['concept'])).toBe('¿A qué categoría pertenece?');
    });
    it('asks for payment method', () => {
      expect(agent.buildPrompt(['paymentMethod'])).toBe('¿Cómo se pagó? (Efectivo, Tarjeta, Banco, Transferencia)');
    });
    it('asks for type', () => {
      expect(agent.buildPrompt(['type'])).toBe('¿Qué tipo de transacción es? (Gasto, Venta, Compra)');
    });
  });

  describe('processInput with context', () => {
    it('fills missing fields from previous context', () => {
      const context = {
        messages: [],
        extractedData: {
          type: 'GASTO' as const,
          amount: 40,
          concept: 'Combustible',
          paymentMethod: 'TARJETA_CREDITO',
          date: '2026-07-10',
          currency: 'USD',
          description: '',
          confidence: 0.95,
          missingFields: [],
          suggestedResponse: '',
        },
      };
      const result = agent.processInput('con tarjeta', context);
      expect(result.type).toBe('GASTO');
      expect(result.amount).toBe(40);
      expect(result.concept).toBe('Combustible');
    });
  });
});
