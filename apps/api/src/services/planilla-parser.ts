import {
  leerTabla, parseFecha, parseMonto, repararComaDecimal,
} from './tabular-utils';

/**
 * Parser del archivo de PLANILLA (nómina) — independiente del import normal
 * (csv-parser.ts): esta carga no usa IA, solo mapea columnas a cuentas.
 * La lectura del archivo y el manejo de montos/fechas viven en tabular-utils.
 *
 * Formato esperado (tolerante a orden y nombres):
 *   QUINCENA | NOMBRE | CEDULA | SUELDO | HORAS EXTRAS | DECIMO | SS | SE | ISR | TOPAL A PAGAR
 * Ejemplo: 30/6/26 | ESPERANZA | (vacía) | 400,00 | - | (vacío) | 39,00 | 5,00 | - | 356,00
 *
 * Reglas: "-"/"—"/vacío = 0; coma decimal panameña ("400,00"); Décimo e ISR
 * pueden venir en cero; la cédula puede venir vacía; la fecha (QUINCENA) es
 * por fila (admite 30/6/26, 30/06/2026, YYYY-MM-DD o celda de fecha de Excel).
 */

export interface PlanillaRow {
  quincena: string | null;   // YYYY-MM-DD (local), null si la celda venía vacía
  employee: string | null;
  cedula: string | null;
  salario: number;
  horasExtras: number;
  decimo: number;
  ss: number;
  se: number;
  isr: number;
  neto: number;
  /** Error de estructura de la fila (p. ej. separador decimal ambiguo) */
  parseError?: string | null;
}

export interface PlanillaParseResult {
  headers: string[];
  rows: PlanillaRow[];
  totalRows: number;
  detectedColumns: Record<keyof PlanillaColumns, string | null>;
}

interface PlanillaColumns {
  quincena: string | null;
  employee: string | null;
  cedula: string | null;
  salario: string | null;
  horasExtras: string | null;
  decimo: string | null;
  ss: string | null;
  se: string | null;
  isr: string | null;
  neto: string | null;
}

const QUINCENA_PATTERNS = [/quincena/i, /fecha/i, /periodo/i, /^d[ií]a/i];
const EMPLOYEE_PATTERNS = [/nombre/i, /empleado/i, /colaborador/i, /^nombres?/i];
const CEDULA_PATTERNS = [/c[eé]dula/i, /identificaci[óo]n/i, /^ci\b/i, /documento/i, /^c\.?i\.?p/i];
const SUELDO_PATTERNS = [/sueldo/i, /salario/i];
const EXTRAS_PATTERNS = [/horas?\s*extras?/i, /^extras?/i];
const DECIMO_PATTERNS = [/d[eé]cimo/i];
const SS_PATTERNS = [/^ss\b/i, /seguro\s*social/i, /^c\.?s\.?s\b/i];
const SE_PATTERNS = [/^se\b/i, /seguro\s*educativo/i];
const ISR_PATTERNS = [/^isr\b/i, /impuesto\s*sobre\s*la\s*renta/i, /^renta\b/i];
const NETO_PATTERNS = [/topal/i, /total\s*a\s*pagar/i, /neto/i, /a\s*pagar/i];

function matchHeader(header: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(header));
}

/** ¿El encabezado corresponde a una columna monetaria? (reparo de coma decimal) */
function isMoneyHeader(h: string): boolean {
  return matchHeader(h, SUELDO_PATTERNS) || matchHeader(h, EXTRAS_PATTERNS) || matchHeader(h, DECIMO_PATTERNS)
    || matchHeader(h, SS_PATTERNS) || matchHeader(h, SE_PATTERNS) || matchHeader(h, ISR_PATTERNS)
    || matchHeader(h, NETO_PATTERNS);
}

/**
 * Parsea un archivo CSV/XLSX de planilla. Devuelve las filas normalizadas
 * (montos en números, "-" → 0) y las columnas detectadas.
 */
