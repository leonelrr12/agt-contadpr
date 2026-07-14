import ExcelJS from 'exceljs';

export type ExportFormat = 'xlsx' | 'csv';

interface ColumnDef {
  header: string;
  key: string;
  width?: number;
}

/**
 * Genera un archivo Excel (.xlsx) a partir de filas de datos.
 */
async function buildXlsx(
  sheetName: string,
  columns: ColumnDef[],
  rows: Record<string, unknown>[],
  moneyFields: string[] = [],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);

  sheet.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width || 18,
  }));

  // Estilo del header
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, size: 11 };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1565C0' },
  };
  headerRow.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
  headerRow.height = 22;

  // Filas de datos
  for (const row of rows) {
    sheet.addRow(row);
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
    col.width = Math.min(maxLen + 4, 40);
  }

  // Borde sutil en todas las celdas con datos
  const lastRow = Math.max(1, rows.length);
  for (let r = 1; r <= lastRow + 1; r++) {
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
function buildCsv(columns: ColumnDef[], rows: Record<string, unknown>[]): string {
  const header = columns.map((c) => escapeCsv(c.header)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCsv(String(row[c.key] ?? ''))).join(','))
    .join('\n');
  return header + '\n' + body;
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
      const moneyFields = ['totalDebit', 'totalCredit', 'balance'];
      const buffer = format === 'xlsx'
        ? await buildXlsx('Balance Comprobación', columns, rows, moneyFields)
        : Buffer.from(buildCsv(columns, rows), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `balance-comprobacion-${today}.${format}`,
      };
    }

    case 'balance-general': {
      const d = data as { activos: { total: number }; pasivos: { total: number }; patrimonio: { total: number }; ecuacion: string };
      const columns: ColumnDef[] = [
        { header: 'Concepto', key: 'concepto' },
        { header: 'Monto', key: 'monto' },
      ];
      const rows = [
        { concepto: 'ACTIVOS', monto: d.activos.total },
        { concepto: 'PASIVOS', monto: d.pasivos.total },
        { concepto: 'PATRIMONIO', monto: d.patrimonio.total },
        { concepto: 'PASIVO + PATRIMONIO', monto: d.pasivos.total + d.patrimonio.total },
        { concepto: 'Ecuación', monto: d.ecuacion },
      ];
      const buffer = format === 'xlsx'
        ? await buildXlsx('Balance General', columns, rows, ['monto'])
        : Buffer.from(buildCsv(columns, rows), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `balance-general-${today}.${format}`,
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
      const d = data as { movimientos: { date: string; description: string; debit: number; credit: number; saldo: number }[]; saldoActual: number };
      const columns: ColumnDef[] = [
        { header: 'Fecha', key: 'date' },
        { header: 'Descripción', key: 'description' },
        { header: 'Entrada', key: 'debit' },
        { header: 'Salida', key: 'credit' },
        { header: 'Saldo', key: 'saldo' },
      ];
      const rows = d.movimientos.map((m) => ({
        date: m.date ? new Date(m.date).toLocaleDateString('es-PA') : '',
        description: m.description,
        debit: m.debit,
        credit: m.credit,
        saldo: m.saldo,
      }));
      rows.push({ date: '', description: 'SALDO ACTUAL', debit: 0, credit: 0, saldo: d.saldoActual });
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
      const buffer = format === 'xlsx'
        ? await buildXlsx('Libro Diario', columns, rows, ['debit', 'credit'])
        : Buffer.from(buildCsv(columns, rows), 'utf-8');
      return {
        buffer,
        contentType: format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv',
        filename: `libro-diario-${today}.${format}`,
      };
    }

    default:
      throw new Error(`Tipo de reporte no soportado: ${reportType}`);
  }
}
