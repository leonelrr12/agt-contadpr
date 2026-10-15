/**
 * Declaración de ITBMS (Formulario 430) como dato.
 *
 * Lo que más importa acá son las transiciones: presentar dos veces, pagar sin
 * presentar, anular y que las retenciones vuelvan a su sitio. Son las que mueven
 * crédito fiscal y las que no se pueden deshacer a mano si salen mal.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  crearDeclaracion,
  editarDeclaracion,
  presentarDeclaracion,
  pagarDeclaracion,
  anularDeclaracion,
  declaracionDelPeriodo,
  renglonesDesdeBorrador,
  liquidarDeclaracion,
  puedeTransicionar,
  retencionesAplicables,
  avisoR52,
  periodoDe,
  primerDiaDelMesSiguiente,
} from '../declaracion-itbms';
import { buildBorrador430 } from '../borrador-430';

const COMPANY = 'c1';
const USER = 'u1';

const CUENTAS = [
  { id: 'itbms', code: '2.1.05', name: 'ITBMS por Pagar', type: 'PASIVO', aliases: ['itbms-por-pagar'] },
  { id: 'ret', code: '1.1.07', name: 'ITBMS Retenido por Terceros', type: 'ACTIVO', aliases: ['itbms-retenido-terceros'] },
  { id: 'banco', code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO', aliases: [] },
  { id: 'ing', code: '4.01.02', name: 'Ventas', type: 'INGRESO', aliases: [] },
  { id: 'gasto', code: '6.01.05', name: 'Internet', type: 'GASTO', aliases: [] },
  { id: 'cxc', code: '1.1.03.01', name: 'Clientes', type: 'ACTIVO', aliases: [] },
];

/** Venta de $1.000 + ITBMS 7 % (forma real de facturas.ts). */
const venta = (id: string, fecha: Date) => ({
  id,
  companyId: COMPANY,
  date: fecha,
  description: 'VENTA: Venta - $1000 + ITBMS $70',
  status: 'BORRADOR',
  isClosing: false,
  createdById: USER,
  lines: [
    { accountId: 'cxc', debit: 1070, credit: 0 },
    { accountId: 'ing', debit: 0, credit: 1000 },
    { accountId: 'itbms', debit: 0, credit: 70 },
  ],
});

/** Pago a la DGI (forma real de ODESA). */
const pagoDgi = (id: string, fecha: Date, monto: number) => ({
  id,
  companyId: COMPANY,
  date: fecha,
  description: 'Pago de Impuesto ITBMS y Tasa Unica.',
  status: 'BORRADOR',
  isClosing: false,
  createdById: USER,
  lines: [
    { accountId: 'itbms', debit: monto, credit: 0 },
    { accountId: 'banco', debit: 0, credit: monto },
  ],
});

const retencion = (id: string, fecha: Date, monto: number, estado = 'RECIBIDA', certificado: string | null = 'C-1') => ({
  id,
  companyId: COMPANY,
  clientId: 'cli1',
  invoiceId: 'inv1',
  fecha,
  baseGravada: monto * (100 / 7),
  itbmsFacturado: monto,
  porcentaje: 0.5,
  montoRetencion: monto,
  numeroCertificado: certificado,
  estado,
  declaracionId: null,
  client: { name: 'Cliente A' },
});

