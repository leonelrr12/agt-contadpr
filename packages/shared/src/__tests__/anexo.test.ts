import { describe, it, expect } from 'vitest';
import { missingAnexoFields, esFilaCredito, proveedorAnexo } from '../anexo';

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

/**
 * El import de archivos del dueño trae RUC + DESCRIPCION, sin columna de
 * Nombre. En cuentas con Anexo (6.01.15 Gastos de Combustible…) la fila se
 * rechazaba con "Falta: Nombre" aunque la Descripción dice el comercio
 * ("Delta"). Ahora la Descripción es el Nombre SOLO en esas cuentas.
 */
describe('proveedorAnexo — Nombre del tercero para el Anexo', () => {
  const conAnexo = { requiresAnexo: true };

  it('manda la columna Proveedor/Nombre', () => {
    expect(proveedorAnexo({ provider: 'Delta', description: 'otra cosa' }, conAnexo)).toBe('Delta');
  });

  it('sin columna, usa la Descripción recortada', () => {
    expect(proveedorAnexo({ provider: null, description: '  Delta  ' }, conAnexo)).toBe('Delta');
  });

  it('sin Anexo no inventa proveedor (Comida no contamina) ', () => {
    expect(proveedorAnexo({ description: 'Almuerzo ejecutivo' }, { requiresAnexo: false })).toBeNull();
    expect(proveedorAnexo({ description: 'Almuerzo ejecutivo' }, null)).toBeNull();
  });

  it('sin proveedor ni descripción no hay Nombre', () => {
    expect(proveedorAnexo({}, conAnexo)).toBeNull();
  });

  it('con el Nombre desde la Descripción, el Anexo deja de pedirlo', () => {
    const row = { ruc: '11524-2-115657', description: 'Delta', paymentMethod: 'TARJETA_CREDITO' };
    expect(missingAnexoFields({ ...row, provider: proveedorAnexo(row, conAnexo) }, conAnexo)).toEqual([]);
  });
});
