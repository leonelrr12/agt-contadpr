import { leerTabla, parseMonto, parseFecha, repararComaDecimal } from './tabular-utils';
import { r2 } from '../lib/money';

/**
 * Alta masiva de empleados desde el archivo de planilla que el contador YA usa.
 *
 * Es el mismo archivo de siempre (el de la carga por archivo), pero acá solo se
 * leen NOMBRE, CÉDULA, SUELDO y —si están— CARGO, NSS y FECHA DE INGRESO. El
 * resto de las columnas se ignora: las deducciones las calcula el motor.
 *
 * La conversión que importa: en el archivo el SUELDO es el del período (casi
 * siempre quincenal), y `Employee.sueldoBase` es SIEMPRE mensual. Por eso el tipo
 * de pago es un parámetro obligatorio del alta y no una adivinanza.
 */

export type TipoPago = 'QUINCENAL' | 'MENSUAL';

export interface RosterRow {
  row: number;
  nombre: string;
  cedula: string | null;
  cargo: string | null;
  nss: string | null;
  /** El sueldo tal como viene en el archivo (el del período). */
  sueldoArchivo: number;
  /** Ya convertido a mensual según el tipo de pago elegido. Es lo que se guarda. */
  sueldoBase: number;
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
  tipoPago: TipoPago,
): Promise<RosterParseResult> {
  const { headers, rawRows } = await leerTabla(buffer, fileName);

  const idx = {
    nombre: columna(headers, NOMBRE_PATTERNS),
    cedula: columna(headers, CEDULA_PATTERNS),
    sueldo: columna(headers, SUELDO_PATTERNS),
    cargo: columna(headers, CARGO_PATTERNS),
    nss: columna(headers, NSS_PATTERNS),
    ingreso: columna(headers, INGRESO_PATTERNS),
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
          sueldoArchivo: 0, sueldoBase: 0, fechaIngreso: null,
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
        sueldoArchivo, sueldoBase: 0, fechaIngreso: null,
        parseError: 'La fila no tiene nombre',
      });
      continue;
    }
    if (sueldoArchivo <= 0) {
      rows.push({
        row: rowNum, nombre, cedula: null, cargo: null, nss: null,
        sueldoArchivo, sueldoBase: 0, fechaIngreso: null,
        parseError: 'La fila no tiene sueldo',
      });
      continue;
    }

    rows.push({
      row: rowNum,
      nombre,
      cedula: texto(values[idx.cedula]),
      cargo: idx.cargo >= 0 ? texto(values[idx.cargo]) : null,
      nss: idx.nss >= 0 ? texto(values[idx.nss]) : null,
      sueldoArchivo,
      // El sueldo del archivo es el del PERÍODO; el del sistema es mensual.
      sueldoBase: tipoPago === 'QUINCENAL' ? r2(sueldoArchivo * 2) : sueldoArchivo,
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