export async function parsePlanillaFile(
  buffer: Buffer,
  fileName: string,
): Promise<PlanillaParseResult> {
  const { headers, rawRows } = await leerTabla(buffer, fileName);

  // Detección de columnas: cada encabezado va a la primera columna cuyo patrón
  // matchee y que aún esté libre (el orden de los patrones evita colisiones:
  // SS antes que SE, TOPAL/TOTAL antes que NETO).
  const cols: PlanillaColumns = {
    quincena: null, employee: null, cedula: null, salario: null, horasExtras: null,
    decimo: null, ss: null, se: null, isr: null, neto: null,
  };

  for (const h of headers) {
    if (!h) continue;
    if (!cols.quincena && matchHeader(h, QUINCENA_PATTERNS)) { cols.quincena = h; continue; }
    if (!cols.employee && matchHeader(h, EMPLOYEE_PATTERNS)) { cols.employee = h; continue; }
    if (!cols.cedula && matchHeader(h, CEDULA_PATTERNS)) { cols.cedula = h; continue; }
    if (!cols.salario && matchHeader(h, SUELDO_PATTERNS)) { cols.salario = h; continue; }
    if (!cols.horasExtras && matchHeader(h, EXTRAS_PATTERNS)) { cols.horasExtras = h; continue; }
    if (!cols.decimo && matchHeader(h, DECIMO_PATTERNS)) { cols.decimo = h; continue; }
    if (!cols.ss && matchHeader(h, SS_PATTERNS)) { cols.ss = h; continue; }
    if (!cols.se && matchHeader(h, SE_PATTERNS)) { cols.se = h; continue; }
    if (!cols.isr && matchHeader(h, ISR_PATTERNS)) { cols.isr = h; continue; }
    if (!cols.neto && matchHeader(h, NETO_PATTERNS)) { cols.neto = h; continue; }
  }

  if (!cols.employee) {
    throw new Error('No se detectó la columna del NOMBRE del empleado. Use "NOMBRE" o "EMPLEADO" como encabezado.');
  }
  if (!cols.salario && !cols.decimo) {
    throw new Error('No se detectó la columna de SUELDO (o DÉCIMO). Use "SUELDO"/"SALARIO" como encabezado.');
  }
  if (!cols.neto) {
    throw new Error('No se detectó la columna del NETO a pagar. Use "TOPAL A PAGAR", "TOTAL A PAGAR" o "NETO" como encabezado.');
  }

  const moneyCols = headers.map(isMoneyHeader);

  const vacia = (parseError: string | null = null): PlanillaRow => ({
    quincena: null, employee: null, cedula: null,
    salario: 0, horasExtras: 0, decimo: 0, ss: 0, se: 0, isr: 0, neto: 0,
    parseError,
  });

  const rows: PlanillaRow[] = rawRows.map(rawRow => {
    // Filas con más campos que encabezados: casi siempre coma decimal partida
    // por un CSV con coma como separador. Intentar el reparo; si no cuadra,
    // la fila queda marcada con error (no se corren las columnas).
    if (rawRow.length !== headers.length) {
      const fixed = repararComaDecimal(rawRow, headers, moneyCols);
      if (!fixed) {
        return vacia(`Fila con ${rawRow.length} campos (se esperaban ${headers.length}): revisa los separadores decimales del archivo`);
      }
      rawRow = fixed;
    }

    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = rawRow[i] || ''; });
    const get = (col: string | null) => (col ? (raw[col] || '') : '');
    return {
      quincena: parseFecha(get(cols.quincena)),
      employee: get(cols.employee).trim() || null,
      cedula: get(cols.cedula).trim() || null,
      salario: parseMonto(get(cols.salario)),
      horasExtras: parseMonto(get(cols.horasExtras)),
      decimo: parseMonto(get(cols.decimo)),
      ss: parseMonto(get(cols.ss)),
      se: parseMonto(get(cols.se)),
      isr: parseMonto(get(cols.isr)),
      neto: parseMonto(get(cols.neto)),
      parseError: null,
    };
  });

  // Filas en blanco (sin nombre ni montos) se descartan; las filas con error
  // de estructura se conservan para reportarlas en el preview.
  const filtered = rows.filter(r =>
    r.parseError || r.employee || r.salario || r.horasExtras || r.decimo || r.ss || r.se || r.isr || r.neto,
  );

  return { headers, rows: filtered, totalRows: filtered.length, detectedColumns: cols };
}
