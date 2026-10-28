import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { reconcileRouter } from '../reconcile';

/**
 * Movimiento de una partida a otra cuenta monetaria desde la conciliación.
 *
 * Es la salida para la carga histórica: el pago se cargó en «Por Clasificar»
 * (1.1.02.09) o en el banco equivocado y el matcher no lo ve porque solo mira
 * la cuenta del extracto. El contador lo elige con «buscar en otros bancos» y
 * al guardar la línea cambia de cuenta y queda conciliada. Si el asiento estaba
 * CONFIRMADO, vuelve a BORRADOR (decisión del dueño: sin asientos extra).
 */

const MONETARIA_PC = { id: 'acc-pc', code: '1.1.02.09', name: 'Por Clasificar' };
const MONETARIA_BANCO = { id: 'acc-banco', code: '1.1.02.01', name: 'Banco General' };
const NO_MONETARIA = { id: 'acc-gasto', code: '6.1.01', name: 'Gastos Generales' };

const statementBase = {
  id: 'bs1',
  bankAccountId: 'acc-banco',
  bankAccount: { code: '1.1.02.01', name: 'Banco General' },
  statementStart: new Date('2026-07-01T00:00:00Z'),
  statementEnd: new Date('2026-07-31T00:00:00Z'),
};

let filas: any[] = [];
let lineas: any[] = [];
let entradas: any[] = [];
let vinculos: any[] = [];
let cuentas: any[] = [];
let cierres: any[] = [];
let auditoria: any[] = [];

