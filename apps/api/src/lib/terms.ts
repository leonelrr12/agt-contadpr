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
