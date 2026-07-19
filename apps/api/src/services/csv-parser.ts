import ExcelJS from 'exceljs';

export interface ParsedRow {
  date: string | null;
  description: string | null;
  amount: number | null;
  concept: string | null;
  paymentMethod: string | null;
  type: string | null;
  provider: string | null;
  // Bancario
  reference: string | null;
  ruc: string | null;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  // Raw data por si el usuario necesita ajustar
  _raw: Record<string, string>;
}

export interface ColumnMapping {
  dateCol: string | null;
  descriptionCol: string | null;
  amountCol: string | null;
  conceptCol: string | null;
  paymentMethodCol: string | null;
  typeCol: string | null;
  providerCol: string | null;
  // Bancario
  debitCol: string | null;
  creditCol: string | null;
  balanceCol: string | null;
  referenceCol: string | null;
  rucCol: string | null;
}

export interface ParseResult {
  headers: string[];
  rows: ParsedRow[];
  detectedMapping: ColumnMapping;
  totalRows: number;
}

const DATE_PATTERNS = [/fecha/i, /date/i, /día/i, /dia/i];
const DESCRIPTION_PATTERNS = [/descripc/i, /desc/i, /concepto/i, /detalle/i, /glosa/i, /memorando/i, /note/i];
const AMOUNT_PATTERNS = [/monto/i, /total/i, /importe/i, /amount/i, /valor/i, /suma/i];
const CONCEPT_PATTERNS = [/concepto/i, /categoria/i, /category/i, /rubro/i];
const PAYMENT_PATTERNS = [/pago/i, /payment/i, /metodo/i, /método/i, /forma/i];
const TYPE_PATTERNS = [/tipo/i, /type/i, /clase/i];
const PROVIDER_PATTERNS = [/proveedor/i, /cliente/i, /entidad/i, /provider/i, /tercero/i, /nombre/i];
const DEBIT_PATTERNS = [/d[eé]bito/i, /debit/i, /cargo/i, /salida/i, /retiro/i, /egreso/i];
const CREDIT_PATTERNS = [/cr[eé]dito/i, /credit/i, /abono/i, /entrada/i, /dep[oó]sito/i, /ingreso/i];
const BALANCE_PATTERNS = [/saldo/i, /balance/i];
const REFERENCE_PATTERNS = [/referencia/i, /ref/i, /n[úu]mero/i, /cheque/i, /nro/i, /#[ ]*ref/i, /factura/i];
const RUC_PATTERNS = [/ruc/i, /tax[_\s]?id/i, /c[ée]dula/i, /identificaci[óo]n/i];

function matchHeader(header: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(header));
}

