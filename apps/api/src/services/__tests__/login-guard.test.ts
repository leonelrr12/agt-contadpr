import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { bloqueoRestante, registrarFallo, limpiarFallos, _resetLoginGuard } from '../login-guard';

/**
 * Freno a la fuerza bruta por cuenta en el login. Lo que fija:
 *  · 5 fallos bloquean 15 minutos (y antes de eso no bloquea nada);
 *  · un login correcto limpia la cuenta (no castiga al que se equivocó y entró);
 *  · los fallos viejos no se acumulan para siempre (ventana de 15 min);
 *  · el correo se normaliza (mayúsculas/espacios no abren un carril nuevo).
 */
describe('login-guard: backoff por cuenta', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-09T15:00:00Z'));
    _resetLoginGuard();
  });
  afterEach(() => vi.useRealTimers());

  it('bloquea recién al quinto fallo', () => {
    for (let i = 0; i < 4; i++) registrarFallo('ana@empresa.com');
    expect(bloqueoRestante('ana@empresa.com')).toBe(0); // 4 fallos: todavía no

    registrarFallo('ana@empresa.com');
    expect(bloqueoRestante('ana@empresa.com')).toBe(15 * 60 * 1000);
  });

  it('el bloqueo expira solo', () => {
    for (let i = 0; i < 5; i++) registrarFallo('ana@empresa.com');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(bloqueoRestante('ana@empresa.com')).toBe(0);
  });

  it('un login correcto limpia los fallos acumulados', () => {
    for (let i = 0; i < 4; i++) registrarFallo('ana@empresa.com');
    limpiarFallos('ana@empresa.com');
    for (let i = 0; i < 4; i++) registrarFallo('ana@empresa.com');
    expect(bloqueoRestante('ana@empresa.com')).toBe(0); // 4 + 4 no suman 8
  });

  it('los fallos viejos no cuentan: pasada la ventana, la cuenta arranca de cero', () => {
    for (let i = 0; i < 4; i++) registrarFallo('ana@empresa.com');
    vi.advanceTimersByTime(15 * 60 * 1000 + 1); // la ventana se venció
    registrarFallo('ana@empresa.com');          // este es el fallo nº 1 otra vez
    expect(bloqueoRestante('ana@empresa.com')).toBe(0);
  });

  it('el email se normaliza: mayúsculas y espacios son la misma cuenta', () => {
    for (let i = 0; i < 5; i++) registrarFallo('  Ana@Empresa.com ');
    expect(bloqueoRestante('ana@empresa.com')).toBeGreaterThan(0);
  });

  it('las cuentas son independientes', () => {
    for (let i = 0; i < 5; i++) registrarFallo('ana@empresa.com');
    expect(bloqueoRestante('luis@empresa.com')).toBe(0);
  });
});
