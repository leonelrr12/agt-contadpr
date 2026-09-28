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

const SUELDO_JUNIO = { tipo: 'SUELDO' as const, fechaPago: new Date(2026, 5, 15) };
const DICIEMBRE = { tipo: 'SUELDO' as const, fechaPago: new Date(2026, 11, 15) };

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
    expect(montoDeCuota(ded({ montoFijo: 125.5 }), 1000)).toBe(125.5);
  });

  it('la cuota por porcentaje va sobre la base del período', () => {
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.1 }), 1234.5)).toBe(123.45);
  });

  it('redondea medio-arriba en el céntimo exacto', () => {
    // 333.33 × 3% = 9.9999 → 10.00 (no 9.99)
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.03 }), 333.33)).toBe(10);
  });

  it('la última cuota es el remanente, no la cuota pactada', () => {
    expect(montoDeCuota(ded({ montoFijo: 100, saldoPendiente: 50 }), 1000)).toBe(50);
  });

  it('sin tope, la cuota no se recorta', () => {
    expect(montoDeCuota(ded({ montoFijo: 100, saldoPendiente: null }), 1000)).toBe(100);
  });

  it('el ajuste del contador manda sobre el fijo y sobre el porcentaje', () => {
    expect(montoDeCuota(ded({ montoAjustado: 75 }), 1000)).toBe(75);
    expect(montoDeCuota(ded({ tipo: 'PORCENTAJE', montoFijo: null, porcentaje: 0.1, montoAjustado: 75 }), 5000)).toBe(75);
  });

  it('un ajuste mayor que la deuda NO se topea (es deliberado), pero se avisa', () => {
    const d = ded({ montoAjustado: 500, saldoPendiente: 200 });
    expect(montoDeCuota(d, 1000)).toBe(500);
    const [cuota] = resolverDeducciones([d], { ...SUELDO_JUNIO, base: 1000 });
    expect(cuota.aviso).toMatch(/supera lo que queda de la deuda/);
  });
});

describe('estadoDeCuota: el orden de evaluación es la regla', () => {
  it('una deducción desactivada no aplica', () => {
    expect(estadoDeCuota(ded({ isActive: false }), SUELDO_JUNIO)).toBe('NO_ACTIVA');
  });

  it('las prestaciones no llevan deducciones de acreedores', () => {
    expect(estadoDeCuota(ded(), { tipo: 'DECIMO', fechaPago: DICIEMBRE.fechaPago })).toBe('NO_ACTIVA');
    expect(estadoDeCuota(ded(), { tipo: 'VACACIONES', fechaPago: SUELDO_JUNIO.fechaPago })).toBe('NO_ACTIVA');
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
