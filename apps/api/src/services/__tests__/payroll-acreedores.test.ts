/**
 * El aviso de los acreedores compara la planilla CONTRA SÍ MISMA, no contra el saldo
 * de la cuenta.
 *
 * La cuenta 2.1.07.01 de Odesa tiene historia previa al módulo (planillas cargadas a
 * mano, correcciones y pagos). Comparar `devengado` con el saldo del mayor hacía que
 * el aviso saltara siempre —incluso con el saldo igual al retenido— y decía "el mayor
 * no cuadra" sin que la planilla tuviera nada inconsistente. Lo que importa es que los
 * asientos de las corridas vivas acrediten exactamente lo que dicen las cuotas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resumenAcreedores } from '../payroll-acreedores';

let creditosPlanilla: number;
let movimientos: { debit: number; credit: number };

const prisma: any = {
  payrollItemDeduction: {
    findMany: async () => [{
      cuentaId: 'acc-1',
      acreedor: 'Banco General — préstamo',
      monto: 108.64,
      employeeId: 'e1',
      deduccionId: 'd1',
      employee: { nombre: 'ALBRYND CASTILLO' },
    }],
  },
  account: {
    findMany: async () => [{ id: 'acc-1', code: '2.1.07.01', name: 'Banco General - Acreedor Empleados' }],
  },
  payrollItem: { findMany: async () => [{ journalEntryId: 'je-planilla' }] },
  journalLine: {
    groupBy: async (args: any) => {
      // Dos consultas: el mayor entero (sin journalEntryId) y los créditos de los
      // asientos que creó la planilla (con journalEntryId).
      if (args.where.journalEntryId) return [{ accountId: 'acc-1', _sum: { credit: creditosPlanilla } }];
      return [{ accountId: 'acc-1', _sum: { debit: movimientos.debit, credit: movimientos.credit } }];
    },
  },
};

beforeEach(() => {
  creditosPlanilla = 108.64;
  movimientos = { debit: 814.8, credit: 814.8 };
});

describe('resumenAcreedores — aviso contra los asientos de la planilla', () => {
  it('no avisa aunque la cuenta tenga movimientos manuales e históricos', async () => {
    const [a] = await resumenAcreedores(prisma, 'c1');

    expect(a.devengado).toBe(108.64);
    expect(a.pagado).toBe(814.8);
    expect(a.saldo).toBe(0);
    expect(a.aviso).toBe('');
  });

  it('no avisa solo porque el saldo del mayor no sea devengado − pagado', async () => {
    // El caso que veía el contador: saldo 108.64 e igual al retenido, pero con
    // pagos históricos que la planilla no conoce. Antes el aviso saltaba igual.
    movimientos = { debit: 706.16, credit: 814.8 };

    const [a] = await resumenAcreedores(prisma, 'c1');

    expect(a.saldo).toBe(108.64);
    expect(a.aviso).toBe('');
  });

  it('avisa cuando los asientos de la planilla no acreditan lo retenido', async () => {
    creditosPlanilla = 100;

    const [a] = await resumenAcreedores(prisma, 'c1');

    expect(a.aviso).toBe('la planilla retuvo 108.64 pero sus asientos acreditaron 100.00 en la cuenta');
  });
});
