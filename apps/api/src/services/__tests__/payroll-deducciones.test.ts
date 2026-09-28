import { describe, it, expect } from 'vitest';
import {
  baseDeduccion,
  estadoDeCuota,
  montoDeCuota,
  resolverDeducciones,
  saldoPendienteDe,
  topeDeuda,
  totalAplicado,
  sePersiste,
  type DeduccionCalc,
} from '../payroll-deducciones';
import { r2 } from '../../lib/money';

/**
 * Las deducciones de acreedores son el único lugar del módulo donde un descuento al
 * sueldo de una persona depende de un HISTORIAL (cuántas cuotas van) además del
 * período. Por eso el estado y el monto se prueban acá, puros: en la corrida, un error
 * acá no rompe nada visible — simplemente le descuenta de más o de menos a alguien.
 */

/** Una deducción del catálogo, con lo mínimo; cada caso pisa lo que le importa. */
function ded(extra: Partial<DeduccionCalc> = {}): DeduccionCalc {
  return {
    deduccionId: 'd1',
    employeeId: 'e1',
    acreedor: 'Mueblería X',
    cuentaId: 'c-muebleria',
    tipo: 'FIJO',
    montoFijo: 100,
    porcentaje: null,
    cuotas: null,
    saldoPendiente: null,
    cuotasAplicadas: 0,
    fechaInicio: null,
    fechaFin: null,
    aplicaEnDiciembre: true,
    isActive: true,
    omitida: false,
    montoAjustado: null,
    ...extra,
  };
}

/**
 * El pago MENSUAL de junio: la cuota entera en un solo pago. Es el caso base de casi
 * todos los casos de abajo; los del reparto quincenal y semanal van al final.
 */
const SUELDO_JUNIO = { tipo: 'SUELDO' as const, fechaPago: new Date(2026, 5, 15), pagoNumero: 1, pagosDelMes: 1 };
const DICIEMBRE = { ...SUELDO_JUNIO, fechaPago: new Date(2026, 11, 15) };
/** La primera quincena de junio, y la segunda (la que cierra el mes). */
const Q1_JUNIO = { ...SUELDO_JUNIO, pagoNumero: 1, pagosDelMes: 2 };
const Q2_JUNIO = { ...SUELDO_JUNIO, fechaPago: new Date(2026, 5, 30), pagoNumero: 2, pagosDelMes: 2 };

describe('topeDeuda / saldoPendienteDe', () => {
  it('el saldo inicial manda sobre el monto total', () => {
    expect(topeDeuda({ saldoInicial: 300, montoTotal: 1000 })).toBe(300);
  });

  it('sin saldo inicial, el tope es el monto total', () => {
    expect(topeDeuda({ montoTotal: 1000 })).toBe(1000);
  });

  it('sin ninguno de los dos no hay tope: la deducción no termina sola', () => {
    expect(topeDeuda({})).toBeNull();
    expect(saldoPendienteDe(null, 500)).toBeNull();
  });

  it('el saldo pendiente descuenta lo ya aplicado', () => {
    expect(saldoPendienteDe(1000, 250)).toBe(750);
  });
});

describe('baseDeduccion', () => {
  it('es sueldo + horas extras: el bono y el viático no son salario', () => {
    expect(baseDeduccion(1200, 80)).toBe(1280);
  });
});

describe('montoDeCuota', () => {
  it('la cuota fija es el monto tal cual', () => {
    expect(montoDeCuota(ded({ montoFijo: 125.5 }), 1000, SUELDO_JUNIO)).toBe(125.5);
  });

  it('la cuota por porcentaje va sobre la base del período', () => {
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.1 }), 1234.5, SUELDO_JUNIO)).toBe(123.45);
  });

  it('redondea medio-arriba en el céntimo exacto', () => {
    // 333.33 × 3% = 9.9999 → 10.00 (no 9.99)
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.03 }), 333.33, SUELDO_JUNIO)).toBe(10);
  });

  it('la última cuota es el remanente, no la cuota pactada', () => {
    expect(montoDeCuota(ded({ montoFijo: 100, saldoPendiente: 50 }), 1000, SUELDO_JUNIO)).toBe(50);
  });

  it('sin tope, la cuota no se recorta', () => {
    expect(montoDeCuota(ded({ montoFijo: 100, saldoPendiente: null }), 1000, SUELDO_JUNIO)).toBe(100);
  });

  it('el ajuste del contador manda sobre el fijo y sobre el porcentaje', () => {
    expect(montoDeCuota(ded({ montoAjustado: 75 }), 1000, SUELDO_JUNIO)).toBe(75);
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.1, montoAjustado: 75 }), 5000, SUELDO_JUNIO)).toBe(75);
  });

  it('un ajuste mayor que la deuda NO se topea (es deliberado), pero se avisa', () => {
    const d = ded({ montoAjustado: 500, saldoPendiente: 200 });
    expect(montoDeCuota(d, 1000, SUELDO_JUNIO)).toBe(500);
    const [cuota] = resolverDeducciones([d], { ...SUELDO_JUNIO, base: 1000 });
    expect(cuota.aviso).toMatch(/supera lo que queda de la deuda/);
  });
});

