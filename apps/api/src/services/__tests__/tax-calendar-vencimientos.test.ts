/**
 * Vencimientos del calendario fiscal: el DÍA, no el instante.
 *
 * Lo que costó (arreglado el 15-10-2026): los vencimientos se guardaban a medianoche
 * del servidor —que corre en Nueva York— y la UI los pinta con la hora del navegador.
 * En verano (EDT) esa medianoche cae a las 23:00 del día anterior en Panamá, así que
 * un ITBMS que vence el 15 de agosto se veía **14/08** y la obligación pasaba a
 * OVERDUE la noche anterior. En invierno las dos zonas coinciden y el bug no se veía.
 */

import { describe, it, expect } from 'vitest';
import { generateUpcomingObligations, getTaxCalendarSummary } from '../tax-calendar';

/** Prisma de mentira: registra lo que se crea, se actualiza y con qué filtros se consulta. */
function stub(filas: any[] = []) {
  const creadas: any[] = [];
  const updates: any[] = [];
  const updateMany: any[] = [];
  const prisma = {
    taxObligation: {
      findFirst: async () => null, // ninguna obligación existe todavía
      create: async ({ data }: any) => {
        creadas.push(data);
        return data;
      },
      update: async (args: any) => {
        updates.push(args);
        return args;
      },
      updateMany: async (args: any) => {
        updateMany.push(args);
        return { count: 0 };
      },
      // Solo la pasada de normalización pide `dueDate`; la de estimados pide `period`
      // (y en este test no hay ninguna obligación ITBMS abierta que refrescar).
      findMany: async (args: any) => (args?.select?.dueDate ? filas : []),
      count: async () => 0,
    },
    journalLine: { findMany: async () => [] }, // estimateITBMS
  };
  return { prisma, creadas, updates, updateMany };
}

const buscar = (creadas: any[], type: string) => creadas.find((c) => c.type === type);

describe('generateUpcomingObligations — el vencimiento es un DÍA', () => {
  it('nace a MEDIODÍA local, no a medianoche', async () => {
    const { prisma, creadas } = stub();
    await generateUpcomingObligations(prisma, 'c1', new Date(2026, 5, 10, 9, 0, 0)); // 10-jun

    expect(creadas.length).toBeGreaterThan(0);
    for (const c of creadas) {
      expect(c.dueDate.getHours()).toBe(12);
      expect(c.dueDate.getMinutes()).toBe(0);
    }
    // ITBMS del período junio vence el 15 de JULIO; la CSS, el 5 de julio.
    const itbms = buscar(creadas, 'ITBMS');
    const css = buscar(creadas, 'CSS');
    expect([itbms.dueDate.getMonth(), itbms.dueDate.getDate()]).toEqual([6, 15]);
    expect([css.dueDate.getMonth(), css.dueDate.getDate()]).toEqual([6, 5]);
  });

  it('⭐ el DÍA del vencimiento la obligación todavía se genera (el ISR del 31 de marzo)', async () => {
    // Con el criterio viejo (`now < isrDue`) el 31 de marzo a las 18:00 ya no se
    // generaba el ISR del año: el día del vencimiento contaba como pasado.
    const { prisma, creadas } = stub();
    await generateUpcomingObligations(prisma, 'c1', new Date(2026, 2, 31, 18, 0, 0));
    const isr = buscar(creadas, 'ISR');
    expect(isr).toBeDefined();
    expect([isr.dueDate.getMonth(), isr.dueDate.getDate()]).toEqual([2, 31]);

    // Y al día siguiente, no.
    const { prisma: p2, creadas: c2 } = stub();
    await generateUpcomingObligations(p2, 'c1', new Date(2026, 3, 1, 9, 0, 0));
    expect(buscar(c2, 'ISR')).toBeUndefined();
  });

  it('⭐ marca vencidas por DÍA: una que vence hoy no está vencida hasta mañana', async () => {
    const { prisma, updateMany } = stub();
    const now = new Date(2026, 9, 15, 20, 0, 0); // 15-oct, 8 de la noche
    await generateUpcomingObligations(prisma, 'c1', now);

    const marcar = updateMany.find((u) => u.data.status === 'OVERDUE');
    expect(marcar.where.status).toBe('PENDING');
    expect(marcar.where.dueDate.lt).toEqual(new Date(2026, 9, 15, 0, 0, 0)); // inicio de hoy
  });

  it('desmarca la que quedó vencida antes de tiempo (el estado se corrige solo)', async () => {
    const { prisma, updateMany } = stub();
    const now = new Date(2026, 9, 15, 20, 0, 0);
    await generateUpcomingObligations(prisma, 'c1', now);

    const desmarcar = updateMany.find((u) => u.data.status === 'PENDING' && u.where.status === 'OVERDUE');
    expect(desmarcar).toBeDefined();
    expect(desmarcar.where.dueDate.gte).toEqual(new Date(2026, 9, 15, 0, 0, 0));
  });

  it('⭐ normaliza a mediodía los vencimientos viejos, sin mover el día ni repetirse', async () => {
    const filas = [
      { id: 'a', dueDate: new Date(2026, 7, 15, 0, 0, 0) }, // medianoche (dato viejo de verano)
      { id: 'b', dueDate: new Date(2026, 11, 15, 0, 0, 0) }, // medianoche (invierno)
      { id: 'c', dueDate: new Date(2026, 7, 5, 12, 0, 0) }, // ya está a mediodía
    ];
    const { prisma, updates } = stub(filas);
    await generateUpcomingObligations(prisma, 'c1', new Date(2026, 5, 10, 9, 0, 0));

    const porId = new Map(updates.map((u) => [u.where.id, u.data]));
    expect(porId.get('a')?.dueDate).toEqual(new Date(2026, 7, 15, 12, 0, 0));
    expect(porId.get('b')?.dueDate).toEqual(new Date(2026, 11, 15, 12, 0, 0));
    expect(porId.has('c')).toBe(false); // la que ya estaba bien no se toca
  });
});

describe('getTaxCalendarSummary — el panel', () => {
  it('una obligación que vence hoy sigue en «próximas» después del mediodía', async () => {
    let capturado: any = null;
    const prisma = {
      taxObligation: {
        findMany: async (args: any) => {
          if (args.where.dueDate?.gte) capturado = args;
          return [];
        },
        count: async () => 0,
      },
      journalLine: { findMany: async () => [] },
    };
    await getTaxCalendarSummary(prisma, 'c1');
    const hoy = new Date();
    const inicioDeHoy = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
    expect(capturado.where.dueDate.gte).toEqual(inicioDeHoy);
  });
});
