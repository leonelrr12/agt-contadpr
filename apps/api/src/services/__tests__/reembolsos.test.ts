import { describe, it, expect } from 'vitest';
import { buildDedupeKey, registrarFacturaRecibida, saldoPendiente, avisoDuplicado } from '../reembolsos';

/**
 * El control de reembolsos se apoya en dos cosas que no pueden fallar en
 * silencio: la clave que impide pagar DOS VECES la misma factura, y el monto a
 * reembolsar. El monto sale del asiento (suma de débitos = lo que el trabajador
 * pagó, neto + ITBMS), no de un campo aparte, justamente para que no haya dos
 * reglas de negocio que puedan divergir.
 */

const asiento = (lines: Array<{ debit: number }>) => ({
  id: 'je-1',
  date: new Date('2026-10-08T12:00:00'),
  lines: lines.map(l => ({ debit: l.debit, credit: 0 })),
});

const prismaFalso = (over: any = {}) => ({
  expenseClaim: {
    findFirst: async () => null,
    create: async ({ data }: any) => ({ id: 'claim-1', ...data }),
    aggregate: async () => ({ _sum: { total: 0 } }),
    ...over,
  },
});

describe('buildDedupeKey', () => {
  it('usa los datos propios de la factura (sobreviven a que cambie el enlace)', () => {
    const key = buildDedupeKey({
      ruc: '356-19-77860', numeroFactura: '0000221106',
      fecha: '2026-10-03', total: 107,
      dgiUrl: 'https://dgi-fep.mef.gob.pa/x',
    });
    expect(key).toBe('F:3561977860:0000221106:2026-10-03:107.00');
  });

  it('normaliza el formato del monto: 107 y 107.00 son la misma factura', () => {
    const base = { ruc: '8-1-2', numeroFactura: '10', fecha: '2026-10-03' };
    expect(buildDedupeKey({ ...base, total: 107 })).toBe(buildDedupeKey({ ...base, total: 107.0 }));
  });

  it('dos facturas del mismo proveedor con montos distintos NO colisionan', () => {
    const base = { ruc: '8-1-2', numeroFactura: '10', fecha: '2026-10-03' };
    expect(buildDedupeKey({ ...base, total: 107 })).not.toBe(buildDedupeKey({ ...base, total: 108 }));
  });

  it('sin número legible cae a la URL del CUTE', () => {
    const key = buildDedupeKey({ ruc: '8-1-2', numeroFactura: null, fecha: '2026-10-03', total: 107, dgiUrl: 'https://dgi-fep.mef.gob.pa/a' });
    expect(key).toMatch(/^U:[0-9a-f]{32}$/);
    // La misma URL da la misma clave; una distinta, no.
    expect(buildDedupeKey({ dgiUrl: 'https://dgi-fep.mef.gob.pa/a' })).toBe(buildDedupeKey({ dgiUrl: 'https://dgi-fep.mef.gob.pa/a' }));
    expect(buildDedupeKey({ dgiUrl: 'https://dgi-fep.mef.gob.pa/b' })).not.toBe(buildDedupeKey({ dgiUrl: 'https://dgi-fep.mef.gob.pa/a' }));
  });

  it('sin nada con qué identificarla devuelve null (no se deduplica)', () => {
    expect(buildDedupeKey({})).toBeNull();
    expect(buildDedupeKey({ proveedor: 'FERRETERÍA', total: 50 })).toBeNull();
  });
});

