import { describe, it, expect } from 'vitest';
import {
  calcularItem,
  calcularCorrida,
  construirLineas,
  impuestoAnual,
  isrMensual,
  isrDelPago,
  diasDelMes,
  diasEntre,
  sueldoSemanal,
  pagosDelMes,
  pagoNumeroEnElMes,
  consolidarLineas,
  TABLA_ISR_PANAMA,
  type CalculoItem,
  type ContextoCorrida,
  type CuentasPlanilla,
  type EmpleadoCalc,
  type LineaAsiento,
  type Tasas,
} from '../payroll-calc';
import { r2, sumarMontos } from '../../lib/money';

/**
 * El motor de planilla es puro, así que se prueba entero sin base de datos.
 *
 * Lo que fijan estos casos NO son reglas de manual: son las reglas que el contador
 * ya aplica, leídas de los 77 asientos de planilla que están cargados en producción.
 * Tres de ellas contradicen lo que uno supondría de memoria, y por eso tienen su
 * propio caso: el ISR proyectado a 13 meses, el décimo cotizando al 7,25% sin
 * Seguro Educativo, y el redondeo medio-arriba en los `.xx5`.
 */

const TASAS: Tasas = {
  ssObrero: 0.0975,
  seObrero: 0.0125,
  ssPatronal: 0.1225,
  sePatronal: 0.015,
  // 13,25% − 12,25%: los riesgos profesionales van a su propia cuenta de gasto.
  riesgosProfesionales: 0.01,
  riesgosPorClase: { I: 0.01, IV: 0.04 },
  ssObreroDecimo: 0.0725,
  seObreroDecimo: 0,
  ssPatronalDecimo: 0.1075,
  factorDecimo: 1 / 12,
  factorVacaciones: 1 / 12,
  factorPrima: 1 / 52,
  tablaISR: TABLA_ISR_PANAMA,
  provisionarPrestaciones: false,
};

/** Primera quincena de junio de 2026: 15 días sobre un mes de 30. */
const Q1_JUNIO: ContextoCorrida = {
  tipo: 'SUELDO',
  periodicidad: 'QUINCENAL',
  fechaDesde: new Date(2026, 5, 1),
  fechaHasta: new Date(2026, 5, 15),
  fechaPago: new Date(2026, 5, 15),
  pagoNumero: 1,
  pagosDelMes: 2,
};

const Q2_JUNIO: ContextoCorrida = { ...Q1_JUNIO, fechaDesde: new Date(2026, 5, 16), fechaHasta: new Date(2026, 5, 30), fechaPago: new Date(2026, 5, 30), pagoNumero: 2 };

/** Junio completo, pagado una sola vez: la cuota mensual del acreedor va entera. */
const MENSUAL_JUNIO: ContextoCorrida = {
  ...Q1_JUNIO,
  periodicidad: 'MENSUAL',
  fechaHasta: new Date(2026, 5, 30),
  fechaPago: new Date(2026, 5, 30),
  pagoNumero: 1,
  pagosDelMes: 1,
};

/**
 * Una semana de septiembre 2026: del lunes 7 al domingo 13. Septiembre tiene cuatro
 * viernes (4, 11, 18 y 25), así que este es el segundo pago del mes.
 */
const SEMANA_SEP_CTX: ContextoCorrida = {
  tipo: 'SUELDO',
  periodicidad: 'SEMANAL',
  fechaDesde: new Date(2026, 8, 7),
  fechaHasta: new Date(2026, 8, 13),
  fechaPago: new Date(2026, 8, 11), // el viernes de esa semana
  pagoNumero: 2,
  pagosDelMes: 4,
};

function empleado(sueldoBase: number, extra: Partial<EmpleadoCalc> = {}): EmpleadoCalc {
  return { id: 'e1', nombre: 'Empleado', sueldoBase, tipoPago: 'QUINCENAL', ...extra };
}

function item(
  sueldoBase: number,
  entrada: Record<string, unknown> = {},
  ctx: ContextoCorrida = Q1_JUNIO,
  empExtra: Partial<EmpleadoCalc> = {},
): CalculoItem {
  const res = calcularItem(empleado(sueldoBase, empExtra), { employeeId: 'e1', ...entrada }, ctx, TASAS);
  if ('error' in res) throw new Error(`renglón con error inesperado: ${res.error}`);
  if ('omitido' in res) throw new Error(`renglón omitido inesperadamente: ${res.omitido}`);
  return res;
}

const CUENTAS: CuentasPlanilla = {
  sueldo: 'c-sueldo',
  horasExtras: 'c-extras',
  decimo: 'c-decimo',
  vacaciones: 'c-vacaciones',
  ss: 'c-ss',
  se: 'c-se',
  isr: 'c-isr',
  otrasDeducciones: 'c-otras',
  ssPatronal: 'c-ss-patronal',
  sePatronal: 'c-se-patronal',
  riesgosPatronal: 'c-riesgos-patronal',
  ssPatronalGasto: 'c-ss-pat-gasto',
  sePatronalGasto: 'c-se-pat-gasto',
  riesgosGasto: 'c-riesgos-gasto',
  decimoPorPagar: 'c-decimo-xp',
  vacacionesPorPagar: 'c-vacaciones-xp',
  prestacionesPorPagar: 'c-prestaciones-xp',
};

const debitos = (lineas: LineaAsiento[]) => sumarMontos(...lineas.map((l) => l.debit));
const creditos = (lineas: LineaAsiento[]) => sumarMontos(...lineas.map((l) => l.credit));

// ─────────────────────────────────────────────────────────────────────────────