function montarStub(datos: { asientos?: any[]; retenciones?: any[]; obligaciones?: any[]; declaraciones?: any[] } = {}) {
  const db = {
    asientos: datos.asientos || [],
    transacciones: [] as any[],
    retenciones: datos.retenciones || [],
    obligaciones: datos.obligaciones || [],
    declaraciones: datos.declaraciones || [],
    creados: [] as any[],
    updateMany: [] as any[],
    update: [] as any[],
  };
  let seq = 0;
  const nid = (p: string) => `${p}-${++seq}`;

  const lineasDe = (a: any) => a.lines.map((l: any) => ({ ...l, journalEntryId: a.id, account: CUENTAS.find((c) => c.id === l.accountId) }));
  const pasaFecha = (fecha: Date, w: any) => {
    if (!w) return true;
    if (w.gte && fecha < w.gte) return false;
    if (w.lt && fecha >= w.lt) return false;
    if (w.lte && fecha > w.lte) return false;
    return true;
  };
  const pasaAsiento = (a: any, w: any = {}) => {
    if (w.status?.notIn && w.status.notIn.includes(a.status)) return false;
    if (w.isClosing === false && a.isClosing) return false;
    return pasaFecha(a.date, w.date);
  };
  const filtra = (o: any, where: any = {}) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v === undefined) return true;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in v) return v.in.includes(o[k]);
        if ('not' in v) return o[k] !== v.not;
        if ('notIn' in v) return !v.notIn.includes(o[k]);
      }
      return o[k] === v;
    });

  const prisma: any = {
    company: { findUnique: async () => ({ declaraITBMS: true }) },
    auditLog: { create: async () => ({}) },
    account: {
      findMany: async ({ where }: any = {}) =>
        (where?.id?.in ? CUENTAS.filter((c) => where.id.in.includes(c.id)) : CUENTAS).map((c) => ({ ...c, isBlocked: false, requiresAnexo: false })),
    },
    journalLine: {
      findMany: async ({ where }: any) => {
        const out: any[] = [];
        for (const a of db.asientos) {
          if (!pasaAsiento(a, where?.journalEntry || {})) continue;
          for (const l of lineasDe(a)) {
            if (where?.accountId?.in && !where.accountId.in.includes(l.accountId)) continue;
            out.push(l);
          }
        }
        return out;
      },
      aggregate: async ({ where }: any) => {
        const ls = await prisma.journalLine.findMany({ where });
        return { _sum: { debit: ls.reduce((s: number, l: any) => s + l.debit, 0), credit: ls.reduce((s: number, l: any) => s + l.credit, 0) } };
      },
      count: async ({ where }: any) => (await prisma.journalLine.findMany({ where })).length,
    },
    journalEntry: {
      findMany: async ({ where }: any) => {
        if (where?.id?.in) return db.asientos.filter((a) => where.id.in.includes(a.id)).map((a) => ({ ...a, lines: lineasDe(a) }));
        if (where?.anuladoPorId?.in) return db.asientos.filter((a) => a.anuladoPorId && where.anuladoPorId.in.includes(a.anuladoPorId)).map((a) => ({ id: a.id, date: a.date }));
        return [];
      },
      findFirst: async ({ where }: any) => {
        const a = db.asientos.find((x) => x.id === where.id);
        if (!a) return null;
        // `anularAsiento` necesita la descripción y las líneas: se devuelve completo.
        return { ...a, anuladoPorId: a.anuladoPorId || null, status: a.status || 'BORRADOR', lines: lineasDe(a) };
      },
      create: async ({ data }: any) => {
        const nuevo = { id: nid('je'), ...data, status: data.status || 'BORRADOR', anuladoPorId: null, lines: data.lines?.create || [] };
        db.asientos.push(nuevo);
        db.creados.push({ tipo: 'journalEntry', data: nuevo });
        return nuevo;
      },
      update: async ({ where, data }: any) => {
        const a = db.asientos.find((x) => x.id === where.id);
        Object.assign(a, data);
        db.update.push({ tipo: 'journalEntry', where, data });
        return a;
      },
    },
    transaction: {
      findMany: async ({ where }: any) => (where?.journalEntryId?.in ? db.transacciones.filter((t) => where.journalEntryId.in.includes(t.journalEntryId)) : []),
      create: async ({ data }: any) => {
        const t = { id: nid('tx'), ...data };
        db.transacciones.push(t);
        db.creados.push({ tipo: 'transaction', data: t });
        return t;
      },
    },
    retentionItbms: {
      findMany: async ({ where }: any) =>
        db.retenciones.filter((r) => filtra(r, { companyId: where?.companyId, declaracionId: where?.declaracionId })).filter((r) => {
          if (where?.estado?.in && !where.estado.in.includes(r.estado)) return false;
          if (where?.fecha?.lt && !(new Date(r.fecha) < where.fecha.lt)) return false;
          return true;
        }),
      updateMany: async ({ where, data }: any) => {
        const alcanzadas = db.retenciones.filter((r) => {
          if (where.companyId && r.companyId !== where.companyId) return false;
          if (where.id?.in && !where.id.in.includes(r.id)) return false;
          if (where.declaracionId && r.declaracionId !== where.declaracionId) return false;
          if (where.estado && r.estado !== where.estado) return false;
          return true;
        });
        for (const r of alcanzadas) Object.assign(r, data);
        db.updateMany.push({ tipo: 'retencionItbms', where, data, count: alcanzadas.length });
        return { count: alcanzadas.length };
      },
    },
    taxObligation: {
      findFirst: async ({ where }: any) =>
        db.obligaciones.find((o) => o.companyId === where.companyId && o.type === where.type && o.period === where.period) || null,
      update: async ({ where, data }: any) => {
        const o = db.obligaciones.find((x) => x.id === where.id);
        Object.assign(o, data);
        db.update.push({ tipo: 'taxObligation', where, data });
        return o;
      },
      updateMany: async ({ where, data }: any) => {
        const alcanzadas = db.obligaciones.filter((o) => o.companyId === where.companyId && (!where.type || o.type === where.type) && (!where.period || o.period === where.period));
        for (const o of alcanzadas) Object.assign(o, data);
        return { count: alcanzadas.length };
      },
    },
    declaracionItbms: {
      findFirst: async ({ where }: any) =>
        db.declaraciones.find(
          (d) => (where.id ? d.id === where.id : true) && (!where.companyId || d.companyId === where.companyId) && (!where.period || d.period === where.period) && (!where.estado?.not || d.estado !== where.estado.not),
        ) || null,
      findMany: async ({ where }: any) => db.declaraciones.filter((d) => filtra(d, { companyId: where?.companyId, year: where?.year, estado: where?.estado })),
      create: async ({ data }: any) => {
        const d = { id: nid('dec'), saldoAFavor: false, obligacionMarcada: false, estado: 'BORRADOR', ...data };
        db.declaraciones.push(d);
        db.creados.push({ tipo: 'declaracionItbms', data: d });
        return d;
      },
      updateMany: async ({ where, data }: any) => {
        const alcanzadas = db.declaraciones.filter((d) => {
          if (where.id && d.id !== where.id) return false;
          if (where.companyId && d.companyId !== where.companyId) return false;
          if (typeof where.estado === 'string' && d.estado !== where.estado) return false;
          if (where.estado?.not && d.estado === where.estado.not) return false;
          return true;
        });
        for (const d of alcanzadas) Object.assign(d, data);
        db.updateMany.push({ tipo: 'declaracionItbms', where, data, count: alcanzadas.length });
        return { count: alcanzadas.length };
      },
    },
    $transaction: async (cb: any) => cb(prisma),
  };
  return { prisma, db };
}

