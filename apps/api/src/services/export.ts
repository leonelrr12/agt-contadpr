import ExcelJS from 'exceljs';

export type ExportFormat = 'xlsx' | 'csv';

interface ColumnDef {
  header: string;
  key: string;
  width?: number;
}

/** Estilo por fila del xlsx: títulos y totales en negrita (el CSV no admite
 *  formato, así que allí solo se ve la sangría de espacios). */
interface RowStyle {
  bold?: boolean;
}

/** Línea del encabezado del estado (empresa / nombre / período): se escribe
 *  ARRIBA de la fila de columnas, combinada a lo ancho y centrada. */
interface TitleRow {
  text: string;
  size?: number;
  bold?: boolean;
}

interface XlsxOptions {
  rowStyles?: RowStyle[];
  titleRows?: TitleRow[];
}

/**
 * Genera un archivo Excel (.xlsx) a partir de filas de datos.
 */
async function buildXlsx(
  sheetName: string,
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  moneyFields: string[] = [],
  footerRow?: Record<string, unknown>,
  opts: XlsxOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map((c) => ({ key: c.key, width: c.width || 18 }));

  // Encabezado del estado (empresa / nombre / período): combinado a lo ancho y
  // centrado, ARRIBA de la fila de columnas — es lo que se ve al abrir el archivo.
  for (const t of opts.titleRows || []) {
    const tr = sheet.addRow([t.text]);
    tr.font = { bold: t.bold !== false, size: t.size || 12 };
    tr.alignment = { horizontal: 'center', vertical: 'middle' };
    sheet.mergeCells(tr.number, 1, tr.number, columns.length);
  }

  // Fila de columnas (azul, como el resto de los exports)
  const headerRow = sheet.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1565C0' },
  };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;

  // Filas de datos (con su estilo, si el reporte lo pide: títulos y totales)
  for (let i = 0; i < rows.length; i++) {
    const r = sheet.addRow(rows[i]);
    if (opts.rowStyles?.[i]?.bold) r.font = { bold: true };
  }

  // Fila de totales (footer)
  if (footerRow) {
    const fr = sheet.addRow(footerRow);
    fr.font = { bold: true, size: 11 };
    for (let c = 1; c <= columns.length; c++) {
      fr.getCell(c).border = {
        top: { style: 'medium', color: { argb: 'FF1A1A2E' } },
        bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      };
    }
  }

  // Formato de moneda para columnas monetarias
  for (let i = 0; i < columns.length; i++) {
    if (moneyFields.includes(columns[i].key)) {
      const col = sheet.getColumn(i + 1);
      col.numFmt = '#,##0.00';
    }
  }

  // Auto-ajustar ancho (máx 40)
  for (let i = 0; i < columns.length; i++) {
    const col = sheet.getColumn(i + 1);
    let maxLen = columns[i].header.length;
    for (const row of rows) {
      const val = String(row[columns[i].key] ?? '');
      if (val.length > maxLen) maxLen = val.length;
    }
    if (footerRow) {
      const val = String(footerRow[columns[i].key] ?? '');
      if (val.length > maxLen) maxLen = val.length;
    }
    col.width = Math.min(maxLen + 4, 40);
  }

  // Borde sutil en todas las celdas con datos (desde la fila de columnas: arriba
  // pueden ir las líneas de título, que no llevan borde)
  const lastRow = sheet.lastRow ? sheet.lastRow.number : headerRow.number;
  for (let r = headerRow.number; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= columns.length; c++) {
      row.getCell(c).border = {
        top: { style: 'thin', color: { argb: 'FFDDDDDD' } },
        bottom: { style: 'thin', color: { argb: 'FFDDDDDD' } },
      };
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Genera un archivo CSV a partir de filas de datos.
 */
function buildCsv(columns: ColumnDef[], rows: Record<string, unknown>[], footerRow?: Record<string, unknown>): string {
  const header = columns.map((c) => escapeCsv(c.header)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCsv(String(row[c.key] ?? ''))).join(','))
    .join('\n');
  let csv = header + '\n' + body;
  if (footerRow) {
    csv += '\n' + columns.map((c) => escapeCsv(String(footerRow[c.key] ?? ''))).join(',');
  }
  return csv;
}

