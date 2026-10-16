import { describe, it, expect } from 'vitest';
import { crearEmpresaConPlantilla, hacerAdministrador, PLANTILLA_DEL_SISTEMA } from '../crear-empresa';

/**
 * El alta de una empresa es el único camino que crea una empresa desde adentro de
 * la app, y tiene que dejar EXACTAMENTE lo mismo que el registro público: plan de
 * cuentas copiado con sus jerarquías, conceptos apuntando a las cuentas nuevas,
 * plan Demo y alguien que pueda entrar. Media empresa creada —sin cuentas o sin
 * admin— es peor que ninguna, y por eso todo corre en una transacción.
 */

function txFalso(opts: any = {}) {
  const creado = { cuentas: [] as any[], conceptos: [] as any[], membresias: [] as any[], suscripciones: [] as any[] };
  const tx: any = {
    company: { create: async ({ data }: any) => ({ id: 'c-nueva', ...data }) },
    account: {
      findMany: async () => opts.plantilla ?? [
        { id: 'a1', code: '1.1.01', name: 'Caja', type: 'ACTIVO', parentId: null, aliases: ['caja'], requiresAnexo: false },
        { id: 'a2', code: '1.1.01.01', name: 'Caja Chica', type: 'ACTIVO', parentId: 'a1', aliases: [], requiresAnexo: true },
      ],
      create: async ({ data }: any) => {
        const nueva = { id: `n-${data.code}`, ...data };
        creado.cuentas.push(nueva);
        return nueva;
      },
      update: async ({ where, data }: any) => {
        const c = creado.cuentas.find((x) => x.id === where.id);
        if (c) Object.assign(c, data);
        return c;
      },
    },
    concept: {
      findMany: async () => opts.conceptos ?? [{ name: 'Gastos', accountId: 'a2', confidence: 0.9 }],
      create: async ({ data }: any) => {
        creado.conceptos.push(data);
        return data;
      },
    },
    plan: { findUnique: async () => opts.plan ?? { id: 'plan-demo', name: 'Demo', monthlyLimit: 50 } },
    subscription: {
      create: async ({ data }: any) => {
        creado.suscripciones.push(data);
        return data;
      },
    },
    userCompany: {
      create: async ({ data }: any) => {
        creado.membresias.push(data);
        return data;
      },
    },
    auditLog: { create: async ({ data }: any) => data },
  };
  return { tx, creado };
}

describe('crearEmpresaConPlantilla', () => {
  it('copia el plan de cuentas con sus jerarquías y su Anexo', async () => {
    const { tx, creado } = txFalso();

    const empresa = await crearEmpresaConPlantilla(tx, { name: 'Cliente Nuevo SA', taxId: '1555-1234-5678' });

    expect(empresa.name).toBe('Cliente Nuevo SA');
    expect(creado.cuentas).toHaveLength(2);
    const hija = creado.cuentas.find((c) => c.code === '1.1.01.01');
    expect(hija.parentId).toBe('n-1.1.01'); // apunta a la cuenta NUEVA, no a la de la plantilla
    expect(hija.requiresAnexo).toBe(true); // el Anexo se hereda
  });

  it('los conceptos apuntan a las cuentas de la empresa nueva', async () => {
    const { tx, creado } = txFalso();
    await crearEmpresaConPlantilla(tx, { name: 'X' });
    expect(creado.conceptos[0].accountId).toBe('n-1.1.01.01');
    expect(creado.conceptos[0].companyId).toBe('c-nueva');
  });

  it('nace con el plan Demo de 14 días', async () => {
    const { tx, creado } = txFalso();
    await crearEmpresaConPlantilla(tx, { name: 'X' });
    expect(creado.suscripciones[0]).toMatchObject({ companyId: 'c-nueva', planId: 'plan-demo', status: 'DEMO', movementsLimit: 50 });
    const dias = (creado.suscripciones[0].periodEnd - creado.suscripciones[0].periodStart) / 86400000;
    expect(Math.round(dias)).toBe(14);
  });

  it('sin RUC queda un marcador, no el RUC de otro', async () => {
    const { tx } = txFalso();
    const empresa = await crearEmpresaConPlantilla(tx, { name: 'X', taxId: null });
    expect(empresa.taxId).toMatch(/^SIN-RUC-/);
  });

  it('copia el catálogo de la empresa que se le pida, no siempre del sistema', async () => {
    // El caso del despacho: el cliente nuevo nace con SU catálogo, no con el de demo.
    let pedidoA = '';
    const { tx } = txFalso();
    const findManyOriginal = tx.account.findMany;
    tx.account.findMany = async (args: any) => {
      pedidoA = args.where.companyId;
      return findManyOriginal(args);
    };

    await crearEmpresaConPlantilla(tx, { name: 'Cliente del despacho' }, { plantillaCompanyId: 'mi-empresa' });

    expect(pedidoA).toBe('mi-empresa');
  });

  it('sin plantilla elegida usa la del sistema', async () => {
    let pedidoA = '';
    const { tx } = txFalso();
    const original = tx.account.findMany;
    tx.account.findMany = async (args: any) => {
      pedidoA = args.where.companyId;
      return original(args);
    };
    await crearEmpresaConPlantilla(tx, { name: 'X' });
    expect(pedidoA).toBe(PLANTILLA_DEL_SISTEMA);
  });

  it('sin planilla igual crea la empresa (avisa, no rompe)', async () => {
    const { tx } = txFalso({ plantilla: [] });
    const empresa = await crearEmpresaConPlantilla(tx, { name: 'X' });
    expect(empresa.id).toBe('c-nueva');
  });
});

describe('hacerAdministrador', () => {
  it('deja al creador como admin de la empresa nueva', async () => {
    const { tx, creado } = txFalso();
    await hacerAdministrador(tx, 'u-1', 'c-nueva');
    expect(creado.membresias[0]).toEqual({ userId: 'u-1', companyId: 'c-nueva', role: 'admin' });
  });
});