const ENERO = { year: 2026, mes: 1 };
const ASIENTOS_BASE = [venta('v1', new Date(2026, 0, 15, 12, 0, 0))];

const obligacionEnero = () => [{ id: 'ob1', companyId: COMPANY, type: 'ITBMS', period: '2026-01', status: 'PENDING', actualAmount: null, estimatedAmount: 888.41, dueDate: new Date(2026, 1, 15, 12, 0, 0), notes: null }];

// ───────────────────────────── Bloque puro ─────────────────────────────

describe('declaración 430 — piezas puras', () => {
  it('la tabla de estados: BORRADOR → PRESENTADA → PAGADA, y ANULADA es terminal', () => {
    expect(puedeTransicionar('BORRADOR', 'PRESENTADA')).toBe(true);
    expect(puedeTransicionar('PRESENTADA', 'PAGADA')).toBe(true);
    expect(puedeTransicionar('PAGADA', 'ANULADA')).toBe(true);
    expect(puedeTransicionar('BORRADOR', 'PAGADA')).toBe(false);
    expect(puedeTransicionar('PRESENTADA', 'BORRADOR')).toBe(false);
    expect(puedeTransicionar('ANULADA', 'PRESENTADA')).toBe(false);
  });

  it('solo las RECIBIDAS con certificado y anteriores al cierre son aplicables', () => {
    const cierre = new Date(2026, 1, 1);
    const rows: any[] = [
      { id: 'a', fecha: new Date(2026, 0, 10), montoRetencion: 10, numeroCertificado: 'C', estado: 'RECIBIDA' },
      { id: 'b', fecha: new Date(2025, 11, 20), montoRetencion: 20, numeroCertificado: 'C', estado: 'RECIBIDA' }, // arrastre
      { id: 'c', fecha: new Date(2026, 0, 10), montoRetencion: 30, numeroCertificado: null, estado: 'PENDIENTE' },
      { id: 'd', fecha: new Date(2026, 0, 10), montoRetencion: 40, numeroCertificado: 'C', estado: 'APLICADA' },
      { id: 'e', fecha: new Date(2026, 1, 3), montoRetencion: 50, numeroCertificado: 'C', estado: 'RECIBIDA' }, // después del cierre
    ];
    expect(retencionesAplicables(rows, cierre).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('el aviso del renglón 52 dice los dos montos y qué hacer con lo que no tiene certificado', () => {
    expect(avisoR52(35, 35, 0)).toBeNull();
    const aviso = avisoR52(0, 35, 4727.36)!;
    expect(aviso).toContain('$0.00');
    expect(aviso).toContain('$35.00');
    expect(aviso).toContain('4727.36');
    expect(aviso).toContain('Retenciones ITBMS');
  });

  it('el período y el mínimo de presentación', () => {
    expect(periodoDe(2026, 1)).toBe('2026-01');
    expect(primerDiaDelMesSiguiente(2026, 1)).toEqual(new Date(2026, 1, 1, 12, 0, 0, 0));
    expect(primerDiaDelMesSiguiente(2026, 12)).toEqual(new Date(2027, 0, 1, 12, 0, 0, 0));
  });
});

// ─────────────────────── crear / editar (con stub) ───────────────────────

describe('declaración 430 — crear y editar', () => {
  let ctx: ReturnType<typeof montarStub>;
  beforeEach(() => {
    ctx = montarStub({ asientos: ASIENTOS_BASE, obligaciones: obligacionEnero() });
  });

  it('nace con los números del borrador, sin tocar asientos ni retenciones', async () => {
    const borrador = await buildBorrador430(ctx.prisma, COMPANY, ENERO, 2026);
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });

    expect(dec.estado).toBe('BORRADOR');
    expect(dec.renglones.debitoFiscal).toBe(borrador.liquidacion.debitoFiscal);
    expect(dec.renglones.creditoFiscal).toBe(borrador.liquidacion.creditoFiscal);
    expect(dec.renglones.saldoAnterior).toBe(borrador.liquidacion.saldoAnterior);
    expect(dec.saldoAPagar).toBe(borrador.liquidacion.debitoFiscal - borrador.liquidacion.creditoFiscal);
    // La foto del borrador queda guardada para poder enseñar «declarado vs libro».
    expect(dec.borrador).toBeTruthy();
    expect(dec.borrador.cuadre.cuadra).toBe(true);
    // Nada más se movió: ni un asiento, ni una retención, ni la obligación.
    expect(ctx.db.creados.filter((c) => c.tipo !== 'declaracionItbms')).toHaveLength(0);
    expect(ctx.db.updateMany).toHaveLength(0);
  });

  it('no deja dos declaraciones vivas del mismo período (409)', async () => {
    await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await expect(crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 })).rejects.toMatchObject({ status: 409 });
  });

  it('una ANULADA no bloquea volver a declarar el período', async () => {
    await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    ctx.db.declaraciones[0].estado = 'ANULADA';
    const nueva = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    expect(nueva.estado).toBe('BORRADOR');
    expect(ctx.db.declaraciones).toHaveLength(2);
  });

  it('editar recalcula el saldo, y en PRESENTADA no deja tocar nada', async () => {
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    const editada = await editarDeclaracion(ctx.prisma, {
      companyId: COMPANY, userId: USER, id: dec.id,
      renglones: { debitoFiscal: 1000, creditoFiscal: 200 },
    });
    expect(editada.saldoAPagar).toBe(800);

    ctx.db.declaraciones[0].estado = 'PRESENTADA';
    const antes = ctx.db.updateMany.length;
    await expect(editarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, renglones: { debitoFiscal: 5 } })).rejects.toMatchObject({ status: 409 });
    expect(ctx.db.updateMany.length).toBe(antes); // no escribió nada
  });
});

