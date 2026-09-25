/**
 * Motor de costo promedio ponderado del kardex.
 *
 * Es una función PURA: recibe el estado del producto y devuelve el resultado. No
 * toca la base de datos, ni Express, ni la hora del sistema — por eso se puede
 * probar entera y por eso `now`/`tx` no aparecen por ningún lado.
 *
 * Dos reglas que sostienen todo el módulo (ver INVENTARIO.md §3.1):
 *
 *  · `valor` es la suma FIRMADA de los montos que fueron al asiento, NO
 *    `cantidad × promedio`. Así el kardex y el mayor cuadran al centavo por
 *    construcción, y el costo promedio se DERIVA de `valor / cantidad` — puede
 *    quedar fraccionario sin ser un error, es un número de gestión.
 *
 *  · `cantidad` y `costoTotal` son SIEMPRE positivos: el signo lo da `tipo`. Así el
 *    kardex se lee en columnas Entradas/Salidas y ningún reporte mira signos.
 *
 * La única excepción a lo segundo es la fila de regularización, que tiene
 * `cantidad = 0` y existe solo para corregir VALOR (ver `regularizarFaltante`).
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

export type TipoMovimiento = 'ENTRADA' | 'SALIDA' | 'AJUSTE_POSITIVO' | 'AJUSTE_NEGATIVO';

/** Estado VIGENTE del producto. `valor` y `promedio` con precisión completa. */
export interface EstadoProducto {
  cantidad: number;
  valor: number;
  promedio: number;
}

export interface MovimientoCalculado {
  tipo: TipoMovimiento;
  /** Solo en la fila de regularización; en el resto lo decide quien llama. */
  origen?: 'REGULARIZACION';
  /** Unidades que mueve. 0 únicamente en la regularización (corrige valor, no cantidad). */
  cantidad: number;
  costoUnitario: number;
  /** Monto POSITIVO que va al asiento; el signo lo pone `tipo`. */
  costoTotal: number;
  /** Saldo corrido DESPUÉS de este movimiento. */
  saldoCantidad: number;
  saldoValor: number;
  saldoCostoPromedio: number;
  avisos: string[];
}

export type ResultadoMovimiento =
  | { ok: true; movimientos: MovimientoCalculado[] }
  | { ok: false; error: string };

/**
 * Aplica un movimiento al estado y devuelve el o los movimientos resultantes.
 *
 * Devuelve una LISTA porque una entrada que cubre un faltante produce dos filas:
 * la entrada y la regularización del valor de lo que ya había salido.
 *
 * `forzar` permite dejar el stock en negativo. El faltante se valora a costo 0 —no
 * se inventa un costo— y el promedio se conserva. Es la válvula para una venta que
 * ya ocurrió: bloquearla obligaría a inventar mercancía que existe físicamente pero
 * no está cargada.
 */
export function calcularMovimiento(
  estado: EstadoProducto,
  mov: { tipo: TipoMovimiento; cantidad: number; costoUnitario?: number },
  opciones: { forzar?: boolean } = {},
): ResultadoMovimiento {
  const { tipo, cantidad } = mov;
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return { ok: false, error: 'La cantidad debe ser mayor que cero' };
  }

  return tipo === 'ENTRADA' || tipo === 'AJUSTE_POSITIVO'
    ? entrada(estado, tipo, cantidad, mov.costoUnitario)
    : salida(estado, tipo, cantidad, !!opciones.forzar, mov.costoUnitario);
}

// ── Entradas ────────────────────────────────────────────────────────────────

function entrada(
  estado: EstadoProducto,
  tipo: 'ENTRADA' | 'AJUSTE_POSITIVO',
  cantidad: number,
  costoUnitario?: number,
): ResultadoMovimiento {
  // Un ajuste positivo puede heredar el promedio vigente; una compra no: siempre
  // trae su costo. Y si no hay stock del que heredar, el costo hay que decirlo.
  if (costoUnitario === undefined) {
    if (tipo === 'ENTRADA') return { ok: false, error: 'La entrada necesita un costo unitario' };
    if (estado.cantidad <= 0) {
      return { ok: false, error: 'Sin existencia previa el ajuste necesita un costo unitario' };
    }
    costoUnitario = estado.promedio;
  }
  if (!Number.isFinite(costoUnitario) || costoUnitario < 0) {
    return { ok: false, error: 'El costo unitario no puede ser negativo' };
  }

  const avisos: string[] = [];
  const costoTotal = r2(cantidad * costoUnitario);
  const saldoCantidad = estado.cantidad + cantidad;
  const saldoValor = r2(estado.valor + costoTotal);

  const movimientos: MovimientoCalculado[] = [{
    tipo,
    cantidad,
    costoUnitario,
    costoTotal,
    saldoCantidad,
    saldoValor,
    saldoCostoPromedio: saldoCantidad > 0 ? saldoValor / saldoCantidad : costoUnitario,
    avisos,
  }];

  // La entrada cubrió unidades que habían salido sin stock: esas unidades se
  // vendieron a costo 0 y ahora sabemos lo que costaban. Se corrige el VALOR (no la
  // cantidad: ya salieron) para que las unidades que quedan no absorban su costo.
  // Sin esto, comprar 5 a $10 con el stock en −2 dejaría un promedio de $16.67 en
  // vez de $10, y el resultado del período no cargaría los $20 que corresponden.
  if (estado.cantidad < 0 && saldoCantidad >= 0) {
    const faltante = Math.abs(estado.cantidad);
    const regularizado = r2(faltante * costoUnitario);
    if (regularizado > 0) {
      const valorFinal = r2(saldoValor - regularizado);
      avisos.push(
        `Se regularizaron ${faltante} unidad(es) que habían salido sin existencia, a $${costoUnitario.toFixed(2)} cada una.`,
      );
      movimientos.push({
        tipo: 'AJUSTE_NEGATIVO',
        origen: 'REGULARIZACION',
        cantidad: 0, // corrige valor, no cantidad: esas unidades ya salieron
        costoUnitario,
        costoTotal: regularizado,
        saldoCantidad,
        saldoValor: valorFinal,
        saldoCostoPromedio: saldoCantidad > 0 ? valorFinal / saldoCantidad : costoUnitario,
        avisos: [],
      });
    } else {
      avisos.push(`Quedaban ${faltante} unidad(es) sin existencia y la compra vino a costo $0.`);
    }
  }

  return { ok: true, movimientos };
}

