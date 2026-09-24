import { describe, it, expect } from 'vitest';
import { computeProyeccion, normalizarMeses, type HorizonteMeses } from '../salud';

/**
 * La proyección de caja arranca del efectivo real (caja + bancos, no de la cuenta
 * 1.1.01 como antes), simula las recurrentes activas y suma las obligaciones
 * fiscales, acumulando el saldo mes a mes.
 *
 * El caso que más importa aquí es el INVARIANTE del horizonte: los 3 primeros
 * meses tienen que salir idénticos se pidan 3 o 12. De eso depende que el caché
 * guarde una sola proyección y la recorte, y que el score no se mueva al cambiar
 * el selector del panel.
 */
const COMPANY = 'company-1';
/** Septiembre 24 de 2026, mediodía local (fecha de solo día: nunca a medianoche). */
const NOW = new Date(2026, 8, 24, 12, 0, 0);

const ACC_BANCO = 'acc-banco';
const ACC_ALQUILER = 'acc-alquiler';

const CUENTAS = [
  { id: ACC_BANCO, code: '1.1.02.01' },
  { id: ACC_ALQUILER, code: '6.01.02' },
];

const CODJOS_CAJA = new Set(['1.1.01', '1.1.02', '1.1.02.01']);

const plantilla = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  companyId: COMPANY,
  description: 'Alquiler oficina',
  amount: 500,
  type: 'GASTO',
  frequency: 'MONTHLY',
  dayOfMonth: 1,
  dayOfWeek: null,
  debitAccountId: null,
  creditAccountId: null,
  nextRunAt: new Date(2026, 9, 1, 0, 0, 0), // 1 de octubre
  isActive: true,
  ...over,
});

const obligacion = (over: Record<string, unknown> = {}) => ({
  type: 'ITBMS',
  period: '2026-09',
  dueDate: new Date(2026, 9, 15, 0, 0, 0), // 15 de octubre
  estimatedAmount: 700,
  actualAmount: null,
  status: 'PENDING',
  ...over,
});

/** Stub de Prisma: solo lo que consume la proyección (convención del repo, sin BD). */
function prismaStub(opts: { templates?: any[]; obligaciones?: any[] } = {}) {
  return {
    recurringTemplate: { findMany: async () => opts.templates || [] },
    account: { findMany: async () => CUENTAS },
    taxObligation: { findMany: async () => opts.obligaciones || [] },
  };
}

const correr = (
  opts: Parameters<typeof prismaStub>[0],
  extra: { caja?: number; meses?: HorizonteMeses; now?: Date } = {},
) =>
  computeProyeccion(
    prismaStub(opts) as never,
    COMPANY,
    { caja: extra.caja ?? 1000, codigosCaja: CODJOS_CAJA, meses: extra.meses },
    extra.now ?? NOW,
  );

describe('computeProyeccion — horizonte', () => {
  it('los 3 primeros meses de una proyección a 12 son idénticos a los de una a 3', async () => {
    // El invariante que autoriza a cachear a 12 y recortar.
    const opts = { templates: [plantilla()], obligaciones: [obligacion()] };
    const a12 = await correr(opts, { meses: 12 });
    const a3 = await correr(opts, { meses: 3 });
    expect(a12.slice(0, 3)).toEqual(a3);
  });

  it('el invariante también aguanta con el mes recién empezado', async () => {
    // Con `now` a día 1, los vencimientos fiscales estimados caen más lejos de la
    // ventana de 90 días que con `now` a fin de mes. Es el caso en que una
    // estimación podría entrar en la proyección a 12 y no en la de 3, y romper el
    // recorte del caché.
    const opts = {
      templates: [plantilla()],
      obligaciones: [obligacion({ period: '2026-11', dueDate: new Date(2026, 11, 15, 0, 0, 0) })],
    };
    const primero = new Date(2026, 8, 1, 12, 0, 0);
    const a12 = await correr(opts, { meses: 12, now: primero });
    const a3 = await correr(opts, { meses: 3, now: primero });
    expect(a12.slice(0, 3)).toEqual(a3);
  });

  it('sin meses devuelve 3 (el default histórico) con claves contiguas', async () => {
    const out = await correr({ templates: [plantilla()] });
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.month)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(out[0].label).toContain('2026');
  });

  it('12 meses devuelve 12 claves correlativas sin huecos', async () => {
    const out = await correr({}, { meses: 12 });
    expect(out).toHaveLength(12);
    expect(out[0].month).toBe('2026-09');
    expect(out[11].month).toBe('2027-08');
  });

  it('una recurrente diaria sigue teniendo movimiento en el último mes (el guard no la trunca)', async () => {
    const out = await correr(
      {
        templates: [
          plantilla({
            frequency: 'DAILY',
            dayOfMonth: null,
            nextRunAt: new Date(2026, 8, 24, 0, 0, 0),
            amount: 10,
            creditAccountId: ACC_BANCO,
          }),
        ],
      },
      { meses: 12 },
    );
    // Con un guard fijo de 200 iteraciones, los últimos meses saldrían en cero.
    expect(out[11].entradas).toBeGreaterThan(0);
  });
});

