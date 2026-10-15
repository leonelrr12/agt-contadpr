/**
 * Tests del borrador del Formulario 430.
 *
 * El grueso son casos de `clasificarAsiento430`, que es pura: ahí está el riesgo del
 * informe (decidir si un débito a 2.1.05 es crédito fiscal, pago a la DGI o
 * compensación del R52) y por eso se prueba sin Prisma. Los montos y las formas de
 * asiento están copiados de los escritores reales del repo, no inventados.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBorrador430,
  clasificarAsiento430,
  r2s,
  rangoMes,
  type Contexto430,
  type Linea430,
} from '../borrador-430';

// ─────────────────────────── utilidades de prueba ───────────────────────────

const ITBMS = 'itbms';
const RET = 'ret';
const BANCO = 'banco';
const CAJA = 'caja';

function ctxPrueba(retenido = true): Contexto430 {
  return {
    porPagar: [{ id: ITBMS, code: '2.1.05', name: 'ITBMS por Pagar', origen: 'alias' }],
    porPagarIds: new Set([ITBMS]),
    retenido: retenido ? { id: RET, code: '1.1.07', name: 'ITBMS Retenido por Terceros', origen: 'alias' } : null,
    retenidoIds: new Set(retenido ? [RET] : []),
    codigosEfectivo: new Set([BANCO, CAJA, '1.1.01', '1.1.02.01', '1.1.02.02']),
  };
}

const L = (accountId: string, code: string, type: string, debit: number, credit: number, name = ''): Linea430 => ({
  accountId,
  code,
  name,
  type,
  debit,
  credit,
});

// ─────────────────────────── A. clasificación pura ───────────────────────────

describe('clasificarAsiento430', () => {
  it('VENTA: acredita 2.1.05 con crédito a INGRESO → débito fiscal y base del ingreso', () => {
    const c = clasificarAsiento430(
      [L('cxc', '1.1.03.01', 'ACTIVO', 1070, 0), L('ing', '4.01.01', 'INGRESO', 0, 1000), L(ITBMS, '2.1.05', 'PASIVO', 0, 70)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('VENTA');
    expect(c.creditoItbms).toBe(70);
    expect(c.debitoItbms).toBe(0);
    expect(c.baseGravada).toBe(1000);
    expect(c.tasaImplicita).toBe(0.07);
    expect(c.confianza).toBe('ALTA');
    expect(c.avisos).not.toContain('TASA_ATIPICA');
  });

  it('VENTA con salida de kardex: la base es SOLO el ingreso, no el costo ni el inventario', () => {
    // Forma real de facturas.ts: el asiento lleva el ingreso, el ITBMS, la CxC y la
    // salida de inventario con su costo.
    const c = clasificarAsiento430(
      [
        L('cxc', '1.1.03.01', 'ACTIVO', 1070, 0),
        L('ing', '4.01.02', 'INGRESO', 0, 1000),
        L(ITBMS, '2.1.05', 'PASIVO', 0, 70),
        L('costo', '5.01.01', 'COSTO', 400, 0),
        L('inv', '1.1.04.01', 'ACTIVO', 0, 400),
      ],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('VENTA');
    expect(c.baseGravada).toBe(1000);
    expect(c.tasaImplicita).toBe(0.07);
  });

  it('COMPRA al contado: base = débito de gasto', () => {
    const c = clasificarAsiento430(
      [L('g', '6.01.05', 'GASTO', 48.33, 0), L(ITBMS, '2.1.05', 'PASIVO', 3.38, 0), L(BANCO, '1.1.02.02', 'ACTIVO', 0, 51.71)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('COMPRA');
    expect(c.debitoItbms).toBe(3.38);
    expect(c.baseGravada).toBe(48.33);
    expect(c.avisos).not.toContain('TASA_ATIPICA');
  });

  it('COMPRA de inventario (kardex): el débito al activo es la base', () => {
    const c = clasificarAsiento430(
      [L('inv', '1.1.04.01', 'ACTIVO', 1000, 0), L(ITBMS, '2.1.05', 'PASIVO', 70, 0), L(BANCO, '1.1.02.01', 'ACTIVO', 0, 1070)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('COMPRA');
    expect(c.baseGravada).toBe(1000);
  });

  it('asiento de inventario MIXTO (regularización + compra): la base netea los créditos', () => {
    // inventario.ts arma un solo asiento con la regularización (crédito a inventario /
    // débito a costo) y la compra (débito a inventario + ITBMS / crédito a banco).
    // Sumar solo débitos daría base 1400; la compra real es 1000.
    const c = clasificarAsiento430(
      [
        L('inv', '1.1.04.01', 'ACTIVO', 1000, 400),
        L('costo', '5.01.01', 'COSTO', 400, 0),
        L(ITBMS, '2.1.05', 'PASIVO', 70, 0),
        L(BANCO, '1.1.02.01', 'ACTIVO', 0, 1070),
      ],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('COMPRA');
    expect(c.baseGravada).toBe(1000);
    expect(c.tasaImplicita).toBe(0.07);
    expect(c.avisos).toContain('BASE_NETA_DE_CREDITOS');
  });

  it('⭐ PAGO_ITBMS de ODESA: débito a 2.1.05 contra banco NO es crédito fiscal', () => {
    // El caso que infla el crédito fiscal si se resta a lo bruto: en ODESA los pagos
    // a la DGI (2.524,77) superan a las compras del período.
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 506.17, 0), L(BANCO, '1.1.02.02', 'ACTIVO', 0, 506.17)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('PAGO_DGI');
    expect(c.debitoItbms).toBe(506.17);
    expect(c.baseGravada).toBeNull();
    expect(c.avisos).toContain('PAGO_SIN_MARCA'); // en producción estos pagos no traen Transaction
  });

  it('PAGO_ITBMS con la marca del chat: confianza alta y sin aviso', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 500, 0), L(BANCO, '1.1.02.01', 'ACTIVO', 0, 500)],
      ctxPrueba(),
      { transactionType: 'PAGO_ITBMS' },
    );
    expect(c.bucket).toBe('PAGO_DGI');
    expect(c.confianza).toBe('ALTA');
    expect(c.avisos).not.toContain('PAGO_SIN_MARCA');
  });

  it('gasto con marca de Transaction pero sin línea de gasto: crédito fiscal con base no derivable', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 70, 0), L(BANCO, '1.1.02.01', 'ACTIVO', 0, 70)],
      ctxPrueba(),
      { transactionType: 'GASTO' },
    );
    expect(c.bucket).toBe('COMPRA');
    expect(c.baseGravada).toBeNull();
    expect(c.avisos).toContain('BASE_NO_DERIVABLE');
  });

  it('COMPENSACIÓN R52: débito 2.1.05 contra 1.1.07, no es crédito fiscal', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 35, 0), L(RET, '1.1.07', 'ACTIVO', 0, 35)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('COMPENSACION_R52');
    expect(c.debitoItbms).toBe(35);
    expect(c.confianza).toBe('ALTA');
  });

  it('compensación descuadrada (ITBMS ≠ retención) se avisa', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 35, 0), L(RET, '1.1.07', 'ACTIVO', 0, 30)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('COMPENSACION_R52');
    expect(c.avisos).toContain('COMPENSACION_DESCUADRADA');
  });

  it('⭐ ANULACIÓN de venta: el espejo resta débito fiscal y NO entra al crédito fiscal', () => {
    // journal-annul.ts crea el espejo con description 'ANULACIÓN: …'. Sin tratarlo
    // aparte cae en COMPRA (tiene un débito a 2.1.05 y otro débito) y el ITBMS de una
    // venta anulada inflaría el crédito fiscal.
    const c = clasificarAsiento430(
      [
        L('ing', '4.01.02', 'INGRESO', 1000, 0),
        L(ITBMS, '2.1.05', 'PASIVO', 70, 0),
        L('cxc', '1.1.03.01', 'ACTIVO', 0, 1070),
      ],
      ctxPrueba(),
      { descripcion: 'ANULACIÓN: VENTA: Venta - $1000 + ITBMS $70' },
    );
    expect(c.bucket).toBe('VENTA');
    expect(c.esAnulacion).toBe(true);
    expect(c.creditoItbms).toBe(-70); // resta al débito fiscal del mes
    expect(c.debitoItbms).toBe(0);
    expect(c.baseGravada).toBe(-1000);
  });

  it('ANULACIÓN de compra: el espejo devuelve el crédito fiscal', () => {
    const c = clasificarAsiento430(
      [L('g', '6.01.05', 'GASTO', 0, 48.33), L(ITBMS, '2.1.05', 'PASIVO', 0, 3.38), L(BANCO, '1.1.02.01', 'ACTIVO', 48.33, 0)],
      ctxPrueba(),
      { descripcion: 'ANULACIÓN: Internet — $48.33 + ITBMS $3.38' },
    );
    expect(c.bucket).toBe('COMPRA');
    expect(c.debitoItbms).toBe(-3.38);
    expect(c.baseGravada).toBe(-48.33);
  });

  it('devolución a proveedor (nota de crédito de compra): acredita 2.1.05 sin ser venta', () => {
    const c = clasificarAsiento430(
      [L('prov', '2.1.01', 'PASIVO', 1070, 0), L('g', '6.01.05', 'GASTO', 0, 1000), L(ITBMS, '2.1.05', 'PASIVO', 0, 70)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('NOTA_CREDITO_COMPRA');
    expect(c.creditoItbms).toBe(70);
    expect(c.baseGravada).toBe(1000);
  });

  it('movimiento contra cuenta de balance: AJUSTE, fuera de la liquidación', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 50, 0), L('prov', '2.1.01', 'PASIVO', 0, 50)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('AJUSTE');
    expect(c.efectoSaldo).toBe(-50);
  });

  it('contrapartida desconocida: NO_CLASIFICADO (no se suma a ningún renglón)', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 50, 0), L('x', '9.99', 'OTRO', 0, 50)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('NO_CLASIFICADO');
    expect(c.confianza).toBe('BAJA');
    expect(c.motivo).toContain('9.99');
  });

  it('asiento mixto (debita y acredita 2.1.05): se clasifica por el neto y se avisa', () => {
    const c = clasificarAsiento430(
      [L(ITBMS, '2.1.05', 'PASIVO', 30, 70), L('ing', '4.01.02', 'INGRESO', 0, 900), L('cxc', '1.1.03.01', 'ACTIVO', 960, 0)],
      ctxPrueba(),
    );
    expect(c.bucket).toBe('VENTA');
    expect(c.efectoSaldo).toBe(40);
    expect(c.confianza).toBe('BAJA');
    expect(c.avisos).toContain('ASIENTO_MIXTO');
    expect(c.avisos).toContain('CLASIFICACION_AMBIGUA');
  });
});

// ─────────────────────────── B. rango del mes ───────────────────────────

describe('rangoMes', () => {
  it('⭐ el ÚLTIMO día del mes entra (regresión del patrón new Date(año, mes, 0))', () => {
    const { start, endExclusive } = rangoMes(2026, 9);
    expect(start).toEqual(new Date(2026, 8, 1, 0, 0, 0, 0));
    expect(endExclusive).toEqual(new Date(2026, 9, 1, 0, 0, 0, 0));
    // Un asiento a mediodía local del 30 de septiembre (la convención del repo) cae dentro.
    const ultimoDia = new Date(2026, 8, 30, 12, 0, 0);
    expect(ultimoDia >= start && ultimoDia < endExclusive).toBe(true);
  });

  it('el día 1 del mes siguiente queda fuera, incluso a medianoche', () => {
    const { endExclusive } = rangoMes(2026, 9);
    expect(new Date(2026, 9, 1, 0, 0, 0) < endExclusive).toBe(false);
  });

  it('diciembre desborda al año siguiente sin caso especial', () => {
    expect(rangoMes(2026, 12).endExclusive).toEqual(new Date(2027, 0, 1, 0, 0, 0, 0));
  });

  it('vence el día 15 del mes siguiente, a mediodía local', () => {
    expect(rangoMes(2026, 9).vence).toEqual(new Date(2026, 9, 15, 12, 0, 0));
    expect(rangoMes(2026, 12).vence).toEqual(new Date(2027, 0, 15, 12, 0, 0));
  });
});

// ─────────────────────────── D. redondeo ───────────────────────────

describe('r2s', () => {
  it('redondea el medio hacia arriba en MAGNITUD, también en negativos', () => {
    expect(r2s(34.125)).toBe(34.13);
    expect(r2s(-34.125)).toBe(-34.13);
    expect(r2s(0.1 + 0.2)).toBe(0.3);
    expect(r2s(0)).toBe(0);
  });
});

// ─────────────────────────── C. informe completo ───────────────────────────

interface CuentaStub {
  id: string;
  code: string;
  name: string;
  type: string;
  aliases?: string[];
}
interface AsientoStub {
  id: string;
  date: Date;
  description: string;
  status?: string;
  isClosing?: boolean;
  lines: Array<{ accountId: string; debit: number; credit: number }>;
}

const CUENTAS_BASE: CuentaStub[] = [
  { id: ITBMS, code: '2.1.05', name: 'ITBMS por Pagar', type: 'PASIVO', aliases: ['itbms-por-pagar'] },
  { id: RET, code: '1.1.07', name: 'ITBMS Retenido por Terceros', type: 'ACTIVO', aliases: ['itbms-retenido-terceros'] },
  { id: BANCO, code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO' },
  { id: CAJA, code: '1.1.01', name: 'Caja', type: 'ACTIVO' },
  { id: 'ing', code: '4.01.02', name: 'Ventas', type: 'INGRESO' },
  { id: 'g', code: '6.01.05', name: 'Internet', type: 'GASTO' },
  { id: 'cxc', code: '1.1.03.01', name: 'Clientes', type: 'ACTIVO' },
];

function stubPrisma(opts: {
  cuentas?: CuentaStub[];
  asientos: AsientoStub[];
  transacciones?: Array<{ journalEntryId: string; type: string }>;
  retenciones?: any[];
}) {
  const cuentas = opts.cuentas || CUENTAS_BASE;
  const cuentaPorId = new Map(cuentas.map((c) => [c.id, c]));
  const conLineas = (a: AsientoStub) => ({
    ...a,
    status: a.status || 'BORRADOR',
    isClosing: a.isClosing || false,
    lines: a.lines.map((l) => ({ ...l, account: cuentaPorId.get(l.accountId) })),
  });
  const dentro = (fecha: Date, w: any) => {
    if (!w) return true;
    if (w.gte && fecha < w.gte) return false;
    if (w.lt && fecha >= w.lt) return false;
    if (w.lte && fecha > w.lte) return false;
    return true;
  };
  const pasaFiltroAsiento = (a: AsientoStub, w: any = {}) => {
    const status = a.status || 'BORRADOR';
    if (w.status?.notIn && w.status.notIn.includes(status)) return false;
    if (w.isClosing === false && a.isClosing) return false;
    if (w.isClosing === true && !a.isClosing) return false;
    return dentro(a.date, w.date);
  };
  const lineas = (where: any = {}) => {
    const out: any[] = [];
    for (const a of opts.asientos) {
      if (!pasaFiltroAsiento(a, where.journalEntry || {})) continue;
      for (const l of a.lines) {
        if (where.accountId?.in && !where.accountId.in.includes(l.accountId)) continue;
        out.push({ ...l, journalEntryId: a.id });
      }
    }
    return out;
  };
  const prisma = {
    account: { findMany: async ({ where }: any = {}) => cuentas.filter((c) => !where?.type || c.type === where.type) },
    journalLine: {
      findMany: async ({ where }: any) => lineas(where).map((l) => ({ journalEntryId: l.journalEntryId, debit: l.debit, credit: l.credit })),
      aggregate: async ({ where }: any) => {
        const ls = lineas(where);
        return { _sum: { debit: ls.reduce((s, l) => s + l.debit, 0), credit: ls.reduce((s, l) => s + l.credit, 0) } };
      },
      count: async ({ where }: any) => lineas(where).length,
    },
    journalEntry: {
      findMany: async ({ where }: any) => {
        if (where?.id?.in) return opts.asientos.filter((a) => where.id.in.includes(a.id)).map(conLineas);
        if (where?.anuladoPorId?.in) {
          return opts.asientos
            .filter((a: any) => a.anuladoPorId && where.anuladoPorId.in.includes(a.anuladoPorId))
            .map((a) => ({ id: a.id, date: a.date }));
        }
        return [];
      },
    },
    transaction: {
      findMany: async ({ where }: any) =>
        (opts.transacciones || []).filter((t) => !where?.journalEntryId?.in || where.journalEntryId.in.includes(t.journalEntryId)),
    },
    retentionItbms: { findMany: async () => opts.retenciones || [] },
  };
  return prisma as any;
}

/** Venta de $1.000 + ITBMS 7 % (forma real de facturas.ts). */
const asientoVenta = (id: string, date: Date, extra: Partial<AsientoStub> = {}): AsientoStub => ({
  id,
  date,
  description: 'VENTA: Venta - $1000 + ITBMS $70',
  lines: [
    { accountId: 'cxc', debit: 1070, credit: 0 },
    { accountId: 'ing', debit: 0, credit: 1000 },
    { accountId: ITBMS, debit: 0, credit: 70 },
  ],
  ...extra,
});

