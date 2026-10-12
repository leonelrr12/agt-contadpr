import { describe, it, expect } from 'vitest';
import { autoMatch, findUnmatchedBookEntries } from '../bank-matcher';

/**
 * Dos cosas del extracto de ENERO (11-10):
 *
 *  · Con dos movimientos idénticos en el extracto (dos YAPPY de $11,50 el
 *    03-ene) y dos asientos idénticos en el libro, las DOS filas se quedaban
 *    con el MISMO asiento y el gemelo aparecía como "sin conciliar (libros)"
 *    para siempre. El reparto tiene que ser uno a uno.
 *  · La lista de "sin conciliar (libros)" mostraba los asientos de TODAS las
 *    cuentas 1.1.02.*, así que el extracto de una cuenta traía como pendientes
 *    el alquiler, la planilla y las letras que salieron de otros bancos
 *    (84 asientos cuando solo 9 eran de la cuenta del extracto).
 */

const fecha = (d: string) => new Date(`${d}T12:00:00`);

/**
 * Vínculos banco ↔ partidas del libro (tabla bank_row_match). Los stubs viejos
 * no la tenían; `vinculadas` deja simular líneas ya conciliadas a mano.
 */
const vinculosFalsos = (vinculadas: any[] = []) => ({
  findMany: async () => vinculadas,
  create: async ({ data }: any) => data,
  createMany: async ({ data }: any) => ({ count: data.length }),
  deleteMany: async () => ({ count: 0 }),
});

/** Dos movimientos idénticos en el extracto. */
const filasExtracto = () => [
  { id: 'r1', date: fecha('2026-01-03'), description: 'YAPPY BG A CARLOS GUTIERREZ', reference: '1', debit: 11.5, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
  { id: 'r2', date: fecha('2026-01-03'), description: 'YAPPY BG A CARLOS GUTIERREZ', reference: '1', debit: 11.5, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
];

/** Dos asientos idénticos en el libro (uno por cada pago). */
const lineasLibro = () => ['je-A', 'je-B'].map(id => ({
  id: `jl-${id}`, journalEntryId: id, debit: 0, credit: 11.5,
  journalEntry: { id, date: fecha('2026-01-03'), description: 'YAPPY BG A CARLOS GUTIERREZ ESPINOSA' },
  account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' },
}));

function prismaDeMatching() {
  const filas = filasExtracto();
  const updates: Array<{ id: string; matchedEntryId: string }> = [];
  const bankStatementRow: any = {
    findMany: async ({ where }: any) =>
      where.status === 'UNMATCHED' ? filas : [], // nadie conciliado todavía
    update: async ({ where, data }: any) => {
      updates.push({ id: where.id, matchedEntryId: data.matchedEntryId });
      return { ...filas.find(f => f.id === where.id), ...data };
    },
  };
  return { updates, bankStatementRow, journalLine: { findMany: async () => lineasLibro() }, bankRowMatch: vinculosFalsos() };
}

describe('autoMatch — un asiento por fila', () => {
  it('dos movimientos idénticos se reparten los dos asientos (no el mismo dos veces)', async () => {
    const prisma = prismaDeMatching();
    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(m => m.entryId)).size).toBe(2); // asientos distintos
    expect(prisma.updates).toEqual([
      { id: 'r1', matchedEntryId: 'je-A' },
      { id: 'r2', matchedEntryId: 'je-B' },
    ]);
  });

  it('un asiento ya conciliado en otro extracto no se reutiliza', async () => {
    const prisma = prismaDeMatching();
    prisma.bankStatementRow.findMany = async ({ where }: any) =>
      where.status === 'UNMATCHED' ? filasExtracto() : [{ matchedEntryId: 'je-A' }];

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(1);
    expect(matches[0].entryId).toBe('je-B');
  });
});

