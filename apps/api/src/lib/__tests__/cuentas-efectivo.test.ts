import { describe, it, expect } from 'vitest';
import { cuentasEfectivo, codigosEfectivo } from '../cuentas-efectivo';

/**
 * `cuentasEfectivo` es la fuente única de "qué es efectivo" para el flujo de caja
 * y para la proyección del panel de salud. Antes cada uno tenía su criterio y en
 * producción eso significaba que el panel proyectaba desde una cuenta vacía.
 * Estos casos fijan el criterio para que no vuelva a divergir.
 */
const COMPANY = 'company-1';

const cuenta = (code: string, type: string, aliases: string[] = []) => ({
  code,
  name: `Cuenta ${code}`,
  type,
  aliases,
});

/** Stub de Prisma: solo el findMany de cuentas, como lo usa el módulo. */
function prismaStub(cuentas: ReturnType<typeof cuenta>[]) {
  return {
    account: {
      findMany: async (args: any) =>
        cuentas.filter((c) => c.type === args?.where?.type),
    },
  };
}

const correr = (cuentas: ReturnType<typeof cuenta>[]) =>
  cuentasEfectivo(prismaStub(cuentas) as never, COMPANY);

describe('cuentasEfectivo — el rango clásico del catálogo', () => {
  it('toma Caja 1.1.01 y Bancos 1.1.02 con sus descendientes', async () => {
    const out = await correr([
      cuenta('1.1.01', 'ACTIVO'),
      cuenta('1.1.02', 'ACTIVO'),
      cuenta('1.1.02.03', 'ACTIVO'),
      cuenta('1.1.03', 'ACTIVO'), // Cuentas por Cobrar: no es efectivo
    ]);
    expect(out.map((c) => c.code)).toEqual(['1.1.01', '1.1.02', '1.1.02.03']);
  });

  it('no arrastra una cuenta que solo comparte prefijo de texto (1.1.010)', async () => {
    // El `startsWith('1.1.01')` anterior sí la metía: el criterio compara por
    // segmento (`=== c || startsWith(c + '.')`), no por prefijo a secas.
    const out = await correr([cuenta('1.1.01', 'ACTIVO'), cuenta('1.1.010', 'ACTIVO')]);
    expect(out.map((c) => c.code)).toEqual(['1.1.01']);
  });
});

describe('cuentasEfectivo — alias de efectivo', () => {
  it('un alias de banco arrastra la cuenta y sus subcuentas aunque el código no sea del rango', async () => {
    const out = await correr([
      cuenta('1.1.09', 'ACTIVO', ['banco-general']),
      cuenta('1.1.09.01', 'ACTIVO'),
      cuenta('1.1.03', 'ACTIVO'),
    ]);
    expect(out.map((c) => c.code)).toEqual(['1.1.09', '1.1.09.01']);
  });

  it('reconoce los alias sueltos caja/banco/efectivo sin importar mayúsculas ni espacios', async () => {
    const out = await correr([
      cuenta('1.1.08', 'ACTIVO', ['  CAJA ']),
      cuenta('1.1.09', 'ACTIVO', ['Efectivo']),
    ]);
    expect(out.map((c) => c.code)).toEqual(['1.1.08', '1.1.09']);
  });

  it('una cuenta que no es ACTIVO queda fuera aunque tenga el alias', async () => {
    const out = await correr([
      cuenta('6.05.02', 'GASTO', ['caja']),
      cuenta('1.1.01', 'ACTIVO'),
    ]);
    expect(out.map((c) => c.code)).toEqual(['1.1.01']);
  });
});

describe('codigosEfectivo', () => {
  it('devuelve un Set con los mismos códigos, para clasificar líneas y plantillas', async () => {
    const set = await codigosEfectivo(
      prismaStub([cuenta('1.1.01', 'ACTIVO'), cuenta('1.1.02.01', 'ACTIVO')]) as never,
      COMPANY,
    );
    expect(set.has('1.1.01')).toBe(true);
    expect(set.has('1.1.02.01')).toBe(true);
    expect(set.has('1.1.03.01')).toBe(false);
  });
});