describe('tasas de seguridad social (fixture verificado contra los asientos reales)', () => {
  // Cada fila salió del archivo de planilla que el contador ya cargó: sueldo
  // quincenal y las dos retenciones que le aplicó.
  const FIXTURE: [sueldoBase: number, sueldo: number, ss: number, se: number][] = [
    [780, 390, 38.03, 4.88],
    [700, 350, 34.13, 4.38],
    [716, 358, 34.91, 4.48],
    [728, 364, 35.49, 4.55],
    [784, 392, 38.22, 4.9],
    [800, 400, 39, 5],
    [840, 420, 40.95, 5.25],
    [1220.8, 610.4, 59.51, 7.63],
    [1500, 750, 73.13, 9.38],
  ];

  it.each(FIXTURE)('sueldo base %d → quincena %d con SS %d y SE %d', (base, sueldo, ss, se) => {
    const r = item(base);
    expect(r.sueldo).toBe(sueldo);
    expect(r.ss).toBe(ss);
    expect(r.se).toBe(se);
  });

  it('las horas extras SÍ entran en la base de cotización', () => {
    // Fila real: 610,40 de sueldo + 120,32 de extras → SS 71,25 y SE 9,13.
    const r = item(1220.8, { horasExtras: 120.32 });
    expect(r.ss).toBe(71.25);
    expect(r.se).toBe(9.13);
  });

  it('redondea medio-arriba en los casos .xx5 (el ruido binario no los tumba)', () => {
    // 390 × 9,75% = 38,025 → 38,03 · 350 × 1,25% = 4,375 → 4,38
    // Con Math.round pelado, 38.025 * 100 da 3802.4999… y saldría 38,02.
    expect(item(780).ss).toBe(38.03);
    expect(item(700).se).toBe(4.38);
    expect(r2(38.025)).toBe(38.03);
    expect(r2(4.375)).toBe(4.38);
  });

  it('el bono y el viático no cotizan', () => {
    const conBono = item(1220.8, { otrosIngresos: 100 });
    expect(conBono.ss).toBe(item(1220.8).ss);
    expect(conBono.bruto).toBe(r2(610.4 + 100));
  });
});

describe('décimo tercer mes', () => {
  const ctxDecimo: ContextoCorrida = {
    tipo: 'DECIMO',
    periodicidad: 'ANUAL',
    fechaDesde: new Date(2026, 0, 1),
    fechaHasta: new Date(2026, 11, 31),
    fechaPago: new Date(2026, 11, 15), // el décimo se paga a mediados de diciembre
    pagoNumero: 1,
    pagosDelMes: 1,
  };

  // Montos reales del archivo: SS al 7,25%, sin SE y sin ISR.
  it.each([
    [260, 18.85],
    [266.66, 19.33],
    [280, 20.3],
    [406.93, 29.5],
    [500, 36.25],
  ])('un décimo de %d retiene SS %d', (monto, ss) => {
    const r = item(780, { montoPrestacion: monto }, ctxDecimo);
    expect(r.ss).toBe(ss);
  });

  it('no lleva Seguro Educativo ni ISR (el ×13 del ISR ya lo incluye)', () => {
    const r = item(780, { montoPrestacion: 500 }, ctxDecimo);
    expect(r.se).toBe(0);
    expect(r.isr).toBe(0);
  });

  it('el patrono cotiza el décimo a su propia tasa, MENOR que la del sueldo', () => {
    // 500 × 10,75% = 53,75 (contra 12,25% + 1% que sería sobre un sueldo).
    const r = item(780, { montoPrestacion: 500 }, ctxDecimo);
    expect(r.ssPatronal).toBe(53.75);
    // El Seguro Educativo del patrono y los riesgos son cero en el décimo: el
    // contador dio una sola tasa para el décimo, y del lado del empleado el SE
    // también es cero.
    expect(r.sePatronal).toBe(0);
    expect(r.riesgosPatronal).toBe(0);
  });

  it('el neto es el monto menos la retención', () => {
    const r = item(780, { montoPrestacion: 500 }, ctxDecimo);
    expect(r.neto).toBe(r2(500 - r.ss));
  });
});

describe('vacaciones', () => {
  const ctxVacaciones: ContextoCorrida = {
    tipo: 'VACACIONES',
    periodicidad: 'EVENTUAL',
    fechaDesde: new Date(2026, 5, 1),
    fechaHasta: new Date(2026, 5, 30),
    fechaPago: new Date(2026, 5, 30),
    pagoNumero: 1,
    pagosDelMes: 1,
  };

  it('se pagan completas: sin SS, sin SE y sin ISR', () => {
    const r = item(780, { montoPrestacion: 780 }, ctxVacaciones);
    expect(r.ss).toBe(0);
    expect(r.se).toBe(0);
    expect(r.isr).toBe(0);
    expect(r.neto).toBe(780);
  });
});

describe('ISR: proyección anual ×13', () => {
  it('la escala es progresiva: el tramo del 25% arrastra el impuesto del 15%', () => {
    expect(impuestoAnual(11000)).toBe(0);
    expect(impuestoAnual(50000)).toBe(5850); // 39.000 × 15%
    // Si el tramo del 25% no arrastrara, esto daría 2.500 en vez de 8.350.
    expect(impuestoAnual(60000)).toBe(8350);
  });

  it('proyecta 13 meses y reparte entre 13', () => {
    // Verificado: 1.220,80/mes → 15.870,40 anual → 730,56 → 56,1969 → 56,20
    expect(isrMensual(1220.8)).toBe(56.2);
    // Verificado: 1.500/mes → 19.500 anual → 1.275 → 98,0769 → 98,08
    expect(isrMensual(1500)).toBe(98.08);
  });

  it('un sueldo proyectado por debajo del mínimo exento no retiene', () => {
    // 780 × 13 = 10.140 < 11.000 — las nueve filas de sueldo del archivo con estos
    // montos tienen ISR en cero, y la tabla mensual también habría dado cero acá.
    expect(isrMensual(780)).toBe(0);
    expect(isrMensual(800)).toBe(0);
    expect(isrMensual(840)).toBe(0);
  });

  it('la quincena es la mitad del mes', () => {
    expect(item(1220.8).isr).toBe(28.1);
    expect(item(1500).isr).toBe(49.04);
  });

  it('la corrida MENSUAL retiene el mes completo', () => {
    const ctxMensual: ContextoCorrida = {
      tipo: 'SUELDO',
      periodicidad: 'MENSUAL',
      fechaDesde: new Date(2026, 5, 1),
      fechaHasta: new Date(2026, 5, 30),
      fechaPago: new Date(2026, 5, 30),
      pagoNumero: 1,
      pagosDelMes: 1,
    };
    const r = item(1500, {}, ctxMensual);
    expect(r.sueldo).toBe(1500);
    expect(r.isr).toBe(98.08); // el valor del archivo real
  });

  it('los dos pagos del mes cierran el mes EXACTO, sin céntimo perdido', () => {
    // 56,19 no se parte en dos mitades iguales: 28,095 → 28,10 el primero y 28,09
    // el último. Dos veces 28,10 daría 56,20 y el mes quedaría un céntimo arriba.
    const primero = isrDelPago(56.19, 1, 2, 0);
    const ultimo = isrDelPago(56.19, 2, 2, primero);
    expect(primero).toBe(28.1);
    expect(ultimo).toBe(28.09);
    expect(sumarMontos(primero, ultimo)).toBe(56.19);
  });

  it('el último pago del mes descuenta lo ya retenido', () => {
    const r = item(1220.8, {}, { ...Q2_JUNIO, isrYaRetenidoPorEmpleado: { e1: 28.1 } });
    expect(r.isr).toBe(28.1);
  });

  it('las horas extras no mueven la retención: la proyección usa el sueldo base', () => {
    expect(item(1220.8, { horasExtras: 120.32 }).isr).toBe(item(1220.8).isr);
  });
});

