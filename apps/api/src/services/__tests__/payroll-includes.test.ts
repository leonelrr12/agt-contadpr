/**
 * Guardia contra `include`/`select` inválidos en los servicios de planilla.
 *
 * El repo pasa `prisma: any` (los tests usan stubs a mano), así que **`tsc` no valida
 * los `include`**: un nombre mal puesto compila, pasa los tests de cálculo y revienta
 * recién en producción. Pasó el 28-09-2026 — `GET /planilla/corridas/:id` pedía
 * `items.deducciones`, que en `PayrollItem` no existe (el desglose cuelga de la
 * CORRIDA, no del ítem) y el endpoint devolvía 500 hasta que el proceso se reinició.
 *
 * Este stub imita a Prisma en lo único que importa acá: **valida las claves de
 * `include` y `select` contra el DMMF real del schema**, así que un include inventado
 * falla en el test y no en la cara del contador.
 */

import { describe, it, expect } from 'vitest';
import { prismaValidador } from '../../test-utils/prisma-validador';
import { obtenerCorrida, listarCorridas } from '../payroll-run';
import { acumuladosDe, listarEmpleados, obtenerEmpleado } from '../payroll-empleados';
import { catalogoDe, listarDeducciones, resumenAcreedores } from '../payroll-acreedores';

describe('planilla: los include existen en el modelo (DMMF)', () => {
  it('el guardia detecta el include que reventó el 28-09', async () => {
    const { prisma } = prismaValidador();
    await expect(prisma.payrollItem.findMany({ include: { deducciones: true } })).rejects.toThrow(
      /include\.deducciones no existe en el modelo PayrollItem/,
    );
    // Y el bueno pasa: el desglose cuelga de la corrida.
    await expect(prisma.payrollRun.findFirst({ include: { deducciones: true } })).resolves.toBeDefined();
  });

  it('obtenerCorrida — el endpoint que devolvía 500', async () => {
    const { prisma, llamadas } = prismaValidador({
      payrollRun: { id: 'r1', tipo: 'SUELDO', fechaPago: new Date(2026, 9, 15, 12), items: [], deducciones: [] },
    });
    const r = await obtenerCorrida(prisma, 'c1', 'r1');
    expect(r.items).toEqual([]);
    expect(llamadas.map((l) => l.delegate)).toContain('payrollRun');
  });

  it('listarCorridas y el detalle de un empleado', async () => {
    const { prisma } = prismaValidador({ payrollRun: [], employee: null });
    await listarCorridas(prisma, 'c1', { limit: 5 });
    await obtenerEmpleado(prisma, 'c1', 'e1');
  });

  it('acumulados, listado de empleados y deducciones de acreedores', async () => {
    const { prisma } = prismaValidador({ payrollItem: [], employee: [], payrollDeduction: [], payrollItemDeduction: [] });
    await acumuladosDe(prisma, 'c1', {});
    await listarEmpleados(prisma, 'c1');
    await listarDeducciones(prisma, 'c1', {});
    await catalogoDe(prisma, 'c1', { empleadoIds: ['e1'], corte: new Date(2026, 9, 15, 12), periodoMensual: '2026-10' });
    await resumenAcreedores(prisma, 'c1');
  });
});
