import { describe, it, expect } from 'vitest';
import { evaluarElegibilidadOCR } from '../ocr';

/**
 * Una foto en blanco (o de cualquier cosa que no sea un recibo) no debe
 * ofrecerse como transacción. La regla: hace falta al menos uno de los tres
 * datos clave —monto, RUC o proveedor— además de texto legible.
 */
describe('evaluarElegibilidadOCR', () => {
  const base = { text: 'FACTURA No. 001', total: null, provider: null, ruc: null };

  it('rechaza una imagen sin texto (foto en blanco)', () => {
    const r = evaluarElegibilidadOCR({ ...base, text: '' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blanco|texto/i);
  });

  it('rechaza texto que no es de un documento (solo espacios)', () => {
    const r = evaluarElegibilidadOCR({ ...base, text: '   \n\t ' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/blanco|texto/i);
  });

  it('rechaza texto legible sin monto, RUC ni proveedor', () => {
    const r = evaluarElegibilidadOCR({ ...base, text: 'La reunión es el martes a las 3' });
    expect(r.eligible).toBe(false);
    expect(r.reason).toMatch(/monto, RUC ni proveedor/i);
  });

  it('acepta cuando detecta un monto', () => {
    expect(evaluarElegibilidadOCR({ ...base, total: 40.5 }).eligible).toBe(true);
  });

  it('acepta cuando detecta un RUC aunque falte el monto', () => {
    expect(evaluarElegibilidadOCR({ ...base, ruc: '8-123-456' }).eligible).toBe(true);
  });

  it('acepta cuando detecta un proveedor aunque falte el monto', () => {
    expect(evaluarElegibilidadOCR({ ...base, provider: 'Distribuidora XYZ' }).eligible).toBe(true);
  });

  it('un documento completo es elegible y no trae motivo', () => {
    const r = evaluarElegibilidadOCR({
      text: 'FACTURA\nDistribuidora XYZ\nRUC 8-123-456\nTotal $40.50',
      total: 40.5,
      provider: 'Distribuidora XYZ',
      ruc: '8-123-456',
    });
    expect(r.eligible).toBe(true);
    expect(r.reason).toBeNull();
  });
});
