/**
 * De la empresa a su cuenta, y de la cuenta a la suscripción. **Única fuente**.
 *
 * La suscripción cuelga de la **cuenta** que paga, no de la empresa: un despacho
 * tiene un plan que cubre a todos sus clientes. Pero casi todo el código —la cuota
 * de un asiento, el add-on de una factura, el aviso de WhatsApp— parte de una
 * empresa, así que el salto «empresa → cuenta → suscripción» vive acá y **en un
 * solo lugar**: si mañana la cuota se reparte de otra forma, se cambia acá.
 *
 * El consumo (`movementsUsed`) es uno solo para toda la cuenta: se suma el de sus
 * empresas, que es lo que dice el plan que se paga.
 */

/** Estados que pueden operar. `EXPIRED` es el único que bloquea. */
export const ESTADOS_VIGENTES = ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'];

/**
 * La suscripción vigente de la cuenta a la que pertenece esta empresa, con su plan.
 * `null` si la empresa no existe o su cuenta no tiene plan (se trata como 402).
 *
 * Si alguna vez hubiera dos vigentes para la misma cuenta —una carrera al crear el
 * plan Demo—, gana la del período más largo, que es la que el dueño quiso dar.
 */
export async function suscripcionDeEmpresa(prisma: any, companyId: string): Promise<any | null> {
  if (!companyId) return null;
  return prisma.subscription.findFirst({
    where: {
      status: { in: ESTADOS_VIGENTES },
      cuenta: { companies: { some: { id: companyId } } },
    },
    include: { plan: true },
    orderBy: { periodEnd: 'desc' },
  });
}

/**
 * Suma movimientos consumidos a la suscripción de la cuenta de esa empresa.
 * Se llama DESPUÉS de crear el movimiento; sin suscripción vigente no hace nada
 * (el `requireQuota` ya habría cortado antes).
 */
export async function incrementarUsoDeEmpresa(prisma: any, companyId: string, cantidad = 1): Promise<void> {
  if (!companyId) return;
  await prisma.subscription.updateMany({
    where: {
      status: { in: ESTADOS_VIGENTES },
      cuenta: { companies: { some: { id: companyId } } },
    },
    data: { movementsUsed: { increment: cantidad } },
  });
}

/**
 * Las empresas de la cuenta a la que pertenece esta empresa (ella incluida).
 * Lo usa el uso diario de `/api/subscription`: el gráfico es de la cuenta, así que
 * suma el de todas sus empresas.
 */
export async function empresasDeLaCuenta(prisma: any, companyId: string): Promise<string[]> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { cuenta: { select: { companies: { select: { id: true } } } } },
  });
  return (company?.cuenta?.companies || []).map((c: any) => c.id);
}
