import { describe, it, expect } from 'vitest';
import { ultimosMeses } from '../payroll-css';

/**
 * El único tramo puro del módulo de CSS. Se prueba porque el cruce de año es
 * exactamente donde estos helpers se rompen en silencio: en enero, "los últimos 6
 * meses" tienen que ser del año anterior y el orden tiene que seguir siendo
 * cronológico.
 */
describe('ultimosMeses', () => {
  it('devuelve los últimos N meses, del más viejo al más nuevo', () => {
    expect(ultimosMeses(3, new Date(2026, 8, 25))).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('cruza el año sin inventarse meses', () => {
    expect(ultimosMeses(4, new Date(2026, 1, 10))).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('un solo mes es el mes corriente', () => {
    expect(ultimosMeses(1, new Date(2026, 0, 1))).toEqual(['2026-01']);
  });

  it('rellena el mes con dos dígitos', () => {
    for (const periodo of ultimosMeses(12, new Date(2026, 11, 31))) {
      expect(periodo).toMatch(/^\d{4}-\d{2}$/);
    }
  });
});
