import { describe, it, expect } from 'vitest';
import { descripcionConsolidada } from '../payroll-run';

/**
 * La descripción del asiento de una corrida CONSOLIDADA (la semanal, que va en un solo
 * asiento). Es lo único que ve el contador en la cola de revisión antes de abrirla, así
 * que lo que dice importa: con un solo empleado tiene que decir SU nombre —"1 empleado"
 * obligaba a abrir la corrida para saber a quién se le estaba aprobando el asiento—, y
 * con varios el conteo, porque treinta nombres no se leen.
 */
describe('descripcionConsolidada', () => {
  const uno = [{ nombre: 'ALBRYND CASTILLO' }];
  const varios = [{ nombre: 'ALBRYND CASTILLO' }, { nombre: 'OTRO EMPLEADO' }];

  it('con UN empleado usa su nombre', () => {
    expect(descripcionConsolidada('SUELDO', uno, '2026-09-S1')).toBe('Planilla de ALBRYND CASTILLO — 2026-09-S1');
  });

  it('con varios cuenta los empleados', () => {
    expect(descripcionConsolidada('SUELDO', varios, '2026-09-S1')).toBe('Planilla de 2 empleados — 2026-09-S1');
  });

  it('nombra la prestación cuando no es sueldo', () => {
    expect(descripcionConsolidada('DECIMO', uno, '2026')).toBe('Décimo III de ALBRYND CASTILLO — 2026');
    expect(descripcionConsolidada('VACACIONES', varios, '2026-06')).toBe('Vacaciones de 2 empleados — 2026-06');
  });

  it('una corrida sin ítems no rompe la descripción', () => {
    expect(descripcionConsolidada('SUELDO', [], '2026-09-S1')).toBe('Planilla de 0 empleados — 2026-09-S1');
  });
});