const prisma: any = {
  bankStatement: {
    findFirst: async () => ({ ...statementBase, rows: filas }),
  },
  bankStatementRow: {
    findFirst: async ({ where }: any = {}) => {
      const f = filas.find(x => x.id === where?.id);
      return f ? { ...f, statement: statementBase } : null;
    },
    findMany: async ({ where }: any = {}) => {
      let out = filas;
      if (where?.status) out = out.filter(f => f.status === where.status);
      // La consulta de matches viejos (`matches: { none: {} }`) no aplica:
      // en estas pruebas todo vínculo escribe su fila en bank_row_match.
      if (where?.matches) out = out.filter(f => !vinculos.some(v => v.rowId === f.id));
      return out.map(f => ({ ...f, statement: { bankAccountId: statementBase.bankAccountId } }));
    },
    update: async ({ where, data }: any) => {
      const f = filas.find(x => x.id === where.id);
      if (f) Object.assign(f, data);
      return f;
    },
  },
  journalLine: {
    findMany: async ({ where }: any = {}) => {
      let out = lineas;
      if (where?.id?.in) out = out.filter(l => where.id.in.includes(l.id));
      if (where?.journalEntryId) out = out.filter(l => l.journalEntryId === where.journalEntryId);
      if (where?.accountId?.in) out = out.filter(l => where.accountId.in.includes(l.accountId));
      if (where?.debit?.gt != null) out = out.filter(l => l.debit > where.debit.gt);
      if (where?.credit?.gt != null) out = out.filter(l => l.credit > where.credit.gt);
      if (where?.bankRowMatches?.none) {
        const usadas = new Set(vinculos.map(v => v.lineId));
        out = out.filter(l => !usadas.has(l.id));
      }
      if (where?.journalEntry) {
        const je = where.journalEntry;
        out = out.filter(l =>
          (!je.companyId || l.journalEntry.companyId === je.companyId) &&
          (!je.status?.notIn || !je.status.notIn.includes(l.journalEntry.status)) &&
          (je.isClosing === undefined || l.journalEntry.isClosing === je.isClosing));
      }
      return out;
    },
    update: async ({ where, data }: any) => {
      const l = lineas.find(x => x.id === where.id);
      if (l) Object.assign(l, data);
      return l;
    },
  },
  journalEntry: {
    findFirst: async ({ where }: any = {}) =>
      (where?.isClosing
        ? cierres.find(c => c.period === where.period && c.status !== (where.status?.not ?? '__ninguno__')) ?? null
        : null),
    findMany: async () => [],
    update: async ({ where, data }: any) => {
      const e = entradas.find(x => x.id === where.id);
      if (e) Object.assign(e, data);
      return e;
    },
  },
  account: {
    findMany: async ({ where }: any = {}) =>
      cuentas.filter(c => !where?.id?.not || c.id !== where.id.not),
  },
  bankRowMatch: {
    findMany: async ({ where }: any = {}) => {
      let out = vinculos;
      if (where?.rowId) out = out.filter(v => v.rowId === where.rowId);
      if (where?.lineId?.in) out = out.filter(v => where.lineId.in.includes(v.lineId));
      if (where?.rowId?.not) out = out.filter(v => v.rowId !== where.rowId.not);
      return out;
    },
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
  auditLog: { create: async ({ data }: any) => { auditoria.push(data); return data; } },
  $transaction: async (fn: any) => fn(prisma),
};

const filaSalida = (over: any = {}) => ({
  id: 'r1', statementId: 'bs1', date: new Date('2026-07-10T12:00:00Z'),
  description: 'PAGO PROVEEDOR', reference: null, debit: 100, credit: 0, balance: 0,
  status: 'UNMATCHED', matchedEntryId: null, matchConfidence: null, matches: [],
  ...over,
});

const lineaDe = (over: any = {}) => ({
  id: 'jl-pc', journalEntryId: 'je-1', accountId: MONETARIA_PC.id,
  debit: 0, credit: 100,
  journalEntry: {
    id: 'je-1', companyId: 'c1', date: new Date('2026-07-10T12:00:00Z'),
    description: 'PAGO PROVEEDOR', status: 'BORRADOR', isClosing: false,
  },
  account: MONETARIA_PC,
  ...over,
});

let server: any;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { companyId: 'c1', userId: 'u1', role: 'admin' };
    req.prisma = prisma;
    next();
  });
  app.use('/api/reconcile', reconcileRouter);
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/reconcile`;
});

afterAll(() => server?.close());

beforeEach(() => {
  filas = [filaSalida()];
  entradas = [{ id: 'je-1', status: 'BORRADOR', reviewedById: null, reviewedAt: null, reviewNotes: null }];
  lineas = [lineaDe()];
  vinculos = [];
  cuentas = [MONETARIA_PC];
  cierres = [];
  auditoria = [];
});

const vincular = async (body: any): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}/bs1/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowId: 'r1', links: [{ lineId: 'jl-pc' }], ...body }),
  });
  return { status: res.status, body: await res.json() };
};

describe('POST /reconcile/:id/match — mover una partida de banco', () => {
  it('mueve la línea de «Por Clasificar» al banco del extracto y la concilia', async () => {
    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(200);
    expect(lineas[0].accountId).toBe('acc-banco');
    expect(filas[0].status).toBe('MATCHED');
    expect(vinculos).toHaveLength(1);
    expect(vinculos[0]).toMatchObject({ rowId: 'r1', lineId: 'jl-pc', amount: 100, isManual: true });
    expect(r.body.movidas).toEqual([
      expect.objectContaining({ lineId: 'jl-pc', desde: '1.1.02.09 — Por Clasificar', hasta: '1.1.02.01 — Banco General', reabierto: false }),
    ]);
    expect(auditoria.some(a => a.action === 'JOURNAL_LINE_MOVED')).toBe(true);
    expect(entradas[0].status).toBe('BORRADOR'); // no toca un asiento que ya estaba abierto
  });

  it('sin moverCuenta rechaza la partida de otra cuenta y no toca nada', async () => {
    const r = await vincular({});

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/mover cuenta/i);
    expect(lineas[0].accountId).toBe('acc-pc');
    expect(filas[0].status).toBe('UNMATCHED');
    expect(vinculos).toHaveLength(0);
  });

  it('si el asiento estaba CONFIRMADO vuelve a BORRADOR para re-aprobar', async () => {
    entradas[0].status = 'CONFIRMADO';
    lineas[0].journalEntry.status = 'CONFIRMADO';

    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(200);
    expect(entradas[0].status).toBe('BORRADOR');
    expect(r.body.movidas[0].reabierto).toBe(true);
    expect(auditoria.some(a => a.action === 'JOURNAL_REOPENED')).toBe(true);
  });

  it('no mueve desde una cuenta que no es monetaria', async () => {
    lineas[0].account = NO_MONETARIA;
    lineas[0].accountId = NO_MONETARIA.id;

    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no es una cuenta monetaria/i);
    expect(lineas[0].accountId).toBe('acc-gasto');
  });

  it('no mueve la pata de una transferencia entre cuentas propias', async () => {
    // El mismo asiento ya tiene la otra pata en el banco del extracto.
    lineas.push(lineaDe({ id: 'jl-banco', accountId: 'acc-banco', debit: 100, credit: 0, account: MONETARIA_BANCO }));

    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/transferencia entre cuentas/i);
  });

  it('no mueve movimientos de un año ya cerrado', async () => {
    cierres = [{ id: 'cierre-2026', period: '2026' }];

    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/año 2026 está cerrado/i);
  });

  it('un cierre ANULADO no bloquea: el año quedó reabierto', async () => {
    cierres = [{ id: 'cierre-viejo', period: '2026', status: 'ANULADO' }];

    const r = await vincular({ moverCuenta: true });

    expect(r.status).toBe(200);
    expect(lineas[0].accountId).toBe('acc-banco');
  });
});

describe('GET /reconcile/:id/candidates — partidas de otras cuentas', () => {
  it('devuelve solo líneas monetarias, del lado de la fila y sin conciliar', async () => {
    lineas = [
      lineaDe(),
      lineaDe({ id: 'jl-otra', journalEntryId: 'je-4', journalEntry: { ...lineaDe().journalEntry, id: 'je-4' } }),
      lineaDe({ id: 'jl-gasto', journalEntryId: 'je-2', accountId: 'acc-gasto', account: NO_MONETARIA, journalEntry: { ...lineaDe().journalEntry, id: 'je-2' } }),
      lineaDe({ id: 'jl-entrada', journalEntryId: 'je-3', debit: 100, credit: 0, journalEntry: { ...lineaDe().journalEntry, id: 'je-3' } }),
    ];
    vinculos = [{ rowId: 'otra-fila', lineId: 'jl-otra', entryId: 'je-4', amount: 100 }];

    const res = await fetch(`${base}/bs1/candidates?rowId=r1`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0]).toMatchObject({
      lineId: 'jl-pc', accountCode: '1.1.02.09', accountName: 'Por Clasificar', disponible: 100,
    });
  });

  it('la fila de entrada solo se sostiene con el débito del libro', async () => {
    filas = [filaSalida({ debit: 0, credit: 100 })];
    lineas = [lineaDe(), lineaDe({ id: 'jl-debito', journalEntryId: 'je-5', debit: 100, credit: 0, journalEntry: { ...lineaDe().journalEntry, id: 'je-5' } })];

    const res = await fetch(`${base}/bs1/candidates?rowId=r1`);
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body.candidates.map((c: any) => c.lineId)).toEqual(['jl-debito']);
  });
});
