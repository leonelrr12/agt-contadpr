import { PDFParse } from 'pdf-parse';

/**
 * Extracto bancario en PDF → tabla de movimientos.
 *
 * El PDF se convierte al MISMO shape que un CSV ya leído (`headers` + filas
 * crudas) para que `parseImportFile` lo mapee con el detector de columnas de
 * siempre. Así el resto del pipeline —fecha, monto con signo, `debitCreditDeFila`,
 * el matcher— no sabe (ni necesita saber) que el archivo era un PDF.
 *
 * La heurística es la de los estados digitales: **fecha al inicio** de un
 * movimiento y **uno o más importes al final**. Entre la fecha y los importes
 * puede haber una descripción que, si es larga, el banco parte en varias líneas
 * (el estado de ahorro de Banco General lo hace en casi todas): por eso las
 * líneas sin fecha se acumulan como continuación del movimiento abierto hasta
 * que aparece la línea de importes. Encabezados, sellos de hora, totales y pies
 * de página se descartan.
 *
 * Varios importes al final se interpretan como columnas: el último es el saldo
 * y, en el orden habitual `Débito Crédito Saldo`, el monto del débito es una
 * salida (negativo para `debitCreditDeFila`) y el del crédito una entrada. Con
 * dos importes (`Monto Saldo`) se conserva el signo del movimiento. Es lo que
 * hace falta para no tomar el saldo —ni la columna vacía— como el monto.
 *
 * Además de las filas, se valida la **cadena de saldos** cuando el estado trae
 * una columna de saldo por movimiento: `saldo[i] = saldo[i-1] ± monto[i]` en
 * orden ascendente y `saldo[i-1] = saldo[i] ± monto[i-1]` en descendente. Si
 * una fila se perdió (descripción que se parte distinto, columna que no se
 * reconoció) la cadena no cierra y el upload **avisa con una alerta**, pero no
 * bloquea la carga: el contador decide si revisa las filas.
 */

/*** Un token es un importe si termina en dos decimales o lleva símbolo de moneda. */
const RE_IMPORTE_TOKEN = /^(?:\(\s*)?-?\s*(?:USD|B\/\.?|\$)?\s*-?\d[\d.,]*(?:[.,]\d{2})?(?:\s*\))?-?$/i;

/** Fecha al inicio: 01/01/2026, 01-ene-2026, 2026-01-01. */
const RE_FECHA_INICIO = /^(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-](?:[a-záéíóúñ]{3,}|\d{1,2})[\/\-]\d{2,4})\b/i;

const MESES_CORTOS = new Set(['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'set', 'oct', 'nov', 'dic']);

/**
 * ¿El texto con forma de fecha es una fecha real? Sin esto, el número de cuenta
 * "04-73-00-002810-1" entra como "04-73-00" y abre un movimiento fantasma que
 * después rompe el parseo (estado de ahorro de Banco General).
 */
function esFechaDeMovimiento(texto: string): boolean {
  const letras = texto.match(/^(\d{1,2})[\/\-]([a-záéíóúñ]{3,})\.?[\/\-](\d{2,4})$/i);
  if (letras) {
    const mes = letras[2].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 3);
    return MESES_CORTOS.has(mes);
  }
  const nums = texto.match(/^(\d{1,4})[\/\-](\d{1,2})[\/\-](\d{1,4})$/);
  if (!nums) return false;
  const a = Number(nums[1]);
  const b = Number(nums[2]);
  const c = Number(nums[3]);
  return nums[1].length === 4
    ? b >= 1 && b <= 12 && c >= 1 && c <= 31 // YYYY-MM-DD
    : a >= 1 && a <= 31 && b >= 1 && b <= 12; // DD-MM-YYYY / DD-MM-YY
}

/** ¿El token es un importe? Exige decimales o `$` para no confundir años ni horas. */
function esImporte(token: string): boolean {
  if (!RE_IMPORTE_TOKEN.test(token)) return false;
  return /[.,]\d{2}\s*\)?-?$/.test(token) || /[\$]/.test(token);
}

/** Normaliza el importe a algo que `parseAmount` entienda (signo adelante). */
function normalizarImporte(token: string): string {
  let t = token.trim();
  if (t.startsWith('(') && t.endsWith(')')) t = '-' + t.slice(1, -1);
  if (t.endsWith('-')) t = '-' + t.slice(0, -1);
  if (t.endsWith(')')) t = t.replace(/\)$/, '');
  return t;
}