describe('estadoDeCuota: el orden de evaluación es la regla', () => {
  it('una deducción desactivada no aplica', () => {
    expect(estadoDeCuota(ded({ isActive: false }), SUELDO_JUNIO)).toBe('NO_ACTIVA');
  });

  it('las prestaciones no llevan deducciones de acreedores', () => {
    expect(estadoDeCuota(ded(), { ...DICIEMBRE, tipo: 'DECIMO' })).toBe('NO_ACTIVA');
    expect(estadoDeCuota(ded(), { ...SUELDO_JUNIO, tipo: 'VACACIONES' })).toBe('NO_ACTIVA');
  });

  it('respeta las fechas de inicio y fin, bordes inclusive', () => {
    const enRango = ded({ fechaInicio: new Date(2026, 5, 15), fechaFin: new Date(2026, 5, 15) });
    expect(estadoDeCuota(enRango, SUELDO_JUNIO)).toBe('APLICA');
    expect(estadoDeCuota(ded({ fechaInicio: new Date(2026, 5, 16) }), SUELDO_JUNIO)).toBe('FUERA_DE_FECHAS');
    expect(estadoDeCuota(ded({ fechaFin: new Date(2026, 5, 14) }), SUELDO_JUNIO)).toBe('FUERA_DE_FECHAS');
  });

  it('termina al completar las cuotas', () => {
    expect(estadoDeCuota(ded({ cuotas: 3, cuotasAplicadas: 2 }), SUELDO_JUNIO)).toBe('APLICA');
    expect(estadoDeCuota(ded({ cuotas: 3, cuotasAplicadas: 3 }), SUELDO_JUNIO)).toBe('TERMINADA_CUOTAS');
  });

  it('termina cuando la deuda quedó saldada', () => {
    expect(estadoDeCuota(ded({ saldoPendiente: 0 }), SUELDO_JUNIO)).toBe('TERMINADA_SALDO');
    expect(estadoDeCuota(ded({ saldoPendiente: -5 }), SUELDO_JUNIO)).toBe('TERMINADA_SALDO');
  });

  it('diciembre suspende solo a la marcada, y solo si se PAGA en diciembre', () => {
    expect(estadoDeCuota(ded({ aplicaEnDiciembre: false }), DICIEMBRE)).toBe('SUSPENDIDA_DICIEMBRE');
    expect(estadoDeCuota(ded({ aplicaEnDiciembre: false }), SUELDO_JUNIO)).toBe('APLICA');
    expect(estadoDeCuota(ded({ aplicaEnDiciembre: true }), DICIEMBRE)).toBe('APLICA');
  });

  it('lo que ya terminó está terminado, aunque el contador la saltara', () => {
    expect(estadoDeCuota(ded({ cuotas: 3, cuotasAplicadas: 3, omitida: true }), SUELDO_JUNIO)).toBe('TERMINADA_CUOTAS');
    expect(estadoDeCuota(ded({ omitida: true }), SUELDO_JUNIO)).toBe('OMITIDA_MANUAL');
  });

  it('desactivada gana sobre diciembre: el motivo que se muestra es el real', () => {
    expect(estadoDeCuota(ded({ isActive: false, aplicaEnDiciembre: false }), DICIEMBRE)).toBe('NO_ACTIVA');
  });
});