describe('registrarFacturaRecibida', () => {
  it('guarda el total del ASIENTO (neto + ITBMS), no el del extractor', async () => {
    const prisma = prismaFalso();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'GASTO',
      journalEntry: asiento([{ debit: 100 }, { debit: 7 }]),
      factura: { ruc: '8-1-2', numeroFactura: '10', fecha: '2026-10-03', total: 100, itbms: 7 },
    });
    expect(r.creado).toBe(true);
    expect(r.claim.total).toBe(107);
    expect(r.claim.itbms).toBe(7);
    expect(r.claim.status).toBe('PENDIENTE');
  });

  it('arrastra la URL del CUTE y el XML al reclamo', async () => {
    const prisma = prismaFalso();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'COMPRA',
      journalEntry: asiento([{ debit: 50 }]),
      factura: { dgiUrl: 'https://dgi-fep.mef.gob.pa/x', dgiXml: '<f/>', proveedor: 'FERRETERÍA' },
    });
    expect(r.claim.dgiUrl).toBe('https://dgi-fep.mef.gob.pa/x');
    expect(r.claim.dgiXml).toBe('<f/>');
    expect(r.claim.total).toBe(50);
  });

  it('una factura repetida no se registra dos veces', async () => {
    const prisma = prismaFalso({
      findFirst: async () => ({ id: 'claim-viejo', worker: { nombre: 'Juan' }, status: 'PENDIENTE' }),
    });
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'GASTO',
      journalEntry: asiento([{ debit: 100 }]),
      factura: { ruc: '8-1-2', numeroFactura: '10', fecha: '2026-10-03', total: 100 },
    });
    expect(r.creado).toBe(false);
    expect(r.motivo).toBe('duplicada');
    expect(r.duplicado.id).toBe('claim-viejo');
  });

  it('una carrera contra el índice único se trata como duplicada, no como error', async () => {
    const prisma = prismaFalso({
      create: async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); },
      findFirst: async () => ({ id: 'claim-otro', worker: { nombre: 'Ana' } }),
    });
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'GASTO',
      journalEntry: asiento([{ debit: 100 }]),
      factura: { ruc: '8-1-2', numeroFactura: '10', fecha: '2026-10-03', total: 100 },
    });
    expect(r.creado).toBe(false);
    expect(r.motivo).toBe('duplicada');
  });

  it('una venta NO genera reembolso', async () => {
    const prisma = prismaFalso();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'VENTA',
      journalEntry: asiento([{ debit: 100 }]),
      factura: null,
    });
    expect(r.creado).toBe(false);
  });

  it('sin asiento no hay nada que reembolsar', async () => {
    const r = await registrarFacturaRecibida(prismaFalso(), {
      companyId: 'c1', workerId: 'w1', tipo: 'GASTO', journalEntry: null, factura: null,
    });
    expect(r.creado).toBe(false);
  });

  it('una factura sin datos igual se registra (el trabajador pagó de su bolsillo)', async () => {
    const prisma = prismaFalso();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: 'w1', tipo: 'GASTO',
      journalEntry: asiento([{ debit: 25 }]),
      factura: null,
    });
    expect(r.creado).toBe(true);
    expect(r.claim.dedupeKey).toBeNull();
    expect(r.claim.total).toBe(25);
  });
});

describe('saldoPendiente', () => {
  it('redondea a centavos y devuelve 0 sin reclamos', async () => {
    expect(await saldoPendiente(prismaFalso(), 'c1', 'w1')).toBe(0);
    const prisma = prismaFalso({ aggregate: async () => ({ _sum: { total: 107.005 } }) });
    expect(await saldoPendiente(prisma, 'c1', 'w1')).toBe(107.01);
  });
});

/**
 * El pago del reembolso. Lo que estos casos cuidan:
 *  · que el asiento sea el correcto (baja el pasivo contra el banco) y que
 *    CONFIRME las facturas que seguían en borrador — el dueño pidió que apruebe
 *    el mismo que paga;
 *  · que no se pueda pagar dos veces, ni con dos clics simultáneos: el candado
 *    es el `updateMany` condicionado a PENDIENTE dentro de la transacción.
 */
import { pagarReembolso } from '../reembolsos';

const claim = (id: string, total: number, status = 'PENDIENTE', entryStatus = 'CONFIRMADO') => ({
  id, total, status, journalEntryId: `je-${id}`, journalEntry: { id: `je-${id}`, status: entryStatus },
});

function prismaPago(over: any = {}) {
  const escrituras = { confirmadas: [] as string[], claims: 0, asiento: null as any };
  const tx = {
    journalEntry: {
      updateMany: async ({ where }: any) => { escrituras.confirmadas.push(...(where.id?.in || [])); return { count: where.id?.in?.length || 0 }; },
      create: async ({ data }: any) => { escrituras.asiento = data; return { id: 'je-pago', ...data }; },
    },
    reimbursement: { create: async ({ data }: any) => ({ id: 'reemb-1', ...data }) },
    expenseClaim: {
      updateMany: async () => ({ count: over.claimsActualizadas ?? 2 }),
    },
  };
  return {
    escrituras,
    workerAccount: { findFirst: async () => ({ id: 'w1', nombre: 'Juan Pérez' }) },
    account: {
      findFirst: async ({ where }: any) => {
        if (where.aliases) return null;                       // sin alias: cae al código
        if (where.code === '2.1.02.02') return { id: 'pasivo-id', code: '2.1.02.02', name: 'Reembolsos Empleados por Pagar' };
        if (where.id === 'banco-id') return { id: 'banco-id', code: '1.1.02.01', name: 'Banco General' };
        return null;
      },
    },
    expenseClaim: { findMany: async () => over.claims ?? [claim('a', 107), claim('b', 25)] },
    $transaction: async (fn: any) => fn(tx),
    ...over.prisma,
  };
}

const pago = (prisma: any, extra: any = {}) => pagarReembolso(prisma, {
  companyId: 'c1', workerId: 'w1', claimIds: ['a', 'b'], cuentaBancoId: 'banco-id',
  fecha: '2026-10-08', userId: 'u1', ...extra,
});

