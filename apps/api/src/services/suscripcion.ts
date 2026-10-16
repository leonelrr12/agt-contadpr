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

/** Los módulos que puede usar la cuenta, con lo mínimo para explicar un 402. */
export interface ModulosDeLaCuenta {
  plan: string;
  vencida: boolean;
  /** Plan + add-ons contratados, sin repetidos. */
  modulos: string[];
}

/**
 * Los módulos que puede usar la cuenta: los del **plan** más los **add-ons**
 * contratados (una cuenta puede contratar un módulo suelto sin cambiar de plan).
 * `null` si la cuenta no tiene suscripción vigente.
 *
 * Es lo que valida `middleware/modulo.ts` (menú **y** rutas) y lo que el frontend
 * usa para mostrar u ocultar cada módulo.
 */
export async function modulosDeLaCuenta(prisma: any, companyId: string): Promise<ModulosDeLaCuenta | null> {
  const sub = await suscripcionDeEmpresa(prisma, companyId);
  if (!sub) return null;
  return {
    plan: sub.plan?.name || '',
    vencida: new Date() > new Date(sub.periodEnd),
    modulos: [...new Set([...(sub.plan?.modulos || []), ...(sub.addons || [])])] as string[],
  };
}

/** Un tope del plan, con lo que ya hay usado. */
export interface Tope { usados: number; max: number }

export interface TopesDeLaCuenta {
  plan: string;
  /** Empresas de la cuenta entera (la cuenta es la que paga). */
  empresas: Tope;
  /** Usuarios PROPIOS de la empresa en la que está parado el usuario. */
  usuarios: Tope;
}

/**
 * Los topes del plan con lo que hay usado, para validar y para mostrar en la UI.
 * `null` si la cuenta no tiene suscripción vigente: quien llama decide qué hacer
 * (las altas de empresa y usuario responden 402, como el resto de las escrituras).
 *
 * El cupo de usuarios es el de ESTA empresa y cuenta solo los **propios** (los que
 * tienen acá su empresa casa): el contador del despacho que entra a los libros de un
 * cliente no le gasta el cupo al cliente. Si contara membresías, un despacho con tres
 * contadores dejaría a cada cliente sin poder dar de alta a su propia gente.
 */
export async function topesDeLaCuenta(prisma: any, companyId: string): Promise<TopesDeLaCuenta | null> {
  const sub = await suscripcionDeEmpresa(prisma, companyId);
  if (!sub) return null;

  const [empresas, usuarios] = await Promise.all([
    prisma.company.count({ where: { cuentaId: sub.cuentaId } }),
    prisma.user.count({ where: { companyId } }),
  ]);

  return {
    plan: sub.plan?.name || '',
    // Gana la cortesía de la suscripción si la hay (`null` = el del plan): es el mismo
    // mecanismo que `movementsLimit`, para el cliente que no encaja en ningún plan.
    empresas: { usados: empresas, max: sub.maxEmpresas ?? sub.plan?.maxEmpresas ?? 0 },
    usuarios: { usados: usuarios, max: sub.maxUsuariosPorEmpresa ?? sub.plan?.maxUsuariosPorEmpresa ?? 0 },
  };
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