function escapeCsv(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

/**
 * Genera el buffer y Content-Type para el reporte solicitado.
 */
export async function exportReport(
  format: ExportFormat,
  reportType: string,
  data: Record<string, unknown>,
  // Encabezado del documento exportado (lo resuelve la ruta, que tiene la empresa)
  meta: { companyName?: string | null } = {},
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const today = new Date().toISOString().split('T')[0];

  switch (reportType) {
    case 'balance-comprobacion': {
      const items = data as unknown as {
        account: { code: string; name: string; type: string };
        totalDebit: number;
        totalCredit: number;
        balance: number;
        balanceType: string;
      }[];
      const columns: ColumnDef[] = [
        { header: 'Código', key: 'code' },
        { header: 'Cuenta', key: 'name' },
        { header: 'Tipo', key: 'type' },
        { header: 'Débitos', key: 'totalDebit' },
        { header: 'Créditos', key: 'totalCredit' },
        { header: 'Saldo', key: 'balance' },
        { header: 'Tipo Saldo', key: 'balanceType' },
      ];
      const rows = items.map((b) => ({
        code: b.account.code,
        name: b.account.name,
        type: b.account.type,
        totalDebit: b.totalDebit,
        totalCredit: b.totalCredit,
        balance: b.balance,
        balanceType: b.balanceType,
      }));
      const totDeb = items.reduce((s, b) => s + (b.totalDebit || 0), 0);
      const totCred = items.reduce((s, b) => s + (b.totalCredit || 0), 0);
      const footerRow = { code: '', name: 'Total', type: '', totalDebit: totDeb, totalCredit: totCred, balance: '', balanceType: '' };
      const moneyFields = ['totalDebit', 'totalCredit', 'balance'];
      const buffer = format === 'xlsx'
        ? await buildXlsx('Balance Comprobación', columns, rows, moneyFields, footerRow)
        : Buffer.from(buildCsv(columns, rows, footerRow), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `balance-comprobacion-${today}.${format}`,
      };
    }

    case 'balance-general': {
      type CuentaSaldo = { code: string; name: string; saldo: number };
      const d = data as {
        periodo?: { start: string | null; end: string | null; anioFiscal: number; acumulado?: boolean };
        activos: { detalle: CuentaSaldo[]; total: number };
        pasivos: { detalle: CuentaSaldo[]; total: number };
        capital: { detalle: CuentaSaldo[]; totalCuentas: number; gananciaPeriodo: number; total: number };
        ecuacion: { ok: boolean; pasivoCapital: number; diferencia: number };
      };
      const columns: ColumnDef[] = [
        { header: 'Concepto', key: 'concepto' },
        { header: 'Monto', key: 'monto' },
      ];
      // Las cuentas van solo por nombre (con su código está el Balance de
      // Comprobación) y sangradas ~5 espacios para colgar del título del bloque.
      const cuenta = (c: CuentaSaldo) => `     ${c.name}`;
      const rows: { concepto: string; monto: number | string }[] = [];
      // Estilo paralelo a `rows`: títulos y totales en negrita (solo lo aplica el
      // xlsx; el CSV no admite formato).
      const estilos: RowStyle[] = [];
      const push = (concepto: string, monto: number | string, bold = false) => {
        rows.push({ concepto, monto });
        estilos.push({ bold });
      };

      // Encabezado del estado: va como bloque combinado y centrado ARRIBA de la
      // fila de columnas (empresa en grande, estado y período debajo).
      const corte = d.periodo?.end;
      const titleRows: TitleRow[] = [];
      if (meta.companyName) titleRows.push({ text: meta.companyName, size: 22, bold: true });
      titleRows.push({
        text: corte
          ? `Balance General al ${new Date(corte).toLocaleDateString('es-PA')}`
          : 'Balance General (acumulado, todo el histórico)',
        bold: true,
      });
      if (d.periodo?.anioFiscal) titleRows.push({ text: `Año fiscal ${d.periodo.anioFiscal}` });

      push('Activo', '', true);
      for (const c of d.activos.detalle) push(cuenta(c), c.saldo);
      push('Total Activo', d.activos.total, true);
      push('', '');

      // Mismos nombres que la pantalla: Pasivo y Patrimonio en un solo bloque, que
      // cierra con el total que debe igualar al Activo.
      push('Pasivo y Patrimonio', '', true);
      for (const c of d.pasivos.detalle) push(cuenta(c), c.saldo);
      push('Total Pasivo', d.pasivos.total, true);
      push('Patrimonio de los Accionistas', '', true);
      for (const c of d.capital.detalle) push(cuenta(c), c.saldo);
      push('Ganancia del periodo', d.capital.gananciaPeriodo);
      push('Total Patrimonio', d.capital.total, true);
      push('Total Pasivo y Patrimonio', d.ecuacion.pasivoCapital, true);
      // Solo se avisa cuando NO cuadra (igual que la pantalla)
      if (!d.ecuacion.ok) {
        push('', '');
        push(`⚠️ EL BALANCE NO CUADRA — diferencia ${d.ecuacion.diferencia}`, '', true);
      }
      const buffer = format === 'xlsx'
        ? await buildXlsx('Balance General', columns, rows, ['monto'], undefined, { rowStyles: estilos, titleRows })
        // El CSV no admite combinación ni centrado: el encabezado va como filas
        : Buffer.from(buildCsv(columns, [...titleRows.map((t) => ({ concepto: t.text, monto: '' })), { concepto: '', monto: '' }, ...rows]), 'utf-8');
      // El nombre lleva la fecha del corte («hasta») cuando hay filtro, y la de hoy
      // cuando el estado es de todo el histórico. El corte llega como Date en UTC
      // (23:59:59.999Z del día elegido), así que toISOString da el día correcto.
      const fechaNombre = corte ? new Date(corte).toISOString().slice(0, 10) : today;
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `balance-general-${fechaNombre}.${format}`,
      };
    }

    case 'estado-resultados': {
      const d = data as {
        ingresos: { detalle: Record<string, number>; total: number };
        costos: { detalle: Record<string, number>; total: number };
        gananciaBruta: number;
        gastos: { detalle: Record<string, number>; total: number };
        utilidadNeta: number;
      };
      const columns: ColumnDef[] = [
        { header: 'Concepto', key: 'concepto' },
        { header: 'Monto', key: 'monto' },
      ];
      const rows: { concepto: string; monto: number | string }[] = [];
      rows.push({ concepto: 'INGRESOS', monto: '' });
      for (const [k, v] of Object.entries(d.ingresos.detalle)) rows.push({ concepto: `  ${k}`, monto: v });
      rows.push({ concepto: 'Total Ingresos', monto: d.ingresos.total });
      rows.push({ concepto: '', monto: '' });
      rows.push({ concepto: 'COSTOS', monto: '' });
      for (const [k, v] of Object.entries(d.costos.detalle)) rows.push({ concepto: `  ${k}`, monto: v });
      rows.push({ concepto: 'Total Costos', monto: d.costos.total });
      rows.push({ concepto: '', monto: '' });
      rows.push({ concepto: 'GANANCIA BRUTA', monto: d.gananciaBruta });
      rows.push({ concepto: '', monto: '' });
      rows.push({ concepto: 'GASTOS', monto: '' });
      for (const [k, v] of Object.entries(d.gastos.detalle)) rows.push({ concepto: `  ${k}`, monto: v });
      rows.push({ concepto: 'Total Gastos', monto: d.gastos.total });
      rows.push({ concepto: '', monto: '' });
      rows.push({ concepto: 'UTILIDAD NETA', monto: d.utilidadNeta });
      const buffer = format === 'xlsx'
        ? await buildXlsx('Estado de Resultados', columns, rows, ['monto'])
        : Buffer.from(buildCsv(columns, rows), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `estado-resultados-${today}.${format}`,
      };
    }

    case 'flujo-caja': {
      const d = data as {
        saldoInicial?: number;
        totalDebit?: number;
        totalCredit?: number;
        movimientos: {
          date: string;
          description: string;
          account?: { code: string; name: string };
          debit: number;
          credit: number;
          saldo: number;
        }[];
        saldoActual: number;
      };
      const columns: ColumnDef[] = [
        { header: 'Fecha', key: 'date' },
        { header: 'Cuenta', key: 'cuenta' },
        { header: 'Descripción', key: 'description' },
        { header: 'Entrada', key: 'debit' },
        { header: 'Salida', key: 'credit' },
        { header: 'Saldo', key: 'saldo' },
      ];
      // La columna Cuenta es necesaria desde que el reporte suma Caja + Bancos.
      const rows = d.movimientos.map((m) => ({
        date: m.date ? new Date(m.date).toLocaleDateString('es-PA') : '',
        cuenta: m.account ? `${m.account.code} ${m.account.name}` : '',
        description: m.description,
        debit: m.debit,
        credit: m.credit,
        saldo: m.saldo,
      }));
      if (typeof d.saldoInicial === 'number') {
        rows.unshift({ date: '', cuenta: '', description: 'SALDO INICIAL', debit: 0, credit: 0, saldo: d.saldoInicial });
      }
      // Totales del período en las columnas de entrada/salida, y el saldo de cierre.
      rows.push({
        date: '',
        cuenta: '',
        description: 'SALDO ACTUAL',
        debit: d.totalDebit ?? 0,
        credit: d.totalCredit ?? 0,
        saldo: d.saldoActual,
      });
      const buffer = format === 'xlsx'
        ? await buildXlsx('Flujo de Caja', columns, rows, ['debit', 'credit', 'saldo'])
        : Buffer.from(buildCsv(columns, rows), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `flujo-caja-${today}.${format}`,
      };
    }

    case 'diario': {
      const d = data as { entries: any[] };
      const columns: ColumnDef[] = [
        { header: 'Fecha', key: 'date' },
        { header: 'ID', key: 'id' },
        { header: 'Descripción', key: 'description' },
        { header: 'Cuenta', key: 'account' },
        { header: 'Débito', key: 'debit' },
        { header: 'Crédito', key: 'credit' },
        { header: 'Estado', key: 'status' },
      ];
      const rows: Record<string, unknown>[] = [];
      for (const e of d.entries || []) {
        for (const line of e.lines || []) {
          rows.push({
            date: new Date(e.date).toLocaleDateString('es-PA'),
            id: (e.id || '').slice(0, 8),
            description: e.description,
            account: line.account?.name || '',
            debit: line.debit || '',
            credit: line.credit || '',
            status: e.status,
          });
        }
      }
      let totDeb = 0, totCred = 0;
      for (const r of rows) {
        totDeb += Number(r.debit) || 0;
        totCred += Number(r.credit) || 0;
      }
      const footerRow = { date: '', id: '', description: '', account: 'Total', debit: totDeb, credit: totCred, status: '' };
      const buffer = format === 'xlsx'
        ? await buildXlsx('Libro Diario', columns, rows, ['debit', 'credit'], footerRow)
        : Buffer.from(buildCsv(columns, rows, footerRow), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `libro-diario-${today}.${format}`,
      };
    }

    case 'proveedores': {
      const d = data as any;

      // Anexos-DGI por cuenta (mismo endpoint; el eje es la cuenta, no el proveedor)
      if (d.reportKind === 'anexos-dgi') {
        const cols: ColumnDef[] = [
          { header: 'RUC/Cédula', key: 'ruc' },
          { header: 'Tercero', key: 'tercero' },
          { header: 'Fecha', key: 'date' },
          { header: 'Detalle', key: 'detalle' },
          { header: 'Factura', key: 'factura' },
          { header: 'Monto', key: 'monto' },
        ];
        const anexoRows: Record<string, unknown>[] = [];
        for (const t of d.terceros || []) {
          for (const f of t.detalle || []) {
            anexoRows.push({
              ruc: t.ruc || '—',
              tercero: t.tercero,
              date: new Date(f.fecha).toLocaleDateString('es-PA'),
              detalle: f.detalle || '—',
              factura: f.factura || '—',
              monto: f.monto,
            });
          }
        }
        const anexoFooter = { ruc: '', tercero: '', date: '', detalle: 'Total', factura: '', monto: d.total };
        const anexoBuf = format === 'xlsx'
          ? await buildXlsx('Anexos DGI', cols, anexoRows, ['monto'], anexoFooter)
          : Buffer.from(buildCsv(cols, anexoRows, anexoFooter), 'utf-8');
        return {
          buffer: anexoBuf,
          contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
          filename: `anexos-dgi-${d.cuenta?.code || 'cuenta'}-${today}.${format}`,
        };
      }

      const columns: ColumnDef[] = [
        { header: 'Proveedor', key: 'provider' },
        { header: 'RUC', key: 'ruc' },
        { header: 'N° Factura', key: 'invoiceNumber' },
        { header: 'Fecha', key: 'date' },
        { header: 'Monto', key: 'amount' },
        { header: 'ITBMS', key: 'itbms' },
        { header: 'Total', key: 'total' },
      ];
      const rows: Record<string, unknown>[] = [];
      for (const p of d.proveedores || []) {
        for (const f of p.detalle || []) {
          rows.push({
            provider: p.provider,
            ruc: p.ruc || '—',
            invoiceNumber: f.invoiceNumber || '—',
            date: new Date(f.date).toLocaleDateString('es-PA'),
            amount: f.amount,
            itbms: f.itbms,
            total: f.total,
          });
        }
      }
      const footerRow = {
        provider: '', ruc: '', invoiceNumber: 'Total', date: '',
        amount: d.subtotal, itbms: d.itbms, total: d.total,
      };
      const buffer = format === 'xlsx'
        ? await buildXlsx('Reporte por Proveedor', columns, rows, ['amount', 'itbms', 'total'], footerRow)
        : Buffer.from(buildCsv(columns, rows, footerRow), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `reporte-proveedores-${today}.${format}`,
      };
    }

    default:
      throw new Error(`Tipo de reporte no soportado: ${reportType}`);
  }
}