describe('computeProyeccion — dirección de la recurrente', () => {
  it('acreditar una cuenta de efectivo es una entrada', async () => {
    const out = await correr({
      templates: [plantilla({ type: 'INGRESO', creditAccountId: ACC_BANCO })],
    });
    expect(out[1].entradas).toBe(500);
    expect(out[1].salidas).toBe(0);
  });

  it('debitar una cuenta de efectivo es una salida', async () => {
    const out = await correr({
      templates: [plantilla({ type: 'GASTO', debitAccountId: ACC_BANCO })],
    });
    expect(out[1].salidas).toBe(500);
    expect(out[1].entradas).toBe(0);
  });

  it('sin cuentas explícitas manda el tipo — el camino real de la UI', async () => {
    // El formulario de recurrentes no ofrece cuentas débito/crédito, así que en
    // producción la dirección sale siempre de aquí.
    const out = await correr({
      templates: [
        plantilla({ id: 'g', type: 'GASTO' }),
        plantilla({ id: 'i', type: 'INGRESO' }),
      ],
    });
    expect(out[1].salidas).toBe(500);
    expect(out[1].entradas).toBe(500);
  });

  it('un tipo que no clasifica no se proyecta', async () => {
    const out = await correr({ templates: [plantilla({ type: 'TRANSFERENCIA' })] });
    expect(out.every((p) => p.entradas === 0 && p.salidas === 0)).toBe(true);
  });
});

