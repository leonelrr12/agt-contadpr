/**
 * Versión vigente de los Términos y Condiciones.
 *
 * Se sube SOLO cuando cambia el texto publicado en
 * `apps/web/public/terminos-y-condiciones.html` (su «Última actualización»), y es
 * la que queda registrada en `User.termsVersion` al aceptar: así la evidencia
 * dice qué texto aceptó cada cuenta, no solo que aceptó «algo».
 *
 * Si algún día se pide re-aceptar, la comparación es contra esta constante
 * (`user.termsVersion !== TERMS_VERSION`), sin migración de por medio.
 */
export const TERMS_VERSION = '2026-10-09';

/**
 * ¿Esta cuenta tiene que (re)aceptar? Sí cuando no hay constancia (cuentas
 * creadas antes de que existiera el registro) o cuando aceptó una versión vieja.
 * El aviso de re-aceptación se apoya en esto; no hay bloqueo en el servidor a
 * propósito: la constancia es el punto, y bloquear endpoints rompería flujos que
 * no son del usuario que acepta (p. ej. los mensajes de un trabajador por WhatsApp).
 */
export function necesitaAceptar(versionAceptada?: string | null): boolean {
  return versionAceptada !== TERMS_VERSION;
}