describe('prorrateo por fechas', () => {
  it('un ingreso a mitad de quincena no cobra la quincena completa', () => {
    // Entró el 8 de junio: del 8 al 15 son 8 días de 30 → 780 × 8/30 = 208.
    const r = item(780, {}, Q1_JUNIO, { fechaIngreso: new Date(2026, 5, 8) });
    expect(r.diasTrabajados).toBe(8);
    expect(r.sueldo).toBe(208);
  });

  it('la salida a mitad de período recorta igual', () => {
    const r = item(780, {}, Q1_JUNIO, { fechaSalida: new Date(2026, 5, 10) });
    expect(r.diasTrabajados).toBe(10);
    expect(r.sueldo).toBe(260);
  });

  it('los días trabajados se pueden editar a mano', () => {
    expect(item(780, { diasTrabajados: 10 }).sueldo).toBe(260);
  });

  it('las dos quincenas de un mes de 30 suman el sueldo del mes', () => {
    const q1 = item(780, {}, Q1_JUNIO);
    const q2 = item(780, {}, Q2_JUNIO);
    expect(sumarMontos(q1.sueldo, q2.sueldo)).toBe(780);
  });

  it('quien no estaba empleado en el período queda omitido, no en cero', () => {
    const res = calcularItem(
      empleado(780, { fechaIngreso: new Date(2026, 6, 1) }),
      { employeeId: 'e1' },
      Q1_JUNIO,
      TASAS,
    );
    expect('omitido' in res).toBe(true);
  });

  it('y quien ya había salido, también', () => {
    const res = calcularItem(
      empleado(780, { fechaSalida: new Date(2026, 4, 31) }),
      { employeeId: 'e1' },
      Q1_JUNIO,
      TASAS,
    );
    expect('omitido' in res).toBe(true);
  });

  it('el mes se cuenta real, no de 30 días', () => {
    expect(diasDelMes(new Date(2026, 1, 10))).toBe(28); // febrero 2026
    expect(diasDelMes(new Date(2028, 1, 10))).toBe(29); // febrero bisiesto
    expect(diasEntre(new Date(2026, 5, 1), new Date(2026, 5, 15))).toBe(15);
  });
});

describe('clase de riesgo profesional', () => {
  it('sin clase asignada usa la tarifa general de la empresa', () => {
    expect(item(1220.8).riesgosPatronal).toBe(6.1); // 610,40 × 1%
  });

  it('con clase asignada usa la tarifa de ESA clase', () => {
    const r = item(1220.8, {}, Q1_JUNIO, { claseRiesgo: 'IV' });
    expect(r.riesgosPatronal).toBe(r2(610.4 * 0.04)); // 24,42
  });

  it('una clase SIN tarifa cargada no se asume en cero: la fila se rechaza', () => {
    // La clase III no está en las tarifas. Un cero silencioso subvaluaría el pasivo
    // del patrono y el balance cuadraría igual, así que nadie lo notaría.
    const res = calcularItem(
      empleado(1220.8, { claseRiesgo: 'III' }),
      { employeeId: 'e1' },
      Q1_JUNIO,
      TASAS,
    );
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toContain('clase III');
  });

  it('la corrida separa los errores de los omitidos', () => {
    const empleados: EmpleadoCalc[] = [
      empleado(1220.8, { id: 'e1', nombre: 'Con clase cargada', claseRiesgo: 'I' }),
      empleado(900, { id: 'e2', nombre: 'Clase sin tarifa', claseRiesgo: 'III' }),
      empleado(900, { id: 'e3', nombre: 'No entró todavía', fechaIngreso: new Date(2026, 6, 1) }),
    ];
    const res = calcularCorrida(empleados, [], Q1_JUNIO, TASAS);

    expect(res.items.map((i) => i.employeeId)).toEqual(['e1']);
    expect(res.errores).toHaveLength(1);
    expect(res.errores[0]).toMatchObject({ employeeId: 'e2' });
    expect(res.omitidos).toHaveLength(1);
    expect(res.omitidos[0]).toMatchObject({ employeeId: 'e3' });
  });
});

describe('el neto es el residuo', () => {
  it('cuadra con un sueldo que no da redondo', () => {
    const r = item(666.66); // quincena 333,33
    expect(r.sueldo).toBe(333.33);
    expect(r.ss).toBe(32.5);
    expect(r.se).toBe(4.17);
    expect(r.neto).toBe(r2(r.bruto - r.ss - r.se - r.isr - r.otrasDeducciones));
  });

  it('la invariante vale para todo el fixture', () => {
    for (const base of [390, 666.66, 780, 1220.8, 1500, 3333.33]) {
      const r = item(base, { horasExtras: 17.77, otrosIngresos: 3.33, otrasDeducciones: 5.55 });
      expect(r.neto).toBe(r2(r.bruto - r.ss - r.se - r.isr - r.otrasDeducciones));
      expect(r.bruto).toBe(sumarMontos(r.sueldo, r.horasExtras, r.otrosIngresos));
    }
  });
});