describe('resolverDeducciones', () => {
  const base = 1000;

  it('salta la cuota sin mover el saldo ni el calendario', () => {
    // 3ª cuota de una deuda de 250 con cuota de 100: quedan 50.
    const d = ded({ saldoPendiente: 50, cuotasAplicadas: 2, cuotas: 3, omitida: true });
    const [cuota] = resolverDeducciones([d], { ...SUELDO_JUNIO, base });
    expect(cuota.estado).toBe('OMITIDA_MANUAL');
    expect(cuota.monto).toBe(0);
    expect(cuota.cuotaNumero).toBeNull();
    expect(cuota.saldoDespues).toBe(50);
    // La corrida siguiente vuelve a ofrecer la MISMA cuota: no se consumió.
    const [siguiente] = resolverDeducciones([{ ...d, omitida: false }], { ...SUELDO_JUNIO, base });
    expect(siguiente.cuotaNumero).toBe(3);
    expect(siguiente.monto).toBe(50);
    expect(siguiente.saldoDespues).toBe(0);
  });

  it('la cuota que aplica trae su número y el saldo que deja', () => {
    const [cuota] = resolverDeducciones([ded({ cuotas: 3, cuotasAplicadas: 1, saldoPendiente: 200 })], {
      ...SUELDO_JUNIO,
      base,
    });
    expect(cuota).toMatchObject({ estado: 'APLICA', cuotaNumero: 2, cuotasTotales: 3, monto: 100, saldoAntes: 200, saldoDespues: 100 });
  });

  it('una tasa en cero no descuenta ni consume la cuota', () => {
    const [cuota] = resolverDeducciones(
      [ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0 })],
      { ...SUELDO_JUNIO, base },
    );
    expect(cuota.estado).toBe('SIN_MONTO');
    expect(cuota.monto).toBe(0);
    expect(sePersiste(cuota)).toBe(false);
  });

  it('sin base (un período sin días trabajados) tampoco descuenta', () => {
    const [cuota] = resolverDeducciones([ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.05 })], {
      ...SUELDO_JUNIO,
      base: 0,
    });
    expect(cuota.estado).toBe('SIN_MONTO');
  });

  it('el total aplicado suma solo lo que aplica', () => {
    const cuotas = resolverDeducciones(
      [
        ded({ deduccionId: 'd1', acreedor: 'Banco', montoFijo: 100 }),
        ded({ deduccionId: 'd2', acreedor: 'Mueblería', montoFijo: 50, saldoPendiente: 50 }),
        ded({ deduccionId: 'd3', acreedor: 'Juzgado', montoFijo: 30, omitida: true }),
        ded({ deduccionId: 'd4', acreedor: 'Terminada', montoFijo: 10, cuotas: 1, cuotasAplicadas: 1 }),
      ],
      { ...SUELDO_JUNIO, base },
    );
    expect(cuotas).toHaveLength(4);
    expect(totalAplicado(cuotas)).toBe(150);
  });

  it('avisa cuando la deducción no tiene cuotas ni monto total', () => {
    const [cuota] = resolverDeducciones([ded({ montoFijo: 25 })], { ...SUELDO_JUNIO, base });
    expect(cuota.aviso).toMatch(/se va a descontar todos los períodos/);
  });

  it('no avisa de una deducción que ya terminó', () => {
    const [cuota] = resolverDeducciones([ded({ cuotas: 2, cuotasAplicadas: 2 })], { ...SUELDO_JUNIO, base });
    expect(cuota.aviso).toBe('');
  });
});

describe('sePersiste', () => {
  it('guarda lo que dejó rastro y no lo que nunca corrió', () => {
    expect(sePersiste({ estado: 'APLICA' } as any)).toBe(true);
    expect(sePersiste({ estado: 'OMITIDA_MANUAL' } as any)).toBe(true);
    expect(sePersiste({ estado: 'SUSPENDIDA_DICIEMBRE' } as any)).toBe(true);
    expect(sePersiste({ estado: 'TERMINADA_CUOTAS' } as any)).toBe(false);
    expect(sePersiste({ estado: 'NO_ACTIVA' } as any)).toBe(false);
  });
});

describe('el céntimo', () => {
  it('una cuota del 3% sobre 333,33 deja 10,00 y el saldo exacto', () => {
    const [cuota] = resolverDeducciones(
      [ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.03, saldoPendiente: 10 })],
      { ...SUELDO_JUNIO, base: 333.33 },
    );
    expect(cuota.monto).toBe(10);
    expect(cuota.saldoDespues).toBe(0);
    expect(r2(cuota.saldoAntes! - cuota.monto)).toBe(cuota.saldoDespues);
  });
});

/**
 * El reparto de la cuota mensual entre los pagos del mes.
 *
 * Es la regla que más caro sale si se rompe: la cuota la pacta el banco POR MES, y un
 * empleado que cobra por quincena o por semana la paga en abonos. Tratarla "por pago"
 * —lo que hacía la primera versión— le descontaba 4,33 cuotas al mes al semanal y le
 * acortaba el plazo a un tercio.
 */
