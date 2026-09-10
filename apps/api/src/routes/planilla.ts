import { Router } from 'express';
import multer from 'multer';
import { parsePlanillaFile } from '../services/planilla-parser';
import type { PlanillaRow } from '../services/planilla-parser';
import { resolvePayoutAccount, payoutAviso } from '../services/account-resolver';
import type { PayoutCache, PayoutResolution } from '../services/account-resolver';

/**
 * Carga masiva de PLANILLA (nómina) — proceso independiente de las demás
 * cargas (Importar → 👷 Planilla). No usa IA ni consume cuota del plan:
 * por cada empleado crea UN asiento BORRADOR con las cuentas configuradas
 * en Administración → Configuración → Planilla y guarda la información en
 * metadata para informes futuros por empleado.
 *
 * Asiento por fila: SUELDO/HORAS EXTRAS/DÉCIMO al DEBE; SS/SE/ISR y el NETO
 * (TOPAL A PAGAR) al HABER. Cuadre: bruto = deducciones + neto (±0.01).
 */

export const planillaRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no soportado: ${file.mimetype}. Use CSV o XLSX.`));
    }
  },
});

type TipoPlanilla = 'SUELDO' | 'DECIMO';

const TIPO_LABEL: Record<TipoPlanilla, string> = {
  SUELDO: 'Sueldo + Horas Extras',
  DECIMO: 'Décimo III',
};

/** Tolerancia de cuadre por fila (céntimos). */
const PLANILLA_EPS = 0.01;

function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Convierte "YYYY-MM-DD" a Date a MEDIODÍA local (12:00): guardado así, ningún
 * lector de la región (p. ej. navegador en Panamá UTC-5 con server en UTC-4)
 * ve el día anterior por el desfase de zona horaria.
 */
function toLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

function esFechaValida(s: string | null | undefined): boolean {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(toLocalDate(s).getTime());
}

interface PlanillaAccountIds {
  sueldo: string | null;
  horasExtras: string | null;
  decimo: string | null;
  ss: string | null;
  se: string | null;
  isr: string | null;
}

async function loadPlanillaAccounts(prisma: any, companyId: string): Promise<PlanillaAccountIds> {
  const c: any = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      planillaSueldoId: true,
      planillaHorasExtrasId: true,
      planillaDecimoId: true,
      planillaSSId: true,
      planillaSEId: true,
      planillaISRId: true,
    },
  });
  return {
    sueldo: c?.planillaSueldoId || null,
    horasExtras: c?.planillaHorasExtrasId || null,
    decimo: c?.planillaDecimoId || null,
    ss: c?.planillaSSId || null,
    se: c?.planillaSEId || null,
    isr: c?.planillaISRId || null,
  };
}

/** Aviso de la fila cuando el banco no salió de la columna del archivo. */


/**
 * Validación de una fila de planilla (fuente de verdad: la usan el preview
 * sobre TODAS las filas y la ejecución). Devuelve el mensaje de error o null.
 */
function validatePlanillaRow(
  row: PlanillaRow,
  tipo: TipoPlanilla,
  cuentas: PlanillaAccountIds,
): string | null {
  if (row.parseError) return row.parseError;
  if (!row.employee) return 'Falta el nombre del empleado';

  const bruto = r2(row.salario + row.horasExtras + row.decimo);
  const deducciones = r2(row.ss + row.se + row.isr);
  if (bruto <= 0 && deducciones <= 0 && row.neto <= 0) return 'La fila no tiene montos';
  if (row.neto < 0) return 'El Neto a pagar no puede ser negativo';
  if (Math.abs(bruto - (deducciones + row.neto)) > PLANILLA_EPS) {
    return `No cuadra: Sueldo+Extras+Décimo ($${bruto.toFixed(2)}) ≠ SS+SE+ISR ($${deducciones.toFixed(2)}) + Neto ($${row.neto.toFixed(2)})`;
  }
  if (tipo === 'SUELDO' && row.decimo > 0) {
    return 'El Décimo III se paga en su propio proceso (selecciona Tipo: Décimo III)';
  }
  if (tipo === 'DECIMO' && (row.salario > 0 || row.horasExtras > 0)) {
    return 'El pago de Décimo III no lleva Sueldo ni Horas Extras (selecciona Tipo: Sueldo)';
  }

  const faltantes: string[] = [];
  if (row.salario > 0 && !cuentas.sueldo) faltantes.push('Sueldo');
  if (row.horasExtras > 0 && !cuentas.horasExtras) faltantes.push('Horas Extras');
  if (row.decimo > 0 && !cuentas.decimo) faltantes.push('Décimo III');
  if (row.ss > 0 && !cuentas.ss) faltantes.push('SS');
  if (row.se > 0 && !cuentas.se) faltantes.push('SE');
  if (row.isr > 0 && !cuentas.isr) faltantes.push('ISR');
  if (faltantes.length > 0) {
    return `Configura la cuenta de ${faltantes.join(', ')} en Configuración → Planilla`;
  }
  return null;
}

/** Clave de dedupe de una planilla cargada: tipo + quincena + empleado + montos. */
function planillaDupKey(tipo: TipoPlanilla, row: PlanillaRow, quincena: string): string {
  const cents = (n: number) => Math.round(n * 100);
  return [
    tipo, quincena,
    (row.employee || '').trim().toLowerCase(),
    (row.cedula || '').trim().toLowerCase(),
    cents(row.neto),
    cents(r2(row.ss + row.se + row.isr)),
  ].join('|');
}

/**
 * Índice de planillas ya cargadas (re-subir el mismo archivo no duplica):
 * lee las Transactions de planilla y reconstruye su clave de dedupe.
 */
async function buildPlanillaIndex(prisma: any, companyId: string): Promise<Set<string>> {
  const txs = await prisma.transaction.findMany({
    where: {
      companyId,
      metadata: { contains: '"source":"planilla"' },
      // Un asiento ANULADO (Transaction re-apuntada al reverso "ANULACIÓN: …")
      // no debe bloquear una re-carga de la misma planilla.
      journalEntry: { is: { NOT: { description: { startsWith: 'ANULACIÓN:' } } } },
    },
    select: { metadata: true },
  });
  const index = new Set<string>();
  for (const t of txs) {
    try {
      const m = JSON.parse(t.metadata || '{}');
      if (m.source !== 'planilla') continue;
      const cents = (n: any) => Math.round((Number(n) || 0) * 100);
      index.add([
        m.tipo, m.quincena,
        String(m.employee || '').trim().toLowerCase(),
        String(m.cedula || '').trim().toLowerCase(),
        cents(m.neto),
        cents((Number(m.ss) || 0) + (Number(m.se) || 0) + (Number(m.isr) || 0)),
      ].join('|'));
    } catch { /* metadata inválida: se ignora */ }
  }
  return index;
}

interface PlanillaPreviewRow extends PlanillaRow {
  row: number;
  status: 'ok' | 'error' | 'omitida';
  error?: string;
  quincenaFinal: string | null;
  /** Cuenta de banco que se usará en el asiento (columna Banco o la por defecto) */
  bankAccount?: { id: string; code: string; name: string } | null;
  bankSource?: string | null;
  bankAviso?: string | null;
}

/**
 * Valida todas las filas y devuelve la muestra (20) con su estado, más el
 * detalle de errores del archivo completo. No escribe nada.
 * El banco de cada fila se resuelve aquí: columna "Banco" del archivo →
 * cuenta de banco por defecto → respaldo 1.1.02.01 (con aviso).
 */
async function buildPlanillaValidation(
  prisma: any,
  companyId: string,
  rows: PlanillaRow[],
  tipo: TipoPlanilla,
  defaultDate: string | null,
) {
  const cuentas = await loadPlanillaAccounts(prisma, companyId);
  const dupIndex = await buildPlanillaIndex(prisma, companyId);
  const payoutCache: PayoutCache = { accounts: null, defaultId: null };

  const previewRows: PlanillaPreviewRow[] = [];
  const errors: { row: number; error: string }[] = [];
  let ok = 0;
  let omitted = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const quincenaFinal = row.quincena || (esFechaValida(defaultDate) ? defaultDate : null);
    let status: PlanillaPreviewRow['status'] = 'ok';
    let error: string | undefined;
    let payout: PayoutResolution | null = null;

    if (!quincenaFinal) {
      status = 'error';
      error = 'Falta la fecha de la quincena (columna QUINCENA o fecha global)';
    } else {
      const invalid = validatePlanillaRow(row, tipo, cuentas);
      if (invalid) {
        status = 'error';
        error = invalid;
      } else {
        payout = await resolvePayoutAccount(prisma, companyId, row.bankName, payoutCache);
        if (row.neto > 0 && !payout.account) {
          status = 'error';
          error = 'No hay cuentas de banco (1.1.02.*) en el catálogo: crea una o configura el banco por defecto';
        } else if (dupIndex.has(planillaDupKey(tipo, row, quincenaFinal))) {
          status = 'omitida';
          error = 'Ya cargada (mismo tipo, quincena, empleado y montos)';
        }
      }
    }

    if (status === 'ok') ok++;
    else if (status === 'omitida') omitted++;
    else errors.push({ row: rowNum, error: error || 'Error' });

    if (i < 20) {
      previewRows.push({
        ...row, row: rowNum, status, error, quincenaFinal,
        bankAccount: payout?.account
          ? { id: payout.account.id, code: payout.account.code, name: payout.account.name }
          : null,
        bankSource: payout?.source || null,
        bankAviso: payoutAviso(payout),
      });
    }
  }

  return { rows: previewRows, errors, ok, omitted, total: rows.length };
}

/**
 * POST /api/planilla/preview
 * Archivo de planilla (multipart: file, tipo=SUELDO|DECIMO, importDate?) →
 * validación de todas las filas + muestra de 20. No escribe en BD.
 */
planillaRouter.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }
  try {
    const tipo = String(req.body.tipo || '').toUpperCase() as TipoPlanilla;
    if (tipo !== 'SUELDO' && tipo !== 'DECIMO') {
      res.status(400).json({ error: 'Tipo de planilla inválido: use SUELDO o DECIMO' });
      return;
    }
    const defaultDate = (req.body.importDate as string) || null;

    const parsed = await parsePlanillaFile(req.file.buffer, req.file.originalname);
    if (parsed.rows.length === 0) {
      res.json({
        headers: parsed.headers,
        totalRows: 0,
        tipo,
        planilla: true,
        planillaPreview: { rows: [], ok: 0, omitted: 0, errors: [], total: 0 },
      });
      return;
    }

    const validation = await buildPlanillaValidation(
      req.prisma, req.user!.companyId, parsed.rows, tipo, defaultDate,
    );

    res.json({
      headers: parsed.headers,
      detectedColumns: parsed.detectedColumns,
      totalRows: parsed.totalRows,
      tipo,
      planilla: true,
      planillaPreview: validation,
    });
  } catch (error: any) {
    console.error('[Planilla] Preview error:', error);
    res.status(400).json({ error: error.message || 'Error al procesar el archivo', detail: error?.message });
  }
});

/**
 * POST /api/planilla/execute-all
 * Ejecuta la carga: un asiento BORRADOR por empleado (con su Transaction y
 * metadata), en su propia transacción Prisma. Las filas con error se omiten
 * y se reportan; NO consume cuota del plan.
 */
planillaRouter.post('/execute-all', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }
  try {
    const tipo = String(req.body.tipo || '').toUpperCase() as TipoPlanilla;
    if (tipo !== 'SUELDO' && tipo !== 'DECIMO') {
      res.status(400).json({ error: 'Tipo de planilla inválido: use SUELDO o DECIMO' });
      return;
    }
    const defaultDate = (req.body.importDate as string) || null;
    const companyId = req.user!.companyId;
    const userId = req.user!.userId;

    const parsed = await parsePlanillaFile(req.file.buffer, req.file.originalname);
    if (parsed.rows.length === 0) {
      res.status(400).json({ error: 'No se encontraron filas válidas en el archivo.' });
      return;
    }

    const cuentas = await loadPlanillaAccounts(req.prisma, companyId);
    // Dedupe: lo ya cargado se re-detecta aquí (la BD pudo cambiar desde el preview)
    const dupIndex = await buildPlanillaIndex(req.prisma, companyId);
    // Banco por fila (columna "Banco" → por defecto → 1.1.02.01), una carga por lote
    const payoutCache: PayoutCache = { accounts: null, defaultId: null };

    const results = {
      success: 0,
      omitted: 0,
      errors: [] as { row: number; error: string }[],
      entryIds: [] as string[],
    };

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const rowNum = i + 1;

      try {
        const quincena = row.quincena || (esFechaValida(defaultDate) ? defaultDate! : null);
        if (!quincena) {
          throw new Error('Falta la fecha de la quincena (columna QUINCENA o fecha global)');
        }
        const invalid = validatePlanillaRow(row, tipo, cuentas);
        if (invalid) throw new Error(invalid);
        if (dupIndex.has(planillaDupKey(tipo, row, quincena))) {
          results.omitted++;
          continue;
        }

        const date = toLocalDate(quincena);
        const bruto = r2(row.salario + row.horasExtras + row.decimo);

        // Líneas del asiento: DEBE gastos (sueldo/extras/décimo), HABER
        // retenciones (SS/SE/ISR) y neto al banco — solo columnas con monto.
        // El banco sale de la columna "Banco" de la fila o del banco por
        // defecto (respaldo 1.1.02.01).
        const lines: { accountId: string; debit: number; credit: number }[] = [];
        if (row.salario > 0) lines.push({ accountId: cuentas.sueldo!, debit: row.salario, credit: 0 });
        if (row.horasExtras > 0) lines.push({ accountId: cuentas.horasExtras!, debit: row.horasExtras, credit: 0 });
        if (row.decimo > 0) lines.push({ accountId: cuentas.decimo!, debit: row.decimo, credit: 0 });
        if (row.ss > 0) lines.push({ accountId: cuentas.ss!, debit: 0, credit: row.ss });
        if (row.se > 0) lines.push({ accountId: cuentas.se!, debit: 0, credit: row.se });
        if (row.isr > 0) lines.push({ accountId: cuentas.isr!, debit: 0, credit: row.isr });
        if (row.neto > 0) {
          const payout = await resolvePayoutAccount(req.prisma, companyId, row.bankName, payoutCache);
          if (!payout.account) {
            throw new Error('No hay cuentas de banco (1.1.02.*) en el catálogo: crea una o configura el banco por defecto');
          }
          lines.push({ accountId: payout.account.id, debit: 0, credit: row.neto });
        }

        const totalDebit = r2(lines.reduce((s, l) => s + l.debit, 0));
        const totalCredit = r2(lines.reduce((s, l) => s + l.credit, 0));
        if (lines.length < 2 || Math.abs(totalDebit - totalCredit) > PLANILLA_EPS) {
          throw new Error(`Asiento no balanceado (débito $${totalDebit} ≠ crédito $${totalCredit})`);
        }
        // Residuo de redondeo (≤ 1 céntimo): se absorbe en la línea de mayor
        // monto del DEBE — el neto al banco y las retenciones van exactos.
        if (Math.abs(totalDebit - totalCredit) > 0.001) {
          const mayorDebe = lines.filter(l => l.debit > 0).sort((a, b) => b.debit - a.debit)[0];
          if (mayorDebe) mayorDebe.debit = r2(mayorDebe.debit + (totalCredit - totalDebit));
        }

        const prefix = tipo === 'DECIMO' ? 'Décimo III de' : 'Planilla de';
        const description = `${prefix} ${row.employee} — ${quincena}`;

        const je = await req.prisma.$transaction(async (tx: any) => {
          const created = await tx.journalEntry.create({
            data: {
              date,
              description,
              status: 'BORRADOR',
              companyId,
              createdById: userId,
              lines: { create: lines },
            },
          });

          await tx.transaction.create({
            data: {
              type: 'PLANILLA',
              amount: bruto,
              description,
              concept: tipo === 'DECIMO' ? 'Décimo III' : 'Planilla',
              paymentMethod: null,
              date,
              companyId,
              createdById: userId,
              journalEntryId: created.id,
              // Sin "provider" a propósito: la planilla no es una compra a
              // proveedor y no debe aparecer en el Informe Por Proveedores.
              metadata: JSON.stringify({
                source: 'planilla',
                tipo,
                quincena,
                employee: row.employee,
                cedula: row.cedula,
                salario: row.salario,
                horasExtras: row.horasExtras,
                decimo: row.decimo,
                ss: row.ss,
                se: row.se,
                isr: row.isr,
                neto: row.neto,
              }),
            },
          });

          return created;
        });

        dupIndex.add(planillaDupKey(tipo, row, quincena));
        results.entryIds.push(je.id);
        results.success++;
      } catch (err: any) {
        results.errors.push({ row: rowNum, error: (err?.message || 'Error desconocido').toString().slice(0, 300) });
      }
    }

    res.json({
      success: results.success,
      omitted: results.omitted,
      errors: results.errors,
      total: parsed.rows.length,
      tipo,
      tipoLabel: TIPO_LABEL[tipo],
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Planilla] Execute-all error:', error);
    const isClientError = /no se|no encontrad|inválid|formato|cuadra|configura|falta/i.test(error.message || '');
    res.status(isClientError ? 400 : 500).json({
      error: isClientError ? error.message : 'Error interno al procesar la planilla. Intente de nuevo.',
      detail: error?.message,
    });
  }
});

// Errores de multer (tamaño de archivo) con mensaje claro
planillaRouter.use((err: any, _req: any, res: any, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'El archivo supera el máximo de 10MB.' });
    return;
  }
  next(err);
});