/** Compra de $500 + ITBMS 7 % pagada con banco. */
const asientoCompra = (id: string, date: Date, extra: Partial<AsientoStub> = {}): AsientoStub => ({
  id,
  date,
  description: 'Internet — $500 + ITBMS $35',
  lines: [
    { accountId: 'g', debit: 500, credit: 0 },
    { accountId: ITBMS, debit: 35, credit: 0 },
    { accountId: BANCO, debit: 0, credit: 535 },
  ],
  ...extra,
});

/** Pago a la DGI (forma real de ODESA: «Pago de Impuesto ITBMS y Tasa Unica»). */
const asientoPago = (id: string, date: Date, monto = 200): AsientoStub => ({
  id,
  date,
  description: 'Pago de Impuesto ITBMS y Tasa Unica.',
  lines: [
    { accountId: ITBMS, debit: monto, credit: 0 },
    { accountId: BANCO, debit: 0, credit: monto },
  ],
});

describe('buildBorrador430', () => {
  it('mes con venta, compra y pago: renglones correctos y cuadre en verde', async () => {
    const prisma = stubPrisma({
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)),
        asientoCompra('c1', new Date(2026, 8, 12, 12, 0, 0)),
        asientoPago('p1', new Date(2026, 8, 20, 12, 0, 0), 200),
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);

    const debito = r.renglones.find((x) => x.id === 'debitoFiscal')!;
    const credito = r.renglones.find((x) => x.id === 'creditoFiscal')!;
    const pagos = r.renglones.find((x) => x.id === 'pagosDgi')!;
    expect(debito.monto).toBe(70);
    expect(credito.monto).toBe(35); // el pago de 200 NO entra al crédito fiscal
    expect(pagos.monto).toBe(200);
    expect(r.liquidacion.sinRetenciones).toBe(35);
    expect(r.liquidacion.totalAPagar).toBe(-165); // 35 − 200 pagados → saldo a favor
    expect(r.liquidacion.saldoAFavor).toBe(true);
    expect(r.detalle.find((d) => d.journalEntryId === 'p1')!.clasificacion).toBe('PAGO_DGI');
    expect(r.cuadre.cuadra).toBe(true);
    expect(r.cuadre.diferencia).toBe(0);
    expect(r.cuadre.movimientoLibroMes).toBe(-165); // 70 − 35 − 200
    expect(r.cuadre.sumaDeBuckets).toBe(-165);
    expect(r.noClasificados).toHaveLength(0);
  });

  it('un asiento sin clasificar tumba el cuadre y sale listado', async () => {
    const prisma = stubPrisma({
      cuentas: [...CUENTAS_BASE, { id: 'raro', code: '9.99', name: 'Cuenta rara', type: 'OTRO' }],
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)),
        {
          id: 'x1',
          date: new Date(2026, 8, 15, 12, 0, 0),
          description: 'Algo raro',
          lines: [
            { accountId: ITBMS, debit: 40, credit: 0 },
            { accountId: 'raro', debit: 0, credit: 40 },
          ],
        },
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.noClasificados).toHaveLength(1);
    expect(r.cuadre.cuadra).toBe(false);
    expect(r.avisos.some((a) => a.codigo === 'SIN_CLASIFICAR' && a.nivel === 'error')).toBe(true);
    // El movimiento sin clasificar no entra al crédito fiscal.
    expect(r.renglones.find((x) => x.id === 'creditoFiscal')!.monto).toBe(0);
    expect(r.renglones.find((x) => x.id === 'noClasificado')!.monto).toBe(-40);
  });

  it('los BORRADOR cuentan (con aviso) y los RECHAZADOS no', async () => {
    const prisma = stubPrisma({
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)),
        asientoVenta('v2', new Date(2026, 8, 11, 12, 0, 0), { status: 'RECHAZADO' }),
        asientoVenta('v3', new Date(2026, 8, 12, 12, 0, 0), { status: 'CONFIRMADO' }),
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.renglones.find((x) => x.id === 'debitoFiscal')!.monto).toBe(140); // v1 + v3
    expect(r.cuadre.asientosBorrador).toBe(1);
    expect(r.incluyeBorradores).toBe(true);
    expect(r.avisos.some((a) => a.codigo === 'BORRADORES_INCLUIDOS')).toBe(true);
  });

  it('⭐ el asiento del ÚLTIMO día del mes entra al informe', async () => {
    const prisma = stubPrisma({
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 30, 12, 0, 0)), // 30-sep a mediodía
        asientoVenta('v2', new Date(2026, 9, 1, 12, 0, 0)), // 01-oct: otro mes
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.cuadre.asientos).toBe(1);
    expect(r.renglones.find((x) => x.id === 'debitoFiscal')!.monto).toBe(70);
  });

  it('saldo anterior con signo: un mes previo con más débitos que créditos da saldo a favor, sin clamp', async () => {
    const prisma = stubPrisma({
      asientos: [
        asientoPago('p0', new Date(2026, 7, 20, 12, 0, 0), 300), // agosto: pago de 300 sin ventas
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)), // septiembre
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.saldoAnterior.monto).toBe(-300);
    expect(r.saldoAnterior.saldoAFavor).toBe(true);
    expect(r.liquidacion.totalAPagar).toBe(-230); // −300 + 70
    expect(r.liquidacion.saldoAFavor).toBe(true);
    expect(r.cuadre.cuadra).toBe(true);
  });

  it('⭐ el saldo a favor se ARRASTRA al mes siguiente (regla del contador, 15-10-2026)', async () => {
    // Septiembre cierra con saldo a favor (más compra que venta) y octubre tiene que
    // abrir con ese saldo como anterior: el favor no se pierde ni se pide en devolución.
    const prisma = stubPrisma({
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)), // 70 de débito fiscal
        asientoCompra('c1', new Date(2026, 8, 12, 12, 0, 0)), // 35 de crédito fiscal
        asientoPago('p1', new Date(2026, 8, 20, 12, 0, 0), 200), // 200 pagados a la DGI
        asientoVenta('v2', new Date(2026, 9, 5, 12, 0, 0)), // octubre: 70 de débito fiscal
      ],
    });
    const sep = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    const oct = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 10 }, 2026);

    expect(sep.liquidacion.totalAPagar).toBe(-165);
    expect(sep.liquidacion.saldoAFavor).toBe(true);
    expect(sep.liquidacion.reglaSaldoAFavor).toBe('ARRASTRE');
    expect(oct.saldoAnterior.monto).toBe(-165); // lo recibe como anterior
    expect(oct.saldoAnterior.saldoAFavor).toBe(true);
    expect(oct.liquidacion.totalAPagar).toBe(-95); // −165 + 70
    expect(oct.cuadre.cuadra).toBe(true);
  });

  it('el R52 disponible son las retenciones RECIBIDAS sin compensar; una APLICADA no se resta dos veces', async () => {
    const prisma = stubPrisma({
      asientos: [asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0))],
      retenciones: [
        { id: 'r1', fecha: new Date(2026, 8, 12, 12, 0, 0), estado: 'RECIBIDA', montoRetencion: 35, baseGravada: 500, itbmsFacturado: 35, numeroCertificado: 'C-1', client: { name: 'Cliente A' } },
        { id: 'r2', fecha: new Date(2026, 6, 5, 12, 0, 0), estado: 'APLICADA', montoRetencion: 50, baseGravada: 700, itbmsFacturado: 50, numeroCertificado: 'C-2', client: { name: 'Cliente B' } },
        { id: 'r3', fecha: new Date(2026, 8, 20, 12, 0, 0), estado: 'ANULADA', montoRetencion: 99, baseGravada: 0, itbmsFacturado: 0, numeroCertificado: null, client: { name: 'Cliente C' } },
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.retenciones.disponibles).toBe(35);
    expect(r.retenciones.aplicadasAcumuladas).toBe(50);
    expect(r.retenciones.registrosDelMes).toBe(1); // la ANULADA no cuenta ni aparece
    expect(r.retenciones.delMes).toBe(35);
    expect(r.liquidacion.renglon52).toBe(35);
    expect(r.liquidacion.aPagarMes).toBe(35); // 70 − 35
  });

  it('alias remapeado: se cuentan las líneas del alias Y las del código 2.1.05', async () => {
    const prisma = stubPrisma({
      cuentas: [
        { id: 'nueva', code: '2.1.05.99', name: 'ITBMS por Pagar (nueva)', type: 'PASIVO', aliases: ['itbms-por-pagar'] },
        { id: ITBMS, code: '2.1.05', name: 'ITBMS por Pagar', type: 'PASIVO' },
        ...CUENTAS_BASE.filter((c) => c.id !== ITBMS),
      ],
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)), // usa el id ITBMS (código)
        {
          id: 'v2',
          date: new Date(2026, 8, 11, 12, 0, 0),
          description: 'VENTA: Venta - $1000 + ITBMS $70',
          lines: [
            { accountId: 'cxc', debit: 1070, credit: 0 },
            { accountId: 'ing', debit: 0, credit: 1000 },
            { accountId: 'nueva', debit: 0, credit: 70 }, // usa el alias
          ],
        },
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.cuentas.porPagar).toHaveLength(2);
    expect(r.renglones.find((x) => x.id === 'debitoFiscal')!.monto).toBe(140);
    expect(r.cuadre.cuadra).toBe(true);
  });

  it('sin cuenta 1.1.07 no lanza: avisa y la compensación queda fuera del crédito fiscal', async () => {
    const prisma = stubPrisma({
      cuentas: CUENTAS_BASE.filter((c) => c.id !== RET),
      asientos: [
        asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)),
        {
          id: 'k1',
          date: new Date(2026, 8, 15, 12, 0, 0),
          description: 'Compensación R52 — retenciones sufridas $35.00',
          // Sin 1.1.07 en el catálogo, la contrapartida es una cuenta de balance
          // cualquiera: cae en AJUSTE (fuera de la liquidación), nunca en crédito fiscal.
          lines: [
            { accountId: ITBMS, debit: 35, credit: 0 },
            { accountId: 'cxc', debit: 0, credit: 35 },
          ],
        },
      ],
    });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.avisos.some((a) => a.codigo === 'CUENTA_RETENCION_NO_RESUELTA')).toBe(true);
    expect(r.renglones.find((x) => x.id === 'creditoFiscal')!.monto).toBe(0);
    expect(r.detalle.find((d) => d.journalEntryId === 'k1')!.clasificacion).toBe('AJUSTE');
    expect(r.renglones.find((x) => x.id === 'ajustes')!.monto).toBe(-35);
    expect(r.cuadre.cuadra).toBe(true); // el movimiento sigue contado, pero visible
  });

  it('período como strings YYYY-MM-DD (el frontend los pinta tal cual: un ISO con Z se ve un día antes)', async () => {
    const prisma = stubPrisma({ asientos: [] });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.periodo.start).toBe('2026-09-01');
    expect(r.periodo.end).toBe('2026-09-30');
    expect(r.periodo.vence).toBe('2026-10-15');
    expect(r.periodo.label).toBe('Septiembre 2026');
  });

  it('la base gravada se reporta por tasa y las exentas no aparecen (la nota lo dice)', async () => {
    const prisma = stubPrisma({ asientos: [asientoVenta('v1', new Date(2026, 8, 10, 12, 0, 0)), asientoCompra('c1', new Date(2026, 8, 12, 12, 0, 0))] });
    const r = await buildBorrador430(prisma, 'c1', { year: 2026, mes: 9 }, 2026);
    expect(r.bases.ventasGravadas).toBe(1000);
    expect(r.bases.comprasGravadas).toBe(500);
    expect(r.bases.ventasPorTasa).toEqual({ '7.00%': 1000 });
    expect(r.bases.nota).toContain('exentas');
  });
});
