import { leerTabla, parseMonto, parseFecha, repararComaDecimal } from './tabular-utils';
import { r2 } from '../lib/money';

/**
 * Alta masiva de empleados desde el archivo de planilla que el contador YA usa.
 *
 * Es el mismo archivo de siempre (el de la carga por archivo), pero acá solo se
 * leen NOMBRE, CÉDULA, SUELDO y —si están— CARGO, NSS y FECHA DE INGRESO. El
 * resto de las columnas se ignora: las deducciones las calcula el motor.
 *
 * El SUELDO del archivo es el **salario base MENSUAL** y se guarda tal cual: no se
 * convierte nada. Antes había que decirle a la pantalla si el archivo venía quincenal
 * o mensual para multiplicarlo, y eso era una fuente de error silencioso —un archivo
 * mensual leído como quincenal duplicaba todos los sueldos—. Ahora el archivo dice el
 * sueldo del contrato y el tipo de pago se lee de su propia columna.
 */

// El tipo de pago lo define el motor, no este archivo: era un `'QUINCENAL' | 'MENSUAL'`
// duplicado que se quedaba corto en cuanto apareciera una periodicidad nueva.
import type { TipoPago } from './payroll-calc';
export type { TipoPago };

export interface RosterRow {
  row: number;
  nombre: string;
  cedula: string | null;
  cargo: string | null;
  nss: string | null;
  /** El sueldo del archivo: es el salario base MENSUAL, tal como se guarda. */
  sueldoArchivo: number;
  /** Lo que se guarda en la ficha. Hoy es el mismo número, ya redondeado. */
  sueldoBase: number;
  /** El tipo de pago que se le va a guardar al empleado. */
  tipoPago: TipoPago;
  /**
   * De dónde salió: de la columna del archivo o del defecto (quincenal). La pantalla
   * lo muestra para que se vea de un vistazo qué filas no traían el dato — si no,
   * un archivo sin la columna y otro con la columna a medias se ven iguales.
   */
  tipoPagoFuente: 'ARCHIVO' | 'DEFECTO';
  fechaIngreso: string | null;
  parseError?: string;
}

export interface RosterParseResult {
  headers: string[];
  detectedColumns: Record<string, string | null>;
  rows: RosterRow[];
  totalRows: number;
}

const NOMBRE_PATTERNS = [/nombre/i, /empleado/i, /colaborador/i, /^nombres?/i];
const CEDULA_PATTERNS = [/c[eé]dula/i, /identificaci[óo]n/i, /^ci\b/i, /documento/i, /^c\.?i\.?p/i];
const SUELDO_PATTERNS = [/sueldo/i, /salario/i];
const CARGO_PATTERNS = [/cargo/i, /puesto/i, /posici[óo]n/i];
const NSS_PATTERNS = [/^nss\b/i, /n[úu]mero\s*de\s*seguro/i, /seguro\s*social/i, /^c\.?s\.?s\b/i];
const INGRESO_PATTERNS = [/ingreso/i, /^alta/i, /fecha\s*de\s*entrada/i];
const TIPO_PAGO_PATTERNS = [
  /tipo\s*de\s*pago/i,
  /tipo\s*pago/i,
  /forma\s*de\s*pago/i,
  /periodicidad/i,
  /^pago$/i,
];

/**
 * El tipo de pago que dice la celda, o `null` si no dice ninguno conocido.
 *
 * Se aceptan las formas en que aparece en los archivos reales —con y sin tilde, en
 * mayúsculas o no, la palabra suelta ("SEMANA") y la inicial sola ("S")— porque la
 * columna la escribe una persona. Lo que NO se hace es adivinar: un valor que no se
 * reconoce no cae al defecto, se reporta como error de la fila. Un "CATORCENAL" mal
 * escrito que se importe como quincenal le paga mal a esa persona hasta que alguien
 * lo note.
 */
export function normalizarTipoPago(valor: string | undefined): TipoPago | null {
  const t = (valor ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, ''); // "quincenal" con tilde no existe, pero "MENSUAL" sí llega escrita de mil formas
  if (t === '') return null;

  if (['S', 'SEM', 'SEMANA', 'SEMANAL', 'SEMANALES'].includes(t)) return 'SEMANAL';
  if (['Q', 'QUI', 'QUINCENA', 'QUINCENAL', 'QUINCENALES'].includes(t)) return 'QUINCENAL';
  if (['M', 'MES', 'MENSUAL', 'MENSUALES'].includes(t)) return 'MENSUAL';
  return null;
}

/** Índice de la primera columna cuyo encabezado matchea; -1 si ninguna. */
function columna(headers: string[], patrones: RegExp[]): number {
  return headers.findIndex((h) => patrones.some((p) => p.test(h)));
}

/**
 * Lee el archivo de planilla como lista de empleados.
 *
 * El orden de detección importa: NSS se busca DESPUÉS de CÉDULA para que un
 * encabezado "Cédula / NSS" no se lo lleve la columna equivocada.
 */
