import { describe, it, expect } from 'vitest';
import { resolveAccount } from '../account-resolver';

/**
 * Resolución de la cuenta de banco/caja de la columna "Banco/Cuenta" de un
 * archivo importado. Lo importante: "1.1.02.01 Banco General" (código + nombre
 * en la misma celda) DEBE resolver — antes no lo hacía y la fila caía en
 * silencio al banco por defecto.
 */
const cuentas = [
  { id: 'a1', code: '1.1.02.01', name: 'Banco General', aliases: ['banco-general'] },
  { id: 'a2', code: '1.1.02.02', name: 'Banistmo', aliases: [] },
  { id: 'a3', code: '1.1.01', name: 'Caja', aliases: [] },
  { id: 'a4', code: '6.1.01', name: 'Gastos de Papelería', aliases: [] },
];

describe('resolveAccount — código y nombre', () => {
  it.each([
    ['1.1.02.01 Banco General', 'a1'],
    ['1.1.02.01 - Banco General', 'a1'],
    ['Banco General 1.1.02.01', 'a1'],
    ['1.1.02.01/banco general', 'a1'],
    // Regresiones: código solo, nombre solo, con typo
    ['1.1.02.01', 'a1'],
    ['banco general', 'a1'],
    ['BANCO GENERAL, S.A.', 'a1'],
    ['Banco Gnral', 'a1'],
  ])('%s → %s', (valor, esperado) => {
    expect(resolveAccount(cuentas as any, valor)?.id).toBe(esperado);
  });

  it('no inventa con un código que no existe aunque el nombre sí (cae al default, no adivina)', () => {
    expect(resolveAccount(cuentas as any, '1.1.02.99 Banco General')).toBeNull();
  });

  it('un nombre genérico ("Bancos") no resuelve: no hay cuenta que inventar', () => {
    expect(resolveAccount(cuentas as any, 'Bancos')).toBeNull();
  });
});
