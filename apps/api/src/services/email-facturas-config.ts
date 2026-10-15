/**
 * Configuración del buzón de facturas por correo (IMAP): 1:1 con la empresa.
 *
 * Se crea **perezosamente** (doctrina `PayrollSettings`): un módulo que no puede
 * funcionar hasta que alguien abra y guarde una pantalla está roto. Los defaults
 * valen; las credenciales no se heredan de nadie.
 *
 * Dos reglas que sostienen todo lo demás:
 *  · **La contraseña IMAP nunca sale al navegador.** `configPublica()` devuelve
 *    `tienePassword` y nada más; el PUT distingue «no mandé contraseña» (sin
 *    cambios) de «mandé null» (borrarla).
 *  · **La contrapartida es una cuenta de BANCO**, nunca Caja ni CxP: la compra es
 *    al contado y el asiento tiene que poder conciliar contra el extracto. Si no
 *    hay cuenta, el barrido no carga nada (mejor no cargar que acreditar una
 *    cuenta equivocada).
 */

/**
 * Campos que el navegador ve y edita, con su etiqueta. Única fuente de nombres y
 * etiquetas (doctrina `PLANILLA_FIELDS`): la lista de `configPublica` y los
 * mensajes de validación salen de acá, no de strings sueltos por el código.
 * `imapPassword` NO está en la lista a propósito: no es un campo público.
 */
export const CAMPOS_EMAIL_FACTURA: { field: string; label: string }[] = [
  { field: 'isActive', label: 'Leer el buzón' },
  { field: 'modo', label: 'Modo' },
  { field: 'imapHost', label: 'Servidor' },
  { field: 'imapPort', label: 'Puerto' },
  { field: 'imapSecure', label: 'Conexión segura' },
  { field: 'imapUser', label: 'Usuario' },
  { field: 'imapFolder', label: 'Carpeta' },
  { field: 'marcarLeido', label: 'Marcar como leído' },
  { field: 'carpetaMover', label: 'Mover a la carpeta' },
  { field: 'cuentaPagoId', label: 'Cuenta de contrapartida' },
  { field: 'conceptoDefaultId', label: 'Concepto por defecto' },
];

/** La fila de configuración, creándola si la empresa nunca entró a la pantalla. */
export async function getOrCreateEmailConfig(prisma: any, companyId: string): Promise<any> {
  return prisma.emailFacturaConfig.upsert({
    where: { companyId },
    update: {},
    create: { companyId },
  });
}

/**
 * Lo que puede ver el navegador: los campos de la lista blanca + el estado de la
 * última corrida + si hay contraseña guardada. **Nunca** `imapPassword`.
 */
export function configPublica(cfg: any): Record<string, any> {
  const pub: Record<string, any> = {};
  for (const { field } of CAMPOS_EMAIL_FACTURA) pub[field] = cfg?.[field] ?? null;
  pub.tienePassword = !!cfg?.imapPassword;
  pub.metodoPago = cfg?.metodoPago || 'TRANSFERENCIA';
  pub.inboxAlias = cfg?.inboxAlias ?? null;
  pub.ultimaCorridaAt = cfg?.ultimaCorridaAt ?? null;
  pub.ultimoEstado = cfg?.ultimoEstado ?? null;
  pub.ultimoDetalle = cfg?.ultimoDetalle ?? null;
  return pub;
}

/**
 * ¿Este código es una cuenta de BANCO? Solo `1.1.02.*`.
 *
 * La Caja (`1.1.01.*`) queda FUERA a propósito: en producción está vacía y
 * acreditarla sería mentir el asiento. La tarjeta de crédito (`2.1.03.*`) entra
 * el día que se pida, con su método de pago propio.
 */
export function cuentaEsDeBanco(code: string | null | undefined): boolean {
  return String(code || '').trim().startsWith('1.1.02');
}

/** Cuentas de banco ofrecidas en la pantalla: de la empresa, activas y sin bloquear. */
export async function cuentasBancoDeEmpresa(
  prisma: any,
  companyId: string,
): Promise<{ id: string; code: string; name: string }[]> {
  return prisma.account.findMany({
    where: { companyId, isActive: true, isBlocked: false, code: { startsWith: '1.1.02' } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
}

/**
 * La cuenta de contrapartida de la empresa, si el id es válido: tiene que ser de
 * ESTA empresa (nada de cruzar tenants), de banco, activa y sin bloquear.
 * Devuelve null cuando no sirve — el llamador decide si es un 400 o un `SIN_CUENTA`.
 */
export async function cuentaBancoDeEmpresa(
  prisma: any,
  companyId: string,
  cuentaId: string | null | undefined,
): Promise<{ id: string; code: string; name: string } | null> {
  if (!cuentaId) return null;
  const cuenta = await prisma.account.findFirst({
    where: { id: String(cuentaId), companyId },
    select: { id: true, code: true, name: true, isActive: true, isBlocked: true },
  });
  if (!cuenta || !cuenta.isActive || cuenta.isBlocked || !cuentaEsDeBanco(cuenta.code)) return null;
  return { id: cuenta.id, code: cuenta.code, name: cuenta.name };
}