function detectDelimiter(firstLine: string): string {
  const semicolons = (firstLine.match(/;/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const tabs = (firstLine.match(/\t/g) || []).length;
  if (tabs > semicolons && tabs > commas) return '\t';
  if (semicolons > commas) return ';';
  return ',';
}

function parseDate(raw: string): string | null {
  if (!raw) return null;
  // Formatos: DD/MM/YYYY (Panamá), MM/DD/YYYY, YYYY-MM-DD, DD-MM-YYYY
  // Prioridad: DD/MM/YYYY (formato Panamá). Si mes > 12, intentar MM/DD/YYYY.
  const ddmmyyyy = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (ddmmyyyy) {
    const p1 = parseInt(ddmmyyyy[1]); // posible día o mes
    const p2 = parseInt(ddmmyyyy[2]); // posible mes o día
    const y = parseInt(ddmmyyyy[3]);
    if (p2 <= 12) {
      // DD/MM/YYYY (Panamá): p1=dd, p2=mm
      const d = new Date(y, p2 - 1, p1);
      if (!isNaN(d.getTime()) && d.getMonth() === p2 - 1) return d.toISOString().split('T')[0];
    }
    if (p1 <= 12) {
      // MM/DD/YYYY (US): p1=mm, p2=dd
      const d = new Date(y, p1 - 1, p2);
      if (!isNaN(d.getTime()) && d.getMonth() === p1 - 1) return d.toISOString().split('T')[0];
    }
    // Ambos fallaron — retornar null (no inventar fecha)
    return null;
  }
  const yyyymmdd = raw.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (yyyymmdd) {
    const d = new Date(parseInt(yyyymmdd[1]), parseInt(yyyymmdd[2]) - 1, parseInt(yyyymmdd[3]));
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  }
  // Intentar parse nativo
  const d = new Date(raw);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return null;
}

function parseAmount(raw: string): number | null {
  if (!raw) return null;
  // Eliminar símbolos de moneda y separadores de miles, preservando decimales
  let cleaned = raw
    .replace(/USD|\bB\/\.\s*|B\/|[\$€£]/gi, '')  // Símbolos: USD, B/., $, €, £
    .replace(/\s/g, '');                            // Espacios

  // Detectar formato europeo: coma como decimal (ej: "1.234,56" → 1234.56)
  if (cleaned.includes(',') && cleaned.match(/,\d{2}$/)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    // Formato estándar: eliminar comas de miles, punto decimal se preserva
    cleaned = cleaned.replace(/,/g, '');
  }

  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function detectType(row: ParsedRow): string {
  const desc = (row.description || row.concept || '').toLowerCase();
  const rawDesc = Object.values(row._raw).join(' ').toLowerCase();

  if (/venta|factur[éa]|ingreso|servicio|cobr[éoa]|client/i.test(rawDesc)) return 'VENTA';
  if (/compra|gasto|pag[uéoa]|combustible|alquiler|servicio|honorario/i.test(rawDesc)) return 'GASTO';
  if (/inventario|mercanc[ií]a|mercader[ií]a/i.test(rawDesc)) return 'COMPRA';
  if (/pr[eé]stamo|financiamiento/i.test(rawDesc)) return 'PRESTAMO';
  if (/pago\s+proveedor|abon[ée]\s+a/i.test(rawDesc)) return 'PAGO_PROVEEDOR';
  if (/cobro\s+cliente|abono\s+cliente/i.test(rawDesc)) return 'COBRO_CLIENTE';

  return 'GASTO'; // default
}

function detectPaymentMethod(row: ParsedRow): string | null {
  const desc = Object.values(row._raw).join(' ').toLowerCase();
  if (/tarjeta\s*(de\s*)?cr[eé]dito|tc\b/i.test(desc)) return 'TARJETA_CREDITO';
  if (/tarjeta\s*(de\s*)?d[eé]bito|td\b/i.test(desc)) return 'TARJETA_DEBITO';
  if (/efectivo|cash|contado/i.test(desc)) return 'EFECTIVO';
  if (/transferencia|ach|wire/i.test(desc)) return 'TRANSFERENCIA';
  if (/cheque|chq/i.test(desc)) return 'CHEQUE';
  if (/cr[eé]dito\b(?!.*tarjeta)/i.test(desc)) return 'CREDITO';
  return null;
}

/**
 * Parsea un archivo CSV o XLSX y devuelve headers, filas parseadas, y mapeo detectado.
 */
export async function parseImportFile(
  buffer: Buffer,
  fileName: string,
): Promise<ParseResult> {
  const isXlsx = fileName.endsWith('.xlsx');

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
        values.push(String(cell.value ?? '').trim());
      });
      // Recortar celdas vacías al final
      while (values.length > 0 && values[values.length - 1] === '') values.pop();
      if (values.length === 0) return;
      if (rowNum === 1) {
        headers = values;
      } else {
        rawRows.push(values);
      }
    });
  } else {
    // CSV
    const text = buffer.toString('utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) throw new Error('El archivo CSV está vacío.');

    const delimiter = detectDelimiter(lines[0]);

    for (let i = 0; i < lines.length; i++) {
      const values = parseCSVLine(lines[i], delimiter);
      if (i === 0) {
        headers = values.map(h => h.trim());
      } else {
        rawRows.push(values.map(v => v.trim()));
      }
    }
  }

  if (headers.length === 0) throw new Error('No se detectaron encabezados en el archivo.');

  // Resto de la función sin cambios
  // Detectar mapeo de columnas
  const mapping: ColumnMapping = {
    dateCol: null,
    descriptionCol: null,
    amountCol: null,
    conceptCol: null,
    paymentMethodCol: null,
    typeCol: null,
    providerCol: null,
    debitCol: null,
    creditCol: null,
    balanceCol: null,
    referenceCol: null,
    rucCol: null,
  };

  for (const h of headers) {
    if (!mapping.dateCol && matchHeader(h, DATE_PATTERNS)) mapping.dateCol = h;
    if (!mapping.descriptionCol && matchHeader(h, DESCRIPTION_PATTERNS)) mapping.descriptionCol = h;
    if (!mapping.amountCol && matchHeader(h, AMOUNT_PATTERNS)) mapping.amountCol = h;
    if (!mapping.conceptCol && matchHeader(h, CONCEPT_PATTERNS) && h !== mapping.descriptionCol) mapping.conceptCol = h;
    if (!mapping.paymentMethodCol && matchHeader(h, PAYMENT_PATTERNS)) mapping.paymentMethodCol = h;
    if (!mapping.typeCol && matchHeader(h, TYPE_PATTERNS)) mapping.typeCol = h;
    if (!mapping.providerCol && matchHeader(h, PROVIDER_PATTERNS)) mapping.providerCol = h;
    if (!mapping.debitCol && matchHeader(h, DEBIT_PATTERNS)) mapping.debitCol = h;
    if (!mapping.creditCol && matchHeader(h, CREDIT_PATTERNS)) mapping.creditCol = h;
    if (!mapping.balanceCol && matchHeader(h, BALANCE_PATTERNS)) mapping.balanceCol = h;
    if (!mapping.referenceCol && matchHeader(h, REFERENCE_PATTERNS)) mapping.referenceCol = h;
    if (!mapping.rucCol && matchHeader(h, RUC_PATTERNS)) mapping.rucCol = h;
  }

  // Si no se detectó amount, intentar debit/credit como fallback
  if (!mapping.amountCol && mapping.debitCol && mapping.creditCol) {
    // Es un extracto bancario: usar debit/credit
  }

  // Parsear filas
  const rows: ParsedRow[] = rawRows.map(rawRow => {
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = rawRow[i] || ''; });

    const getVal = (col: string | null) => col ? (raw[col] || '') : '';

    const dateStr = getVal(mapping.dateCol);
    const amountStr = getVal(mapping.amountCol);
    const debitStr = getVal(mapping.debitCol);
    const creditStr = getVal(mapping.creditCol);

    let amount: number | null = parseAmount(amountStr);
    let debit: number | null = parseAmount(debitStr);
    let credit: number | null = parseAmount(creditStr);

    // Si no hay columna amount pero sí debit/credit, derivar amount
    if (amount === null && (debit !== null || credit !== null)) {
      if (debit && debit > 0) amount = debit;
      else if (credit && credit > 0) amount = credit;
    }

    const row: ParsedRow = {
      date: parseDate(dateStr),
      description: getVal(mapping.descriptionCol) || null,
      amount,
      concept: getVal(mapping.conceptCol) || getVal(mapping.descriptionCol) || null,
      paymentMethod: getVal(mapping.paymentMethodCol) || null,
      type: getVal(mapping.typeCol) || null,
      provider: getVal(mapping.providerCol) || null,
      reference: getVal(mapping.referenceCol) || null,
      ruc: getVal(mapping.rucCol) || null,
      debit,
      credit,
      balance: parseAmount(getVal(mapping.balanceCol)),
      _raw: raw,
    };

    // Auto-detectar tipo si no está en el archivo
    if (!row.type) {
      row.type = detectType(row);
    }

    // Auto-detectar método de pago
    if (!row.paymentMethod) {
      row.paymentMethod = detectPaymentMethod(row);
    }

    return row;
  });

  return { headers, rows, detectedMapping: mapping, totalRows: rows.length };
}

