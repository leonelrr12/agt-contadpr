import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { reconcileRouter } from '../reconcile';

/**
 * Subida del extracto bancario, contra el router real (multer incluido).
 *
 * Fija las dos cosas del 11-10: un archivo del que no se puede leer ni una
 * partida con fecha NO se guarda (antes quedaba en la lista con 0 filas y sin
 * nada que conciliar), y el extracto del Banco General —fecha con el mes en
 * letras y una sola columna de monto con signo— entra con sus fechas y con el
 * débito/crédito que el conciliador necesita para comparar contra el libro.
 */

const EXTRACTO_ENERO = [
  ',Fecha,Referencia,Descripción,Monto,Saldo total',
  ',01-ene-2026,1,YAPPY BG A KARLA ISABEL ROMERO GOMEZ," - $ 10,00","$ 55.039,36"',
  ',02-ene-2026,1,YAPPY BG A ANIBAL ENRIQUE BARRIA DE LA CRUZ," - $ 22,00","$ 54.997,36"',
].join('\n');

/** Lo que el endpoint le pasa a Prisma para crear el extracto. */
let creado: any = null;
/** Filas del extracto tal como las vería el auto-matching (se actualizan al matchear). */
let filas: any[] = [];

const prisma = {
  account: { findFirst: async () => ({ id: 'acc-banco', code: '1.1.02.01', name: 'Banco General' }) },
  bankStatement: {
    create: async ({ data }: any) => {
      creado = data;
      filas = data.rows.create.map((r: any, i: number) => ({ id: 'r' + i, status: 'UNMATCHED', matchedEntryId: null, ...r }));
      return { id: 'bs1', ...data, uploadDate: new Date(), rows: filas };
    },
    // Relectura con la que el endpoint arma la respuesta (igual que GET /:id)
    findFirst: async () => ({
      id: 'bs1', fileName: 'ENERO.csv', bankAccountId: 'acc-banco',
      rows: filas.map(f => ({
        ...f,
        matchedEntry: f.matchedEntryId ? { id: f.matchedEntryId, date: new Date('2026-01-01T12:00:00'), description: 'YAPPY KARLA', status: 'BORRADOR' } : null,
        matches: vinculos.filter(v => v.rowId === f.id),
      })),
    }),
  },
  bankStatementRow: {
    findMany: async ({ where }: any = {}) => {
      if (where?.status !== 'MATCHED') return filas.filter(f => f.status === 'UNMATCHED');
      // Como la consulta real: `matches: { none: {} }` deja fuera los matches que
      // SÍ registraron su vínculo por línea, y cada fila trae la cuenta de su
      // extracto (una fila de `filas` puede ser de otro extracto: `cuenta`).
      return filas
        .filter(f => f.status === 'MATCHED')
        .filter(f => !where?.matches || !vinculos.some(v => v.rowId === f.id))
        .map(f => ({ ...f, statement: { bankAccountId: f.cuenta || 'acc-banco' } }));
    },
    findFirst: async ({ where }: any = {}) => {
      const f = filas.find(x => x.id === where?.id);
      return f ? { ...f, statement: { bankAccountId: 'acc-banco' } } : null;
    },
    update: async ({ where, data }: any) => {
      const f = filas.find(x => x.id === where.id);
      if (f) Object.assign(f, data);
      return f;
    },
  },
  // Un solo asiento en el libro: el pago de $10 del 01-ene en la cuenta de banco
  journalLine: {
    findMany: async ({ where }: any = {}) =>
      lineasLibro.filter(l =>
        (!where?.accountId || l.accountId === where.accountId) &&
        (!where?.id?.in || where.id.in.includes(l.id))),
  },
  journalEntry: { findMany: async () => [] },
  // Vínculos banco ↔ partidas del libro (los crea el matcher y el vinculador)
  bankRowMatch: {
    findMany: async () => vinculos,
    create: async ({ data }: any) => { vinculos.push(data); return data; },
    createMany: async ({ data }: any) => { vinculos.push(...data); return { count: data.length }; },
    deleteMany: async ({ where }: any = {}) => {
      const antes = vinculos.length;
      vinculos = vinculos.filter(v => {
        if (where?.rowId && v.rowId !== where.rowId) return true;
        if (where?.lineId?.notIn && where.lineId.notIn.includes(v.lineId)) return true;
        return false;
      });
      return { count: antes - vinculos.length };
    },
  },
};
/** Vínculos vivos entre corridas (cada test arranca sin ninguno). */
let vinculos: any[] = [];

