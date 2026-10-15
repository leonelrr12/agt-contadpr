/**
 * Lectura de la narrativa que devuelve DeepSeek.
 *
 * Lo que costó (arreglado el 15-10-2026): con `max_tokens: 600` y un resumen rico, la
 * API cortaba la respuesta a media cadena y el `JSON.parse` reventaba con
 * «Unterminated string in JSON at position ~2000» — 3 veces en el log de producción.
 * Ahora el techo es 1.500, el motivo se distingue (cortada ≠ no-JSON) y una respuesta
 * cortada se reintenta una vez pidiendo brevedad.
 */

import { describe, it, expect } from 'vitest';
import { interpretarNarrativa } from '../salud';

const VALIDA = JSON.stringify({
  resumen: 'La empresa mantiene una posición de liquidez sólida.',
  alertas: ['El margen bajó 2 puntos en septiembre.', 'Hay 3 facturas vencidas por cobrar.'],
  recomendaciones: ['Cobrar las facturas vencidas esta semana.', 'Revisar el gasto de planilla.'],
});

describe('interpretarNarrativa', () => {
  it('respuesta completa: devuelve la narrativa', () => {
    const { narrativa, motivo } = interpretarNarrativa(VALIDA, 'stop');
    expect(motivo).toBeUndefined();
    expect(narrativa?.resumen).toContain('liquidez sólida');
    expect(narrativa?.alertas).toHaveLength(2);
    expect(narrativa?.recomendaciones).toHaveLength(2);
  });

  it('recorta a 4 alertas y 4 recomendaciones aunque el modelo se pase', () => {
    const larga = JSON.stringify({
      resumen: 'ok',
      alertas: Array.from({ length: 9 }, (_, i) => `alerta ${i}`),
      recomendaciones: Array.from({ length: 7 }, (_, i) => `rec ${i}`),
    });
    const { narrativa } = interpretarNarrativa(larga, 'stop');
    expect(narrativa?.alertas).toHaveLength(4);
    expect(narrativa?.recomendaciones).toHaveLength(4);
  });

  it('⭐ respuesta cortada por el techo de tokens: lo dice, y NO como JSON roto', () => {
    // Así se veía en producción: el JSON se corta dentro de una cadena.
    const cortada = '{\n  "resumen": "La empresa mantiene una posición de liquidez",\n  "alertas": ["El margen bajó 2 puntos en sep';
    const { narrativa, motivo } = interpretarNarrativa(cortada, 'length');
    expect(narrativa).toBeNull();
    expect(motivo).toContain('cortada por max_tokens');
    expect(motivo).toContain(String(cortada.length));
  });

  it('texto que no es JSON: se distingue de la respuesta cortada', () => {
    const { narrativa, motivo } = interpretarNarrativa('Aquí tienes el análisis: ...', 'stop');
    expect(narrativa).toBeNull();
    expect(motivo).toContain('no es JSON válido');
  });

  it('JSON sin resumen utilizable: se descarta', () => {
    expect(interpretarNarrativa('{"alertas": []}', 'stop').motivo).toContain('"resumen"');
    expect(interpretarNarrativa('{"resumen": "   "}', 'stop').motivo).toContain('"resumen"');
  });

  it('sin alertas ni recomendaciones, el resumen igual sirve', () => {
    const { narrativa } = interpretarNarrativa('{"resumen": "Todo en orden."}', 'stop');
    expect(narrativa?.resumen).toBe('Todo en orden.');
    expect(narrativa?.alertas).toEqual([]);
    expect(narrativa?.recomendaciones).toEqual([]);
  });
});