describe('computeProyeccion — obligaciones fiscales', () => {
  it('una obligación real entra en el mes de su vencimiento, sin marcar como estimada', async () => {
    const out = await correr({ obligaciones: [obligacion()] });
    expect(out[1].month).toBe('2026-10');
    expect(out[1].salidas).toBe(700);
    expect(out[1].fiscal).toBe(700);
    expect(out[1].fiscalEstimado).toBe(false);
  });

  it('la línea fiscal es continua: todo mes sin obligación registrada se estima', async () => {
    const out = await correr(
      { obligaciones: [obligacion()] }, // el ancla: ITBMS del 15, monto 700
      { meses: 12 },
    );
    // Octubre cobra la obligación real; de noviembre en adelante todo es estimación.
    expect(out[1]).toMatchObject({ month: '2026-10', fiscal: 700, fiscalEstimado: false });
    for (let i = 2; i < 12; i++) {
      expect(out[i]).toMatchObject({ fiscal: 700, fiscalEstimado: true });
    }
    // Septiembre no tiene nada: el período de agosto (que vencería el 15 de
    // septiembre) no se rellena, porque su vencimiento ya pasó.
    expect(out[0]).toMatchObject({ fiscal: 0, fiscalEstimado: false });
  });

  it('rellena también los huecos ANTERIORES a la última obligación conocida', async () => {
    // El calendario va atrasado: la única fila es la de diciembre. Octubre y
    // noviembre no tienen nada cargado, y dejarlos en cero escondería el pago.
    const out = await correr(
      { obligaciones: [obligacion({ period: '2026-11', dueDate: new Date(2026, 11, 15, 0, 0, 0) })] },
      { meses: 12 },
    );
    expect(out[1]).toMatchObject({ month: '2026-10', fiscal: 700, fiscalEstimado: true });
    expect(out[2]).toMatchObject({ month: '2026-11', fiscal: 700, fiscalEstimado: true });
    expect(out[3]).toMatchObject({ month: '2026-12', fiscal: 700, fiscalEstimado: false }); // la real
    expect(out[4]).toMatchObject({ month: '2027-01', fiscal: 700, fiscalEstimado: true });
  });

  it('una fila creada pero valorada en CERO se estima: no es un dato, es un hueco con fecha', async () => {
    // El caso real de producción: el generador crea la fila del período en cuanto
    // entra, y `estimateITBMS` la deja en 0 mientras no haya movimiento en 2.1.05.
    // Tratarla como dato hacía que octubre, noviembre y diciembre salieran en cero.
    const out = await correr(
      {
        obligaciones: [
          obligacion({ period: '2026-08', dueDate: new Date(2026, 8, 15, 0, 0, 0), estimatedAmount: 380.57, status: 'OVERDUE' }),
          obligacion({ period: '2026-09', dueDate: new Date(2026, 9, 15, 0, 0, 0), estimatedAmount: 0 }),
        ],
      },
      { meses: 12 },
    );
    expect(out[0]).toMatchObject({ month: '2026-09', fiscal: 380.57, fiscalEstimado: false }); // la valorada
    expect(out[1]).toMatchObject({ month: '2026-10', fiscal: 380.57, fiscalEstimado: true }); // la del cero
    expect(out[2]).toMatchObject({ month: '2026-11', fiscal: 380.57, fiscalEstimado: true }); // sin fila
  });

  it('una obligación sin NINGÚN monto conocido no se extrapola: no se inventan cifras', async () => {
    const out = await correr(
      {
        obligaciones: [
          obligacion({ type: 'CSS', estimatedAmount: null, actualAmount: null }),
        ],
      },
      { meses: 12 },
    );
    expect(out.every((p) => p.fiscal === 0 && !p.fiscalEstimado)).toBe(true);
  });
});

describe('computeProyeccion — saldo acumulado', () => {
  it('acumula entradas y salidas sobre el efectivo inicial', async () => {
    const out = await correr({ templates: [plantilla()] }, { caja: 1000 });
    expect(out[0].saldoFinal).toBe(1000); // la ocurrencia es el 1 de octubre, no de septiembre
    expect(out[1].saldoFinal).toBe(500);
    expect(out[2].saldoFinal).toBe(0);
  });

  it('redondea el saldo a 2 decimales: sin el r2 se cuela el ruido binario', async () => {
    const out = await correr(
      {
        templates: [
          plantilla({ type: 'INGRESO', amount: 0.7, creditAccountId: ACC_BANCO }),
        ],
      },
      { caja: 0, meses: 12 },
    );
    // Las ocurrencias caen el 1 de octubre, noviembre y diciembre; al acumular la
    // tercera, 0.7 × 3 en punto flotante da 2.0999999999999996.
    expect(out[1].saldoFinal).toBe(0.7);
    expect(out[2].saldoFinal).toBe(1.4);
    expect(out[3].saldoFinal).toBe(2.1);
  });
});

describe('normalizarMeses', () => {
  it('acepta solo los horizontes ofrecidos y cae a 3 con cualquier otra cosa', () => {
    expect(normalizarMeses('6')).toBe(6);
    expect(normalizarMeses('12')).toBe(12);
    expect(normalizarMeses(3)).toBe(3);
    expect(normalizarMeses('4')).toBe(3);
    expect(normalizarMeses('abc')).toBe(3);
    expect(normalizarMeses(undefined)).toBe(3);
    expect(normalizarMeses(null)).toBe(3);
  });
});