/** Asientos del libro que ve el matcher (cada test puede cambiarlos). */
let lineasLibro: any[] = [];
const lineaDe = (entryId: string, credit: number, dia = '2026-01-01') => ({
  id: `jl-${entryId}`, journalEntryId: entryId, accountId: 'acc-banco', debit: 0, credit,
  journalEntry: { id: entryId, date: new Date(`${dia}T12:00:00`), description: 'YAPPY BG A KARLA ISABEL ROMERO GOMEZ' },
  account: { code: '1.1.02.01', name: 'Banco General' },
});

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json()); // como en main.ts: sin esto /match no ve el body
  // Lo que en producción pone el middleware de auth
  app.use((req: any, _res, next) => { req.user = { companyId: 'c1', userId: 'u1', role: 'admin' }; req.prisma = prisma; next(); });
  app.use('/api/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/reconcile`;
});

afterAll(() => server?.close());
beforeEach(() => {
  creado = null;
  filas = [];
  vinculos = [];
  lineasLibro = [lineaDe('je-1', 10)];
});

async function subir(csv: string): Promise<{ status: number; body: any }> {
  const fd = new FormData();
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'ENERO.csv');
  fd.append('bankAccountId', 'acc-banco');
  const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
  return { status: res.status, body: await res.json() };
}

describe('POST /reconcile/upload — aviso cuando no se lee ninguna partida', () => {
  it('archivo sin filas de datos: avisa y no guarda nada', async () => {
    const r = await subir(',Fecha,Referencia,Descripción,Monto,Saldo total\n');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no trae ninguna fila de datos/i);
    expect(creado).toBeNull();
  });

  it('filas con fecha ilegible: avisa y no guarda nada', async () => {
    const csv = ',Fecha,Descripción,Monto\n,01-xxx-2026,Algo," - $ 5,00"\n';
    const r = await subir(csv);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no se pudo leer la fecha de ninguna de las 1 filas/i);
    expect(r.body.error).toMatch(/01-ene-2026/); // el formato que sí se acepta
    expect(creado).toBeNull();
  });
});

