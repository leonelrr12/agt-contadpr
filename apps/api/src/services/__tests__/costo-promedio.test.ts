import { describe, it, expect } from 'vitest';
import { calcularMovimiento, type EstadoProducto, type TipoMovimiento } from '../costo-promedio';

/**
 * El motor de costo promedio es puro, así que se prueba entero sin base de datos ni
 * stubs. Lo que fijan estos casos es lo que hace que el kardex cuadre con el mayor:
 *
 *  · el valor es la suma de los montos posteados, y una salida NUNCA cambia el promedio;
 *  · una salida que vacía el stock se lleva el valor completo que quedaba (barrido), para
 *    que el inventario cierre en 0/0 exacto y no queden centavos fantasma;
 *  · vender sin existencia deja el faltante a costo 0, y la compra que lo cubre regulariza
 *    el valor de esas unidades sin tocar la cantidad — ya salieron.
 */

const VACIO: EstadoProducto = { cantidad: 0, valor: 0, promedio: 0 };

/** Aplica una secuencia y devuelve el estado final, exigiendo que nada falle. */
function aplicar(
  inicial: EstadoProducto,
  pasos: { tipo: TipoMovimiento; cantidad: number; costoUnitario?: number; forzar?: boolean }[],
) {
  let estado = inicial;
  const movimientos = [];
  for (const p of pasos) {
    const res = calcularMovimiento(estado, p, { forzar: p.forzar });
    if (!res.ok) throw new Error(`Paso inesperadamente rechazado: ${res.error}`);
    movimientos.push(...res.movimientos);
    const ultimo = res.movimientos[res.movimientos.length - 1];
    estado = {
      cantidad: ultimo.saldoCantidad,
      valor: ultimo.saldoValor,
      promedio: ultimo.saldoCostoPromedio,
    };
  }
  return { estado, movimientos };
}

describe('costo promedio — entradas', () => {
  it('la primera entrada fija el promedio en su costo', () => {
    const { estado } = aplicar(VACIO, [{ tipo: 'ENTRADA', cantidad: 10, costoUnitario: 2 }]);
    expect(estado).toMatchObject({ cantidad: 10, valor: 20, promedio: 2 });
  });

  it('dos compras a distinto costo ponderan por cantidad', () => {
    const { estado } = aplicar(VACIO, [
      { tipo: 'ENTRADA', cantidad: 100, costoUnitario: 1 },
      { tipo: 'ENTRADA', cantidad: 50, costoUnitario: 1.6 },
    ]);
    expect(estado.cantidad).toBe(150);
    expect(estado.valor).toBe(180);
    expect(estado.promedio).toBeCloseTo(1.2, 10);
  });

  it('acepta cantidades fraccionarias (se vende por peso)', () => {
    const { estado } = aplicar(VACIO, [{ tipo: 'ENTRADA', cantidad: 2.5, costoUnitario: 4 }]);
    expect(estado).toMatchObject({ cantidad: 2.5, valor: 10, promedio: 4 });
  });

  it('una entrada sin costo unitario se rechaza', () => {
    const res = calcularMovimiento(VACIO, { tipo: 'ENTRADA', cantidad: 5 });
    expect(res.ok).toBe(false);
  });

  it('una cantidad de cero o negativa se rechaza', () => {
    expect(calcularMovimiento(VACIO, { tipo: 'ENTRADA', cantidad: 0, costoUnitario: 1 }).ok).toBe(false);
    expect(calcularMovimiento(VACIO, { tipo: 'SALIDA', cantidad: -3 }).ok).toBe(false);
  });
});

