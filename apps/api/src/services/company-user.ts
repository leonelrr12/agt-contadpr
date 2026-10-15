/**
 * El usuario de la empresa al que se le atribuyen los asientos que nacen en un
 * canal sin sesión (WhatsApp, y ahora el correo).
 *
 * `OrchestratorAgent` exige un `createdById` real —es FK contra `User`— y la
 * doctrina del repo es que sea de la propia empresa: el admin activo y, si no
 * hay, cualquier usuario activo. Lanza si la empresa no tiene ninguno: en la
 * práctica no ocurre (el registro siempre crea un admin) y así se evita atribuir
 * transacciones a un usuario fantasma.
 */

export async function resolveCompanyUserId(
  prisma: any,
  companyId: string,
  /** Canal que pide el usuario, solo para el mensaje de error. */
  canal = 'WhatsApp',
): Promise<string> {
  const user =
    (await prisma.user.findFirst({ where: { companyId, role: 'admin', isActive: true } })) ||
    (await prisma.user.findFirst({ where: { companyId, isActive: true } }));
  if (!user) {
    throw new Error(`La empresa ${companyId} no tiene usuarios activos para operar por ${canal}`);
  }
  return user.id;
}