/** Valor numérico de un importe ya normalizado (misma convención que `parseAmount`). */
function valorDeImporte(raw: string): number | null {
  const limpio = String(raw || '').replace(/[^\d,.-]/g, '');
  if (!limpio) return null;
  let t = limpio;
  if (/,\d{2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Línea de encabezado, pie o sello de hora: nunca es un movimiento ni la
 * continuación de uno. Se evalúa ANTES de buscar la fecha porque los sellos
 * ("23-oct-2026 06:20 PM") empiezan con una fecha.
 */
function esRuido(linea: string): boolean {
  return (
    /^\d{1,2}[\/\-][a-z0-9]+[\/\-]\d{2,4}\b[\s•·|,-]*\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i.test(linea) ||
    /^P[aá]g(?:ina)?\.?\s*\d+\s*de\s*\d+$/i.test(linea) ||
    /^--\s*\d+\s+of\s+\d+\s*--$/i.test(linea) ||
    /^Fecha\b.*(?:Descripci[oó]n|Concepto|Monto)/i.test(linea) ||
    /^(?:CUENTA\b|Titular:|Saldo total:|Disponible:|Movimientos entre\b|Estado de cuenta\b)/i.test(linea)
  );
}

/** Separa los importes pegados al final; lo de adelante es descripción. */
function partirImportes(texto: string): { descripcion: string; importes: string[] } {
  const tokens = texto.split(' ').filter(Boolean);
  let desde = tokens.length;
  const importes: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!esImporte(tokens[i])) break;
    importes.unshift(normalizarImporte(tokens[i]));
    desde = i;
  }
  return { descripcion: tokens.slice(0, desde).join(' ').trim(), importes };
}

/** Fila final a partir de la fecha, la descripción acumulada y los importes. */
function armarFila(fecha: string, descripcion: string, importes: string[]) {
  // Con varias columnas al final la última es el saldo. En el orden habitual
  // de los extractos panameños (`Débito Crédito Saldo`) el débito es una SALIDA
  // y va negativo para `debitCreditDeFila`; el crédito es una entrada. Con dos
  // columnas (movimiento + saldo) se conserva el signo que trae el archivo.
  let monto = importes[0];
  let saldo = '';
  if (importes.length > 1) {
    saldo = importes[importes.length - 1];
    if (importes.length === 2) {
      monto = importes[0];
    } else {
      const debito = importes[0];
      const credito = importes[1];
      if (/[1-9]/.test(debito)) monto = '-' + debito.replace(/^-/, '');
      else if (/[1-9]/.test(credito)) monto = credito.replace(/^-/, '');
      else monto = credito;
    }
  }
  return { fecha, descripcion, monto, saldo };
}

/**
 * Filas de movimiento de un texto de extracto. Exportada para poder probarla
 * con el texto del PDF sin depender de un binario en el repo.
 *
 * Los movimientos se arman como una máquina de estados: una línea con fecha
 * abre uno; las líneas sin fecha se suman a su descripción; la línea con
 * importes al final lo cierra. Un movimiento que se abre y no se cierra es un
 * parseo incompleto (no una fila a saltear): se avisa.
 */
export function filasDeTextoDeExtracto(texto: string): Array<{ fecha: string; descripcion: string; monto: string; saldo: string }> {
  const filas: Array<{ fecha: string; descripcion: string; monto: string; saldo: string }> = [];
  let abierta: { fecha: string; partes: string[] } | null = null;

  for (const lineaOriginal of (texto || '').replace(/\f/g, '\n').split(/\r?\n/)) {
    const linea = lineaOriginal.replace(/\t/g, ' ').replace(/\s+/g, ' ').trim();
    if (!linea || esRuido(linea)) continue;

    const fecha = linea.match(RE_FECHA_INICIO);
    if (fecha && esFechaDeMovimiento(fecha[0])) {
      // Si había un movimiento abierto sin importes, este es otro movimiento:
      // el anterior quedó incompleto y no se puede guardar un extracto a medias.
      if (abierta) {
        throw new Error(`No se pudo leer completo el movimiento del ${abierta.fecha}: se encontró otra fecha antes de sus importes.`);
      }
      const resto = linea.slice(fecha[0].length).trim();
      // Una línea que es solo la fecha no es un movimiento (encabezado suelto).
      if (!resto) continue;
      const { descripcion, importes } = partirImportes(resto);
      if (importes.length) {
        filas.push(armarFila(fecha[0], descripcion, importes));
      } else {
        abierta = { fecha: fecha[0], partes: resto ? [resto] : [] };
      }
      continue;
    }

    if (!abierta) continue;
    const { descripcion, importes } = partirImportes(linea);
    if (importes.length) {
      // La descripción puede venir partida: la primera línea abrió el movimiento
      // y las de en medio se acumularon; la de importes puede traer el final.
      const acumulada = [...abierta.partes, descripcion].filter(Boolean).join(' ').trim();
      filas.push(armarFila(abierta.fecha, acumulada, importes));
      abierta = null;
    } else {
      abierta.partes.push(linea);
    }
  }

  if (abierta) {
    throw new Error(`No se pudo leer completo el movimiento del ${abierta.fecha}: no se encontraron sus importes.`);
  }

  return filas;
}

/**
 * Valida la cadena de saldos de una tabla que trae saldo por movimiento.
 *
 * Un extracto puede venir del más viejo al más nuevo (ascendente) o al revés
 * (el de la cuenta corriente de Banco General, descendente). La relación es
 * `saldo[i] = saldo[i-1] ± monto[i]` en ascendente y `saldo[i-1] = saldo[i] ±
 * monto[i-1]` en descendente; el signo distingue una cuenta bancaria de la
 * deuda de una tarjeta. Se prueban las cuatro convenciones y gana la que más
 * pares explica.
 *
 * **No bloquea**: si ninguna cubre todos los pares, devuelve una advertencia
 * para que el contador revise, pero el extracto se carga igual (decisión del
 * dueño: una alerta, no un error). Las filas sin saldo (estados de tarjeta) no
 * se validan.
 */
export interface ResultadoCadenaSaldos {
  /** Pares consecutivos con saldo comparable que explica la mejor convención. */
  comprobados: number;
  /** Orden que explica la cadena, o null si no se pudo verificar. */
  orden: 'asc' | 'desc' | null;
  /** Aviso cuando la cadena no cierra en todos los pares (NO bloquea la carga). */
  advertencia: string | null;
}

export function validarCadenaDeSaldos(
  filas: Array<{ fecha: string; monto: string; saldo: string }>,
): ResultadoCadenaSaldos {
  const pares: Array<{ i: number; prev: number; actual: number; montoPrev: number; montoActual: number }> = [];
  for (let i = 1; i < filas.length; i++) {
    const prev = valorDeImporte(filas[i - 1].saldo);
    const actual = valorDeImporte(filas[i].saldo);
    const montoPrev = valorDeImporte(filas[i - 1].monto);
    const montoActual = valorDeImporte(filas[i].monto);
    if (prev === null || actual === null || montoPrev === null || montoActual === null) continue;
    pares.push({ i, prev, actual, montoPrev, montoActual });
  }
  if (!pares.length) return { comprobados: 0, orden: null, advertencia: null };

  const TOL = 0.02;
  const convenciones = [
    { orden: 'asc' as const, cuadra: (p: any) => Math.abs(p.prev + p.montoActual - p.actual) <= TOL },
    { orden: 'asc' as const, cuadra: (p: any) => Math.abs(p.prev - p.montoActual - p.actual) <= TOL },
    { orden: 'desc' as const, cuadra: (p: any) => Math.abs(p.actual + p.montoPrev - p.prev) <= TOL },
    { orden: 'desc' as const, cuadra: (p: any) => Math.abs(p.actual - p.montoPrev - p.prev) <= TOL },
  ];

  let mejor = convenciones[0];
  let mejores = -1;
  for (const c of convenciones) {
    const n = pares.filter(c.cuadra).length;
    if (n > mejores) { mejor = c; mejores = n; }
  }

  if (mejores === pares.length) {
    return { comprobados: pares.length, orden: mejor.orden, advertencia: null };
  }

  const primero = pares.find(p => !mejor.cuadra(p))!;
  return {
    comprobados: mejores,
    orden: mejor.orden,
    advertencia:
      `La cadena de saldos no cierra en ${pares.length - mejores} de ${pares.length} movimientos ` +
      `(el primero: ${filas[primero.i].fecha}, saldo ${primero.prev.toFixed(2)} → monto ${primero.montoActual.toFixed(2)} → saldo ${primero.actual.toFixed(2)}). ` +
      'Puede que el formato no se haya leído completo; revisá las filas del extracto.',
  };
}

export interface TablaExtractoPDF {
  headers: string[];
  rawRows: string[][];
  /** Avisos de parseo que NO bloquean la carga (p. ej. cadena de saldos rota). */
  warnings: string[];
}

/**
 * Lee un PDF de extracto y devuelve sus movimientos como tabla cruda.
 * Lanza si el PDF no tiene texto, no se reconoce ninguna fila o la cadena de
 * saldos no cierra: el upload lo convierte en un 400 con explicación, en vez de
 * guardar un extracto incompleto.
 */
export async function extraerTablaExtractoPDF(buffer: Buffer): Promise<TablaExtractoPDF> {
  const parser = new PDFParse({ data: buffer });
  let texto = '';
  try {
    texto = (await parser.getText()).text || '';
  } finally {
    await parser.destroy();
  }

  if (!texto.trim()) {
    throw new Error('El PDF no tiene texto (parece un escaneo). Pasá el extracto digital o convertí el PDF con OCR.');
  }

  const filas = filasDeTextoDeExtracto(texto).filter(f => !/^saldo\s+(anterior|inicial|de apertura)\b/i.test(f.descripcion));
  if (!filas.length) {
    throw new Error('No se reconoció ningún movimiento en el PDF. Se esperan líneas con fecha al inicio e importe al final (formato de los extractos digitales).');
  }

  // El estado de tarjeta no trae saldo por movimiento; el de banco sí. Si lo
  // trae, la cadena dice si alguna fila no se leyó: se avisa, no se bloquea.
  const cadena = validarCadenaDeSaldos(filas);
  const warnings = cadena.advertencia ? [cadena.advertencia] : [];

  return {
    headers: ['Fecha', 'Descripción', 'Monto', 'Saldo'],
    rawRows: filas.map(f => [f.fecha, f.descripcion, f.monto, f.saldo]),
    warnings,
  };
}
