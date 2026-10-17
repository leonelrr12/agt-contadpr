/**
 * Flujo de caja: saldo inicial del período y resumen NETO POR ASIENTO.
 *
 * La regla que más se puede romper en silencio es la de las transferencias: si
 * el resumen suma los débitos y créditos de cada línea, mover $1.000 de un banco
 * a otro aparece como $1.000 de entrada MÁS $1.000 de salida. El saldo final
 * sigue estando bien, pero las dos columnas mienten. Neteando por asiento, la
 * transferencia da 0 y se informa aparte.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { reportsRouter } from '../reports';

const CUENTAS = [
  { code: '1.1.01', name: 'Caja', aliases: [] },
  { code: '1.1.02.01', name: 'Banco General', aliases: [] },
  { code: '1.1.02.02', name: 'Banco Nacional', aliases: [] },
];

const linea = (journalEntryId: string, debit: number, credit: number) => ({
  journalEntryId,
  debit,
  credit,
  journalEntry: { date: new Date('2026-10-05T12:00:00'), description: journalEntryId },
  account: { code: '1.1.02.01', name: 'Banco General' },
});

function prismaFalso(lines: any[], prior = { debit: 0, credit: 0 }) {
  return {
    account: { findMany: async () => CUENTAS },
    journalLine: {
      aggregate: async () => ({ _sum: prior }),
      findMany: async () => lines,
    },
  };
}

let server: any;
let base = '';
let actual: any = {};

beforeAll(async () => {
  const app = express();
  app.use((req: any, _res, next) => {
    req.user = { userId: 'u-1', companyId: 'c-1', role: 'contador', name: 'Contador', email: 'c@x.com' };
    req.prisma = actual.prisma;
    next();
  });
  app.use('/api/reports', reportsRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

afterAll(() => server?.close());

const flujo = async (query = 'startDate=2026-10-01&endDate=2026-10-31') => {
  const res = await fetch(`${base}/reports/flujo-caja?${query}`);
  return { status: res.status, body: (await res.json()) as any };
};

describe('flujo de caja — resumen del período', () => {
  it('arranca en el saldo anterior al período y netea las transferencias', async () => {
    const lines = [
      linea('venta', 100, 0),           // +100 entrada
      linea('gasto', 0, 40),            // −40 salida
      linea('transferencia', 25, 0),    // Banco B +25 …
      linea('transferencia', 0, 25),    // … Banco A −25 → neto 0
      linea('mixto', 60, 0),            // +60
      linea('mixto', 0, 100),           // −100 → neto −40
    ];
    actual = { prisma: prismaFalso(lines, { debit: 600, credit: 100 }) };

    const r = await flujo();

    expect(r.status).toBe(200);
    expect(r.body.saldoInicial).toBe(500);
    expect(r.body.entradas).toBe(100);
    expect(r.body.salidas).toBe(80);       // 40 + 40 del mixto
    expect(r.body.transferencias).toBe(25);
    expect(r.body.saldoActual).toBe(520);  // 500 + 100 − 80
    // Los brutos del libro siguen siendo la suma línea por línea.
    expect(r.body.totalDebit).toBe(185);
    expect(r.body.totalCredit).toBe(165);
  });

  it('sin movimientos igual devuelve el saldo inicial y los totales en cero', async () => {
    actual = { prisma: prismaFalso([], { debit: 120, credit: 20 }) };

    const r = await flujo();

    expect(r.status).toBe(200);
    expect(r.body.saldoInicial).toBe(100);
    expect(r.body.entradas).toBe(0);
    expect(r.body.salidas).toBe(0);
    expect(r.body.transferencias).toBe(0);
    expect(r.body.saldoActual).toBe(100);
    expect(r.body.movimientos).toEqual([]);
  });

  it('sin fecha de inicio no inventa saldo inicial (todo el histórico)', async () => {
    actual = { prisma: prismaFalso([linea('venta', 100, 0)], { debit: 999, credit: 0 }) };

    const r = await flujo('');

    expect(r.body.saldoInicial).toBe(0);
    expect(r.body.entradas).toBe(100);
    expect(r.body.saldoActual).toBe(100);
  });
});