describe('acumulados', () => {
  it('se congelan en el ítem con el factor vigente', () => {
    const r = item(1220.8);
    expect(r.decimoGenerado).toBe(r2(r.bruto / 12));
    expect(r.vacacionesGeneradas).toBe(r2(r.bruto / 12));
    expect(r.primaGenerada).toBe(r2(r.bruto / 52));
  });

  it('solo se devengan en las corridas de sueldo', () => {
    const ctxDecimo: ContextoCorrida = { ...Q1_JUNIO, tipo: 'DECIMO', periodicidad: 'ANUAL' };
    const r = item(780, { montoPrestacion: 500 }, ctxDecimo);
    expect(r.decimoGenerado).toBe(0);
    expect(r.vacacionesGeneradas).toBe(0);
    expect(r.primaGenerada).toBe(0);
  });
});

describe('el asiento cuadra por construcción', () => {
  const casos: [string, CalculoItem, ContextoCorrida][] = [
    ['sueldo redondo', item(1220.8), Q1_JUNIO],
    ['sueldo feo', item(666.66), Q1_JUNIO],
    ['con extras', item(1220.8, { horasExtras: 120.32 }), Q1_JUNIO],
    ['con bono', item(1220.8, { otrosIngresos: 250 }), Q1_JUNIO],
    ['con préstamo', item(1220.8, { otrasDeducciones: 75.5 }), Q1_JUNIO],
    ['todo junto', item(666.66, { horasExtras: 17.77, otrosIngresos: 3.33, otrasDeducciones: 5.55 }), Q1_JUNIO],
    ['décimo', item(780, { montoPrestacion: 406.93 }, { ...Q1_JUNIO, tipo: 'DECIMO' }), { ...Q1_JUNIO, tipo: 'DECIMO' }],
    ['vacaciones', item(780, { montoPrestacion: 780 }, { ...Q1_JUNIO, tipo: 'VACACIONES' }), { ...Q1_JUNIO, tipo: 'VACACIONES' }],
  ];

  it.each(casos)('%s', (_nombre, calculo, ctx) => {
    for (const provisionar of [false, true]) {
      const lineas = construirLineas(calculo, ctx.tipo, CUENTAS, 'c-banco', provisionar);
      expect(lineas.length).toBeGreaterThanOrEqual(2);
      expect(debitos(lineas)).toBe(creditos(lineas));
    }
  });

  it('el crédito al banco es exactamente el neto', () => {
    const calculo = item(1220.8, { horasExtras: 50 });
    const lineas = construirLineas(calculo, 'SUELDO', CUENTAS, 'c-banco', false);
    const banco = lineas.filter((l) => l.accountId === 'c-banco');
    expect(banco).toHaveLength(1);
    expect(banco[0].credit).toBe(calculo.neto);
  });

  it('los aportes del patrono van al debe, cada uno a SU cuenta, y no tocan el neto', () => {
    const calculo = item(1220.8);
    const lineas = construirLineas(calculo, 'SUELDO', CUENTAS, 'c-banco', false);
    const gasto = (id: string) => lineas.find((l) => l.accountId === id)?.debit ?? 0;

    expect(gasto('c-ss-pat-gasto')).toBe(calculo.ssPatronal);
    expect(gasto('c-se-pat-gasto')).toBe(calculo.sePatronal);
    expect(gasto('c-riesgos-gasto')).toBe(calculo.riesgosPatronal);
    // El pasivo también va por concepto: cada aporte del patrono acredita SU cuenta,
    // y los riesgos tienen la suya (a la CSS se le paga todo junto, pero eso es el
    // pago — ver `registrarPagoCSS`).
    const pasivo = (id: string) => lineas.find((l) => l.accountId === id)?.credit ?? 0;
    expect(pasivo('c-ss-patronal')).toBe(calculo.ssPatronal);
    expect(pasivo('c-se-patronal')).toBe(calculo.sePatronal);
    expect(pasivo('c-riesgos-patronal')).toBe(calculo.riesgosPatronal);

    expect(calculo.neto).toBe(r2(calculo.bruto - calculo.ss - calculo.se - calculo.isr));
    // 1% sobre la base de cotización, que es la quincena de 610,40.
    expect(calculo.riesgosPatronal).toBe(6.1);
  });

  it('el gasto del patrono queda repartido en tres cuentas distintas', () => {
    const lineas = construirLineas(item(1220.8), 'SUELDO', CUENTAS, 'c-banco', false);
    const gastos = lineas.filter((l) => l.debit > 0).map((l) => l.accountId);
    expect(gastos).toContain('c-ss-pat-gasto');
    expect(gastos).toContain('c-se-pat-gasto');
    expect(gastos).toContain('c-riesgos-gasto');
    expect(new Set(gastos).size).toBe(gastos.length);
  });

  it('el décimo y las vacaciones también causan el aporte del patrono', () => {
    const decimo = item(780, { montoPrestacion: 500 }, { ...Q1_JUNIO, tipo: 'DECIMO' });
    const lineasDecimo = construirLineas(decimo, 'DECIMO', CUENTAS, 'c-banco', false);
    expect(lineasDecimo.find((l) => l.accountId === 'c-ss-pat-gasto')!.debit).toBe(53.75);
    expect(debitos(lineasDecimo)).toBe(creditos(lineasDecimo));

    const vacaciones = item(780, { montoPrestacion: 780 }, { ...Q1_JUNIO, tipo: 'VACACIONES' });
    const lineasVac = construirLineas(vacaciones, 'VACACIONES', CUENTAS, 'c-banco', false);
    expect(vacaciones.ssPatronal).toBe(r2(780 * 0.1225)); // 95,55
    expect(vacaciones.riesgosPatronal).toBe(r2(780 * 0.01)); // 7,80
    expect(debitos(lineasVac)).toBe(creditos(lineasVac));
  });

  it('la provisión suma sus tres líneas solo si está encendida', () => {
    const calculo = item(1220.8);
    const sin = construirLineas(calculo, 'SUELDO', CUENTAS, 'c-banco', false);
    const con = construirLineas(calculo, 'SUELDO', CUENTAS, 'c-banco', true);

    expect(sin.some((l) => l.accountId === 'c-decimo-xp')).toBe(false);
    expect(con.some((l) => l.accountId === 'c-decimo-xp')).toBe(true);
    expect(con.some((l) => l.accountId === 'c-vacaciones-xp')).toBe(true);
    expect(con.some((l) => l.accountId === 'c-prestaciones-xp')).toBe(true);
    expect(debitos(con)).toBe(creditos(con));
    // La provisión mueve gasto y pasivo en la misma cuantía: el neto no cambia.
    expect(con.find((l) => l.accountId === 'c-banco')!.credit).toBe(calculo.neto);
  });

  it('el décimo descarga el pasivo acumulado en vez de generar gasto nuevo', () => {
    const calculo = item(780, { montoPrestacion: 500 }, { ...Q1_JUNIO, tipo: 'DECIMO' });
    const lineas = construirLineas(calculo, 'DECIMO', CUENTAS, 'c-banco', false);
    expect(lineas.find((l) => l.accountId === 'c-decimo')!.debit).toBe(500);
    expect(lineas.some((l) => l.accountId === 'c-patronal-gasto')).toBe(false);
    expect(debitos(lineas)).toBe(creditos(lineas));
  });

  it('no emite líneas de monto cero', () => {
    const calculo = item(1220.8);
    const lineas = construirLineas(calculo, 'SUELDO', CUENTAS, 'c-banco', false);
    for (const l of lineas) {
      expect(l.debit > 0 || l.credit > 0).toBe(true);
    }
    expect(lineas.some((l) => l.accountId === 'c-extras')).toBe(false);
    expect(lineas.some((l) => l.accountId === 'c-otras')).toBe(false);
  });
});

