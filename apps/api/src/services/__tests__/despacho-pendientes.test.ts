import { describe, it, expect } from 'vitest';
import { pendientesPorEmpresa } from '../despacho-pendientes';

/**
 * El tablero es lo primero que mira un contador al sentarse: si un número miente,
 * pierde el día en la empresa equivocada. Las tres cosas que importan: que el
 * buzón con problemas se vea, que lo vencido se cuente bien (no lo que todavía no
 * venció) y que un error en una empresa no deje sin tablero a las demás.
 */

const prismaFalso = (opts: any = {}) => ({
  journalEntry: { count: async () => opts.borradores ?? 0 },
  emailFacturaConfig: {
    findUnique: async () => ('cfg' in opts ? opts.cfg : { ultimoEstado: 'OK', ultimoDetalle: null, isActive: true }),
  },
  emailFacturaMensaje: { count: async () => opts.correos ?? 0 },
  invoice: { findMany: async () => opts.vencidas ?? [] },
  taxObligation: { findMany: async () => opts.obligaciones ?? [] },
  subscription: {
    findFirst: async () => ('sub' in opts ? opts.sub : { movementsUsed: 3, movementsLimit: 500, plan: { name: 'Demo' } }),
  },
});

const EMPRESA = [{ id: 'c1', name: 'Empresa Uno', role: 'superadmin' }];

describe('pendientesPorEmpresa', () => {
  it('trae los cinco números de la empresa', async () => {
    const prisma = prismaFalso({
      borradores: 4,
      correos: 2,
      vencidas: [{ total: 100, paidAmount: 40 }, { total: 60, paidAmount: 60 }],
      obligaciones: [{ status: 'OVERDUE' }, { status: 'PENDING' }, { status: 'PENDING' }],
    });

    const [e] = await pendientesPorEmpresa(prisma, EMPRESA);

    expect(e.borradores).toBe(4);
    expect(e.buzon.problemas).toBe(2);
    expect(e.porCobrar).toEqual({ vencidas: 2, monto: 60 }); // la pagada aporta 0
    expect(e.obligaciones).toEqual({ vencidas: 1, porVencer: 2 });
    expect(e.cuota).toEqual({ usado: 3, limite: 500, plan: 'Demo' });
  });

  it('un buzón caído se ve aunque no haya correos trabados', async () => {
    const prisma = prismaFalso({ cfg: { ultimoEstado: 'ERROR_CREDENCIALES', ultimoDetalle: 'El servidor rechazó el usuario', isActive: true } });
    const [e] = await pendientesPorEmpresa(prisma, EMPRESA);
    expect(e.buzon.estado).toBe('ERROR_CREDENCIALES');
    expect(e.buzon.detalle).toContain('rechazó');
  });

  it('un buzón apagado a propósito NO es un pendiente', async () => {
    const prisma = prismaFalso({ cfg: { ultimoEstado: 'INACTIVO', ultimoDetalle: 'El buzón no está activo.', isActive: false } });
    const [e] = await pendientesPorEmpresa(prisma, EMPRESA);
    expect(e.buzon.detalle).toBeNull();
  });

  it('el CxC vencido excluye las facturas de contado', async () => {
    const prisma: any = prismaFalso({ vencidas: [] });
    let args: any;
    prisma.invoice.findMany = async (a: any) => { args = a; return []; };

    await pendientesPorEmpresa(prisma, EMPRESA);

    expect(args.where.OR).toEqual([
      { paymentMethod: null },
      { paymentMethod: { not: 'EFECTIVO' } },
    ]);
  });

  it('sin suscripción la cuota es 0 y no rompe', async () => {
    const prisma = prismaFalso({ sub: null });
    const [e] = await pendientesPorEmpresa(prisma, EMPRESA);
    expect(e.cuota).toEqual({ usado: 0, limite: 0, plan: null });
  });

  it('si una empresa falla, las demás igual salen', async () => {
    const prisma: any = prismaFalso();
    let llamadas = 0;
    prisma.journalEntry.count = async () => {
      llamadas++;
      if (llamadas === 1) throw new Error('esa empresa tiene la BD rota');
      return 7;
    };

    const r = await pendientesPorEmpresa(prisma, [
      { id: 'c1', name: 'Rota', role: 'contador' },
      { id: 'c2', name: 'Sana', role: 'contador' },
    ]);

    expect(r).toHaveLength(2);
    expect(r[0].borradores).toBe(0); // la que falló queda en cero, no tumba nada
    expect(r[1].borradores).toBe(7);
  });
});
