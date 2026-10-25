import ExcelJS from 'exceljs';

/**
 * Utilidades compartidas para leer archivos tabulares (CSV/XLSX) de las cargas
 * que NO usan IA (Planilla): lectura tolerante, montos con coma
 * decimal panameña ("400,00") y fechas de Excel sin perder días.
 */

/** Fecha "YYYY-MM-DD" del calendario LOCAL (sin desfase UTC). */
export function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fórmula de Excel SIN resultado cacheado. Excel guarda el valor calculado
 * junto a la fórmula (`{ formula, result }`), pero un archivo generado por un
 * export/macro —o guardado con cálculo manual— trae solo `{ formula }`: el
 * valor NO está en el archivo y ExcelJS no calcula fórmulas. Se evalúan los
 * casos que no dependen de otras celdas: literales de texto/número,
 * concatenación con `&` y CONCAT/CONCATENATE de esos literales. null = la
 * fórmula usa celdas o funciones que no podemos resolver.
 */
function formulaLiteral(formula: string): string | null {
  const s = formula.trim().replace(/^=/, '');
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const expr = (): string | null => {
    const parts: string[] = [];
    let v = term();
    if (v === null) return null;
    parts.push(v);
    ws();
    while (s[i] === '&') {
      i++;
      v = term();
      if (v === null) return null;
      parts.push(v);
      ws();
    }
    return parts.join('');
  };
  const term = (): string | null => {
    ws();
    const ch = s[i];
    if (ch === '"') {
      i++;
      let out = '';
      while (i < s.length) {
        if (s[i] === '"') {
          if (s[i + 1] === '"') { out += '"'; i += 2; continue; } // "" = comilla
          i++;
          return out;
        }
        out += s[i++];
      }
      return null; // comilla sin cerrar
    }
    if (ch === '(') {
      i++;
      const v = expr();
      ws();
      if (s[i] !== ')') return null;
      i++;
      return v;
    }
    const fn = /^(CONCATENATE|CONCAT)\s*\(/i.exec(s.slice(i));
    if (fn) {
      i += fn[0].length;
      const parts: string[] = [];
      let v = expr();
      if (v === null) return null;
      parts.push(v);
      ws();
      while (s[i] === ',') {
        i++;
        v = expr();
        if (v === null) return null;
        parts.push(v);
        ws();
      }
      if (s[i] !== ')') return null;
      i++;
      return parts.join('');
    }
    const num = /^-?\d+(?:\.\d+)?/.exec(s.slice(i));
    if (num) { i += num[0].length; return num[0]; }
    return null;
  };
  const v = expr();
  ws();
  return v !== null && i === s.length ? v.trim() : null;
}

/** Índice 1-based de una letra de columna de Excel ("A"→1, "AB"→28). */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

const REF_CELDA = /^\$?([A-Za-z]{1,3})\$?(\d+)$/;

/**
 * BUSCARV/VLOOKUP con coincidencia EXACTA dentro de la MISMA hoja:
 * `BUSCARV(H2; $J$2:$K$6; 2; FALSO)` → mira H2 en la 1ª columna del rango y
 * devuelve la 2ª del match. Es el caso de los archivos que traen el código de
 * cuenta por fórmula y NO traen el valor calculado. null = no aplica (otra
 * función, otro sheet, coincidencia aproximada o sin match).
 */
function buscarV(formula: string, cell: any, depth: number): string | null {
  const m = /^(?:BUSCARV|VLOOKUP)\s*\(\s*(\$?[A-Za-z]{1,3}\$?\d+)\s*[;,]\s*(\$?[A-Za-z]{1,3}\$?\d+)\s*:\s*(\$?[A-Za-z]{1,3}\$?\d+)\s*[;,]\s*(\d+)\s*[;,]\s*(?:FALSO|FALSE|0)\s*\)\s*$/i
    .exec(formula.trim().replace(/^=/, ''));
  if (!m) return null;
  const sheet = cell && cell.worksheet;
  const ini = REF_CELDA.exec(m[2].replace(/\$/g, ''));
  const fin = REF_CELDA.exec(m[3].replace(/\$/g, ''));
  const col = parseInt(m[4], 10);
  if (!sheet || !ini || !fin || !(col >= 1)) return null;

  const claveCell = sheet.getCell(m[1].replace(/\$/g, ''));
  if (cell.address && claveCell.address === cell.address) return null; // auto-referencia
  const clave = valorTexto(claveCell.value, claveCell, depth + 1).trim().toLowerCase();
  if (!clave) return null;

  const filaA = parseInt(ini[2], 10);
  const filaB = parseInt(fin[2], 10);
  const colIni = Math.min(colIndex(ini[1]), colIndex(fin[1]));
  for (let r = Math.min(filaA, filaB); r <= Math.max(filaA, filaB); r++) {
    const celdaClave = sheet.getRow(r).getCell(colIni);
    const valorClave = valorTexto(celdaClave.value, celdaClave, depth + 1).trim().toLowerCase();
    if (valorClave !== clave) continue;
    const resultado = sheet.getRow(r).getCell(colIni + col - 1);
    return valorTexto(resultado.value, resultado, depth + 1);
  }
  return null; // sin match: Excel daría #N/A; se muestra la fórmula
}

/** Fórmula que es solo una celda (`=A2`): se lee esa celda. */
function referenciaSimple(formula: string, cell: any, depth: number): string | null {
  const m = REF_CELDA.exec(formula.trim().replace(/^=/, ''));
  const sheet = cell && cell.worksheet;
  if (!m || !sheet) return null;
  const ref = sheet.getCell(formula.trim().replace(/^=/, '').replace(/\$/g, ''));
  if (cell.address && ref.address === cell.address) return null;
  return valorTexto(ref.value, ref, depth + 1);
}

/**
 * Valor de celda como texto; las fechas nativas de Excel se normalizan a
 * YYYY-MM-DD usando sus componentes UTC: ExcelJS entrega el día-calendario de
 * la celda como Date en UTC (30/6/2026 → 2026-06-30T00:00:00Z), y leerlo con
 * componentes locales restaría un día cuando el server no está en UTC.
 *
 * Las celdas que ExcelJS entrega como OBJETO (fórmula, hipervínculo, texto
 * enriquecido) se leen de su parte visible: `String(object)` daba el literal
 * "[object Object]", que no es ni fecha ni cuenta ni monto — en la columna
 * Banco/Cuenta del import resolvía al banco por defecto en silencio.
 *
 * `cell` (la celda de ExcelJS) habilita resolver fórmulas sin valor cacheado
 * que apuntan a la propia hoja: BUSCARV y referencias simples. Sin `cell`,
 * solo se leen su resultado o sus literales.
 */
export function cellToText(value: any, cell?: any): string {
  return valorTexto(value, cell, 0);
}

function valorTexto(value: any, cell: any, depth: number): string {
  if (depth > 8) return ''; // fórmulas en cadena/ciclo: no colgarse
  if (value instanceof Date) {
    // Fecha inválida: ExcelJS la produce cuando la celda tiene formato de
    // fecha pero el valor no lo es (p. ej. el resultado "2.1.03.02" de una
    // fórmula en una columna con formato yyyy-m). No es texto: se descarta
    // para que la fórmula se evalúe en su lugar.
    if (isNaN(value.getTime())) return '';
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (value && typeof value === 'object') {
    // Fórmula: manda el resultado ya calculado por Excel.
    if ('result' in value) {
      const r = valorTexto(value.result, cell, depth + 1);
      if (r) return r;
    }
    // Sin valor cacheado: la fórmula propia o, si la celda es parte de una
    // fórmula COMPARTIDA (Excel la guarda una vez y las demás la referencian),
    // la que ExcelJS traduce para esta celda con `cell.formula`.
    const formula = typeof value.formula === 'string'
      ? value.formula
      : (value.sharedFormula && cell && typeof cell.formula === 'string' ? cell.formula : null);
    if (formula) {
      // Resolver lo que apunte a la misma hoja y, si no, evaluar literales.
      // Último recurso: la fórmula (visible y honesta) para que el preview
      // diga POR QUÉ no resolvió, nunca "[object Object]".
      if (cell) {
        const resuelto = buscarV(formula, cell, depth) ?? referenciaSimple(formula, cell, depth);
        if (resuelto !== null) return resuelto;
      }
      const lit = formulaLiteral(formula);
      return lit !== null ? lit : `=${formula.trim()}`;
    }
    // Texto enriquecido: concatenar los tramos.
    if (Array.isArray(value.richText)) {
      return value.richText.map((t: any) => t?.text ?? '').join('').trim();
    }
    // Celda con hipervínculo: el texto visible, no la URL.
    if ('text' in value) return String(value.text ?? '').trim();
    // Error de Excel (#N/A, #REF!…): mostrarlo tal cual, es lo honesto.
    if ('error' in value) return String(value.error).trim();
    return '';
  }
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
        values.push(cellToText(cell.value, cell));
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