describe('POST /reconcile/upload — extracto del Banco General', () => {
  it('guarda las partidas con su fecha y su débito', async () => {
    const r = await subir(EXTRACTO_ENERO);
    expect(r.status).toBe(201);

    expect(creado.rows.create).toHaveLength(2);
    expect(creado.rows.create[0]).toMatchObject({
      description: 'YAPPY BG A KARLA ISABEL ROMERO GOMEZ',
      reference: '1',
      debit: 10,
      credit: 0,
    });
    expect(creado.rows.create[0].date.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(creado.rows.create[1]).toMatchObject({ debit: 22, credit: 0 });

    // El rango del extracto sale de las fechas leídas
    expect(creado.statementStart.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(creado.statementEnd.toISOString().slice(0, 10)).toBe('2026-01-02');
  });

  it('responde lo mismo que el detalle: unmatchedBooks y el conteo DESPUÉS del auto-matching', async () => {
    const r = await subir(EXTRACTO_ENERO);
    expect(r.status).toBe(201);

    // Sin esta lista el render del detalle reventaba con
    // "Cannot read properties of undefined (reading 'length')"
    expect(Array.isArray(r.body.unmatchedBooks)).toBe(true);

    // El pago de $10 quedó conciliado contra el asiento del libro: la respuesta
    // no puede ser la foto de antes del auto-matching (que decía 0)
    expect(r.body.summary.matched).toBe(1);
    expect(r.body.summary.unmatched).toBe(1);
    expect(r.body.summary.matches).toHaveLength(1);
    expect(r.body.statement.rows[0].status).toBe('MATCHED');
    expect(r.body.statement.rows[0].matchedEntry.id).toBe('je-1');
  });
});

/**
 * "Volver a conciliar": el matching corre una sola vez, en la subida, así que un
 * extracto cargado antes de corregir un criterio se quedaba con la foto vieja.
 * El caso que lo motivó es el de los dos YAPPY de $11,50 del 03-ene: los dos
 * quedaron apuntando al MISMO asiento y su gemelo aparecía siempre como
 * "sin conciliar (libros)".
 */
describe('POST /reconcile/:id/rematch — volver a conciliar sin volver a subir', () => {
  const conAsientoRepetido = () => {
    filas = [
      { id: 'r1', date: new Date('2026-01-03T12:00:00'), description: 'YAPPY BG A CARLOS GUTIERREZ', reference: '1', debit: 11.5, credit: 0, balance: 0, status: 'MATCHED', matchedEntryId: 'je-A', matchConfidence: 0.9 },
      { id: 'r2', date: new Date('2026-01-03T12:00:00'), description: 'YAPPY BG A CARLOS GUTIERREZ', reference: '1', debit: 11.5, credit: 0, balance: 0, status: 'MATCHED', matchedEntryId: 'je-A', matchConfidence: 0.9 },
    ];
    lineasLibro = [lineaDe('je-A', 11.5, '2026-01-03'), lineaDe('je-B', 11.5, '2026-01-03')];
  };

  it('suelta el asiento repetido y lo reparte: cada fila con su asiento', async () => {
    conAsientoRepetido();
    const res = await fetch(`${base}/bs1/rematch`, { method: 'POST' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    // El vínculo del match viejo (r1 → la línea de je-A) se reconstruye en la
    // misma corrida: es el dato que hace que el reparto sea por línea.
    expect(body.rematch).toEqual({ liberadas: 1, nuevas: 1, vinculos: 1 });

    const porFila = Object.fromEntries(filas.map(f => [f.id, f.matchedEntryId]));
    expect(porFila).toEqual({ r1: 'je-A', r2: 'je-B' });
    expect(body.summary.matched).toBe(2);
    expect(body.summary.unmatched).toBe(0);
  });

  it('responde el mismo cuerpo que el detalle (el frente tiene un solo render)', async () => {
    conAsientoRepetido();
    const res = await fetch(`${base}/bs1/rematch`, { method: 'POST' });
    const body: any = await res.json();

    expect(Array.isArray(body.unmatchedBooks)).toBe(true);
    expect(body.statement.rows).toHaveLength(2);
    expect(body.statement.rows[0].matchedEntry.id).toBe('je-A');
  });

  /**
   * Transferencia entre cuentas propias (06-ene, 8829-7 → 2810-1: $2.100 y
   * $5.000): el asiento tiene la línea de crédito en una cuenta y la de débito
   * en la otra. El match de la cuenta emisora es de los VIEJOS —no dejó vínculo
   * por línea—, así que el asiento quedaba bloqueado entero y la cuenta
   * receptora no podía conciliar sus filas nunca. El rematch reconstruye ese
   * vínculo y recién entonces el asiento deja de estorbar.
   */
  it('un asiento con línea en cada cuenta no bloquea a la receptora', async () => {
    filas = [
      { id: 'vieja', cuenta: 'acc-otro', date: new Date('2026-01-06T12:00:00'), description: 'TRANFERENCIA A 8829-7', reference: '1', debit: 5000, credit: 0, balance: 0, status: 'MATCHED', matchedEntryId: 'je-transf', matchConfidence: 1 },
      { id: 'r-transf', date: new Date('2026-01-06T12:00:00'), description: 'BANCA EN LINEA TRANSFERENCIA DE 0446016788297 ODERAY', reference: '1', debit: 0, credit: 5000, balance: 0, status: 'UNMATCHED', matchedEntryId: null },
    ];
    lineasLibro = [
      { id: 'jl-otro', journalEntryId: 'je-transf', accountId: 'acc-otro', debit: 0, credit: 5000, journalEntry: { id: 'je-transf', date: new Date('2026-01-06T12:00:00'), description: 'TRANFERENCIA DE 2610-1 A 8829-7' }, account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' } },
      { id: 'jl-esta', journalEntryId: 'je-transf', accountId: 'acc-banco', debit: 5000, credit: 0, journalEntry: { id: 'je-transf', date: new Date('2026-01-06T12:00:00'), description: 'TRANFERENCIA DE 2610-1 A 8829-7' }, account: { code: '1.1.02.02', name: 'Banco General SOCIEDAD ANONIMA - 2810-1' } },
    ];

    const res = await fetch(`${base}/bs1/rematch`, { method: 'POST' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.rematch.vinculos).toBe(1); // el del match viejo, en la otra cuenta
    expect(body.rematch.nuevas).toBe(1);
    expect(filas.find(f => f.id === 'r-transf').matchedEntryId).toBe('je-transf');
  });

  it('un extracto de otra empresa no se toca', async () => {
    // El stub devuelve null cuando el id no existe para esa empresa
    const original = prisma.bankStatement.findFirst;
    (prisma.bankStatement as any).findFirst = async () => null;
    const res = await fetch(`${base}/ajeno/rematch`, { method: 'POST' });
    expect(res.status).toBe(404);
    (prisma.bankStatement as any).findFirst = original;
  });
});

/**
 * Con dos bancos propios, el mismo monto el mismo día existe en los dos. Acá el
 * asiento del extracto (8829-7) se lo había llevado el asiento de la 2810-1 y la
 * fila quedaba apuntando al banco equivocado mientras el asiento correcto
 * aparecía como "sin conciliar (libros)".
 */
describe('POST /reconcile/:id/rematch — suelta los emparejamientos cruzados', () => {
  it('la fila vuelve a su asiento de la cuenta del extracto', async () => {
    filas = [
      { id: 'y1', date: new Date('2026-01-15T12:00:00'), description: 'YAPPY BG A JOEL ARTURO KELLYS', reference: '1', debit: 15, credit: 0, balance: 0, status: 'MATCHED', matchedEntryId: 'je-2810', matchConfidence: 0.9 },
    ];
    lineasLibro = [
      { id: 'jl-2810', journalEntryId: 'je-2810', accountId: 'acc-2810', debit: 0, credit: 15, journalEntry: { id: 'je-2810', date: new Date('2026-01-15T12:00:00'), description: 'YAPPY BG A JOEL ARTURO KELLYS' }, account: { code: '1.1.02.02', name: 'Banco General SOCIEDAD ANONIMA - 2810-1' } },
      { id: 'jl-8829', journalEntryId: 'je-8829', accountId: 'acc-banco', debit: 0, credit: 15, journalEntry: { id: 'je-8829', date: new Date('2026-01-15T12:00:00'), description: 'YAPPY BG A JOEL ARTURO KELLYS POR Neithan Blis' }, account: { code: '1.1.02.01', name: 'Banco General ODESA Natural - 8829-7' } },
    ];

    const res = await fetch(`${base}/bs1/rematch`, { method: 'POST' });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.rematch.liberadas).toBe(1);
    expect(filas[0].matchedEntryId).toBe('je-8829');
    expect(body.summary.matched).toBe(1);
  });
});

/**
 * El ACH de Inmobiliaria Don Antonio del 20-feb: un solo depósito de $17.353,68
 * que cobra CUATRO facturas ($912,54 + $6.618,06 + $527,85 + $9.295,23). El
 * matcher empareja UNA línea contra UNA fila y por monto exacto, así que ese
 * depósito no tiene contra qué conciliarse solo y las cuatro partidas quedaban
 * "sin conciliar (libros)" para siempre. Lo arma el contador, a mano.
 */
describe('POST /reconcile/:id/match — una fila del extracto contra varias partidas', () => {
  const ACH = 17353.68;
  const COBROS: Array<[string, string, number]> = [
    ['je-993', 'jl-993', 527.85],
    ['je-994', 'jl-994', 912.54],
    ['je-995', 'jl-995', 9295.23],
    ['je-996', 'jl-996', 6618.06],
  ];

  const conAchSinConciliar = () => {
    filas = [{ id: 'ach', date: new Date('2026-02-20T12:00:00'), description: 'ACH - INMOBILIARIA DON ANTONIO, S. A.', reference: '2', debit: 0, credit: ACH, balance: 0, status: 'UNMATCHED', matchedEntryId: null }];
    lineasLibro = COBROS.map(([je, jl, monto]) => ({
      id: jl, journalEntryId: je, accountId: 'acc-banco', debit: monto, credit: 0,
      journalEntry: { id: je, date: new Date('2026-02-20T12:00:00'), description: `Cobro de factura ${je.slice(-3)}`, status: 'BORRADOR', companyId: 'c1' },
      account: { code: '1.1.02.01', name: 'Banco General' },
    }));
  };

  const vincular = async (links: any[]): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${base}/bs1/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId: 'ach', links }),
    });
    return { status: res.status, body: await res.json() };
  };

  it('las cuatro partidas cuadran la fila y todas quedan conciliadas', async () => {
    conAchSinConciliar();

    const r = await vincular(COBROS.map(([, jl, monto]) => ({ lineId: jl, amount: monto })));

    expect(r.status).toBe(200);
    expect(filas[0].status).toBe('MATCHED');
    expect(filas[0].matchedEntryId).toBe('je-993'); // el primero del vínculo, para la UI
    expect(vinculos).toHaveLength(4);
    expect(vinculos.every(v => v.isManual)).toBe(true);
    expect(vinculos.reduce((s, v) => s + v.amount, 0)).toBeCloseTo(ACH, 2);
    // La respuesta es el detalle completo: el frente tiene un solo render
    expect(Array.isArray(r.body.unmatchedBooks)).toBe(true);
    expect(r.body.statement.rows[0].matches).toHaveLength(4);
  });

  it('sin el monto de la fila no vincula: dice cuánto falta y no toca nada', async () => {
    conAchSinConciliar();

    const r = await vincular(COBROS.slice(0, 3).map(([, jl, monto]) => ({ lineId: jl, amount: monto })));

    expect(r.status).toBe(400);
    // Faltan los $6.618,06 de la factura 996, la que quedó fuera
    expect(r.body.error).toMatch(/Faltan \$6618\.06/i);
    expect(filas[0].status).toBe('UNMATCHED');
    expect(vinculos).toHaveLength(0);
  });

  it('una partida del lado contrario de la fila no sirve', async () => {
    conAchSinConciliar();
    // La fila es una ENTRADA de dinero: la partida va al débito del banco
    lineasLibro.push({
      id: 'jl-raro', journalEntryId: 'je-raro', accountId: 'acc-banco', debit: 0, credit: 17353.68,
      journalEntry: { id: 'je-raro', date: new Date('2026-02-20T12:00:00'), description: 'Salida que no corresponde', status: 'BORRADOR', companyId: 'c1' },
      account: { code: '1.1.02.01', name: 'Banco General' },
    });

    const r = await vincular([{ lineId: 'jl-raro', amount: 17353.68 }]);

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no sirve para esta fila/i);
    expect(filas[0].status).toBe('UNMATCHED');
  });

  it('una partida ya conciliada en otra fila no se reutiliza', async () => {
    conAchSinConciliar();
    vinculos = [{ rowId: 'otra-fila', lineId: 'jl-993', entryId: 'je-993', amount: 527.85, isManual: true }];

    const r = await vincular(COBROS.map(([, jl, monto]) => ({ lineId: jl, amount: monto })));

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/ya está conciliada en otra fila/i);
  });

  it('desvincular borra los vínculos y deja la fila sin conciliar', async () => {
    conAchSinConciliar();
    await vincular(COBROS.map(([, jl, monto]) => ({ lineId: jl, amount: monto })));

    const res = await fetch(`${base}/bs1/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId: 'ach', entryId: null }),
    });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(vinculos).toHaveLength(0);
    expect(filas[0].status).toBe('UNMATCHED');
    expect(body.statement.rows[0].matches).toHaveLength(0);
  });
});