export async function parseRosterFile(
  buffer: Buffer,
  fileName: string,
  /** El tipo de pago que se usa cuando el archivo no trae la columna. */
  tipoPagoDefecto: TipoPago,
): Promise<RosterParseResult> {
  const { headers, rawRows } = await leerTabla(buffer, fileName);

  const idx = {
    nombre: columna(headers, NOMBRE_PATTERNS),
    cedula: columna(headers, CEDULA_PATTERNS),
    sueldo: columna(headers, SUELDO_PATTERNS),
    cargo: columna(headers, CARGO_PATTERNS),
    nss: columna(headers, NSS_PATTERNS),
    ingreso: columna(headers, INGRESO_PATTERNS),
    tipoPago: columna(headers, TIPO_PAGO_PATTERNS),
  };
  // NSS solo cuenta si es una columna DISTINTA de la de cédula.
  if (idx.nss === idx.cedula) idx.nss = -1;

  if (idx.nombre < 0) throw new Error('No se encontró la columna del NOMBRE en el archivo.');
  if (idx.sueldo < 0) throw new Error('No se encontró la columna del SUELDO en el archivo.');

  const moneyCols = headers.map((h, i) => i === idx.sueldo);

  const rows: RosterRow[] = [];
  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 1;
    let values = rawRows[i];

    // Trampa conocida de estos archivos: CSV con coma de separador Y coma decimal
    // ("400,00" llega partido en dos campos). Se repara solo si cuadra exacto.
    if (values.length > headers.length) {
      const reparado = repararComaDecimal(values, headers, moneyCols);
      if (!reparado) {
        rows.push({
          row: rowNum, nombre: '', cedula: null, cargo: null, nss: null,
          sueldoArchivo: 0, sueldoBase: 0, tipoPago: 'QUINCENAL', tipoPagoFuente: 'DEFECTO',
          fechaIngreso: null,
          parseError: `La fila tiene ${values.length} campos y el archivo ${headers.length} columnas: revisa el separador decimal`,
        });
        continue;
      }
      values = reparado;
    }

    const nombre = (values[idx.nombre] ?? '').trim();
    const sueldoArchivo = parseMonto(values[idx.sueldo] ?? '');

    if (!nombre) {
      rows.push({
        row: rowNum, nombre: '', cedula: null, cargo: null, nss: null,
        sueldoArchivo, sueldoBase: 0, tipoPago: 'QUINCENAL', tipoPagoFuente: 'DEFECTO',
        fechaIngreso: null,
        parseError: 'La fila no tiene nombre',
      });
      continue;
    }
    if (sueldoArchivo <= 0) {
      rows.push({
        row: rowNum, nombre, cedula: null, cargo: null, nss: null,
        sueldoArchivo, sueldoBase: 0, tipoPago: 'QUINCENAL', tipoPagoFuente: 'DEFECTO',
        fechaIngreso: null,
        parseError: 'La fila no tiene sueldo',
      });
      continue;
    }

    // El tipo de pago de la FILA manda: un archivo con la columna puede traer gente
    // semanal y quincenal mezclada, que es justo el caso que obligó a agregarla.
    // Las tres reglas, en orden: la celda decide; la celda VACÍA es quincenal (el
    // defecto que pidió el dueño); y si el archivo no trae la columna, manda el
    // selector de la pantalla, que es como se cargaban los archivos de antes.
    const celdaTipo = idx.tipoPago >= 0 ? texto(values[idx.tipoPago]) : null;
    const tipoDeLaCelda = normalizarTipoPago(celdaTipo ?? undefined);
    if (celdaTipo && !tipoDeLaCelda) {
      rows.push({
        row: rowNum, nombre, cedula: null, cargo: null, nss: null,
        sueldoArchivo, sueldoBase: 0, tipoPago: 'QUINCENAL', tipoPagoFuente: 'DEFECTO',
        fechaIngreso: null,
        parseError: `Tipo de pago no reconocido: "${celdaTipo}". Usá Semanal, Quincenal o Mensual.`,
      });
      continue;
    }
    const tipoDeLaFila: TipoPago = tipoDeLaCelda ?? (idx.tipoPago >= 0 ? 'QUINCENAL' : tipoPagoDefecto);

    rows.push({
      row: rowNum,
      nombre,
      cedula: texto(values[idx.cedula]),
      cargo: idx.cargo >= 0 ? texto(values[idx.cargo]) : null,
      nss: idx.nss >= 0 ? texto(values[idx.nss]) : null,
      sueldoArchivo,
      // El sueldo del archivo ES el mensual: se guarda tal cual. El tipo de pago no
      // lo toca —solo dice cómo se parte ese mensual al pagarlo—, y por eso una fila
      // semanal de 1.000 y una mensual de 1.000 valen lo mismo al año.
      sueldoBase: r2(sueldoArchivo),
      tipoPago: tipoDeLaFila,
      tipoPagoFuente: tipoDeLaCelda ? 'ARCHIVO' : 'DEFECTO',
      fechaIngreso: idx.ingreso >= 0 ? parseFecha(values[idx.ingreso] ?? '') : null,
    });
  }

  return {
    headers,
    detectedColumns: {
      nombre: idx.nombre >= 0 ? headers[idx.nombre] : null,
      cedula: idx.cedula >= 0 ? headers[idx.cedula] : null,
      sueldo: headers[idx.sueldo],
      cargo: idx.cargo >= 0 ? headers[idx.cargo] : null,
      nss: idx.nss >= 0 ? headers[idx.nss] : null,
      tipoPago: idx.tipoPago >= 0 ? headers[idx.tipoPago] : null,
      fechaIngreso: idx.ingreso >= 0 ? headers[idx.ingreso] : null,
    },
    rows,
    totalRows: rawRows.length,
  };
}

function texto(valor: string | undefined): string | null {
  const t = (valor ?? '').trim();
  return t === '' || /^[-–—]+$/.test(t) ? null : t;
}