describe('la cuota mensual repartida entre los pagos', () => {
  const fija = (extra: Partial<DeduccionCalc> = {}) => ded({ montoFijo: 100, ...extra });
  const base = 1000;

  it('el pago mensual lleva la cuota entera y la cierra', () => {
    const [c] = resolverDeducciones([fija()], { ...SUELDO_JUNIO, base });
    expect(c.monto).toBe(100);
    expect(c.cierraCuota).toBe(true);
  });

  it('el quincenal la parte en dos: la segunda quincena cierra', () => {
    const [q1] = resolverDeducciones([fija()], { ...Q1_JUNIO, base });
    const [q2] = resolverDeducciones([fija({ yaDescontadoEnElMes: 50 })], { ...Q2_JUNIO, base });
    expect([q1.monto, q2.monto]).toEqual([50, 50]);
    expect([q1.cierraCuota, q2.cierraCuota]).toEqual([false, true]);
    // Los dos son la MISMA cuota: el número no se mueve entre uno y otro.
    expect([q1.cuotaNumero, q2.cuotaNumero]).toEqual([1, 1]);
  });

  it('el semanal la parte en cuatro y solo la última la cierra', () => {
    const cuotaSemanal = { ...SUELDO_JUNIO, pagosDelMes: 4 };
    const montos = [1, 2, 3].map((pagoNumero) =>
      resolverDeducciones([fija({ yaDescontadoEnElMes: 25 * (pagoNumero - 1) })], { ...cuotaSemanal, pagoNumero, base })[0],
    );
    const ultima = resolverDeducciones([fija({ yaDescontadoEnElMes: 75 })], { ...cuotaSemanal, pagoNumero: 4, base })[0];
    expect(montos.map((c) => c.monto)).toEqual([25, 25, 25]);
    expect(montos.every((c) => !c.cierraCuota)).toBe(true);
    expect(ultima.monto).toBe(25);
    expect(ultima.cierraCuota).toBe(true);
  });

  it('el último pago cierra el céntimo del reparto', () => {
    const tres = { ...SUELDO_JUNIO, pagosDelMes: 3 };
    const [p1] = resolverDeducciones([fija({ montoFijo: 100 })], { ...tres, pagoNumero: 1, base });
    const [p3] = resolverDeducciones([fija({ yaDescontadoEnElMes: 66.66 })], { ...tres, pagoNumero: 3, base });
    expect(p1.monto).toBe(33.33);
    expect(p3.monto).toBe(33.34);
    expect(r2(p1.monto * 2 + p3.monto)).toBe(100);
  });

  it('si el contador ajustó un abono, el que cierra toma lo que falta (no la cobra dos veces)', () => {
    const [q1] = resolverDeducciones([fija({ montoAjustado: 30 })], { ...Q1_JUNIO, base });
    const [q2] = resolverDeducciones([fija({ yaDescontadoEnElMes: 30 })], { ...Q2_JUNIO, base });
    expect([q1.monto, q2.monto]).toEqual([30, 70]);
    expect(r2(q1.monto + q2.monto)).toBe(100);
  });

  it('si se salta un abono, el que cierra toma la cuota completa', () => {
    const [q2] = resolverDeducciones([fija({ yaDescontadoEnElMes: 0 })], { ...Q2_JUNIO, base });
    expect(q2.monto).toBe(100);
  });

  it('el reparto no se pasa del remanente: la deuda termina al cerrar el mes', () => {
    const [q1] = resolverDeducciones([fija({ saldoPendiente: 50 })], { ...Q1_JUNIO, base });
    const [q2] = resolverDeducciones([fija({ saldoPendiente: 25, yaDescontadoEnElMes: 25 })], { ...Q2_JUNIO, base });
    expect([q1.monto, q2.monto]).toEqual([25, 25]);
    expect(q2.saldoDespues).toBe(0);
  });

  it('una cuota que no llega a un céntimo por pago se cierra igual al final del mes', () => {
    // 1,00 al mes entre 4 pagos: 0,25 cada uno. Con 0,10 el intermedio redondea a 0,03.
    const cuatro = { ...SUELDO_JUNIO, pagosDelMes: 4 };
    const [p4] = resolverDeducciones([fija({ montoFijo: 0.1, yaDescontadoEnElMes: 0.06 })], { ...cuatro, pagoNumero: 4, base });
    expect(p4.monto).toBe(0.04);
    expect(p4.cierraCuota).toBe(true);
  });
});
