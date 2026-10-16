/**
 * El reintento de la narrativa: cuando el modelo se pasa del techo de tokens, se le
 * pide una versión breve en vez de dejar el panel sin narrativa.
 *
 * Es la mitad del arreglo del 15-10-2026 que no se puede probar desde
 * `interpretarNarrativa` (que es pura): acá se ejercita el ida y vuelta con el modelo,
 * con el cliente de DeepSeek de mentira. Lo que se vigila:
 *
 *  · que una respuesta cortada **reintente** en vez de rendirse;
 *  · que el reintento pida de verdad menos (si alguien edita `NARRATIVA_SYSTEM` y el
 *    `.replace()` deja de coincidir, el prompt «breve» sería idéntico al largo y el
 *    reintento no serviría para nada — sin que nada avise);
 *  · que si el segundo intento también falla, devuelva null y no explote.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** Lo que devolverá cada llamada al modelo, en orden. */
const respuestas: any[] = [];
const llamadas: any[] = [];

vi.mock('openai', () => ({
  default: class {
    chat = {
      completions: {
        create: async (args: any) => {
          llamadas.push(args);
          const r = respuestas.shift();
          if (r instanceof Error) throw r;
          return r;
        },
      },
    };
  },
}));

const { generateNarrativa, NARRATIVA_SYSTEM_BREVE } = await import('../salud');

const PAYLOAD: any = {
  fecha: '2026-10-16',
  ratios: { liquidez: 5.21, deltas: {} },
  caja: { saldoActual: 3100 },
  monthly: [{ month: '2026-09', ingresos: 15200, gastos: 13100, neto: 2100 }],
  proyeccion: [{ month: '2026-11', label: 'nov', entradas: 18000, salidas: 14000, saldoFinal: 7000 }],
  horizonte: 3,
  alertas: [{ severidad: 'warning', mensaje: '2 facturas por pagar vencidas' }],
};

const CORTADA = '{\n  "resumen": "La empresa mantiene una posición de liquidez sólida",\n  "alertas": ["El margen bajó 2 puntos en sep';
const BREVE = JSON.stringify({ resumen: 'Liquidez sólida, margen en baja.', alertas: ['Cobrar vencidas.'], recomendaciones: ['Revisar gastos.'] });

const respuesta = (content: string, finish: string) => ({ choices: [{ message: { content }, finish_reason: finish }] });

beforeEach(() => {
  respuestas.length = 0;
  llamadas.length = 0;
  process.env.DEEPSEEK_API_KEY = 'clave-de-prueba';
});

afterEach(() => { delete process.env.DEEPSEEK_API_KEY; });

describe('el reintento de la narrativa', () => {
  it('⭐ si la respuesta viene cortada, reintenta y se queda con la breve', async () => {
    respuestas.push(respuesta(CORTADA, 'length'), respuesta(BREVE, 'stop'));

    const narrativa = await generateNarrativa(PAYLOAD);

    expect(narrativa?.resumen).toContain('Liquidez sólida');
    expect(llamadas).toHaveLength(2);
    // El segundo intento pide brevedad de verdad, no el mismo prompt.
    expect(llamadas[1].messages[0].content).toBe(NARRATIVA_SYSTEM_BREVE);
    expect(NARRATIVA_SYSTEM_BREVE).not.toBe(llamadas[0].messages[0].content);
    expect(NARRATIVA_SYSTEM_BREVE.length).toBeLessThan(llamadas[0].messages[0].content.length);
  });

  it('el prompt breve pide menos: 2 frases, 2 alertas y 2 recomendaciones', () => {
    expect(NARRATIVA_SYSTEM_BREVE).toContain('"resumen": "párrafo de 2 frases"');
    expect(NARRATIVA_SYSTEM_BREVE).toContain('Máximo 2 alertas y 2 recomendaciones.');
    expect(NARRATIVA_SYSTEM_BREVE).not.toContain('2-4 frases');
    expect(NARRATIVA_SYSTEM_BREVE).not.toContain('Máximo 4 alertas');
  });

  it('una respuesta buena no se reintenta (una sola llamada)', async () => {
    respuestas.push(respuesta(BREVE, 'stop'));

    const narrativa = await generateNarrativa(PAYLOAD);

    expect(narrativa?.recomendaciones).toHaveLength(1);
    expect(llamadas).toHaveLength(1);
  });

  it('si el reintento también se corta, devuelve null y no explota', async () => {
    respuestas.push(respuesta(CORTADA, 'length'), respuesta(CORTADA, 'length'));

    await expect(generateNarrativa(PAYLOAD)).resolves.toBeNull();
    expect(llamadas).toHaveLength(2); // un reintento, no un bucle
  });

  it('un error del proveedor se traga y devuelve null (el panel degrada)', async () => {
    respuestas.push(new Error('Unterminated string in JSON at position 1999 (line 13 column 191)'));

    await expect(generateNarrativa(PAYLOAD)).resolves.toBeNull();
  });

  it('sin clave del modelo no se llama a nadie', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    await expect(generateNarrativa(PAYLOAD)).resolves.toBeNull();
    expect(llamadas).toHaveLength(0);
  });
});
