/**
 * Cómo nace una empresa en Contador507. **Única fuente**: la usan el registro
 * público (un cliente nuevo) y el alta desde «🏢 Mis empresas» (un despacho que
 * suma otro cliente a su cuenta).
 *
 * Una empresa recién creada tiene que poder trabajar el mismo día, así que nace
 * con: el **plan de cuentas copiado de la plantilla** —con sus jerarquías, sus
 * alias y el «Lleva Anexo»—, los **conceptos** apuntando a esas cuentas nuevas,
 * el **plan Demo** (14 días, 50 movimientos) y su **administrador** como
 * membresía. `isBlocked` no se copia a propósito: bloquear una cuenta es una
 * decisión operativa de cada empresa y heredarla dejaría flujos rotos desde el
 * día uno (misma doctrina que el registro).
 *
 * Corre SIEMPRE dentro de una transacción: media empresa creada —sin cuentas o
 * sin admin— es peor que ninguna.
 */

/**
 * La plantilla del SISTEMA: la que se usa si no se elige otra. Es la empresa
 * semilla del registro público, y copiarla está permitido para cualquiera (es el
 * catálogo con el que nace todo cliente nuevo).
 */
export const PLANTILLA_DEL_SISTEMA = 'demo-company';

export interface DatosEmpresa {
  name: string;
  taxId?: string | null;
}

export interface OpcionesEmpresa {
  /**
   * De qué empresa se copian el plan de cuentas y los conceptos. Por defecto la
   * plantilla del sistema; un despacho suele querer copiar **su propio** catálogo
   * —el que ya tiene armado y probado— para que todos sus clientes nazcan con el
   * mismo. Quien llama valida que se pueda usar (`empresaComoPlantilla`).
   */
  plantillaCompanyId?: string;
}

export async function crearEmpresaConPlantilla(
  tx: any,
  datos: DatosEmpresa,
  opts: OpcionesEmpresa = {},
): Promise<any> {
  const plantillaId = opts.plantillaCompanyId || PLANTILLA_DEL_SISTEMA;
  const company = await tx.company.create({
    data: {
      name: datos.name,
      // Sin RUC queda un marcador: el dueño lo completa en Configuración, y así
      // nadie queda con el RUC de otro por un campo vacío.
      taxId: datos.taxId || `SIN-RUC-${crypto.randomUUID()}`,
      country: 'PA',
      currency: 'USD',
    },
  });

  // ── Plan de cuentas ──
  const plantilla = await tx.account.findMany({ where: { companyId: plantillaId } });
  if (!plantilla.length) {
    console.warn(`[Empresa] La plantilla ${plantillaId} no tiene cuentas: la empresa queda sin plan de cuentas`);
  }

  const porCodigo: Record<string, string> = {};
  for (const acc of plantilla) {
    const creada = await tx.account.create({
      data: {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        parentId: null, // se completa abajo, cuando ya existen todas
        companyId: company.id,
        aliases: acc.aliases || [],
        requiresAnexo: acc.requiresAnexo,
      },
    });
    porCodigo[acc.code] = creada.id;
  }

  for (const acc of plantilla) {
    if (!acc.parentId) continue;
    const codigoPadre = plantilla.find((a: any) => a.id === acc.parentId)?.code;
    if (codigoPadre && porCodigo[codigoPadre] && porCodigo[acc.code]) {
      await tx.account.update({ where: { id: porCodigo[acc.code] }, data: { parentId: porCodigo[codigoPadre] } });
    }
  }

  // ── Conceptos, apuntando a las cuentas NUEVAS ──
  const conceptos = await tx.concept.findMany({ where: { companyId: plantillaId } });
  for (const c of conceptos) {
    const cuentaPlantilla = plantilla.find((a: any) => a.id === c.accountId);
    const cuentaNueva = cuentaPlantilla ? porCodigo[cuentaPlantilla.code] : null;
    if (!cuentaNueva) continue;
    await tx.concept.create({
      data: { name: c.name, accountId: cuentaNueva, companyId: company.id, confidence: c.confidence },
    });
  }

  // ── Plan Demo (14 días, 50 movimientos) ──
  const demoPlan = await tx.plan.findUnique({ where: { name: 'Demo' } });
  if (demoPlan) {
    const fin = new Date();
    fin.setDate(fin.getDate() + 14);
    await tx.subscription.create({
      data: {
        companyId: company.id,
        planId: demoPlan.id,
        status: 'DEMO',
        movementsLimit: demoPlan.monthlyLimit,
        periodStart: new Date(),
        periodEnd: fin,
      },
    });
  }

  return company;
}

/**
 * Da de alta a alguien como administrador de una empresa.
 *
 * Va aparte de la creación porque el orden no siempre es el mismo: el registro
 * crea la empresa y DESPUÉS el usuario (que necesita el `companyId`), así que la
 * membresía no puede ir adentro. Una empresa sin miembros existiría y nadie
 * podría abrirla: quien crea una empresa tiene que llamar a esto.
 */
export async function hacerAdministrador(tx: any, userId: string, companyId: string): Promise<void> {
  await tx.userCompany.create({ data: { userId, companyId, role: 'admin' } });
}
