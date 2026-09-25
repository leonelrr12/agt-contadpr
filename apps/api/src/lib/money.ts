/**
 * Redondeo monetario del módulo de Planilla.
 *
 * Existe porque `Math.round` NO es de fiar con los céntimos: matemáticamente
 * redondea la mitad hacia arriba, pero el ruido binario hace que el caso exacto
 * `.xx5` caiga del lado equivocado. `34.125 * 100` da `3412.4999999999995`, así que
 * `Math.round` devuelve 3412 (34,12) donde la cuenta a mano —y la planilla del
 * contador— dicen 34,13.
 *
 * Eso importa acá más que en ningún otro sitio: las tasas de la CSS son 9,75% y
 * 1,25%, que sobre sueldos redondos caen en `.xx5` constantemente (350 → 34,125;
 * 750 → 73,125; 390 → 38,025; 400 → 5,00…). Ver PLANILLA.md §3.1, donde el
 * redondeo medio-arriba está verificado contra los asientos ya cargados.
 */

/**
 * Redondeo a 2 decimales, medio-arriba, tolerante al ruido binario.
 *
 * El epsilon se suma ANTES de escalar a céntimos, así que corrige exactamente el
 * caso `.xx5` sin poder mover un resultado que no esté en el medio: vale 1e-7 de
 * céntimo. Un monto real nunca está a esa distancia de la frontera.
 *
 * Solo para valores POSITIVOS, que es todo lo que maneja la planilla (sueldos,
 * deducciones y acumulados nunca son negativos).
 */
export function r2(n: number): number {
  return Math.round((n + 1e-9) * 100) / 100;
}

/**
 * Suma montos ya redondeados y redondea una sola vez, al final.
 *
 * Sumar valores de 2 decimales en punto flotante acumula ruido (`0.1 + 0.2`), así
 * que el resultado se redondea para poder compararlo con `===`. Es la función que
 * usan las invariantes de cuadre.
 */
export function sumarMontos(...montos: number[]): number {
  return r2(montos.reduce((acc, m) => acc + m, 0));
}

/** Diferencia de montos ya redondeados, redondeada una sola vez. */
export function restarMontos(a: number, b: number): number {
  return r2(a - b);
}
