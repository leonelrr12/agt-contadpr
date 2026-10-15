/**
 * Arnés de test que valida las consultas de Prisma contra el **DMMF real** del schema.
 *
 * Por qué existe: los servicios de `apps/api` reciben `prisma: any` (la convención del
 * repo, que permite los stubs a mano), así que **`tsc` no valida los `include`**: un
 * nombre mal puesto compila, pasa los tests de cálculo y revienta recién en producción.
 * Pasó el 28-09-2026 —`GET /planilla/corridas/:id` pedía `items.deducciones`, que en
 * `PayrollItem` no existe— y el endpoint devolvió 500 hasta que se reinició el proceso.
 *
 * Cómo se usa: se le pasan los resultados que debe devolver cada consulta y las
 * funciones de lectura se corren contra él. Si alguna pide un `include`/`select` que el
 * modelo no tiene, el test falla nombrando el modelo y el campo.
 *
 *   const { prisma, llamadas } = prismaValidador({ payrollRun: { items: [], deducciones: [] } });
 *   await obtenerCorrida(prisma, 'c1', 'r1');
 *
 * Los valores por defecto imitan a Prisma en lo que importa para no romper por otra
 * razón: `findMany`/`groupBy` → `[]`, `findFirst`/`findUnique` → `null`,
 * `aggregate` → sumas vacías, `count` → `0`.
 */

import { Prisma } from '@agt-contador/prisma-schema';

type Modelo = { name: string; fields: { name: string; kind: string }[] };

const MODELOS = new Map<string, Modelo>(
  ((Prisma as any).dmmf.datamodel.models as Modelo[]).map((m) => [m.name, m]),
);

/** `payrollItem` → `PayrollItem`: la convención de Prisma para los delegates. */
const modeloDe = (delegate: string) => MODELOS.get(delegate.charAt(0).toUpperCase() + delegate.slice(1));

const VACIOS: Record<string, () => any> = {
  findMany: () => [],
  groupBy: () => [],
  findFirst: () => null,
  findUnique: () => null,
  aggregate: () => ({ _sum: {}, _avg: {}, _count: {}, _min: {}, _max: {} }),
  count: () => 0,
  create: () => null,
  createMany: () => ({ count: 0 }),
  update: () => null,
  updateMany: () => ({ count: 0 }),
  upsert: () => null,
  delete: () => null,
  deleteMany: () => ({ count: 0 }),
};

export function validarArgs(delegate: string, args: any, metodo: string): void {
  const modelo = modeloDe(delegate);
  if (!modelo || !args || typeof args !== 'object') return;
  validarBloque(modelo, args, `${delegate}.${metodo}`);
}

/**
 * Valida `include`/`select` y **baja por las relaciones**: el include que rompió en
 * planilla era anidado (`payrollRun → items → deducciones`), así que mirar solo el
 * primer nivel no habría atrapado nada.
 */
function validarBloque(modelo: Modelo, args: any, contexto: string): void {
  for (const clave of ['include', 'select'] as const) {
    const bloque = args?.[clave];
    if (!bloque || typeof bloque !== 'object') continue;
    for (const [campo, valor] of Object.entries<any>(bloque)) {
      // `_count`, `_sum`… son agregados y no campos del modelo.
      if (campo.startsWith('_')) continue;
      const f = modelo.fields.find((x) => x.name === campo);
      if (!f) {
        throw new Error(
          `${contexto}: ${clave}.${campo} no existe en el modelo ${modelo.name}. ` +
            `Disponibles: ${modelo.fields.map((x) => x.name).join(', ')}`,
        );
      }
      // Si el campo es una relación y trae su propio bloque, se valida contra el
      // modelo del otro lado.
      if (f.kind === 'object' && valor && typeof valor === 'object') {
        const hijo = MODELOS.get((f as any).type);
        if (hijo) validarBloque(hijo, valor, `${contexto} → ${modelo.name}.${campo}`);
      }
    }
  }
}

export interface Arnés {
  prisma: any;
  /** Consultas que se ejecutaron, en orden (para afirmar que la ruta llegó hasta ahí). */
  llamadas: { delegate: string; metodo: string; args: any }[];
  /** El error que lanzó una escritura que el arnés no simula (si hubo). */
  escrituras: { delegate: string; metodo: string }[];
}

export function prismaValidador(resultados: Record<string, any> = {}): Arnés {
  const llamadas: Arnés['llamadas'] = [];
  const escrituras: Arnés['escrituras'] = [];

  const prisma: any = new Proxy(
    {},
    {
      get: (_t, prop: string) => {
        if (prop === '$transaction') return async (cb: any) => cb(prisma);
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe' || prop === '$executeRawUnsafe') return async () => [];
        if (prop.startsWith('$')) return async () => undefined;
        return new Proxy(
          {},
          {
            get: (_t2, metodo: string) => async (args: any) => {
              validarArgs(prop, args, metodo);
              llamadas.push({ delegate: prop, metodo, args });
              // 1) lo que se pidió para ese delegate+método exacto
              const propia = resultados[`${prop}.${metodo}`];
              if (propia !== undefined) return typeof propia === 'function' ? propia(args) : propia;
              // 2) lo que se pidió para todo el delegate, en las consultas de lectura
              const porDelegate = resultados[prop];
              if (porDelegate !== undefined && ['findMany', 'findFirst', 'findUnique', 'aggregate', 'count'].includes(metodo)) {
                return typeof porDelegate === 'function' ? porDelegate(args) : porDelegate;
              }
              // 3) el vacío que imita a Prisma (y se anota si fue una escritura)
              if (metodo.startsWith('create') || metodo.startsWith('update') || metodo.startsWith('delete') || metodo === 'upsert') {
                escrituras.push({ delegate: prop, metodo });
              }
              return VACIOS[metodo] ? VACIOS[metodo]() : null;
            },
          },
        );
      },
    },
  );
  return { prisma, llamadas, escrituras };
}
