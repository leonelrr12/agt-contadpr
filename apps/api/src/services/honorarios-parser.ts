import { leerTabla, parseFecha, parseMonto, repararComaDecimal } from './tabular-utils';

/**
 * Parser del archivo de HONORARIOS PROFESIONALES — carga sin IA (solo crea
 * asiento y guarda metadata para el informe por RUC/Cédula). La lectura del
 * archivo y el manejo de montos/fechas viven en tabular-utils.
 *
 * Formato esperado (tolerante a orden y nombres):
 *   FECHA | RUC/CÉDULA | NOMBRE | DESCRIPCIÓN/CONCEPTO | MONTO
 * El MONTO es el bruto que sale del banco (el asiento es siempre
 * Honorarios Profesionales al DEBE vs Banco al HABER).
 */

export interface HonorariosRow {
  fecha: string | null;      // YYYY-MM-DD (local); null si la celda venía vacía
  taxId: string | null;      // RUC o cédula del profesional (clave del informe)
  nombre: string | null;
  concepto: string | null;
  monto: number;
  /** Columna "Banco" opcional: banco del que sale el pago (si no, el default) */
  bankName?: string | null;
  /** Error de estructura de la fila (p. ej. separador decimal ambiguo) */
  parseError?: string | null;
}

export interface HonorariosParseResult {
  headers: string[];
  rows: HonorariosRow[];
  totalRows: number;
  detectedColumns: Record<keyof HonorariosColumns, string | null>;
  /** Filas que necesitaron reparo de coma decimal (CSV con coma decimal) */
  repairCount: number;
}

interface HonorariosColumns {
  fecha: string | null;
  taxId: string | null;
  nombre: string | null;
  concepto: string | null;
  monto: string | null;
  banco: string | null;
}

const FECHA_PATTERNS = [/fecha/i, /^d[ií]a/i, /^periodo/i];
const TAXID_PATTERNS = [/^ruc/i, /c[eé]dula/i, /identificaci[óo]n/i, /^ci\b/i, /^c\.?i\.?p/i, /documento/i];
const NOMBRE_PATTERNS = [/nombre/i, /beneficiario/i, /profesional/i, /prestador/i, /^a\s*nombre/i];
const CONCEPTO_PATTERNS = [/descripc/i, /concepto/i, /detalle/i, /servicio/i, /glosa/i];
const MONTO_PATTERNS = [/monto/i, /importe/i, /total/i, /honorario/i, /valor/i, /^pago/i];
// Columna opcional "Banco" (o "Cuenta"): si el pago sale de un banco concreto
const BANCO_PATTERNS = [/^banco/i, /^cuenta/i, /banco/i];

function matchHeader(header: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(header));
}

/**
 * Parsea un archivo CSV/XLSX de honorarios. Devuelve las filas normalizadas
 * (fechas YYYY-MM-DD, montos en números) y las columnas detectadas.
 */
export async function parseHonorariosFile(
  buffer: Buffer,
  fileName: string,
): Promise<HonorariosParseResult> {
  const { headers, rawRows } = await leerTabla(buffer, fileName);

  const cols: HonorariosColumns = {
    fecha: null, taxId: null, nombre: null, concepto: null, monto: null, banco: null,
  };

  for (const h of headers) {
    if (!h) continue;
    if (!cols.fecha && matchHeader(h, FECHA_PATTERNS)) { cols.fecha = h; continue; }
    if (!cols.taxId && matchHeader(h, TAXID_PATTERNS)) { cols.taxId = h; continue; }
    if (!cols.nombre && matchHeader(h, NOMBRE_PATTERNS)) { cols.nombre = h; continue; }
    if (!cols.monto && matchHeader(h, MONTO_PATTERNS)) { cols.monto = h; continue; }
    if (!cols.concepto && matchHeader(h, CONCEPTO_PATTERNS)) { cols.concepto = h; continue; }
    if (!cols.banco && matchHeader(h, BANCO_PATTERNS)) { cols.banco = h; continue; }
  }

  if (!cols.nombre) {
    throw new Error('No se detectó la columna del NOMBRE del profesional. Use "NOMBRE" o "BENEFICIARIO" como encabezado.');
  }
  if (!cols.taxId) {
    throw new Error('No se detectó la columna de RUC/CÉDULA. Use "RUC" o "CÉDULA" como encabezado (es la clave del informe por profesional).');
  }
  if (!cols.monto) {
    throw new Error('No se detectó la columna del MONTO pagado. Use "MONTO" o "IMPORTE" como encabezado.');
  }

  const moneyCols = headers.map(h => matchHeader(h, MONTO_PATTERNS));

  let repairCount = 0;
  const rows: HonorariosRow[] = rawRows.map(rawRow => {
    if (rawRow.length > headers.length) {
      const fixed = repararComaDecimal(rawRow, headers, moneyCols);
      if (!fixed) {
        return {
          fecha: null, taxId: null, nombre: null, concepto: null, monto: 0, bankName: null,
          parseError: `Fila con ${rawRow.length} campos (se esperaban ${headers.length}): revisa los separadores decimales del archivo`,
        };
      }
      rawRow = fixed;
      repairCount++;
    } else if (rawRow.length < headers.length) {
      // Menos campos que encabezados: celdas vacías al final que Excel no
      // guarda (p. ej. la columna "Banco" opcional en blanco) → completar.
      rawRow = [...rawRow, ...Array(headers.length - rawRow.length).fill('')];
    }

    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = rawRow[i] || ''; });
    const get = (col: string | null) => (col ? (raw[col] || '') : '');
    return {
      fecha: parseFecha(get(cols.fecha)),
      taxId: get(cols.taxId).trim() || null,
      nombre: get(cols.nombre).trim() || null,
      concepto: get(cols.concepto).trim() || null,
      monto: parseMonto(get(cols.monto)),
      bankName: get(cols.banco).trim() || null,
      parseError: null,
    };
  });

  // Filas en blanco se descartan; las filas con error de estructura se
  // conservan para reportarlas en el preview.
  const filtered = rows.filter(r => r.parseError || r.nombre || r.taxId || r.monto);

  return { headers, rows: filtered, totalRows: filtered.length, detectedColumns: cols, repairCount };
}