describe('findUnmatchedBookEntries — solo la cuenta del extracto', () => {
  it('pide los asientos de la cuenta del extracto, no de todos los bancos', async () => {
    let where: any = null;
    let include: any = null;
    const prisma = {
      bankStatementRow: { findMany: async () => [] },
      bankRowMatch: vinculosFalsos(),
      journalEntry: {
        findMany: async (args: any) => {
          where = args.where;
          include = args.include;
          return [{ id: 'je-libre' }];
        },
      },
    };

    const r = await findUnmatchedBookEntries(prisma as any, 'odesa', 'acc-8829', fecha('2026-01-01'), fecha('2026-01-31'));

    expect(where.lines.some).toEqual({ accountId: 'acc-8829' });
    expect(include.lines.where).toEqual({ accountId: 'acc-8829' });
    expect(r).toEqual([{ id: 'je-libre' }]);
  });

  it('descarta los asientos que ya sostienen una fila del extracto', async () => {
    const prisma = {
      bankStatementRow: { findMany: async () => [{ matchedEntryId: 'je-conciliado' }] },
      bankRowMatch: vinculosFalsos(),
      journalEntry: { findMany: async () => [{ id: 'je-conciliado' }, { id: 'je-libre' }] },
    };

    const r = await findUnmatchedBookEntries(prisma as any, 'odesa', 'acc-8829');

    expect(r.map((e: any) => e.id)).toEqual(['je-libre']);
  });

  /**
   * El ACH de Inmobiliaria Don Antonio (20-feb, $17.353,68) son cuatro facturas
   * cobradas de una vez: la fila se vincula a mano con las cuatro y solo una de
   * ellas es el `matchedEntryId` de la fila. Las otras tres también están
   * conciliadas y no pueden seguir apareciendo como pendientes.
   */
  it('descarta también los asientos vinculados por línea (varias partidas por fila)', async () => {
    const prisma = {
      bankStatementRow: { findMany: async () => [{ matchedEntryId: 'je-993' }] },
      bankRowMatch: vinculosFalsos([
        { entryId: 'je-993' }, { entryId: 'je-994' }, { entryId: 'je-995' }, { entryId: 'je-996' },
      ]),
      journalEntry: {
        findMany: async () => ['je-993', 'je-994', 'je-995', 'je-996', 'je-libre'].map(id => ({ id })),
      },
    };

    const r = await findUnmatchedBookEntries(prisma as any, 'odesa', 'acc-8829');

    expect(r.map((e: any) => e.id)).toEqual(['je-libre']);
  });
});

/**
 * Un asiento puede tener DOS líneas de banco: el 06-ene el libro cargó las dos
 * transferencias a 2810-1 ($5.000 y $2.100) en un solo asiento, con una línea
 * por cada una. Bloquear por asiento dejaba la de $5.000 "sin conciliar" aunque
 * su línea estuviera libre — la unidad es la línea.
 */
