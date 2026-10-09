/**
 * Freno a la fuerza bruta por CUENTA en el login: cuenta los fallos por email y
 * bloquea temporalmente al llegar al tope.
 *
 * Complementa al rate limit por IP (`loginLimiter` en main.ts): el limiter
 * protege el endpoint; esto protege una contraseña concreta aunque los intentos
 * lleguen desde varias IPs.
 *
 * En memoria a propósito: la API corre en un solo proceso (PM2 fork). Si algún
 * día se escala horizontal (varias instancias), esto tiene que mudarse a Redis
 * o a la BD — si no, cada instancia llevaría su propia cuenta.
 *
 * El bloqueo es corto (15 min) y el mensaje no revela si el email existe: un
 * bloqueo largo sería un DoS gratis contra cualquier cuenta (basta con fallar
 * 5 veces con el correo del otro).
 */
const MAX_FALLOS = 5;
const VENTANA_MS = 15 * 60 * 1000; // los fallos más viejos que esto no cuentan
const BLOQUEO_MS = 15 * 60 * 1000;

type Registro = { fallos: number; ultimo: number; hasta: number };
const intentos = new Map<string, Registro>();

const clave = (email: string): string => String(email || '').trim().toLowerCase();

/** Milisegundos que le quedan de bloqueo a la cuenta (0 = puede intentar). */
export function bloqueoRestante(email: string): number {
  const r = intentos.get(clave(email));
  if (!r?.hasta) return 0;
  const restante = r.hasta - Date.now();
  if (restante <= 0) {
    intentos.delete(clave(email));
    return 0;
  }
  return restante;
}

/** Suma un fallo; al llegar al tope deja la cuenta bloqueada un rato. */
export function registrarFallo(email: string): void {
  const k = clave(email);
  if (!k) return;
  const ahora = Date.now();
  const previo = intentos.get(k);
  const fallos = (previo && ahora - previo.ultimo < VENTANA_MS ? previo.fallos : 0) + 1;
  intentos.set(k, {
    fallos,
    ultimo: ahora,
    hasta: fallos >= MAX_FALLOS ? ahora + BLOQUEO_MS : 0,
  });
  if (intentos.size > 1000) purgar(ahora);
}

/** Login correcto: la cuenta vuelve a foja cero. */
export function limpiarFallos(email: string): void {
  intentos.delete(clave(email));
}

/** Evita que el Map crezca sin techo en una instalación con muchos correos. */
function purgar(ahora: number): void {
  for (const [k, r] of intentos) {
    if (!r.hasta || r.hasta < ahora) {
      if (ahora - r.ultimo > VENTANA_MS) intentos.delete(k);
    }
  }
}

/** Solo para los tests. */
export function _resetLoginGuard(): void {
  intentos.clear();
}