// ─────────────────────────── presentar ───────────────────────────

describe('declaración 430 — presentar', () => {
  it('⭐ sin retenciones con certificado (el caso de producción): presenta igual y avisa', async () => {
    const ctx = montarStub({
      asientos: ASIENTOS_BASE,
      obligaciones: obligacionEnero(),
      retenciones: [retencion('r1', new Date(2026, 0, 20), 35, 'PENDIENTE', null)],
    });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    const r = await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: '430-2026-01-1' });

    expect(r.declaracion.estado).toBe('PRESENTADA');
    expect(r.asientoCompensacion).toBeNull();
    expect(r.totalAplicado).toBe(0);
    expect(r.pendienteCertificado).toBe(35);
    expect(r.avisos[0]).toContain('certificado');
    expect(ctx.db.creados.filter((c) => c.tipo === 'journalEntry')).toHaveLength(0);
    expect(ctx.db.retenciones[0].estado).toBe('PENDIENTE'); // intacta
    expect(r.obligacionMarcada).toBe(true);
  });

  it('⭐ con retenciones RECIBIDAS: asiento D 2.1.05 / C 1.1.07, retenciones a APLICADA y vínculo real', async () => {
    const ctx = montarStub({
      asientos: [
        ...ASIENTOS_BASE,
        {
          id: 'c1', companyId: COMPANY, date: new Date(2026, 0, 12, 12, 0, 0), description: 'Internet', status: 'BORRADOR', isClosing: false, createdById: USER,
          lines: [
            { accountId: 'gasto', debit: 500, credit: 0 },
            { accountId: 'itbms', debit: 35, credit: 0 },
            { accountId: 'banco', debit: 0, credit: 535 },
          ],
        },
      ],
      obligaciones: obligacionEnero(),
      retenciones: [retencion('r1', new Date(2026, 0, 20), 35, 'RECIBIDA')],
    });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    expect(dec.renglones.retencionAplicada).toBe(35); // el borrador ya la veía disponible

    const r = await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: '430-2026-01-2', fechaPresentacion: '2026-02-10' });

    expect(r.declaracion.estado).toBe('PRESENTADA');
    expect(r.totalAplicado).toBe(35);
    expect(r.asientoCompensacion?.total).toBe(35);

    const asiento = ctx.db.asientos.find((a) => a.id === r.asientoCompensacion!.id);
    const lineas = asiento.lines.map((l: any) => `${l.accountId}:${l.debit}:${l.credit}`).sort();
    expect(lineas).toEqual(['itbms:35:0', 'ret:0:35']);
    expect(asiento.status).toBe('BORRADOR'); // la compensación la aprueba el contador
    expect(ctx.db.retenciones[0].estado).toBe('APLICADA');
    expect(ctx.db.retenciones[0].declaracionId).toBe(dec.id);
    // La marca de la Transaction es la que hace que el borrador la clasifique sin avisos.
    expect(ctx.db.transacciones[0].type).toBe('PAGO_ITBMS');
    expect(JSON.parse(ctx.db.transacciones[0].metadata).declaracionId).toBe(dec.id);
    expect(ctx.db.obligaciones[0].status).toBe('COMPLETED');
    expect(ctx.db.obligaciones[0].actualAmount).toBe(dec.saldoAPagar);
  });

  it('⭐ presentar dos veces: el segundo intento no crea un segundo asiento', async () => {
    const ctx = montarStub({
      asientos: ASIENTOS_BASE,
      obligaciones: obligacionEnero(),
      retenciones: [retencion('r1', new Date(2026, 0, 20), 35)],
    });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' });

    await expect(
      presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-2' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(ctx.db.creados.filter((c) => c.tipo === 'journalEntry')).toHaveLength(1);
  });

  it('si el renglón 52 no cuadra con lo aplicable, no presenta y no toca nada', async () => {
    const ctx = montarStub({
      asientos: ASIENTOS_BASE,
      obligaciones: obligacionEnero(),
      retenciones: [retencion('r1', new Date(2026, 0, 20), 35)],
    });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    // El contador deja el renglón 52 en cero aunque hay $35 aplicables.
    await editarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, renglones: { retencionAplicada: 0 } });

    await expect(
      presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(ctx.db.creados.filter((c) => c.tipo !== 'declaracionItbms')).toHaveLength(0);
    expect(ctx.db.retenciones[0].estado).toBe('RECIBIDA');
    expect(ctx.db.declaraciones[0].estado).toBe('BORRADOR');
  });

  it('no se puede presentar antes de que cierre el mes declarado', async () => {
    const ctx = montarStub({ asientos: ASIENTOS_BASE, obligaciones: obligacionEnero() });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await expect(
      presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1', fechaPresentacion: '2026-01-20' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('sin obligación en el calendario (período viejo) presenta igual', async () => {
    const ctx = montarStub({ asientos: ASIENTOS_BASE });
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    const r = await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' });
    expect(r.declaracion.estado).toBe('PRESENTADA');
    expect(r.obligacionMarcada).toBe(false);
  });
});