describe('costo promedio — salidas', () => {
  it('sale al promedio vigente y NO lo mueve', () => {
    const { estado, movimientos } = aplicar({ cantidad: 10, valor: 20, promedio: 2 }, [
      { tipo: 'SALIDA', cantidad: 4 },
    ]);
    expect(movimientos[0].costoTotal).toBe(8);
    expect(estado.cantidad).toBe(6);
    expect(estado.valor).toBe(12);
    expect(estado.promedio).toBeCloseTo(2, 10);
  });

  it('si vacía el stock se lleva el valor completo y cierra en 0/0 exacto', () => {
    // El promedio es 1/3 y el valor no es divisible: el barrido evita el centavo fantasma.
    const { estado, movimientos } = aplicar(VACIO, [
      { tipo: 'ENTRADA', cantidad: 3, costoUnitario: 0.333333 },
      { tipo: 'SALIDA', cantidad: 1 },
      { tipo: 'SALIDA', cantidad: 1 },
      { tipo: 'SALIDA', cantidad: 1 },
    ]);
    expect(movimientos[0].saldoValor).toBe(1); // la compra redondea a centavos
    expect(estado.cantidad).toBe(0);
    expect(estado.valor).toBe(0);
  });

  it('sin existencia suficiente se rechaza, salvo que se fuerce', () => {
    const estado: EstadoProducto = { cantidad: 3, valor: 30, promedio: 10 };

    const rechazada = calcularMovimiento(estado, { tipo: 'SALIDA', cantidad: 5 });
    expect(rechazada.ok).toBe(false);
    if (!rechazada.ok) expect(rechazada.error).toContain('Existencia insuficiente');

    const forzada = calcularMovimiento(estado, { tipo: 'SALIDA', cantidad: 5 }, { forzar: true });
    expect(forzada.ok).toBe(true);
    if (!forzada.ok) return;
    const mov = forzada.movimientos[0];
    expect(mov.costoTotal).toBe(30); // se valora lo que había; el faltante va a costo 0
    expect(mov.saldoCantidad).toBe(-2);
    expect(mov.saldoValor).toBe(0);
    expect(mov.saldoCostoPromedio).toBe(10); // el promedio se conserva, nunca queda negativo
    expect(mov.avisos.join(' ')).toContain('sin existencia');
  });
});

describe('costo promedio — costo cero', () => {
  it('una entrada a costo 0 con stock previo baja el promedio', () => {
    const { estado } = aplicar({ cantidad: 10, valor: 20, promedio: 2 }, [
      { tipo: 'ENTRADA', cantidad: 10, costoUnitario: 0 },
    ]);
    expect(estado).toMatchObject({ cantidad: 20, valor: 20 });
    expect(estado.promedio).toBeCloseTo(1, 10);
  });

  it('sin stock la existencia queda a costo 0 y la salida lo avisa', () => {
    const { movimientos } = aplicar(VACIO, [
      { tipo: 'ENTRADA', cantidad: 5, costoUnitario: 0 },
      { tipo: 'SALIDA', cantidad: 5 },
    ]);
    expect(movimientos[1].costoTotal).toBe(0);
    expect(movimientos[1].avisos.join(' ')).toContain('costo $0');
  });
});

