import { describe, it, expect } from 'vitest';
import { missingAnexoFields, esFilaCredito } from '../anexo';

describe('reglas de Anexo DGI', () => {
  const cuenta = { requiresAnexo: true };

  it('una cuenta sin el flag no exige nada', () => {
    expect(missingAnexoFields({}, { requiresAnexo: false })).toEqual([]);
    expect(missingAnexoFields({}, null)).toEqual([]);
  });

  it('con el flag exige RUC/Cédula y Nombre', () => {
    expect(missingAnexoFields({ paymentMethod: 'TRANSFERENCIA' }, cuenta)).toEqual(['RUC/Cédula', 'Nombre']);
  });

  it('a crédito exige además el Nº de factura', () => {
    const missing = missingAnexoFields({ paymentMethod: 'CREDITO' }, cuenta);
    expect(missing).toContain('Nº de factura (obligatorio en crédito)');
  });

  it('con todos los datos no falta nada', () => {
    expect(missingAnexoFields({
      ruc: '8-123-456',
      provider: 'Distribuidora XYZ',
      reference: 'A-000123',
      paymentMethod: 'CREDITO',
    }, cuenta)).toEqual([]);
  });

  it('la tarjeta de crédito no cuenta como crédito', () => {
    expect(esFilaCredito({ paymentMethod: 'TARJETA_CREDITO' })).toBe(false);
    expect(esFilaCredito({ paymentMethod: 'CREDITO' })).toBe(true);
  });
});
