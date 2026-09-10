import { Router } from 'express';
import multer from 'multer';
import { parseHonorariosFile } from '../services/honorarios-parser';
import type { HonorariosRow } from '../services/honorarios-parser';
import { resolvePayoutAccount, payoutAviso } from '../services/account-resolver';
import type { PayoutCache, PayoutResolution } from '../services/account-resolver';

/**
 * Carga masiva de HONORARIOS PROFESIONALES — proceso independiente de las
 * demás cargas (Importar → ⚖️ Honorarios). No usa IA ni consume cuota:
 * por cada pago crea UN asiento BORRADOR (Honorarios Profesionales al DEBE,
 * Banco al HABER — cuentas en Administración → Honorarios) y guarda la
 * información en metadata para el informe por RUC/Cédula.
 * La metadata NO lleva "provider": los honorarios no deben mezclarse con el
 * Informe Por Proveedores (que filtra metadata contains 'provider').
 */

export const honorariosRouter = Router();

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

interface HonorariosAccountIds {
  gasto: string | null;
}

async function loadHonorariosAccounts(prisma: any, companyId: string): Promise<HonorariosAccountIds> {
  const c: any = await prisma.company.findUnique({
    where: { id: companyId },
    select: { honorariosGastoId: true },
  });
  return {
    gasto: c?.honorariosGastoId || null,
  };
}

/**
 * Validación de una fila (fuente de verdad: la usan el preview sobre TODAS
 * las filas y la ejecución). Devuelve el mensaje de error o null.
 */
function validateHonorariosRow(row: HonorariosRow, cuentas: HonorariosAccountIds): string | null {
  if (row.parseError) return row.parseError;
  if (!row.nombre) return 'Falta el nombre del profesional';
  if (!row.taxId) return 'Falta el RUC/Cédula (es la clave del informe por profesional)';
  // Celdas Excel numéricas: una cédula/RUC largo se guarda como 8.88E+07
  if (/^\d+(\.\d+)?e\+?\d+$/i.test(row.taxId)) {
    return 'El RUC/Cédula viene en notación científica: formatea esa columna como texto en Excel';
  }
  if (!(row.monto > 0)) return 'El monto debe ser mayor que 0';

  const faltantes: string[] = [];
  if (!cuentas.gasto) faltantes.push('Honorarios Profesionales (gasto)');
  if (faltantes.length > 0) {
    return `Configura la cuenta de ${faltantes.join(', ')} en Configuración → Cargas`;
  }
  return null;
}

/** Clave de dedupe: fecha + RUC/Cédula + nombre + concepto + monto (céntimos). */
function honorariosDupKey(row: HonorariosRow, fecha: string): string {
  return [
    fecha,
    (row.taxId || '').trim().toLowerCase(),
    (row.nombre || '').trim().toLowerCase(),
    (row.concepto || '').trim().toLowerCase(),
    Math.round(row.monto * 100),
  ].join('|');
}

/**
 * Índice de honorarios ya cargados (re-subir el mismo archivo no duplica):
 * lee las Transactions con source honorarios y reconstruye su clave.
 */
async function buildHonorariosIndex(prisma: any, companyId: string): Promise<Set<string>> {
  const txs = await prisma.transaction.findMany({
    where: {
      companyId,
      metadata: { contains: '"source":"honorarios"' },
      // Un pago ANULADO (Transaction re-apuntada al asiento de reversión
      // "ANULACIÓN: …") no debe bloquear una re-carga del mismo pago.
      journalEntry: { is: { NOT: { description: { startsWith: 'ANULACIÓN:' } } } },
    },
    select: { metadata: true },
  });
  const index = new Set<string>();
  for (const t of txs) {
    try {
      const m = JSON.parse(t.metadata || '{}');
      if (m.source !== 'honorarios') continue;
      index.add([
        m.fecha,
        String(m.ruc || '').trim().toLowerCase(),
        String(m.nombre || '').trim().toLowerCase(),
        String(m.concepto || '').trim().toLowerCase(),
        Math.round((Number(m.monto) || 0) * 100),
      ].join('|'));
    } catch { /* metadata inválida: se ignora */ }
  }
  return index;
}

interface HonorariosPreviewRow extends HonorariosRow {
  row: number;
  status: 'ok' | 'error' | 'omitida';
  error?: string;
  fechaFinal: string | null;
  /** Cuenta de banco que se usará en el asiento (columna Banco o la por defecto) */
  bankAccount?: { id: string; code: string; name: string } | null;
  bankSource?: string | null;
  bankAviso?: string | null;
}

/**
 * Valida todas las filas y devuelve la muestra (20) con estado + errores.
 * El banco de cada fila se resuelve aquí: columna "Banco" del archivo →
 * cuenta de banco por defecto → respaldo 1.1.02.01 (con aviso).
 */