// ── Salidas ─────────────────────────────────────────────────────────────────

/**
 * Una salida sale al promedio vigente, salvo que se le pase un costo explícito.
 *
 * El costo explícito existe para los REVERSOS, y no es un adorno: reponer la cantidad
 * al promedio NO devuelve el valor anterior, porque el promedio se mezcló con otros
 * movimientos. Anular una entrada de 10 a $3 cuando el promedio ya es $2,59 saca
 * $25,88 en vez de $30 y el kardex queda corrido para siempre. Reponiendo al costo
 * original, la ida y vuelta se cancelan exactamente.
 */
function salida(
  estado: EstadoProducto,
  tipo: 'SALIDA' | 'AJUSTE_NEGATIVO',
  cantidad: number,
  forzar: boolean,
  costoExplicito?: number,
): ResultadoMovimiento {
  if (cantidad > estado.cantidad && !forzar) {
    return {
      ok: false,
      error: `Existencia insuficiente: hay ${estado.cantidad} y se piden ${cantidad}. ` +
        'Confirma la salida para dejarla en negativo y regularizarla después.',
    };
  }

  const avisos: string[] = [];
  // Se valora lo que efectivamente había. Si la salida vacía el stock, se lleva el
  // valor COMPLETO que quedaba (barrido) en vez de cantidad × promedio: así absorbe
  // el redondeo acumulado y el inventario cierra en 0/0 exacto, sin centavos fantasma.
  // El barrido solo aplica al camino del promedio: con costo explícito el importe es
  // el del movimiento que se está revirtiendo, que es justamente lo que hay que reponer.
  const cubierto = Math.min(cantidad, Math.max(0, estado.cantidad));
  const vacia = costoExplicito === undefined && cubierto === estado.cantidad && estado.cantidad > 0;
  const costoUnitario = costoExplicito ?? estado.promedio;
  // Con costo explícito (un reverso) el importe es el de la CANTIDAD PEDIDA, no el de
  // la que hay en stock: el reverso tiene que deshacer exactamente lo que el movimiento
  // original hizo. Si se limita a lo que queda, un reverso parcial deja el valor
  // corrido para siempre — sacar 10 unidades de un stock de 8 reponía solo 8.
  const costoTotal = costoExplicito !== undefined
    ? r2(cantidad * costoExplicito)
    : vacia ? estado.valor : r2(cubierto * costoUnitario);

  const saldoCantidad = estado.cantidad - cantidad;
  const saldoValor = r2(estado.valor - costoTotal);

  // Con el saldo en negativo o en cero el promedio NO se recalcula: se conserva el
  // último conocido. Dividir por cero daría NaN y reiniciar a 0 perdería el dato.
  const saldoCostoPromedio = saldoCantidad > 0 ? saldoValor / saldoCantidad : estado.promedio;

  if (cantidad > estado.cantidad) {
    avisos.push(
      `Salió sin existencia: quedan ${saldoCantidad} unidad(es). El faltante se valoró a costo 0; ` +
      'al cargar la compra se regulariza solo.',
    );
  }
  if (cubierto > 0 && estado.promedio === 0) {
    avisos.push('Salió a costo $0: el producto no tiene costo cargado.');
  }

  return {
    ok: true,
    movimientos: [{
      tipo,
      cantidad,
      // Sin faltante, el costo unitario es el que se usó; con faltante, el importe
      // reparte entre las unidades que salieron, porque las demás iban a costo 0.
      costoUnitario: cantidad > 0 && cubierto === cantidad ? costoUnitario : cubierto > 0 ? costoTotal / cubierto : 0,
      costoTotal,
      saldoCantidad,
      saldoValor,
      saldoCostoPromedio,
      avisos,
    }],
  };
}