describe('autoMatch — un asiento con dos líneas de banco sostiene dos filas', () => {
  const filasTransferencias = () => [
    { id: 't1', date: fecha('2026-01-06'), description: 'TRANSFERENCIA A 0473000028101', reference: '1', debit: 5000, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
    { id: 't2', date: fecha('2026-01-06'), description: 'TRANSFERENCIA A 0473000028101', reference: '1', debit: 2100, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
  ];

  const prismaCon = (lineas: any[], filas: any[] = filasTransferencias()) => {
    const updates: Array<{ id: string; matchedEntryId: string }> = [];
    return {
      updates,
      bankStatementRow: {
        findMany: async ({ where }: any) => (where.status === 'UNMATCHED' ? filas : []),
        update: async ({ where, data }: any) => {
          updates.push({ id: where.id, matchedEntryId: data.matchedEntryId });
          return data;
        },
      },
      journalLine: { findMany: async () => lineas },
      bankRowMatch: vinculosFalsos(),
    };
  };

  it('las dos filas se concilian contra el mismo asiento, cada una con su línea', async () => {
    const lineas = [
      { id: 'jl-T1', journalEntryId: 'je-T', debit: 0, credit: 5000, journalEntry: { id: 'je-T', date: fecha('2026-01-06'), description: 'TRANFERENCIA DE 2610-1 A 8829-7' }, account: { code: '1.1.02.01', name: 'Banco' } },
      { id: 'jl-T2', journalEntryId: 'je-T', debit: 0, credit: 2100, journalEntry: { id: 'je-T', date: fecha('2026-01-06'), description: 'TRANFERENCIA DE 2610-1 A 8829-7' }, account: { code: '1.1.02.01', name: 'Banco' } },
    ];
    const prisma = prismaCon(lineas);

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(2);
    expect(matches.map(m => m.entryId)).toEqual(['je-T', 'je-T']);
    expect(prisma.updates).toEqual([
      { id: 't1', matchedEntryId: 'je-T' },
      { id: 't2', matchedEntryId: 'je-T' },
    ]);
  });

  it('una sola línea del libro no sostiene dos filas: la segunda queda sin conciliar', async () => {
    const lineas = [
      { id: 'jl-unica', journalEntryId: 'je-U', debit: 0, credit: 5000, journalEntry: { id: 'je-U', date: fecha('2026-01-06'), description: 'TRANSFERENCIA' }, account: { code: '1.1.02.01', name: 'Banco' } },
    ];
    const dosIguales = [
      { id: 'x1', date: fecha('2026-01-06'), description: 'TRANSFERENCIA A 2810-1', reference: '1', debit: 5000, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
      { id: 'x2', date: fecha('2026-01-06'), description: 'TRANSFERENCIA A 2810-1', reference: '1', debit: 5000, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
    ];
    const prisma = prismaCon(lineas, dosIguales);

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    // Hay una sola línea de $5.000 en el libro: sustenta UNA fila, no las dos
    expect(matches).toHaveLength(1);
    expect(prisma.updates).toEqual([{ id: 'x1', matchedEntryId: 'je-U' }]);
  });

  it('un asiento bloqueado (el que acaba de soltar filas sobrantes) no se reutiliza', async () => {
    const lineas = [
      { id: 'jl-T1', journalEntryId: 'je-T', debit: 0, credit: 5000, journalEntry: { id: 'je-T', date: fecha('2026-01-06'), description: 'X' }, account: { code: '1.1.02.01', name: 'Banco' } },
    ];
    const prisma = prismaCon(lineas);

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829', new Set(['je-T']));

    expect(matches).toHaveLength(0);
    expect(prisma.updates).toHaveLength(0);
  });
});

/**
 * El asiento del MISMO día tiene que ganarle al del día anterior.
 *
 * Extracto de junio (12-10): la fila del 01-jun de $5 ("pasaje Alejandro Rey el
 * valle") se emparejó con el YAPPY de Edilza del 31-may —monto idéntico, un día
 * antes— y el asiento que le correspondía, "Viaticos — $5.00" del 01-jun, quedó
 * "sin conciliar (libros)". La fila se guarda a medianoche UTC y el asiento a
 * mediodía local (16:00Z), así que restar timestamps daba 16 h dentro del mismo
 * día: `Math.round` las volvía un día y el par correcto puntuaba 0.9 mientras el
 * del día anterior puntuaba 1.0.
 */
describe('autoMatch — el mismo día gana al día anterior', () => {
  const filaDelPrimero = () => [
    { id: 'v1', date: fecha('2026-06-01'), description: 'YAPPY BG A JOEL ANTONIO BLIS SAEZ POR pasaje Alejandro Rey el valle', reference: '6', debit: 5, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
  ];

  /** El de Edilza va PRIMERO: es el que se llevaba la fila con la cuenta vieja. */
  const lineasDeJunio = () => [
    { id: 'jl-edilza', journalEntryId: 'je-edilza', debit: 0, credit: 5, journalEntry: { id: 'je-edilza', date: fecha('2026-05-31'), description: 'YAPPY BG A EDILZA ABREGO DE YAU POR Joseph — $5.00' }, account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' } },
    { id: 'jl-viaticos', journalEntryId: 'je-viaticos', debit: 0, credit: 5, journalEntry: { id: 'je-viaticos', date: fecha('2026-06-01'), description: 'Viaticos — $5.00' }, account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' } },
  ];

  const prismaCon = (lineas: any[]) => {
    const updates: any[] = [];
    return {
      updates,
      bankStatementRow: {
        findMany: async ({ where }: any) => (where.status === 'UNMATCHED' ? filaDelPrimero() : []),
        update: async ({ where, data }: any) => { updates.push({ id: where.id, matchedEntryId: data.matchedEntryId, confidence: data.matchConfidence }); return data; },
      },
      journalLine: { findMany: async () => lineas },
      bankRowMatch: vinculosFalsos(),
    };
  };

  it('la fila del 01-jun se concilia contra "Viaticos" (mismo día) y no contra el del 31-may', async () => {
    const prisma = prismaCon(lineasDeJunio());

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(1);
    expect(matches[0].entryId).toBe('je-viaticos');
    expect(matches[0].confidence).toBe(1); // mismo día = exacto, no "cercano"
    expect(prisma.updates).toEqual([{ id: 'v1', matchedEntryId: 'je-viaticos', confidence: 1 }]);
  });

  it('sin asiento del mismo día, el del día anterior sigue sirviendo', async () => {
    const prisma = prismaCon(lineasDeJunio().slice(0, 1));

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches[0].entryId).toBe('je-edilza');
    expect(matches[0].confidence).toBe(0.9);
  });

  it('la ventana de ±5 días cubre el día +5 completo', async () => {
    let where: any = null;
    const prisma = {
      bankStatementRow: { findMany: async ({ where: w }: any) => (w.status === 'UNMATCHED' ? [{ id: 'b1', date: fecha('2026-06-10'), description: 'X', reference: '1', debit: 5, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null }] : []), update: async () => ({}) },
      journalLine: { findMany: async (args: any) => { where = args.where; return []; } },
      bankRowMatch: vinculosFalsos(),
    };

    await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(where.journalEntry.date.gte).toEqual(new Date('2026-06-05T00:00:00.000Z'));
    expect(where.journalEntry.date.lte).toEqual(new Date('2026-06-15T23:59:59.999Z'));
  });
});

/**
 * Un vínculo hecho a mano (el ACH de cuatro facturas) no se desarma solo: la
 * corrida automática no puede llevarse una de esas líneas porque su monto
 * coincida con otra fila del extracto.
 */
describe('autoMatch — respeta los vínculos manuales', () => {
  it('no se lleva una línea ya vinculada por el contador', async () => {
    const filas = [
      { id: 'a1', date: fecha('2026-02-20'), description: 'ACH - INMOBILIARIA DON ANTONIO', reference: '2', debit: 0, credit: 912.54, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
    ];
    const lineas = [
      { id: 'jl-994', journalEntryId: 'je-994', debit: 912.54, credit: 0, journalEntry: { id: 'je-994', date: fecha('2026-02-20'), description: 'Cobro de factura 994 — $943.40' }, account: { code: '1.1.02.01', name: 'Banco' } },
    ];
    const updates: any[] = [];
    const prisma = {
      bankStatementRow: {
        findMany: async ({ where }: any) => (where.status === 'UNMATCHED' ? filas : []),
        update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); return data; },
      },
      journalLine: { findMany: async () => lineas },
      bankRowMatch: vinculosFalsos([{ lineId: 'jl-994' }]), // ya la sostiene el ACH
    };

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});

/**
 * Con dos bancos propios hay montos repetidos el mismo día. El 13-ene el
 * extracto de la 8829-7 traía $15 y el matcher se llevó el asiento de $15 de la
 * 2810-1 (mismo monto, tres días antes), dejando huérfano el asiento correcto de
 * la 8829-7: el contador veía como "sin conciliar" un movimiento registrado.
 */
describe('autoMatch — solo la cuenta del extracto', () => {
  it('no se lleva el asiento del otro banco con el mismo monto y fecha', async () => {
    const filas = [
      { id: 'y1', date: fecha('2026-01-15'), description: 'YAPPY BG A JOEL ARTURO KELLYS', reference: '1', debit: 15, credit: 0, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
    ];
    // El del otro banco va PRIMERO: sin el filtro por cuenta, se lo lleva él
    const lineas = [
      { id: 'jl-otro', journalEntryId: 'je-2810', accountId: 'acc-2810', debit: 0, credit: 15, journalEntry: { id: 'je-2810', date: fecha('2026-01-15'), description: 'YAPPY BG A JOEL ARTURO KELLYS' }, account: { code: '1.1.02.02', name: 'Banco General SOCIEDAD ANONIMA - 2810-1' } },
      { id: 'jl-propio', journalEntryId: 'je-8829', accountId: 'acc-8829', debit: 0, credit: 15, journalEntry: { id: 'je-8829', date: fecha('2026-01-15'), description: 'YAPPY BG A JOEL ARTURO KELLYS POR Neithan Blis' }, account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' } },
    ];
    const updates: any[] = [];
    const prisma = {
      bankStatementRow: {
        findMany: async ({ where }: any) => (where.status === 'UNMATCHED' ? filas : []),
        update: async ({ where, data }: any) => { updates.push({ id: where.id, matchedEntryId: data.matchedEntryId }); return data; },
      },
      journalLine: {
        findMany: async ({ where }: any = {}) => lineas.filter(l => !where.accountId || l.accountId === where.accountId),
      },
      bankRowMatch: vinculosFalsos(),
    };

    const matches = await autoMatch('bs1', prisma as any, 'odesa', 'acc-8829');

    expect(matches).toHaveLength(1);
    expect(matches[0].entryId).toBe('je-8829');
    expect(updates).toEqual([{ id: 'y1', matchedEntryId: 'je-8829' }]);
  });
});