describe('la corrida completa', () => {
  const empleados: EmpleadoCalc[] = [
    empleado(1220.8, { id: 'e1', nombre: 'Ana' }),
    empleado(1500, { id: 'e2', nombre: 'Beto' }),
    empleado(780, { id: 'e3', nombre: 'Caro' }),
    empleado(900, { id: 'e4', nombre: 'Dora', fechaIngreso: new Date(2026, 6, 1) }),
  ];

  it('barre a todos y deja fuera a quien no corresponde, sin fallar', () => {
    const res = calcularCorrida(empleados, [{ employeeId: 'e1', horasExtras: 120.32 }], Q1_JUNIO, TASAS);
    expect(res.items).toHaveLength(3);
    expect(res.omitidos).toEqual([
      { employeeId: 'e4', nombre: 'Dora', motivo: 'no estaba empleado en el período' },
    ]);
  });

  it('los totales son la suma de los renglones', () => {
    const res = calcularCorrida(empleados, [], Q1_JUNIO, TASAS);
    expect(res.totales.bruto).toBe(sumarMontos(...res.items.map((i) => i.bruto)));
    expect(res.totales.neto).toBe(sumarMontos(...res.items.map((i) => i.neto)));
    expect(res.totales.deducciones).toBe(
      sumarMontos(...res.items.map((i) => i.ss + i.se + i.isr + i.otrasDeducciones)),
    );
  });

  it('el total de los asientos cuadra con el total de la corrida', () => {
    const res = calcularCorrida(empleados, [], Q1_JUNIO, TASAS);
    const lineas = res.items.flatMap((i) => construirLineas(i, 'SUELDO', CUENTAS, 'c-banco', false));
    expect(debitos(lineas)).toBe(creditos(lineas));

    const banco = sumarMontos(...lineas.filter((l) => l.accountId === 'c-banco').map((l) => l.credit));
    expect(banco).toBe(res.totales.neto);

    const patronal = sumarMontos(
      ...res.items.map((i) => i.ssPatronal + i.sePatronal + i.riesgosPatronal),
    );
    expect(patronal).toBe(res.totales.patronal);
    expect(patronal).toBeGreaterThan(0);
  });

  it('sin empleados no explota: devuelve totales en cero', () => {
    const res = calcularCorrida([], [], Q1_JUNIO, TASAS);
    expect(res.items).toHaveLength(0);
    expect(res.totales.neto).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * La planilla SEMANAL. Dos decisiones del dueño que estos casos fijan:
 *
 *  · El sueldo de una semana es `mensual × 12/52`, no un prorrateo por días del mes:
 *    52 semanas son 364 días, así que el reparto por días dejaría el año corto.
 *  · El mes tiene 4 o 5 pagos (no una constante), y el ÚLTIMO cierra el ISR del mes.
 */
describe('planilla semanal: el sueldo de la semana', () => {
  /** La misma semana, corrida a otro mes: para probar que el mes no cambia el monto. */
  const SEMANA_SEP = (dia: number, hasta?: number): ContextoCorrida => ({
    ...SEMANA_SEP_CTX,
    fechaDesde: new Date(2026, 8, dia),
    fechaHasta: new Date(2026, 8, hasta ?? dia + 6),
    pagoNumero: 1,
  });

  it('una semana completa paga mensual × 12/52', () => {
    expect(sueldoSemanal(1220.8)).toBe(281.72); // 1220,80 × 12 / 52 = 281,7230…
    expect(item(1220.8, {}, SEMANA_SEP(7)).sueldo).toBe(281.72);
  });

  it('el sueldo de la semana NO depende de los días del mes', () => {
    // La misma semana completa en un mes de 31, en uno de 30 y en febrero paga igual.
    const enEnero = item(1220.8, {}, { ...SEMANA_SEP(4), fechaDesde: new Date(2026, 0, 5), fechaHasta: new Date(2026, 0, 11) });
    const enAbril = item(1220.8, {}, { ...SEMANA_SEP(4), fechaDesde: new Date(2026, 3, 6), fechaHasta: new Date(2026, 3, 12) });
    const enFebrero = item(1220.8, {}, { ...SEMANA_SEP(4), fechaDesde: new Date(2026, 1, 2), fechaHasta: new Date(2026, 1, 8) });
    expect(enEnero.sueldo).toBe(enAbril.sueldo);
    expect(enAbril.sueldo).toBe(enFebrero.sueldo);
  });

  it('el año cierra casi exacto: la semana redondeada deja céntimos, no pesos', () => {
    // 1220,80 × 12/52 = 281,7230769… → 281,72. La semana redondeada pierde tres
    // milésimas cada vez, así que el año paga 16 céntimos menos que los 12 sueldos
    // del contrato. Es inherente a pagar un monto semanal redondeado —el mismo
    // redondeo que hace cualquier planilla— y por eso se acota en vez de exigir cero:
    // el error máximo es medio céntimo por semana (52 × 0,005 = 0,26).
    const semanal = sueldoSemanal(1220.8);
    const anio = sumarMontos(...Array.from({ length: 52 }, () => semanal));
    expect(Math.abs(anio - 1220.8 * 12)).toBeLessThanOrEqual(0.26);
  });

  it('una semana parcial prorratea sobre SÉPTIMOS (ingreso a mitad de semana)', () => {
    // Entra el miércoles 9 y la semana corre hasta el domingo 13: cinco días.
    const res = calcularItem(
      empleado(1220.8, { tipoPago: 'SEMANAL', fechaIngreso: new Date(2026, 8, 9) }),
      { employeeId: 'e1' },
      SEMANA_SEP(7),
      TASAS,
    );
    if ('error' in res || 'omitido' in res) throw new Error('no debería omitirse');
    expect(res.diasTrabajados).toBe(5);
    expect(res.sueldo).toBe(r2((281.72 * 5) / 7)); // 201,23
    // La semana se paga entera (sábado y domingo incluidos) porque el sueldo es
    // semanal, no por día trabajado. Para pagar solo los días laborables, el
    // contador edita los días en el grid: es un dato del renglón, no una regla.
  });

  it('una corrida que cubre dos semanas paga las dos (sin duplicar el período)', () => {
    const dosSemanas = item(1220.8, {}, SEMANA_SEP(7, 20));
    expect(dosSemanas.diasTrabajados).toBe(14);
    expect(dosSemanas.sueldo).toBe(sumarMontos(sueldoSemanal(1220.8), sueldoSemanal(1220.8)));
  });

  it('la cotización va sobre el bruto de la semana, con las horas extras adentro', () => {
    const calculo = item(1220.8, { horasExtras: 20 }, SEMANA_SEP(7));
    expect(calculo.ss).toBe(r2((calculo.sueldo + 20) * TASAS.ssObrero));
    expect(calculo.se).toBe(r2((calculo.sueldo + 20) * TASAS.seObrero));
  });
});

describe('planilla semanal: el calendario de pagos del mes', () => {
  const VIERNES = 5;

  it('cuenta los días de pago que el mes tiene de verdad', () => {
    // Septiembre 2026: viernes 4, 11, 18 y 25.
    expect(pagosDelMes('SEMANAL', new Date(2026, 8, 25), VIERNES)).toBe(4);
    // Octubre 2026: viernes 2, 9, 16, 23 y 30 — cinco.
    expect(pagosDelMes('SEMANAL', new Date(2026, 9, 30), VIERNES)).toBe(5);
    // Febrero 2027: viernes 5, 12, 19 y 26.
    expect(pagosDelMes('SEMANAL', new Date(2027, 1, 26), VIERNES)).toBe(4);
  });

  it('numera el pago dentro del mes, del 1 al 4 o 5', () => {
    expect(pagoNumeroEnElMes(new Date(2026, 8, 4), VIERNES)).toBe(1);
    expect(pagoNumeroEnElMes(new Date(2026, 8, 25), VIERNES)).toBe(4);
    expect(pagoNumeroEnElMes(new Date(2026, 9, 30), VIERNES)).toBe(5);
  });

  it('la quincena y el mensual NO miran el calendario: son 2 y 1', () => {
    expect(pagosDelMes('QUINCENAL', new Date(2026, 8, 30), VIERNES)).toBe(2);
    expect(pagosDelMes('MENSUAL', new Date(2026, 8, 30), VIERNES)).toBe(1);
    expect(pagosDelMes('ANUAL', new Date(2026, 8, 30), VIERNES)).toBe(1);
  });

  it('los 4 o 5 pagos del mes cierran el ISR exacto, sin céntimo perdido', () => {
    const mensual = isrMensual(1220.8); // 56,20
    for (const pagos of [4, 5]) {
      let retenido = 0;
      for (let n = 1; n <= pagos; n++) {
        const pago = isrDelPago(mensual, n, pagos, retenido);
        retenido = sumarMontos(retenido, pago);
      }
      expect(retenido).toBe(mensual);
    }
  });

  it('un reparto que no da exacto deja el resto para el ÚLTIMO pago', () => {
    // 28,10 entre 4 no da redondo: 7,025 → 7,03 los tres primeros, 7,01 el último.
    expect(isrDelPago(28.1, 1, 4)).toBe(7.03);
    expect(isrDelPago(28.1, 3, 4)).toBe(7.03);
    expect(isrDelPago(28.1, 4, 4, 21.09)).toBe(7.01);
  });
});

describe('el asiento consolidado', () => {
  it('suma por cuenta y sigue cuadrando al centavo', () => {
    const a = item(1220.8, { horasExtras: 20 }, SEMANA_SEP_CTX);
    const b = item(666.66, { otrasDeducciones: 30 }, SEMANA_SEP_CTX, { id: 'e2', nombre: 'Otro' });
    const lineas = consolidarLineas([
      { lineas: construirLineas(a, 'SUELDO', CUENTAS, 'c-banco', false) },
      { lineas: construirLineas(b, 'SUELDO', CUENTAS, 'c-banco', false) },
    ]);

    expect(debitos(lineas)).toBe(creditos(lineas));
    // Una sola línea por cuenta, con la suma de los dos.
    expect(lineas.filter((l) => l.accountId === 'c-banco')).toHaveLength(1);
    expect(lineas.find((l) => l.accountId === 'c-banco')!.credit).toBe(sumarMontos(a.neto, b.neto));
    expect(lineas.find((l) => l.accountId === 'c-ss')!.credit).toBe(sumarMontos(a.ss, b.ss));
    expect(lineas.find((l) => l.accountId === 'c-sueldo')!.debit).toBe(sumarMontos(a.sueldo, b.sueldo));
  });

  it('dos empleados que cobran por bancos distintos llevan DOS créditos', () => {
    // Fundirlos en una sola línea dejaría el banco mal y el neto bien: el asiento
    // seguiría cuadrando y solo se notaría al conciliar.
    const a = item(1220.8, {}, SEMANA_SEP_CTX);
    const b = item(666.66, {}, SEMANA_SEP_CTX, { id: 'e2', nombre: 'Otro' });
    const lineas = consolidarLineas([
      { lineas: construirLineas(a, 'SUELDO', CUENTAS, 'banco-1', false) },
      { lineas: construirLineas(b, 'SUELDO', CUENTAS, 'banco-2', false) },
    ]);

    expect(lineas.find((l) => l.accountId === 'banco-1')!.credit).toBe(a.neto);
    expect(lineas.find((l) => l.accountId === 'banco-2')!.credit).toBe(b.neto);
    expect(debitos(lineas)).toBe(creditos(lineas));
  });

  it('no emite líneas de monto cero ni deja cuentas sin sumar', () => {
    const a = item(1220.8, {}, SEMANA_SEP_CTX);
    const lineas = consolidarLineas([{ lineas: construirLineas(a, 'SUELDO', CUENTAS, 'c-banco', false) }]);
    const sueltas = construirLineas(a, 'SUELDO', CUENTAS, 'c-banco', false);
    expect(lineas).toHaveLength(sueltas.length);
    for (const l of lineas) expect(l.debit + l.credit).toBeGreaterThan(0);
  });
});

describe('descuento por ausencia o tardanza (R1c)', () => {
  // Quincena de junio (15 días sobre un mes de 30): 1.220,80 / 2 = 610,40.
  const AUSENCIA = 81.38; // dos días de sueldo diario (610,40 / 15 × 2)

  it('baja el sueldo del período', () => {
    const conDescuento = item(1220.8, { menosSueldo: AUSENCIA }, Q1_JUNIO);
    expect(conDescuento.sueldo).toBe(529.02); // 610,40 − 81,38
    expect(conDescuento.menosSueldo).toBe(AUSENCIA);
    // El bruto es el sueldo ya descontado: lo que se paga es lo que se devengó.
    expect(conDescuento.bruto).toBe(529.02);
  });

  it('baja la base de cotización: la CSS no cotiza sobre un sueldo que no se pagó', () => {
    const sin = item(1220.8, {}, Q1_JUNIO);
    const con = item(1220.8, { menosSueldo: AUSENCIA }, Q1_JUNIO);

    expect(con.ss).toBe(r2(529.02 * TASAS.ssObrero));
    expect(con.ss).toBeLessThan(sin.ss);
    expect(con.se).toBe(r2(529.02 * TASAS.seObrero));
    // Y también el gasto del patrono, que se causa sobre lo mismo.
    expect(con.ssPatronal).toBe(r2(529.02 * TASAS.ssPatronal));
  });

  it('NO toca otras deducciones: no inventa un pasivo que nadie debe', () => {
    const con = item(1220.8, { menosSueldo: AUSENCIA }, Q1_JUNIO);
    expect(con.otrasDeducciones).toBe(0);

    const lineas = construirLineas(con, 'SUELDO', CUENTAS, 'c-banco', false);
    // Sin línea en la cuenta de otras deducciones, y el asiento cuadra igual.
    expect(lineas.find((l) => l.accountId === 'c-otras')).toBeUndefined();
    expect(debitos(lineas)).toBe(creditos(lineas));
    expect(lineas.find((l) => l.accountId === 'c-sueldo')!.debit).toBe(529.02);
  });

  it('convive con las horas extras: el descuento va al sueldo, no a las extras', () => {
    const con = item(1220.8, { menosSueldo: 50, horasExtras: 120.32 }, Q1_JUNIO);
    expect(con.sueldo).toBe(560.4); // 610,40 − 50
    expect(con.horasExtras).toBe(120.32);
    // La base es la del sueldo descontado MÁS las extras.
    expect(con.ss).toBe(r2((560.4 + 120.32) * TASAS.ssObrero));
  });

  it('un descuento mayor que el sueldo del período REPORTA la fila, no paga en negativo', () => {
    const res = calcularItem(empleado(1220.8), { employeeId: 'e1', menosSueldo: 5000 }, Q1_JUNIO, TASAS);
    expect('error' in res).toBe(true);
    if ('error' in res) expect(res.error).toMatch(/supera el sueldo del período/);
  });

  it('la ausencia de días COMPLETOS se sigue cargando en Días (prorrateo, sin descuento)', () => {
    // Dos días menos de quince: el sueldo baja igual, y sin inventar un monto a mano.
    const conDias = item(1220.8, { diasTrabajados: 13 }, Q1_JUNIO);
    expect(conDias.sueldo).toBe(r2((1220.8 * 13) / 30)); // 529,01
    expect(conDias.menosSueldo).toBe(0);
    expect(conDias.ss).toBe(r2(529.01 * TASAS.ssObrero));
  });

  it('en las prestaciones no aplica: no hay sueldo que descontar', () => {
    const decimo = item(780, { montoPrestacion: 400, menosSueldo: 100 }, { ...Q1_JUNIO, tipo: 'DECIMO' });
    expect(decimo.menosSueldo).toBe(0);
    expect(decimo.bruto).toBe(400);
  });
});

/**
 * Deducciones de acreedores (préstamos, embargos, mueblerías) dentro del motor.
 *
 * Lo que se fija acá es la garantía del asiento: el total descontado es exactamente
 * `manual + Σ de las que aplican`, y ese total se acredita repartido por cuenta de
 * acreedor más el resto a la genérica — sin céntimo que absorber, igual que el neto.
 */
describe('deducciones de acreedores', () => {
  const banco = {
    deduccionId: 'd-banco',
    employeeId: 'e1',
    acreedor: 'Banco General',
    cuentaId: 'c-banco-prestamo',
    tipo: 'FIJO' as const,
    montoFijo: 100,
    saldoPendiente: 500,
    cuotasAplicadas: 1,
    cuotas: 12,
    aplicaEnDiciembre: true,
    isActive: true,
  };
  const muebleria = {
    ...banco,
    deduccionId: 'd-muebleria',
    acreedor: 'Mueblería X',
    cuentaId: 'c-muebleria',
    montoFijo: 45.45,
    tipo: 'FIJO' as const,
    saldoPendiente: null,
    cuotas: null,
    cuotasAplicadas: 0,
  };

  it('el total descontado es el manual más las cuotas que aplican', () => {
    const r = item(1220.8, { deducciones: [banco, muebleria], otrasDeduccionesManual: 20 }, MENSUAL_JUNIO);
    expect(r.deducciones).toHaveLength(2);
    expect(r.otrasDeducciones).toBe(sumarMontos(20, 100, 45.45));
    expect(r.neto).toBe(r2(r.bruto - r.ss - r.se - r.isr - r.otrasDeducciones));
  });

  it('el alias viejo `otrasDeducciones` sigue siendo el monto sin acreedor', () => {
    const conAlias = item(1220.8, { otrasDeducciones: 75.5 });
    const conNombreNuevo = item(1220.8, { otrasDeduccionesManual: 75.5 });
    expect(conAlias.otrasDeducciones).toBe(75.5);
    expect(conAlias.neto).toBe(conNombreNuevo.neto);
  });

  it('una cuota saltada no descuenta ni consume el número de cuota', () => {
    const r = item(1220.8, { deducciones: [{ ...banco, omitida: true }] }, MENSUAL_JUNIO);
    const cuota = r.deducciones[0];
    expect(cuota.monto).toBe(0);
    expect(cuota.estado).toBe('OMITIDA_MANUAL');
    expect(cuota.cuotaNumero).toBeNull();
    expect(r.otrasDeducciones).toBe(0);
  });

  it('en una prestación no corren: el catálogo es contra el sueldo', () => {
    const decimo = item(780, { montoPrestacion: 500, deducciones: [banco] }, { ...Q1_JUNIO, tipo: 'DECIMO' });
    expect(decimo.deducciones).toEqual([]);
    expect(decimo.otrasDeducciones).toBe(0);
  });

  it('el asiento acredita UNA cuenta por acreedor y el resto a la genérica', () => {
    // 30 sin acreedor: tiene que caer en `c-otras`, la cuenta genérica.
    const r = item(1220.8, { deducciones: [banco, muebleria], otrasDeduccionesManual: 30 }, MENSUAL_JUNIO);
    const lineas = construirLineas(r, 'SUELDO', CUENTAS, 'c-banco', false);
    const credito = (id: string) => lineas.filter((l) => l.accountId === id).reduce((s, l) => s + l.credit, 0);

    expect(credito('c-banco-prestamo')).toBe(100);
    expect(credito('c-muebleria')).toBe(45.45);
    expect(credito('c-otras')).toBe(30);
    expect(debitos(lineas)).toBe(creditos(lineas));
  });

  it('dos deducciones al mismo acreedor son una sola línea', () => {
    const r = item(1220.8, { deducciones: [banco, { ...banco, deduccionId: 'd2', montoFijo: 50 }] }, MENSUAL_JUNIO);
    const lineas = construirLineas(r, 'SUELDO', CUENTAS, 'c-banco', false);
    const lineasBanco = lineas.filter((l) => l.accountId === 'c-banco-prestamo');
    expect(lineasBanco).toHaveLength(1);
    expect(lineasBanco[0].credit).toBe(150);
    expect(creditos(lineas)).toBe(debitos(lineas));
  });

  it('si el acreedor usa la cuenta genérica, no se duplica la línea', () => {
    const r = item(1220.8, { deducciones: [{ ...banco, cuentaId: CUENTAS.otrasDeducciones }], otrasDeduccionesManual: 30 }, MENSUAL_JUNIO);
    const lineas = construirLineas(r, 'SUELDO', CUENTAS, 'c-banco', false);
    const generica = lineas.filter((l) => l.accountId === 'c-otras');
    expect(generica).toHaveLength(1);
    expect(generica[0].credit).toBe(130);
    expect(creditos(lineas)).toBe(debitos(lineas));
  });

  it('sin nada sin acreedor, la cuenta genérica no aparece en el asiento', () => {
    const r = item(1220.8, { deducciones: [banco, muebleria] }, MENSUAL_JUNIO);
    const lineas = construirLineas(r, 'SUELDO', CUENTAS, 'c-banco', false);
    expect(lineas.some((l) => l.accountId === 'c-otras')).toBe(false);
    expect(creditos(lineas)).toBe(debitos(lineas));
  });

  it('el cuadre se mantiene en la corrida consolidada', () => {
    const items = [
      item(1220.8, { deducciones: [banco] }, MENSUAL_JUNIO, { id: 'e1' }),
      item(666.66, { deducciones: [muebleria], otrasDeduccionesManual: 5.55 }, MENSUAL_JUNIO, { id: 'e2' }),
    ];
    const conLineas = items.map((i) => ({ lineas: construirLineas(i, 'SUELDO', CUENTAS, 'c-banco', false) }));
    const consolidadas = consolidarLineas(conLineas);
    expect(debitos(consolidadas)).toBe(creditos(consolidadas));
    expect(consolidadas.filter((l) => l.accountId === 'c-banco-prestamo')).toHaveLength(1);
  });

  it('en un pago quincenal la cuota va REPARTIDA: es mensual, no por pago', () => {
    // Sin el reparto, el mismo préstamo le descontaba 200 al mes al quincenal y 433 al
    // semanal. Los dos abonos son la MISMA cuota: solo el segundo la cierra.
    const q1 = item(1220.8, { deducciones: [banco] }, Q1_JUNIO);
    const q2 = item(1220.8, { deducciones: [{ ...banco, yaDescontadoEnElMes: 50 }] }, Q2_JUNIO);
    expect([q1.otrasDeducciones, q2.otrasDeducciones]).toEqual([50, 50]);
    expect(sumarMontos(q1.otrasDeducciones, q2.otrasDeducciones)).toBe(100);
    expect([q1.deducciones[0].cierraCuota, q2.deducciones[0].cierraCuota]).toEqual([false, true]);
    // Y el asiento sigue cuadrando en los dos abonos.
    for (const r of [q1, q2]) {
      const lineas = construirLineas(r, 'SUELDO', CUENTAS, 'c-banco', false);
      expect(debitos(lineas)).toBe(creditos(lineas));
    }
  });

  it('el aviso de neto negativo nombra al acreedor', () => {
    const r = item(1220.8, { deducciones: [{ ...banco, montoFijo: 2000, saldoPendiente: 2000 }] }, MENSUAL_JUNIO);
    expect(r.neto).toBeLessThan(0);
    expect(r.avisos.join(' ')).toMatch(/Banco General 2000\.00/);
  });
});