// ─────────────────────────── pagar y anular ───────────────────────────

describe('declaración 430 — pagar y anular', () => {
  const conRetencion = () =>
    montarStub({
      asientos: ASIENTOS_BASE,
      obligaciones: obligacionEnero(),
      retenciones: [retencion('r1', new Date(2026, 0, 20), 35)],
    });

  it('el pago nace CONFIRMADO contra el banco elegido', async () => {
    const ctx = conRetencion();
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' });

    const r = await pagarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, cuentaBancoId: 'banco' });
    expect(r.monto).toBe(dec.saldoAPagar);
    const asiento = ctx.db.asientos.find((a) => a.id === r.journalEntryId);
    expect(asiento.status).toBe('CONFIRMADO');
    // D 2.1.05 / C banco por el saldo declarado ($70 de débito − $35 de R52).
    expect(dec.saldoAPagar).toBe(35);
    expect(asiento.lines.map((l: any) => `${l.accountId}:${l.debit}:${l.credit}`).sort()).toEqual(['banco:0:35', 'itbms:35:0']);
    expect(r.declaracion.estado).toBe('PAGADA');
    expect(r.declaracion.montoPagado).toBe(dec.saldoAPagar);
  });

  it('no se puede pagar sin presentar, ni dos veces, ni un saldo a favor', async () => {
    const ctx = conRetencion();
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await expect(pagarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, cuentaBancoId: 'banco' })).rejects.toMatchObject({ status: 409 });

    await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' });
    await pagarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, cuentaBancoId: 'banco' });
    await expect(pagarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, cuentaBancoId: 'banco' })).rejects.toMatchObject({ status: 409 });

    // Saldo a favor: no se paga, se arrastra (D2). Hace falta un pago de un mes
    // ANTERIOR: los pagos del propio mes no son renglones del formulario.
    const ctx2 = montarStub({ asientos: [pagoDgi('p0', new Date(2025, 11, 5, 12, 0, 0), 500), venta('v1', new Date(2026, 0, 15, 12, 0, 0))] });
    const dec2 = await crearDeclaracion(ctx2.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    await presentarDeclaracion(ctx2.prisma, { companyId: COMPANY, userId: USER, id: dec2.id, numeroFormulario: 'B-1' });
    expect(dec2.saldoAPagar).toBeLessThan(0);
    await expect(pagarDeclaracion(ctx2.prisma, { companyId: COMPANY, userId: USER, id: dec2.id, cuentaBancoId: 'banco' })).rejects.toMatchObject({ status: 400 });
  });

  it('⭐ anular revierte los asientos, devuelve las retenciones y suelta el período', async () => {
    const ctx = conRetencion();
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    const pres = await presentarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, numeroFormulario: 'A-1' });
    await pagarDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, cuentaBancoId: 'banco' });

    const r = await anularDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, motivo: 'Se presentó con un número equivocado' });
    expect(r.declaracion.estado).toBe('ANULADA');
    expect(r.asientosAnulados).toHaveLength(2); // compensación + pago
    expect(r.retencionesDevueltas).toBe(1);
    expect(r.obligacionDevuelta).toBe(true);

    // Los espejos quedan marcados en el original y fechados hoy.
    for (const a of r.asientosAnulados) {
      const original = ctx.db.asientos.find((x) => x.id === a.originalId);
      const reverso = ctx.db.asientos.find((x) => x.id === a.reversalId);
      expect(original.anuladoPorId).toBe(reverso.id);
      expect(reverso.description.startsWith('ANULACIÓN:')).toBe(true);
    }
    expect(ctx.db.retenciones[0].estado).toBe('RECIBIDA');
    expect(ctx.db.retenciones[0].declaracionId).toBeNull();
    expect(ctx.db.obligaciones[0].status).toBe('OVERDUE'); // el vencimiento ya pasó; se recalcula por fecha
    expect(ctx.db.obligaciones[0].actualAmount).toBeNull();
    void pres;

    // Y el período vuelve a estar libre.
    const nueva = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    expect(nueva.estado).toBe('BORRADOR');
  });

  it('anular dos veces falla, y una BORRADOR no toca retenciones ni obligación', async () => {
    const ctx = conRetencion();
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    const r = await anularDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, motivo: 'Me equivoqué de mes' });
    expect(r.asientosAnulados).toHaveLength(0);
    expect(r.retencionesDevueltas).toBe(0);
    expect(r.obligacionDevuelta).toBe(false);
    expect(ctx.db.retenciones[0].estado).toBe('RECIBIDA');
    expect(ctx.db.obligaciones[0].status).toBe('PENDING');

    await expect(anularDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, id: dec.id, motivo: 'otra vez' })).rejects.toMatchObject({ status: 409 });
  });

  it('declaracionDelPeriodo ignora las anuladas', async () => {
    const ctx = conRetencion();
    const dec = await crearDeclaracion(ctx.prisma, { companyId: COMPANY, userId: USER, ...ENERO, anioFiscal: 2026 });
    expect((await declaracionDelPeriodo(ctx.prisma, COMPANY, '2026-01'))?.id).toBe(dec.id);
    ctx.db.declaraciones[0].estado = 'ANULADA';
    expect(await declaracionDelPeriodo(ctx.prisma, COMPANY, '2026-01')).toBeNull();
  });
});