async function buildHonorariosValidation(
  prisma: any,
  companyId: string,
  rows: HonorariosRow[],
  defaultDate: string | null,
) {
  const cuentas = await loadHonorariosAccounts(prisma, companyId);
  const dupIndex = await buildHonorariosIndex(prisma, companyId);
  const payoutCache: PayoutCache = { accounts: null, defaultId: null };

  const previewRows: HonorariosPreviewRow[] = [];
  const errors: { row: number; error: string }[] = [];
  let ok = 0;
  let omitted = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;
    const fechaFinal = row.fecha || (esFechaValida(defaultDate) ? defaultDate : null);
    let status: HonorariosPreviewRow['status'] = 'ok';
    let error: string | undefined;
    let payout: PayoutResolution | null = null;

    if (!fechaFinal) {
      status = 'error';
      error = 'Falta la fecha del pago (columna FECHA o fecha global)';
    } else {
      const invalid = validateHonorariosRow(row, cuentas);
      if (invalid) {
        status = 'error';
        error = invalid;
      } else {
        payout = await resolvePayoutAccount(prisma, companyId, row.bankName, payoutCache);
        if (!payout.account) {
          status = 'error';
          error = 'No hay cuentas de banco (1.1.02.*) en el catálogo: crea una o configura el banco por defecto';
        } else if (dupIndex.has(honorariosDupKey(row, fechaFinal))) {
          status = 'omitida';
          error = 'Ya cargado (misma fecha, RUC/Cédula, nombre y monto)';
        }
      }
    }

    if (status === 'ok') ok++;
    else if (status === 'omitida') omitted++;
    else errors.push({ row: rowNum, error: error || 'Error' });

    if (i < 20) {
      previewRows.push({
        ...row, row: rowNum, status, error, fechaFinal,
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
 * POST /api/honorarios/preview
 * Archivo de honorarios (multipart: file, importDate?) → validación de todas
 * las filas + muestra de 20. No escribe en BD.
 */
honorariosRouter.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }
  try {
    const defaultDate = (req.body.importDate as string) || null;
    const parsed = await parseHonorariosFile(req.file.buffer, req.file.originalname);
    if (parsed.rows.length === 0) {
      res.json({
        headers: parsed.headers,
        totalRows: 0,
        honorarios: true,
        honorariosPreview: { rows: [], ok: 0, omitted: 0, errors: [], total: 0 },
      });
      return;
    }

    const validation = await buildHonorariosValidation(
      req.prisma, req.user!.companyId, parsed.rows, defaultDate,
    );

    res.json({
      headers: parsed.headers,
      detectedColumns: parsed.detectedColumns,
      totalRows: parsed.totalRows,
      repairCount: parsed.repairCount,
      honorarios: true,
      honorariosPreview: validation,
    });
  } catch (error: any) {
    console.error('[Honorarios] Preview error:', error);
    res.status(400).json({ error: error.message || 'Error al procesar el archivo', detail: error?.message });
  }
});

/**
 * POST /api/honorarios/execute-all
 * Ejecuta la carga: un asiento BORRADOR por pago (DEBE Honorarios
 * Profesionales / HABER Banco) con su Transaction y metadata, en su propia
 * transacción Prisma. Las filas con error se omiten y se reportan.
 * NO consume cuota del plan.
 */
honorariosRouter.post('/execute-all', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }
  try {
    const defaultDate = (req.body.importDate as string) || null;
    const companyId = req.user!.companyId;
    const userId = req.user!.userId;

    const parsed = await parseHonorariosFile(req.file.buffer, req.file.originalname);
    if (parsed.rows.length === 0) {
      res.status(400).json({ error: 'No se encontraron filas válidas en el archivo.' });
      return;
    }

    const cuentas = await loadHonorariosAccounts(req.prisma, companyId);
    const dupIndex = await buildHonorariosIndex(req.prisma, companyId);
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
        const fecha = row.fecha || (esFechaValida(defaultDate) ? defaultDate! : null);
        if (!fecha) {
          throw new Error('Falta la fecha del pago (columna FECHA o fecha global)');
        }
        const invalid = validateHonorariosRow(row, cuentas);
        if (invalid) throw new Error(invalid);
        if (dupIndex.has(honorariosDupKey(row, fecha))) {
          results.omitted++;
          continue;
        }

        const date = toLocalDate(fecha);
        const monto = r2(row.monto);
        const concept = row.concepto || 'Honorarios profesionales';
        const description = `Honorarios profesionales — ${row.nombre} — ${fecha}`;

        // Banco de la fila: columna "Banco" → banco por defecto → 1.1.02.01
        const payout = await resolvePayoutAccount(req.prisma, companyId, row.bankName, payoutCache);
        if (!payout.account) {
          throw new Error('No hay cuentas de banco (1.1.02.*) en el catálogo: crea una o configura el banco por defecto');
        }

        const je = await req.prisma.$transaction(async (tx: any) => {
          const created = await tx.journalEntry.create({
            data: {
              date,
              description,
              status: 'BORRADOR',
              companyId,
              createdById: userId,
              lines: {
                create: [
                  { accountId: cuentas.gasto!, debit: monto, credit: 0 },
                  { accountId: payout.account!.id, debit: 0, credit: monto },
                ],
              },
            },
          });

          await tx.transaction.create({
            data: {
              type: 'HONORARIOS',
              amount: monto,
              description,
              concept,
              paymentMethod: null,
              date,
              companyId,
              createdById: userId,
              journalEntryId: created.id,
              // Sin "provider" a propósito: los honorarios tienen su propio
              // informe y no deben salir en el Informe Por Proveedores.
              metadata: JSON.stringify({
                source: 'honorarios',
                fecha,
                ruc: row.taxId,
                nombre: row.nombre,
                concepto: row.concepto,
                monto,
              }),
            },
          });

          return created;
        });

        dupIndex.add(honorariosDupKey(row, fecha));
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
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Honorarios] Execute-all error:', error);
    const isClientError = /no se|no encontrad|inválid|formato|configura|falta/i.test(error.message || '');
    res.status(isClientError ? 400 : 500).json({
      error: isClientError ? error.message : 'Error interno al procesar los honorarios. Intente de nuevo.',
      detail: error?.message,
    });
  }
});

// Errores de multer (tamaño de archivo) con mensaje claro
honorariosRouter.use((err: any, _req: any, res: any, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'El archivo supera el máximo de 10MB.' });
    return;
  }
  next(err);
});
