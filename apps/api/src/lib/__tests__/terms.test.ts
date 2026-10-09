import { describe, it, expect } from 'vitest';
import { TERMS_VERSION, necesitaAceptar } from '../terms';

/**
 * El aviso de re-aceptación depende de esta comparación. Los casos que importan:
 * las cuentas creadas antes de que existiera el registro (sin constancia) y las
 * que aceptaron una versión vieja tienen que verlo; la que aceptó la vigente, no.
 */
describe('necesitaAceptar', () => {
  it('sin constancia (cuenta vieja): sí', () => {
    expect(necesitaAceptar(null)).toBe(true);
    expect(necesitaAceptar(undefined)).toBe(true);
    expect(necesitaAceptar('')).toBe(true);
  });

  it('con la versión vigente: no', () => {
    expect(necesitaAceptar(TERMS_VERSION)).toBe(false);
  });

  it('con una versión anterior: sí', () => {
    expect(necesitaAceptar('2025-01-01')).toBe(true);
  });
});