describe('pagarReembolso', () => {
  it('suma las facturas y arma el asiento contra el pasivo y el banco', async () => {
    const p = prismaPago();
    const r = await pago(p);
    expect(r.total).toBe(132);
    expect(r.facturas).toBe(2);
    expect(p.escrituras.asiento.lines.create).toEqual([
      { accountId: 'pasivo-id', debit: 132, credit: 0 },
      { accountId: 'banco-id', debit: 0, credit: 132 },
    ]);
    expect(p.escrituras.asiento.description).toContain('Juan Pérez');
    expect(p.escrituras.asiento.status).toBe('CONFIRMADO');
  });

  it('el pago aprueba las facturas que seguían en BORRADOR', async () => {
    const p = prismaPago({ claims: [claim('a', 107, 'PENDIENTE', 'BORRADOR'), claim('b', 25)] });
    const r = await pago(p);
    expect(p.escrituras.confirmadas).toEqual(['je-a']);
    expect(r.aprobadas).toBe(1);
  });

  it('no toca las que ya estaban confirmadas', async () => {
    const p = prismaPago();
    await pago(p);
    expect(p.escrituras.confirmadas).toEqual([]);
  });

  it('una factura ya pagada se rechaza antes de tocar nada', async () => {
    const p = prismaPago({ claims: [claim('a', 107), claim('b', 25, 'PAGADO')] });
    await expect(pago(p)).rejects.toThrow(/ya .*pagada/i);
    expect(p.escrituras.asiento).toBeNull();
  });

  it('dos clics a la vez: si otro proceso se adelantó, no se paga nada', async () => {
    // El updateMany condicionado a PENDIENTE actualiza menos filas que las pedidas
    const p = prismaPago({ claimsActualizadas: 1 });
    await expect(pago(p)).rejects.toThrow(/cambió mientras lo pagabas/);
  });

  it('sin la cuenta 2.1.02.02 el error dice cuál crear', async () => {
    const p = prismaPago();
    p.account.findFirst = async ({ where }: any) => (where.id === 'banco-id' ? { id: 'banco-id', code: '1.1.02.01', name: 'Banco General' } : null);
    await expect(pago(p)).rejects.toThrow(/2\.1\.02\.02/);
  });

  it('una factura sin asiento válido no se reembolsa', async () => {
    const p = prismaPago({ claims: [{ ...claim('a', 107), journalEntryId: null, journalEntry: null }, claim('b', 25)] });
    await expect(pago(p)).rejects.toThrow(/sin asiento válido/);
  });

  it('sin facturas seleccionadas no hace nada', async () => {
    await expect(pago(prismaPago(), { claimIds: [] })).rejects.toThrow(/No hay facturas/);
  });
});

/**
 * La MISMA tabla archiva las facturas de la empresa (sin trabajador): son las
 * que el contador sube por WhatsApp y hasta ahora se perdían. Sin `workerId` no
 * hay reembolso — solo el registro consultable con su URL y su XML.
 */
describe('registrarFacturaRecibida — factura de la empresa', () => {
  it('se archiva sin trabajador', async () => {
    const prisma = prismaFalso();
    const r = await registrarFacturaRecibida(prisma, {
      companyId: 'c1', workerId: null, tipo: 'GASTO',
      journalEntry: asiento([{ debit: 113 }]),
      factura: { dgiUrl: 'https://dgi-fep.mef.gob.pa/x', dgiXml: '<f/>', proveedor: 'ENSA', ruc: '8-1-2', numeroFactura: '99', fecha: '2026-10-03', total: 113 },
    });
    expect(r.creado).toBe(true);
    expect(r.claim.workerId).toBeNull();
    expect(r.claim.dgiUrl).toBe('https://dgi-fep.mef.gob.pa/x');
    expect(r.claim.total).toBe(113);
  });

  it('una venta no se archiva como factura recibida', async () => {
    const r = await registrarFacturaRecibida(prismaFalso(), {
      companyId: 'c1', workerId: null, tipo: 'VENTA',
      journalEntry: asiento([{ debit: 100 }]), factura: null,
    });
    expect(r.creado).toBe(false);
  });
});

describe('avisoDuplicado', () => {
  it('con trabajador dice quién y en qué estado está', () => {
    const msg = avisoDuplicado({ workerId: 'w1', worker: { nombre: 'Juan' }, status: 'PENDIENTE', createdAt: new Date('2026-10-08T12:00:00') });
    expect(msg).toContain('Juan');
    expect(msg).toContain('pendiente de reembolso');
  });

  it('una factura de la empresa no habla de reembolsos', () => {
    const msg = avisoDuplicado({ workerId: null, worker: null, status: 'PENDIENTE', createdAt: new Date('2026-10-08T12:00:00') });
    expect(msg).toContain('factura de la empresa');
    expect(msg).not.toContain('reembols');
    expect(msg).not.toContain('trabajador');
  });
});