describe('costo promedio — ajustes', () => {
  it('un ajuste positivo sin costo hereda el promedio vigente', () => {
    const { estado } = aplicar({ cantidad: 10, valor: 20, promedio: 2 }, [
      { tipo: 'AJUSTE_POSITIVO', cantidad: 5 },
    ]);
    expect(estado).toMatchObject({ cantidad: 15, valor: 30 });
    expect(estado.promedio).toBeCloseTo(2, 10);
  });

  it('sin existencia previa el ajuste positivo exige costo: no se inventa', () => {
    const res = calcularMovimiento(VACIO, { tipo: 'AJUSTE_POSITIVO', cantidad: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('costo');
  });

  it('un ajuste negativo que vacía el stock también barre el valor', () => {
    const { estado, movimientos } = aplicar({ cantidad: 5, valor: 10, promedio: 2 }, [
      { tipo: 'AJUSTE_NEGATIVO', cantidad: 5 },
    ]);
    expect(movimientos[0].costoTotal).toBe(10);
    expect(estado).toMatchObject({ cantidad: 0, valor: 0 });
  });
});

describe('costo promedio — entrada que cubre un faltante', () => {
  it('regulariza el valor de lo que salió sin existencia, sin tocar la cantidad', () => {
    // Se vendieron 2 unidades que no estaban cargadas: salieron a costo 0 y el stock
    // quedó en −2. Al comprar 5 a $10 hay que reconocer que esas 2 costaban $10 cada
    // una, o las 3 que quedan absorberían su costo y el promedio daría $16.67.
    const trasVender: EstadoProducto = { cantidad: -2, valor: 0, promedio: 0 };
    const res = calcularMovimiento(trasVender, { tipo: 'ENTRADA', cantidad: 5, costoUnitario: 10 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.movimientos).toHaveLength(2);
    const [compra, regularizacion] = res.movimientos;

    expect(compra).toMatchObject({ tipo: 'ENTRADA', cantidad: 5, costoTotal: 50 });
    expect(regularizacion).toMatchObject({
      tipo: 'AJUSTE_NEGATIVO',
      origen: 'REGULARIZACION',
      cantidad: 0, // corrige valor, no cantidad: esas unidades ya salieron
      costoTotal: 20,
    });

    // El estado final: 3 unidades (las 5 menos las 2 que ya habían salido) a $10.
    expect(regularizacion.saldoCantidad).toBe(3);
    expect(regularizacion.saldoValor).toBe(30);
    expect(regularizacion.saldoCostoPromedio).toBe(10);
    expect(regularizacion.saldoCostoPromedio).not.toBeCloseTo(16.67, 1);
  });

  it('si la compra viene a costo 0 igual deja el saldo correcto, sin regularizar', () => {
    const res = calcularMovimiento(
      { cantidad: -2, valor: 0, promedio: 0 },
      { tipo: 'ENTRADA', cantidad: 5, costoUnitario: 0 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.movimientos).toHaveLength(1);
    expect(res.movimientos[0].saldoCantidad).toBe(3);
    expect(res.movimientos[0].avisos.join(' ')).toContain('costo $0');
  });

  it('si la compra NO alcanza a cubrir el faltante, no regulariza todavía', () => {
    const res = calcularMovimiento(
      { cantidad: -5, valor: 0, promedio: 0 },
      { tipo: 'ENTRADA', cantidad: 3, costoUnitario: 10 },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.movimientos).toHaveLength(1);
    expect(res.movimientos[0].saldoCantidad).toBe(-2);
  });
});

describe('costo promedio — reversos', () => {
  it('reponer al costo ORIGINAL devuelve el estado exactamente como estaba', () => {
    const inicial: EstadoProducto = { cantidad: 7, valor: 14, promedio: 2 };
    const { estado } = aplicar(inicial, [
      { tipo: 'ENTRADA', cantidad: 10, costoUnitario: 3 },
      { tipo: 'SALIDA', cantidad: 10, costoUnitario: 3 }, // el reverso, a su costo original
    ]);
    expect(estado.cantidad).toBe(inicial.cantidad);
    expect(estado.valor).toBe(inicial.valor);
  });

  it('reponer al PROMEDIO no devuelve el valor anterior: por eso el reverso lleva costo', () => {
    // Documenta por qué el costo explícito existe. Si el reverso saliera al promedio
    // vigente ($2,588…), repondría $25,88 en vez de $30 y el kardex quedaría corrido.
    const inicial: EstadoProducto = { cantidad: 7, valor: 14, promedio: 2 };
    const { estado } = aplicar(inicial, [
      { tipo: 'ENTRADA', cantidad: 10, costoUnitario: 3 },
      { tipo: 'SALIDA', cantidad: 10 }, // sin costo explícito: sale al promedio
    ]);
    expect(estado.cantidad).toBe(inicial.cantidad);
    expect(estado.valor).not.toBe(inicial.valor);
    expect(estado.valor).toBe(18.12);
  });
});

describe('costo promedio — invariante del valor', () => {
  it('el saldo en valor es siempre la suma firmada de los montos posteados', () => {
    // PRNG con semilla fija (mulberry32): reproducible y sin dependencias.
    let semilla = 20260925;
    const azar = () => {
      semilla |= 0;
      semilla = (semilla + 0x6d2b79f5) | 0;
      let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    for (let corrida = 0; corrida < 200; corrida++) {
      let estado: EstadoProducto = { cantidad: 0, valor: 0, promedio: 0 };
      let valorEsperado = 0;
      let cantidadEsperada = 0;

      for (let paso = 0; paso < 12; paso++) {
        const r = azar();
        const tipo: TipoMovimiento =
          r < 0.45 ? 'ENTRADA' : r < 0.85 ? 'SALIDA' : r < 0.93 ? 'AJUSTE_POSITIVO' : 'AJUSTE_NEGATIVO';
        const cantidad = Math.ceil(azar() * 10);
        const costoUnitario = azar() < 0.15 ? 0 : Math.round(azar() * 1000) / 100;

        const res = calcularMovimiento(estado, { tipo, cantidad, costoUnitario }, { forzar: true });
        if (!res.ok) throw new Error(`Rechazado en la corrida ${corrida}: ${res.error}`);

        for (const m of res.movimientos) {
          const resta = m.tipo === 'SALIDA' || m.tipo === 'AJUSTE_NEGATIVO';
          valorEsperado += resta ? -m.costoTotal : m.costoTotal;
          cantidadEsperada += resta ? -m.cantidad : m.cantidad;
        }

        const ultimo = res.movimientos[res.movimientos.length - 1];
        estado = {
          cantidad: ultimo.saldoCantidad,
          valor: ultimo.saldoValor,
          promedio: ultimo.saldoCostoPromedio,
        };

        // Exacto, no aproximado: todos los montos se redondean a centavos al postearse.
        expect(estado.valor).toBeCloseTo(valorEsperado, 8);
        expect(estado.cantidad).toBeCloseTo(cantidadEsperada, 8);
      }
    }
  });
});