// ─────────────────── la declaración nace igual que el informe ───────────────────

describe('renglonesDesdeBorrador', () => {
  it('⭐ el saldo a pagar de la declaración es el del borrador (mismos números)', async () => {
    const ctx = montarStub({
      asientos: [
        venta('v1', new Date(2026, 0, 15, 12, 0, 0)),
        {
          id: 'c1', companyId: COMPANY, date: new Date(2026, 0, 12, 12, 0, 0), description: 'Internet', status: 'BORRADOR', isClosing: false, createdById: USER,
          lines: [
            { accountId: 'gasto', debit: 500, credit: 0 },
            { accountId: 'itbms', debit: 35, credit: 0 },
            { accountId: 'banco', debit: 0, credit: 535 },
          ],
        },
        pagoDgi('p1', new Date(2026, 0, 20, 12, 0, 0), 200),
      ],
      retenciones: [retencion('r1', new Date(2026, 0, 25), 35)],
    });
    const borrador = await buildBorrador430(ctx.prisma, COMPANY, ENERO, 2026);
    const renglones = renglonesDesdeBorrador(borrador);
    const { saldoAPagar, saldoAFavor } = liquidarDeclaracion(renglones);

    // El informe resta también los pagos del mes y las compensaciones; la declaración
    // es el formulario: débito − crédito − R52 + saldo anterior.
    expect(renglones.debitoFiscal).toBe(70);
    expect(renglones.creditoFiscal).toBe(35);
    expect(renglones.retencionAplicada).toBe(35);
    expect(saldoAPagar).toBe(0);
    expect(saldoAFavor).toBe(false);
    expect(borrador.cuadre.cuadra).toBe(true);
  });
});
