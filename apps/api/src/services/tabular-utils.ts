import ExcelJS from 'exceljs';

/**
 * Utilidades compartidas para leer archivos tabulares (CSV/XLSX) de las cargas
 * que NO usan IA (Planilla, Honorarios): lectura tolerante, montos con coma
 * decimal panameña ("400,00") y fechas de Excel sin perder días.
 */

/** Fecha "YYYY-MM-DD" del calendario LOCAL (sin desfase UTC). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Valor de celda como texto; las fechas nativas de Excel se normalizan a
 * YYYY-MM-DD usando sus componentes UTC: ExcelJS entrega el día-calendario de
 * la celda como Date en UTC (30/6/2026 → 2026-06-30T00:00:00Z), y leerlo con
 * componentes locales restaría un día cuando el server no está en UTC.
 */
export function cellToText(value: any): string {
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (value && typeof value === 'object' && 'result' in value) return cellToText(value.result);
  return String(value ?? '').trim();
}

export function detectDelimiter(firstLine: string): string {
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (tabs > semicolons && tabs > commas) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

/** Parsea una línea CSV respetando comillas. */
export function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (inQuotes) {
      if (ch === '"') inQuotes = false;
      else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/** Lee un CSV/XLSX y devuelve encabezados + filas crudas (celdas como texto). */
export async function leerTabla(
  buffer: Buffer,
  fileName: string,
): Promise<{ headers: string[]; rawRows: string[][] }> {
  const isXlsx = fileName.toLowerCase().endsWith('.xlsx');
  let headers: string[] = [];
  const rawRows: string[][] = [];

  if (isXlsx) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error('El archivo Excel no tiene hojas.');
    sheet.eachRow((row, rowNum) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        values.push(cellToText(cell.value));
      });
      while (values.length > 0 && values[values.length - 1] === '') values.pop();
      if (values.length === 0) return;
      if (rowNum === 1) headers = values;
      else rawRows.push(values);
    });
  } else {
    const text = buffer.toString('utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) throw new Error('El archivo CSV está vacío.');
    const delimiter = detectDelimiter(lines[0]);
    for (let i = 0; i < lines.length; i++) {
      const values = parseCSVLine(lines[i], delimiter);
      if (i === 0) headers = values.map(h => h.trim());
      else rawRows.push(values.map(v => v.trim()));
    }
  }

  if (headers.length === 0) throw new Error('No se detectaron encabezados en el archivo.');
  return { headers, rawRows };
}

/** "-", "—", "" y similares significan cero en estos archivos. */
export function isEmptyMark(raw: string): boolean {
  const t = (raw || '').trim();
  return t === '' || /^[-–—]+$/.test(t) || /^n\/?a$/i.test(t);
}

/** Monto: vacío/"-" → 0; soporta coma decimal ("400,00") y símbolos. */
export function parseMonto(raw: string): number {
  if (isEmptyMark(raw)) return 0;
  let cleaned = raw.replace(/USD|\bB\/\.\s*|B\/|[\$€£]/gi, '').replace(/\s/g, '');
  if (cleaned.includes(',') && cleaned.match(/,\d{1,2}$/)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

/**
 * Fecha: soporta 30/6/26 y 30/6/2026 (día/mes, formato Panamá), 30-6-26,
 * YYYY-MM-DD, ISO con hora ("2026-06-30T00:00:00Z" → el día tal cual) y
 * fechas nativas de Excel (ya normalizadas por cellToText).
 */
export function parseFecha(raw: string): string | null {
  const t = (raw || '').trim();
  if (!t) return null;

  // Fecha ISO con hora: quedarse con el día tal cual
  const isoConHora = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ]/);
  if (isoConHora) {
    return `${isoConHora[1]}-${isoConHora[2].padStart(2, '0')}-${isoConHora[3].padStart(2, '0')}`;
  }

  const iso = t.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (iso) {
    const d = new Date(parseInt(iso[1]), parseInt(iso[2]) - 1, parseInt(iso[3]));
    return isNaN(d.getTime()) ? null : localDateKey(d);
  }

  // DD/MM/AA o DD/MM/AAAA (Panamá: día primero)
  const dmy = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    const p1 = parseInt(dmy[1]);
    const p2 = parseInt(dmy[2]);
    let y = parseInt(dmy[3]);
    if (y < 100) y += 2000;
    const d = new Date(y, p2 - 1, p1);
    if (!isNaN(d.getTime()) && d.getMonth() === p2 - 1) return localDateKey(d);
    return null;
  }

  const native = new Date(t);
  return isNaN(native.getTime()) ? null : localDateKey(native);
}

/**
 * CSV exportado con coma decimal Y coma como separador de campos
 * ("30/6/26,ESPERANZA,,400,00,…"): cada monto llega partido en dos campos
 * ("400" + "00"). El reparo fusiona entero+decimales en las columnas
 * monetarias SOLO si el resultado cuadra EXACTAMENTE con los encabezados;
 * si no cuadra devuelve null y la fila se reporta como inválida — nunca se
 * asignan columnas corridas en silencio.
 * `moneyCols[i]` indica si el encabezado i es monetario.
 */
export function repararComaDecimal(values: string[], headers: string[], moneyCols: boolean[]): string[] | null {
  if (values.length <= headers.length) return null;
  const result: string[] = [];
  let i = 0;
  for (let c = 0; c < headers.length; c++) {
    if (i >= values.length) return null;
    const tok = values[i];
    const next = values[i + 1];
    if (moneyCols[c] && next !== undefined && /^\d+(?:\.\d{3})*$/.test(tok) && /^\d{1,2}$/.test(next)) {
      result.push(`${tok}.${next}`);
      i += 2;
    } else {
      result.push(tok);
      i += 1;
    }
  }
  return i === values.length ? result : null;
}