// ── Carga Inicial ──

export interface CargaInicialRow {
  accountType: string;   // "Activo", "Pasivo", "Patrimonio"
  accountName: string;   // "Banco", "Cuentas por Cobrar", etc.
  amount: number;
}

export interface CargaInicialResult {
  headers: string[];
  rows: CargaInicialRow[];
  totalRows: number;
}

const CATEGORIA_PATTERNS = [/categoria/i, /category/i, /tipo[_\s]?cuenta/i, /clase/i];
const NOMBRE_CUENTA_PATTERNS = [/concepto/i, /cuenta/i, /nombre/i, /descripc/i, /account/i, /name/i, /rubro/i];

/**
 * Parsea un archivo CSV/XLSX para carga inicial (balance de apertura).
 * Formato esperado: Categoria, Concepto, Monto
 *   - Categoria: Activo | Pasivo | Patrimonio
 *   - Concepto: nombre de la cuenta contable
 *   - Monto: saldo inicial
 */
export async function parseCargaInicialFile(
  buffer: Buffer,
  fileName: string,
): Promise<CargaInicialResult> {
  const isXlsx = fileName.endsWith('.xlsx');

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
        values.push(String(cell.value ?? '').trim());
      });
      while (values.length > 0 && values[values.length - 1] === '') values.pop();
      if (values.length === 0) return;
      if (rowNum === 1) {
        headers = values;
      } else {
        rawRows.push(values);
      }
    });
  } else {
    const text = buffer.toString('utf-8').replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length === 0) throw new Error('El archivo CSV está vacío.');

    const delimiter = detectDelimiter(lines[0]);

    for (let i = 0; i < lines.length; i++) {
      const values = parseCSVLine(lines[i], delimiter);
      if (i === 0) {
        headers = values.map(h => h.trim());
      } else {
        rawRows.push(values.map(v => v.trim()));
      }
    }
  }

  if (headers.length === 0) throw new Error('No se detectaron encabezados en el archivo.');

  // Detectar columnas
  let categoriaCol: string | null = null;
  let nombreCol: string | null = null;
  let montoCol: string | null = null;

  for (const h of headers) {
    if (!categoriaCol && matchHeader(h, CATEGORIA_PATTERNS)) categoriaCol = h;
    if (!nombreCol && matchHeader(h, NOMBRE_CUENTA_PATTERNS)) nombreCol = h;
    if (!montoCol && matchHeader(h, AMOUNT_PATTERNS)) montoCol = h;
  }

  if (!categoriaCol) throw new Error('No se detectó columna de Categoría (Activo/Pasivo/Patrimonio). Use "Categoria" como encabezado.');
  if (!nombreCol) throw new Error('No se detectó columna de Concepto (nombre de cuenta). Use "Concepto" como encabezado.');
  if (!montoCol) throw new Error('No se detectó columna de Monto. Use "Monto" como encabezado.');

  const rows: CargaInicialRow[] = [];

  for (const rawRow of rawRows) {
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { raw[h] = rawRow[i] || ''; });

    const accountType = (raw[categoriaCol] || '').trim();
    const accountName = (raw[nombreCol] || '').trim();
    const amount = parseAmount(raw[montoCol] || '');

    if (!accountType || !accountName || amount === null || amount <= 0) continue;

    // Normalizar tipo de cuenta
    const normalizedType = normalizeAccountType(accountType);
    if (!normalizedType) continue; // tipo no reconocido

    rows.push({
      accountType: normalizedType,
      accountName,
      amount,
    });
  }

  return { headers, rows, totalRows: rows.length };
}

/**
 * Normaliza el tipo de cuenta a: ACTIVO, PASIVO, PATRIMONIO.
 * Retorna null si no se reconoce.
 */
function normalizeAccountType(raw: string): string | null {
  const lower = raw.toLowerCase().trim();
  if (/activo/i.test(lower)) return 'ACTIVO';
  if (/pasivo/i.test(lower)) return 'PASIVO';
  if (/patrimonio|patrimonio|capital/i.test(lower)) return 'PATRIMONIO';
  // También aceptar INGRESO, GASTO, COSTO para flexibilidad
  if (/ingreso/i.test(lower)) return 'INGRESO';
  if (/gasto/i.test(lower)) return 'GASTO';
  if (/costo/i.test(lower)) return 'COSTO';
  return null;
}

/**
 * Parsea una línea CSV respetando comillas.
 */
function parseCSVLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const ch of line) {
    if (inQuotes) {
      if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}
