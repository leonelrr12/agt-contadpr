import { Router } from 'express';
import multer from 'multer';
import { validate } from '../middleware/validate';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { parseImportFile, parseCargaInicialFile, parseCobrosFile } from '../services/csv-parser';
import type { ParsedRow, CobrosRow, CobrosParseResult } from '../services/csv-parser';
import { resolveCargaInicialRows } from '../services/account-lookup';
import { ClassificationAgent } from '@agt-contador/agents';
import { AccountingAgent } from '@agt-contador/agents';
import { importExecuteSchema } from '../validation/schemas';
import { syncEntityFromEntry } from '../services/entity-service';

export const importRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ];
    // También aceptar por extensión (algunos navegadores no envían el MIME correcto)
    const ext = file.originalname.toLowerCase();
    if (allowed.includes(file.mimetype) || ext.endsWith('.csv') || ext.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error(`Formato no soportado: ${file.mimetype}. Use CSV o XLSX.`));
    }
  },
});

/**
 * POST /api/import/preview
 * Sube un archivo CSV/XLSX, lo parsea, clasifica conceptos, y devuelve preview.
 */
importRouter.post('/preview', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const cargaInicial = req.body.cargaInicial === 'true';

    if (cargaInicial) {
      // ── Carga Inicial Preview ──
      const parsed = await parseCargaInicialFile(req.file.buffer, req.file.originalname);

      if (parsed.rows.length === 0) {
        res.json({
          headers: parsed.headers,
          totalRows: parsed.totalRows,
          cargaInicial: true,
          cargaInicialPreview: { rows: [], totalDebit: 0, totalCredit: 0, balanced: true, accountsNotFound: 0 },
        });
        return;
      }

      const previewRows = parsed.rows.slice(0, 20);
      const { results, totalDebit, totalCredit } = await resolveCargaInicialRows(
        req.prisma, req.user!.companyId, previewRows,
      );

      res.json({
        headers: parsed.headers,
        totalRows: parsed.totalRows,
        cargaInicial: true,
        cargaInicialPreview: {
          rows: results,
          totalDebit,
          totalCredit,
          balanced: Math.abs(totalDebit - totalCredit) < 0.01,
          accountsNotFound: results.filter(r => r.status !== 'ok').length,
        },
      });
      return;
    }

    // ── Cobros / pagos a facturas (Preview) ──
    const cobros = req.body.cobros === 'true';
    if (cobros) {
      const parsed = await parseCobrosFile(req.file.buffer, req.file.originalname);
      assertCobrosFileColumns(parsed);

      if (parsed.rows.length === 0) {
        res.json({
          headers: parsed.headers,
          totalRows: parsed.totalRows,
          cobros: true,
          cobrosPreview: { rows: [], success: 0, errors: [], pending: 0, omitted: 0, appliedTotal: 0, markedPaid: 0 },
        });
        return;
      }

      // Simular el batch completo EN ORDEN sobre un snapshot en memoria:
      // los abonos parciales a una misma factura se acumulan igual que en la
      // ejecución real (segundo pago de la fila 5 ve el saldo tras la fila 2).
      // Filas sin "Fecha de Pago"/"Cuenta" → pendientes (omitidas); abonos ya
      // registrados en BD → omitidos (idempotente).
      const sim = await simulateCobrosFile(req.prisma, req.user!.companyId, parsed.rows);

      res.json({
        headers: parsed.headers,
        totalRows: parsed.totalRows,
        cobros: true,
        cobrosPreview: {
          rows: sim.rows.slice(0, 20),
          success: sim.rows.filter(r => r.status === 'ok').length,
          errors: sim.errors,
          pending: sim.pending,
          omitted: sim.omitted,
          appliedTotal: sim.appliedTotal,
          markedPaid: sim.markedPaid,
        },
      });
      return;
    }

    // ── Flujo normal ──
    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);

    // Mismas reglas que /execute-all: fecha global solo si el usuario la indicó
    const defaultDate = (req.body.importDate as string) || null;
    const allRows = buildImportRows(parsed.rows, defaultDate);

    // Validación estricta sobre TODAS las filas (no solo la muestra de 20):
    // las incompletas se cuentan y se reportan aunque no se muestren en el preview.
    const invalidRows: { row: number; missing: string[] }[] = [];
    allRows.forEach((r, i) => {
      const missing = missingImportFields(r);
      if (missing.length > 0) invalidRows.push({ row: i + 1, missing });
    });

    // Clasificar las primeras 20 filas para el preview
    const classifier = new ClassificationAgent({
      prisma: req.prisma,
      companyId: req.user!.companyId,
    });

    const previewRows = [];
    const conceptColName = parsed.detectedMapping.conceptCol;
    for (let i = 0; i < Math.min(allRows.length, 20); i++) {
      const row = allRows[i];
      // Si hay columna Concepto explícita, tomar el valor crudo (sin fallback a descripción)
      // Si no hay columna, dejar null — la clasificación BD se muestra en columna "Cuenta"
      const rawConcept = conceptColName ? (parsed.rows[i]._raw[conceptColName]?.trim() || null) : null;
      const conceptForClassify = rawConcept || row.description || '';
      let classification = null;
      if (conceptForClassify) {
        classification = await classifier.classify(conceptForClassify, row.type || 'GASTO');
      }
      previewRows.push({
        ...row,
        missing: missingImportFields(row),
        concept: rawConcept,
        classification: classification ? {
          concept: classification.concept,
          accountId: classification.accountId,
          confidence: classification.confidence,
        } : null,
      });
    }

    res.json({
      headers: parsed.headers,
      detectedMapping: parsed.detectedMapping,
      previewRows,
      totalRows: parsed.totalRows,
      invalidRows,
      detectedCobrosFile: isCobrosFileHeaders(parsed.headers) || isCobrosFileRows(allRows),
    });
  } catch (error: any) {
    console.error('[Import] Preview error:', error);
    res.status(400).json({
      error: error.message || 'Error al procesar el archivo',
      detail: error?.message,
    });
  }
});

// ── Lógica compartida de ejecución ──

/** Convierte una fecha "YYYY-MM-DD" a Date en hora local (evita offset UTC → día anterior) */
function toLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);  // Mediodía local: sin riesgo de cambio de día por zona horaria
}

interface ImportRow {
  date: string | null;  // pueden faltar: la validación estricta los exige en runtime
  description: string;
  amount: number | null;  // neto (sin ITBMS); el impuesto va en itbms
  itbms?: number | null;  // monto del ITBMS de la fila (0/null si no aplica)
  concept?: string;
  paymentMethod?: string | null;
  type: string;
  provider?: string | null;
  reference?: string | null;
  ruc?: string | null;
  debitAccountId?: string;
  creditAccountId?: string;
}

function r2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Reduce el error de Prisma a su causa (quita el "Invalid `prisma.x.y()` invocation:")
 * para que el error mostrado al usuario sea legible.
 */
function cleanImportError(err: any): string {
  const raw = (err?.message || err || 'Error desconocido').toString();
  if (!raw.startsWith('Invalid `prisma')) return raw;
  const parts = raw.split(/\n\s*\n/);
  const last = parts[parts.length - 1] || raw;
  return last.split('\n')[0].trim() || raw.slice(0, 200);
}

/**
 * Validación estricta del import normal (la carga inicial usa su propio
 * endpoint): TODAS las filas deben traer los datos completos.
 * Única fuente de verdad — la usa el preview (sobre el archivo completo)
 * y la ejecución.
 */
function missingImportFields(row: ImportRow): string[] {
  const missing: string[] = [];
  if (!row.date) missing.push('fecha');
  if (!(row.concept || row.description || '').trim()) missing.push('concepto');
  if (!row.amount || row.amount <= 0) missing.push('monto');
  if (!row.ruc) missing.push('RUC');
  if (!row.reference) missing.push('Nº de factura');
  return missing;
}

/**
 * Detección de archivo de PAGOS A FACTURAS (el import NORMAL no mapea
 * "Fecha de Pago" ni la cuenta/banco del archivo: usa la "Fecha" genérica y
 * clasifica por concepto — contabilizaría cobros como transacciones sueltas).
 * Señales:
 * 1. Encabezados: columna de pago/depósito + Nº de factura + cuenta/banco + total.
 * 2. Contenido (suficiente por sí solo): la mayoría de las filas dicen
 *    cobro/abono/pago de factura en concepto o descripción.
 */
function isCobrosFileHeaders(headers: string[]): boolean {
  const has = (re: RegExp) => headers.some(h => re.test(h));
  return has(/pago|dep[ió]sito/i)
    && has(/factura|nro|n[úu]mero|ref\.?/i)
    && has(/^cuenta|^banco|^bancos|^caja/i)
    && has(/^total|^monto|^importe|amount/i);
}

function isCobrosConcept(row: { concept?: string; description: string }): boolean {
  return /(^|\s|de\s)(cobro|abono|pago de factura|pago a factura|cobro de factura|abono de cliente|cobro de cliente|abono a factura)(\s|$)/i
    .test(`${row.concept || ''} ${row.description || ''}`);
}

/** Señal de contenido: mayoría de filas con concepto de cobro/abono. */
function isCobrosFileRows(rows: { concept?: string; description: string }[]): boolean {
  if (rows.length === 0) return false;
  const signal = rows.filter(isCobrosConcept).length;
  // Archivos de 1-2 filas: todas deben decir cobro (evita falso positivo
  // en lotes mixtos pequeños); con más filas, mayoría estricta.
  if (rows.length < 3) return signal === rows.length;
  return signal > rows.length / 2;
}

/**
 * Convierte filas parseadas → ImportRow. La fecha global SOLO aplica si el
 * usuario la indicó (importDate); las filas incompletas se detectan después
 * con missingImportFields (mismas reglas en preview y en /execute-all).
 */
function buildImportRows(parsedRows: ParsedRow[], defaultDate: string | null): ImportRow[] {
  return parsedRows.map(r => ({
    date: defaultDate ? (r.date || defaultDate) : r.date,
    description: r.description || '',
    amount: r.amount,
    // Redondear a centavos: la columna ITBMS suele traer celdas con fórmula
    // (=Monto*7%) cuyo valor flotante ensucia descripción y líneas (902.1341).
    itbms: r.itbms && r.itbms > 0 ? r2(r.itbms) : null,
    concept: r.concept || r.description || '',
    paymentMethod: r.paymentMethod,
    type: r.type || 'GASTO',
    provider: r.provider,
    reference: r.reference,
    ruc: r.ruc,
  }));
}

async function executeImportRows(
  rows: ImportRow[],
  prisma: any,
  companyId: string,
  userId: string,
  incrementUsageFn: (req: any) => Promise<void>,
  req: any,
): Promise<{ success: number; errors: { row: number; error: string }[]; entryIds: string[] }> {
  const classifier = new ClassificationAgent({ prisma, companyId });
  const accountant = new AccountingAgent(prisma, companyId);
  await accountant.init();

  const results = { success: 0, errors: [] as { row: number; error: string }[], entryIds: [] as string[] };

  // CADA FILA se crea en SU PROPIA transacción. Antes el lote completo corría
  // en un solo $transaction con catch por fila: si cualquier query fallaba,
  // Postgres abortaba la transacción entera → error 25P02 en cadena sobre las
  // filas siguientes, y el COMMIT final se convertía en rollback silencioso de
  // TODO el lote (hasta los asientos ya contados como exitosos se perdían).
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    try {
      const missing = missingImportFields(row);
      if (missing.length > 0) {
        throw new Error(`Faltan datos obligatorios: ${missing.join(', ')}`);
      }
      // Tras la validación estricta, date y amount están garantizados
      // (TS no re-narrowa tras los await, por eso se capturan locales).
      const date = row.date!;
      const amount = row.amount!;
      // Total pagado: neto + ITBMS (cuando la fila trae impuesto)
      const total = row.itbms ? r2(amount + row.itbms) : amount;

      let accountId = row.debitAccountId || row.creditAccountId;
      let classifiedConcept = row.concept || row.description || 'Gastos Varios';
      let classConfidence = 0.9;

      if (!accountId) {
        const concept = row.concept || row.description || 'Gastos Varios';
        const classResult = await classifier.classify(concept, row.type);
        if (!classResult.accountId || classResult.confidence < 0.3) {
          throw new Error(`No se pudo clasificar el concepto "${concept}"`);
        }
        accountId = classResult.accountId;
        // Usar el concepto normalizado de la BD (ej. "Ventas" en vez de "Venta de Calzado")
        classifiedConcept = classResult.concept;
        classConfidence = classResult.confidence;
      }

      const dialog = {
        type: row.type as any,
        amount,  // neto: el agente desglosa el ITBMS cuando itbmsAmount > 0
        currency: 'USD',
        description: row.description,
        concept: classifiedConcept,
        paymentMethod: (row.paymentMethod || null) as any,
        date,
        confidence: 0.9,
        missingFields: [] as string[],
        itbms: !!row.itbms,
        itbmsAmount: row.itbms && row.itbms > 0 ? row.itbms : undefined,
        provider: row.provider || null,
        reference: row.reference || null,
        ruc: row.ruc || null,
        suggestedResponse: '',
      };

      const classification = { concept: classifiedConcept, accountId, confidence: classConfidence };
      const entry = accountant.generateEntry(dialog, classification);
      const validation = accountant.validateEntry(entry);
      if (!validation.valid) {
        throw new Error(validation.error || 'Asiento no balanceado');
      }

      const debitLines = entry.debit.map((d: any) => ({
        accountId: accountant.resolveAlias(d.accountId),
        debit: d.amount,
        credit: 0,
      }));
      const creditLines = entry.credit.map((c: any) => ({
        accountId: accountant.resolveAlias(c.accountId),
        debit: 0,
        credit: c.amount,
      }));

      // Asiento + Transaction: transacción propia de la fila
      const je = await prisma.$transaction(async (tx: any) => {
        const created = await tx.journalEntry.create({
          data: {
            date: toLocalDate(date),
            description: entry.description,
            status: 'BORRADOR',
            companyId,
            createdById: userId,
            lines: { create: [...debitLines, ...creditLines] },
          },
        });

        await tx.transaction.create({
          data: {
            type: row.type,
            amount: total,
            description: row.description,
            concept: classifiedConcept,
            paymentMethod: row.paymentMethod,
            date: toLocalDate(date),
            companyId,
            createdById: userId,
            journalEntryId: created.id,
            metadata: (() => {
              const m: Record<string, any> = {};
              if (row.provider) m.provider = row.provider;
              if (row.reference) m.reference = row.reference;
              if (row.ruc) m.ruc = row.ruc;
              if (row.itbms) m.itbms = row.itbms;
              return JSON.stringify(m);
            })(),
          },
        });

        return created;
      });

      // Sincronizar auxiliar (CxC/CxP) FUERA de la transacción de la fila:
      // si falla no aborta la fila ya guardada (y no envenena las demás).
      if (row.provider) {
        try {
          await syncEntityFromEntry(prisma, companyId, je);
        } catch (e: any) {
          console.warn(`[Import] sync auxiliar fila ${rowNum}:`, e?.message || e);
        }
      }

      results.entryIds.push(je.id);
      results.success++;
    } catch (err: any) {
      results.errors.push({ row: rowNum, error: cleanImportError(err) });
    }
  }

  for (let i = 0; i < results.success; i++) {
    try { await incrementUsageFn(req); } catch { /* quota exhausted */ }
  }

  return results;
}

/**
 * POST /api/import/execute
 * Recibe las filas procesadas y crea los asientos contables en lote.
 */
importRouter.post('/execute', requireQuota, validate(importExecuteSchema), async (req, res) => {
  const { rows } = req.body;

  try {
    const results = await executeImportRows(
      rows, req.prisma, req.user!.companyId, req.user!.userId,
      incrementUsage, req,
    );

    res.json({
      success: results.success,
      errors: results.errors,
      total: rows.length,
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Import] Execute error:', error);
    res.status(500).json({
      error: 'Error al ejecutar la importación',
      detail: error?.message,
    });
  }
});

/**
 * POST /api/import/execute-all
 * Atajo: recibe archivo + mapping y ejecuta todo en un solo paso.
 */
importRouter.post('/execute-all', requireQuota, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const parsed = await parseImportFile(req.file.buffer, req.file.originalname);

    // Construir rows desde el parseo automático (mismas reglas que el preview)
    const defaultDate = (req.body.importDate as string) || null;
    const rows = buildImportRows(parsed.rows, defaultDate);

    if (rows.length === 0) {
      res.status(400).json({ error: 'No se encontraron filas válidas en el archivo.' });
      return;
    }

    // Verificar cuota: ¿hay cupo suficiente para todas las filas?
    const sub = (req as any).subscription;
    if (sub) {
      const remaining = sub.movementsLimit - sub.movementsUsed;
      if (rows.length > remaining) {
        res.status(429).json({
          error: `No tienes suficientes movimientos disponibles. Tu plan permite ${sub.movementsLimit} por período y has usado ${sub.movementsUsed}. Te quedan ${remaining} pero necesitas ${rows.length}.`,
          code: 'QUOTA_EXCEEDED',
          limit: sub.movementsLimit,
          used: sub.movementsUsed,
          remaining,
          required: rows.length,
        });
        return;
      }
    }

    // Ejecutar usando la misma lógica
    const results = await executeImportRows(
      rows, req.prisma, req.user!.companyId, req.user!.userId,
      incrementUsage, req,
    );

    res.json({
      success: results.success,
      errors: results.errors,
      total: rows.length,
      entryIds: results.entryIds.slice(0, 5),
    });
  } catch (error: any) {
    console.error('[Import] Execute-all error:', error);
    // Errores de validación/negocio → 400; errores internos → 500
    const isClientError = /no se pudo|no encontrad|inválid|formato|balance/i.test(error.message || '');
    const status = isClientError ? 400 : 500;
    res.status(status).json({
      error: isClientError ? error.message : 'Error interno al procesar la importación. Intente de nuevo.',
      detail: error?.message,
    });
  }
});

/**
 * POST /api/import/cobros/execute-all
 * Archivo de pagos/abonos a facturas de clientes → una transacción por fila:
 * JE BORRADOR (débito cuenta/banco, crédito Clientes), Transaction COBRO_CLIENTE,
 * InvoicePayment y paidAmount += monto (PAGADA + paidAt cuando saldo ≈ 0).
 */
importRouter.post('/cobros/execute-all', requireQuota, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const parsed = await parseCobrosFile(req.file.buffer, req.file.originalname);
    assertCobrosFileColumns(parsed);

    if (parsed.rows.length === 0) {
      res.status(400).json({ error: 'No se encontraron filas válidas en el archivo.' });
      return;
    }

    // Candidatas: filas con "Fecha de Pago" + "Cuenta". Las pendientes son
    // facturas que aún no han recibido su pago: ni se intentan ni consumen cuota.
    const candidates = parsed.rows.filter(r => !isCobroPending(r));
    if (candidates.length === 0) {
      res.status(400).json({ error: 'No hay pagos para aplicar: todas las filas están pendientes (sin "Fecha de Pago"/"Cuenta").' });
      return;
    }

    // Verificar cuota: un movimiento por abono candidato
    const sub = (req as any).subscription;
    if (sub) {
      const remaining = sub.movementsLimit - sub.movementsUsed;
      if (candidates.length > remaining) {
        res.status(429).json({
          error: `No tienes suficientes movimientos disponibles. Tu plan permite ${sub.movementsLimit} por período y has usado ${sub.movementsUsed}. Te quedan ${remaining} pero necesitas ${candidates.length}.`,
          code: 'QUOTA_EXCEEDED',
          limit: sub.movementsLimit,
          used: sub.movementsUsed,
          remaining,
          required: candidates.length,
        });
        return;
      }
    }

    const companyId = req.user!.companyId;
    const userId = req.user!.userId;

    // Cargar catálogo + facturas UNA vez; cada fila corre en SU PROPIA
    // transacción (lección 25P02 del import normal) y re-lee la factura
    // fresca dentro de ella (nada de estado compartido entre filas).
    const accounts = await loadCobroAccounts(req.prisma, companyId);
    const { list: invoicesList } = await loadCobroInvoices(req.prisma, companyId);
    // Pagos ya registrados en BD → re-subidas idempotentes. El índice se
    // actualiza con cada pago aplicado (también dedupe dentro del mismo archivo).
    const dupKeys = await buildCobroPaymentsIndex(req.prisma, companyId);

    const results = {
      success: 0,
      errors: [] as { row: number; error: string }[],
      pending: 0,
      omitted: 0,
      entryIds: [] as string[],
    };
    let markedPaid = 0;

    for (let i = 0; i < parsed.rows.length; i++) {
      const row = parsed.rows[i];
      const rowNum = i + 1;

      // Pendiente: factura sin pago aún — se omite, no es error ni consume
      if (isCobroPending(row)) {
        results.pending++;
        continue;
      }

      try {
        const validation = validateCobroRow(row, accounts, invoicesList, dupKeys);
        if (!validation.ok) {
          if (validation.code === 'ALREADY_APPLIED') results.omitted++;
          else results.errors.push({ row: rowNum, error: validation.message });
          continue;
        }
        // validation.ok garantiza estos campos; el guarda permite a TS estrechar
        const { invoice, account, clientsAccount, amount, dateStr } = validation;
        if (!invoice || !account || !clientsAccount || amount == null || !dateStr) {
          throw new Error('Fila de cobro inválida (datos incompletos).');
        }
        const paymentMethod = cobroPaymentMethod(account);

        // Re-leer la factura fresca dentro de la transacción: entre el preload
        // y esta fila otro proceso pudo registrar un abono (p.ej. PATCH /pay).
        const outcome = await req.prisma.$transaction(async (tx: any) => {
          const fresh = await tx.invoice.findUnique({ where: { id: invoice.id } });
          if (!fresh) throw new Error(`Factura ${invoice.number} ya no existe.`);
          const saldo = r2(fresh.total - fresh.paidAmount);
          // Ya pagada o abono idéntico ya registrado (re-subida / fila repetida
          // en el mismo archivo): se OMITE, no es error ni duplica el saldo.
          if (saldo <= 0.01) return { kind: 'omitted' as const };
          const key = cobroDupKey(fresh.id, amount, account.id, dateStr);
          if (dupKeys.get(fresh.id)?.has(key)) return { kind: 'omitted' as const };
          if (amount > saldo + 0.01) {
            throw new Error(`El abono $${amount.toFixed(2)} excede el saldo de la factura ${fresh.number} ($${saldo.toFixed(2)}).`);
          }
          const nuevoSaldo = r2(saldo - amount);
          const quedaPagada = nuevoSaldo <= 0.01;

          const desc = `Cobro de factura ${fresh.number} — $${amount.toFixed(2)}`;
          const created = await tx.journalEntry.create({
            data: {
              date: toLocalDate(dateStr),
              description: desc,
              status: 'BORRADOR',
              companyId,
              createdById: userId,
              lines: { create: [
                { accountId: account.id, debit: amount, credit: 0 },
                { accountId: clientsAccount.id, debit: 0, credit: amount },
              ] },
            },
          });

          await tx.transaction.create({
            data: {
              type: 'COBRO_CLIENTE',
              amount,
              description: desc,
              concept: row.concept || 'Cobro de factura',
              paymentMethod,
              date: toLocalDate(dateStr),
              companyId,
              createdById: userId,
              journalEntryId: created.id,
              metadata: JSON.stringify({
                source: 'import-cobros',
                invoiceNumber: fresh.number,
                fileNumber: row.invoiceNumber || null,
                accountName: row.accountName || null,
                client: invoice.clientName,
              }),
            },
          });

          const payment = await tx.invoicePayment.create({
            data: {
              companyId,
              invoiceId: fresh.id,
              amount,
              date: toLocalDate(dateStr),
              accountId: account.id,
              accountName: row.accountName || null,
              journalEntryId: created.id,
            },
          });

          const updated = await tx.invoice.update({
            where: { id: fresh.id },
            data: {
              paidAmount: r2(fresh.paidAmount + amount),
              ...(quedaPagada ? { status: 'PAGADA', paidAt: toLocalDate(dateStr) } : {}),
            },
          });

          return { kind: 'applied' as const, created, payment, quedaPagada, numero: updated.number, key };
        });

        if (outcome.kind === 'omitted') {
          results.omitted++;
          continue;
        }
        // Registrar la clave del pago aplicado: una fila idéntica repetida más
        // adelante en el MISMO archivo también se omite.
        if (!dupKeys.has(invoice.id)) dupKeys.set(invoice.id, new Set());
        dupKeys.get(invoice.id)!.add(outcome.key);

        if (outcome.quedaPagada) markedPaid++;
        results.entryIds.push(outcome.created.id);
        results.success++;
      } catch (err: any) {
        results.errors.push({ row: rowNum, error: cleanImportError(err) });
      }
    }

    for (let i = 0; i < results.success; i++) {
      try { await incrementUsage(req); } catch { /* quota exhausted */ }
    }

    res.json({
      success: results.success,
      errors: results.errors,
      total: candidates.length,
      pending: results.pending,
      omitted: results.omitted,
      entryIds: results.entryIds.slice(0, 5),
      markedPaid,
    });
  } catch (error: any) {
    console.error('[Import] Cobros execute-all error:', error);
    const isClientError = /no se (pudo|encontró|detectó)|no encontrad|inválid|formato/i.test(error.message || '');
    const status = isClientError ? 400 : 500;
    res.status(status).json({
      error: isClientError ? error.message : 'Error interno al procesar los pagos.',
      detail: error?.message,
    });
  }
});

/**
 * POST /api/import/carga-inicial
 * Recibe un archivo CSV con formato Categoria,Concepto,Monto
 * y crea UN solo asiento de apertura con todas las líneas.
 */
importRouter.post('/carga-inicial', requireQuota, upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No se recibió ningún archivo' });
    return;
  }

  try {
    const defaultDate = (req.body.importDate as string) || new Date().toISOString().split('T')[0];
    const parsed = await parseCargaInicialFile(req.file.buffer, req.file.originalname);

    if (parsed.rows.length === 0) {
      res.status(400).json({ error: 'No se encontraron filas válidas en el archivo. Revise que tenga columnas Categoria, Concepto y Monto con valores correctos.' });
      return;
    }

    // Resolver cuentas
    const { results, totalDebit, totalCredit } = await resolveCargaInicialRows(
      req.prisma, req.user!.companyId, parsed.rows,
    );

    // Verificar cuentas no encontradas
    const notFound = results.filter(r => r.status === 'not_found');
    if (notFound.length > 0) {
      res.status(400).json({
        error: `No se encontraron ${notFound.length} cuenta(s) en el catálogo contable.`,
        code: 'ACCOUNTS_NOT_FOUND',
        notFound: notFound.map(r => ({ accountName: r.accountName, accountType: r.accountType })),
        success: 0,
        total: parsed.rows.length,
      });
      return;
    }

    // Verificar balance
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({
        error: `El balance no cuadra. Débitos: ${totalDebit.toFixed(2)}, Créditos: ${totalCredit.toFixed(2)}. Diferencia: ${(totalDebit - totalCredit).toFixed(2)}`,
        code: 'UNBALANCED',
        totalDebit,
        totalCredit,
        success: 0,
        total: parsed.rows.length,
      });
      return;
    }

    // Verificar cuota
    const sub = (req as any).subscription;
    if (sub) {
      const remaining = sub.movementsLimit - sub.movementsUsed;
      if (remaining < 1) {
        res.status(429).json({
          error: 'No tienes movimientos disponibles en tu plan.',
          code: 'QUOTA_EXCEEDED',
          limit: sub.movementsLimit,
          used: sub.movementsUsed,
          remaining,
        });
        return;
      }
    }

    // Crear UN solo JournalEntry con todas las líneas
    const entry = await req.prisma.journalEntry.create({
      data: {
        date: toLocalDate(defaultDate),
        description: `Carga Inicial - ${defaultDate}`,
        status: 'BORRADOR',
        companyId: req.user!.companyId,
        createdById: req.user!.userId,
        lines: {
          create: results.map(r => ({
            accountId: r.matchedAccount!.id,
            debit: r.side === 'Debe' ? r.amount : 0,
            credit: r.side === 'Haber' ? r.amount : 0,
          })),
        },
      },
    });

    // Incrementar uso de cuota (una sola vez para toda la carga inicial)
    try { await incrementUsage(req); } catch { /* quota exhausted */ }

    res.json({
      success: 1,
      errors: [],
      total: parsed.rows.length,
      entryIds: [entry.id],
      description: `Carga Inicial: ${parsed.rows.length} cuentas cargadas al ${defaultDate}`,
      totalDebit,
      totalCredit,
    });
  } catch (error: any) {
    console.error('[Import] Carga inicial error:', error);
    const isClientError = /no se (detectó|encontró)/i.test(error.message || '');
    const status = isClientError ? 400 : 500;
    res.status(status).json({
      error: isClientError ? error.message : 'Error interno al procesar la carga inicial.',
      detail: error?.message,
    });
  }
});

/**
 * POST /api/import/carga-inicial/execute
 * Versión JSON: recibe las filas ya resueltas (con accountId) desde el frontend
 * después de que el usuario revisó/corrigió los matches en el preview.
 */
importRouter.post('/carga-inicial/execute', requireQuota, async (req, res) => {
  const { rows, importDate } = req.body;

  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    res.status(400).json({ error: 'Se requiere un arreglo de filas (rows) con accountId, amount, y side.' });
    return;
  }

  try {
    const date = (importDate as string) || new Date().toISOString().split('T')[0];

    // Validar que todas las filas tengan accountId
    const invalid = rows.filter((r: any) => !r.accountId || !r.amount || !r.side);
    if (invalid.length > 0) {
      res.status(400).json({
        error: `${invalid.length} fila(s) no tienen accountId. Usa el selector de cuenta en el preview.`,
        code: 'MISSING_ACCOUNT',
        invalidRows: invalid.map((r: any, i: number) => ({ index: i, accountName: r.accountName })),
      });
      return;
    }

    // Calcular totales
    const totalDebit = rows
      .filter((r: any) => r.side === 'Debe')
      .reduce((s: number, r: any) => s + r.amount, 0);
    const totalCredit = rows
      .filter((r: any) => r.side === 'Haber')
      .reduce((s: number, r: any) => s + r.amount, 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      res.status(400).json({
        error: `El balance no cuadra. Débitos: ${totalDebit.toFixed(2)}, Créditos: ${totalCredit.toFixed(2)}. Diferencia: ${(totalDebit - totalCredit).toFixed(2)}`,
        code: 'UNBALANCED',
        totalDebit, totalCredit,
        success: 0, total: rows.length,
      });
      return;
    }

    // Verificar cuota
    const sub = (req as any).subscription;
    if (sub) {
      const remaining = sub.movementsLimit - sub.movementsUsed;
      if (remaining < 1) {
        res.status(429).json({
          error: 'No tienes movimientos disponibles en tu plan.',
          code: 'QUOTA_EXCEEDED',
        });
        return;
      }
    }

    // Crear UN solo JournalEntry
    const entry = await req.prisma.journalEntry.create({
      data: {
        date: toLocalDate(date),
        description: `Carga Inicial - ${date}`,
        status: 'BORRADOR',
        companyId: req.user!.companyId,
        createdById: req.user!.userId,
        lines: {
          create: rows.map((r: any) => ({
            accountId: r.accountId,
            debit: r.side === 'Debe' ? r.amount : 0,
            credit: r.side === 'Haber' ? r.amount : 0,
          })),
        },
      },
    });

    try { await incrementUsage(req); } catch { /* quota exhausted */ }

    res.json({
      success: 1,
      errors: [],
      total: rows.length,
      entryIds: [entry.id],
      description: `Carga Inicial: ${rows.length} cuentas cargadas al ${date}`,
      totalDebit,
      totalCredit,
    });
  } catch (error: any) {
    console.error('[Import] Carga inicial execute error:', error);
    res.status(500).json({
      error: 'Error interno al crear la carga inicial.',
      detail: error?.message,
    });
  }
});

// ── Helpers cobros / pagos a facturas ──

interface CobroAccount {
  id: string;
  code: string;
  name: string;
  aliases: string[];
}

interface CobroInvoiceLite {
  id: string;
  number: string;
  clientName: string | null;
  total: number;
  paidAmount: number;
  paymentMethod: string | null;
  status: string;
}

const COBRO_EPS = 0.01;

/** Fila del archivo maestro sin "Fecha de Pago" NI "Cuenta" → factura aún NO pagada (se omite, no es error). */
function isCobroPending(row: CobrosRow): boolean {
  return !row.paymentDate && !row.accountName;
}

/**
 * Validación a nivel archivo: las columnas "Fecha de Pago" y "Cuenta"
 * (banco/caja) son obligatorias para cargar cobros — las filas de facturas
 * aún no pagadas se dejan con esas celdas vacías y se omiten automáticamente.
 */
function assertCobrosFileColumns(parsed: CobrosParseResult): void {
  if (!parsed.hasPaymentDateCol || !parsed.hasAccountCol) {
    throw new Error(
      'El archivo de pagos debe incluir las columnas "Fecha de Pago" y "Cuenta" (banco/caja). ' +
      'Deje vacías esas celdas en las facturas que aún no han recibido su pago: se omitirán como pendientes.',
    );
  }
}

/** Clave de dedupe de un pago: factura + monto (en céntimos) + cuenta + fecha. */
function cobroDupKey(invoiceId: string, amount: number, accountId: string, dateStr: string): string {
  return `${invoiceId}|${Math.round(r2(amount) * 100)}|${accountId}|${dateStr}`;
}

/** Fecha "YYYY-MM-DD" local de un Date (los InvoicePayment se guardan a mediodía local). */
function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Índice de pagos ya registrados en BD (invoiceId → Set de claves de dedupe):
 * permite re-subir el archivo maestro sin duplicar abonos idénticos.
 * La simulación añade al índice los pagos que aplica (dedupe también dentro
 * del mismo archivo).
 */
async function buildCobroPaymentsIndex(prisma: any, companyId: string): Promise<Map<string, Set<string>>> {
  const payments = await prisma.invoicePayment.findMany({
    where: { companyId },
    select: { invoiceId: true, amount: true, accountId: true, date: true },
  });
  const index = new Map<string, Set<string>>();
  for (const p of payments) {
    if (!p.invoiceId || !p.accountId) continue;
    const key = cobroDupKey(p.invoiceId, p.amount, p.accountId, localDateKey(p.date));
    if (!index.has(p.invoiceId)) index.set(p.invoiceId, new Set());
    index.get(p.invoiceId)!.add(key);
  }
  return index;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Normaliza texto para comparar nombres: minúsculas, sin acentos ni puntuación. */
function normalizeNameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza a solo letras para comparación de tokens (palabra a palabra). */
function wordKey(w: string): string {
  return w.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

async function loadCobroAccounts(prisma: any, companyId: string): Promise<CobroAccount[]> {
  return prisma.account.findMany({
    where: { companyId },
    select: { id: true, code: true, name: true, aliases: true },
  });
}

async function loadCobroInvoices(
  prisma: any,
  companyId: string,
): Promise<{ list: CobroInvoiceLite[]; byId: Map<string, CobroInvoiceLite> }> {
  const rows = await prisma.invoice.findMany({
    where: { companyId },
    select: {
      id: true, number: true, total: true, paidAmount: true, paymentMethod: true, status: true,
      client: { select: { name: true } },
    },
  });
  const list: CobroInvoiceLite[] = rows.map((r: any) => ({
    id: r.id,
    number: r.number,
    clientName: r.client?.name || null,
    total: r.total,
    paidAmount: r.paidAmount,
    paymentMethod: r.paymentMethod,
    status: r.status,
  }));
  const byId = new Map(list.map(i => [i.id, i]));
  return { list, byId };
}

/**
 * Resuelve la cuenta de destino del depósito desde el texto del archivo:
 * 1. coincidencia exacta con código/alias/nombre (sin acentos ni símbolos),
 * 2. tolerante a typos ("Bnaco General" → "Banco General"): por tokens con
 *    distancia de edición ≤ 1 en palabras de ≥ 4 letras, cobertura completa
 *    de ambos lados y menor distancia total.
 */
function resolveCobroAccount(accounts: CobroAccount[], raw: string | null): CobroAccount | null {
  if (!raw) return null;
  const input = raw.trim();
  if (!input) return null;

  // 1) Exacta: código, alias o nombre, normalizados (sin acentos ni símbolos)
  const want = wordKey(input).replace(/\s+/g, '');
  for (const a of accounts) {
    const keys = [a.code, a.name, ...(a.aliases || [])];
    for (const k of keys) {
      if (wordKey(k).replace(/\s+/g, '') === want) return a;
    }
  }

  // 2) Tolerante a typos. IMPORTANTE: se normaliza conservando los espacios
  // (normalizeNameKey) — wordKey elimina todo lo no alfanumérico y colapsaría
  // "Banco de Panama" a un solo token "bancodepanama".
  const inputWords = normalizeNameKey(input).split(/\s+/).filter(w => w.length >= 2);
  if (inputWords.length === 0) return null;

  const wordMatch = (a: string, b: string): boolean => {
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true; // "bancos" vs "banco"
    if (a.length >= 5 && b.length >= 5 && levenshtein(a, b) <= 2) return true; // "Bnaco" ↔ "Banco" (transposición)
    return a.length >= 4 && b.length >= 4 && levenshtein(a, b) <= 1;
  };

  let best: { account: CobroAccount; dist: number } | null = null;

  for (const acc of accounts) {
    const accWords = [
      ...normalizeNameKey(acc.name).split(/\s+/).filter(w => w.length >= 2),
      ...(acc.aliases || []).map(normalizeNameKey).flatMap(a => a.split(/\s+/)).filter(w => w.length >= 2),
    ];
    if (accWords.length === 0) continue;

    // Cobertura completa de ambos lados
    const inputOk = inputWords.every(iw => accWords.some(aw => wordMatch(iw, aw)));
    const accOk = accWords.every(aw => inputWords.some(iw => wordMatch(iw, aw)));
    if (!inputOk || !accOk) continue;

    // Menor distancia total (suma del mejor match por token de entrada)
    let dist = 0;
    for (const iw of inputWords) {
      let bestWord = Infinity;
      for (const aw of accWords) bestWord = Math.min(bestWord, levenshtein(iw, aw));
      dist += bestWord;
    }
    if (!best || dist < best.dist || (dist === best.dist && acc.name.length < best.account.name.length)) {
      best = { account: acc, dist };
    }
  }

  return best ? best.account : null;
}

/** Cuenta contrapartida del cobro: la de Clientes (alias "clientes"). */
function findClientsAccount(accounts: CobroAccount[]): CobroAccount | null {
  for (const a of accounts) {
    const aliases = (a.aliases || []).map(normalizeNameKey);
    if (aliases.includes('clientes')) return a;
  }
  for (const a of accounts) {
    const nk = normalizeNameKey(a.name);
    if (nk.includes('clientes') || nk.includes('cuentas por cobrar')) return a;
  }
  return null;
}

function digitsOf(s: string): string { return (s || '').replace(/\D/g, ''); }
function stripZeros(s: string): string { return s.replace(/^0+/, ''); }

/** Match de la factura por Nº exacto; si no, por dígitos (A-001003 ↔ 1003). */
function matchCobroInvoice(
  invoices: CobroInvoiceLite[],
  rawNumber: string,
): { invoice: CobroInvoiceLite; via: 'exact' | 'digits' } | { error: string } {
  const number = (rawNumber || '').trim();
  const exact = invoices.filter(i => i.number.trim() === number);

  if (exact.length === 1) return { invoice: exact[0], via: 'exact' };
  if (exact.length > 1) return { error: `El Nº de factura "${number}" es ambiguo (${exact.length} coincidencias).` };

  const digits = stripZeros(digitsOf(number));
  if (digits.length > 0) {
    const byDigits = invoices.filter(i => stripZeros(digitsOf(i.number)) === digits);
    if (byDigits.length === 1) return { invoice: byDigits[0], via: 'digits' };
    if (byDigits.length > 1) return { error: `El Nº de factura "${number}" es ambiguo (${byDigits.length} coincidencias).` };
  }
  return { error: `No se encontró la factura Nº "${number}".` };
}

export interface CobroValidation {
  ok: boolean;
  message: string;
  code?: string;
  invoice?: CobroInvoiceLite;
  viaDigits?: boolean;
  amount?: number;
  dateStr?: string;
  account?: CobroAccount;
  clientsAccount?: CobroAccount;
  saldoBefore?: number;
  saldoAfter?: number;
}

/**
 * Valida una fila de cobro contra catálogo + facturas (sin escribir nada).
 * Solo "Fecha de Pago" marca un cobro (sin fallback a la fecha de la factura);
 * una factura ya pagada o un abono idéntico ya registrado devuelven
 * code 'ALREADY_APPLIED' → el llamador la OMITE (no es error) — re-subidas
 * del archivo maestro son idempotentes.
 */
function validateCobroRow(
  row: CobrosRow,
  accounts: CobroAccount[],
  invoices: CobroInvoiceLite[],
  dupKeysByInvoice?: Map<string, Set<string>>,
): CobroValidation {
  const dateStr = row.paymentDate;
  const amount = row.amount != null && row.amount > 0 ? r2(row.amount) : null;

  const missing: string[] = [];
  if (!dateStr) missing.push('fecha de pago');
  if (!row.invoiceNumber) missing.push('Nº de factura');
  if (amount == null) missing.push('monto');
  if (!row.accountName) missing.push('cuenta');
  if (missing.length > 0) {
    return { ok: false, code: 'MISSING_FIELDS', message: `Faltan datos obligatorios: ${missing.join(', ')}` };
  }

  const account = resolveCobroAccount(accounts, row.accountName!);
  if (!account) {
    return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: `Cuenta contable no encontrada: "${row.accountName}". Revise la columna Cuenta o cree la cuenta en el catálogo.` };
  }

  const clientsAccount = findClientsAccount(accounts);
  if (!clientsAccount) {
    return { ok: false, code: 'CLIENTS_ACCOUNT_NOT_FOUND', message: 'No se encontró la cuenta Clientes (alias "clientes") en el catálogo.' };
  }

  const match = matchCobroInvoice(invoices, row.invoiceNumber!);
  if ('error' in match) return { ok: false, code: 'INVOICE_NOT_FOUND', message: match.error };
  const { invoice, via } = match;

  // El RUC está cifrado en BD (crypto-fields): se valida por Nº + nombre normalizado
  if (row.client && invoice.clientName) {
    if (normalizeNameKey(row.client) !== normalizeNameKey(invoice.clientName)) {
      return {
        ok: false, code: 'INVOICE_CLIENT_MISMATCH',
        message: `La factura ${invoice.number} corresponde a "${invoice.clientName}", no a "${row.client}".`,
      };
    }
  }

  if (invoice.paymentMethod === 'EFECTIVO') {
    return {
      ok: false, code: 'CASH_SALE',
      message: `La factura ${invoice.number} es de contado (EFECTIVO) y no admite abonos.`,
    };
  }

  const saldo = r2(invoice.total - invoice.paidAmount);
  if (saldo <= COBRO_EPS) {
    return { ok: false, code: 'ALREADY_APPLIED', message: `La factura ${invoice.number} ya está pagada (se omite).` };
  }
  const dupKey = cobroDupKey(invoice.id, amount!, account.id, dateStr!);
  if (dupKeysByInvoice?.get(invoice.id)?.has(dupKey)) {
    return { ok: false, code: 'ALREADY_APPLIED', message: `El abono de $${amount!.toFixed(2)} a la factura ${invoice.number} ya está registrado (se omite).` };
  }
  if (amount! > saldo + COBRO_EPS) {
    return {
      ok: false, code: 'EXCEEDS_BALANCE',
      message: `El abono de $${amount!.toFixed(2)} excede el saldo de la factura ${invoice.number} ($${saldo.toFixed(2)}).`,
    };
  }

  return {
    ok: true,
    message: '',
    invoice,
    viaDigits: via === 'digits',
    amount: amount!,
    dateStr: dateStr!,
    account,
    clientsAccount,
    saldoBefore: saldo,
    saldoAfter: r2(saldo - amount!),
  };
}

/** Cuenta destino caja vs banco: deriva el paymentMethod de la transacción. */
function cobroPaymentMethod(account: CobroAccount): string {
  const nk = normalizeNameKey(`${account.code} ${account.name} ${(account.aliases || []).join(' ')}`);
  return nk.includes('caja') ? 'EFECTIVO' : 'BANCO';
}

interface CobroPreviewRow {
  row: number;
  status: 'ok' | 'error' | 'pending' | 'omitted';
  code?: string;
  error?: string;
  fileNumber: string | null;
  number: string | null;         // Nº real en BD (si se encontró)
  viaDigits: boolean;
  clientFile: string | null;
  clientMatched: string | null;
  date: string | null;
  amount: number | null;
  accountName: string | null;
  accountCode: string | null;    // código de la cuenta contable resuelta
  saldoBefore: number | null;
  saldoAfter: number | null;
  paid: boolean;
}

/**
 * Simula el batch completo en orden sobre un snapshot en memoria (no escribe):
 * cada abono válido descuenta del saldo acumulado del snapshot, así un segundo
 * abono a la misma factura ve el saldo del primero — igual que la ejecución real.
 */
export async function simulateCobrosFile(
  prisma: any,
  companyId: string,
  rows: CobrosRow[],
): Promise<{
  rows: CobroPreviewRow[];
  errors: { row: number; error: string }[];
  pending: number;
  omitted: number;
  appliedTotal: number;
  markedPaid: number;
}> {
  const accounts = await loadCobroAccounts(prisma, companyId);
  const { list } = await loadCobroInvoices(prisma, companyId);
  // Pagos ya registrados en BD: re-subidas idempotentes (misma factura+monto+cuenta+fecha)
  const dupKeys = await buildCobroPaymentsIndex(prisma, companyId);

  // Snapshot de trabajo: paidAmount mutable por fila aplicada
  const working = list.map(i => ({ ...i }));
  const detail: CobroPreviewRow[] = [];
  const errors: { row: number; error: string }[] = [];
  let pending = 0;
  let omitted = 0;
  let appliedTotal = 0;
  let markedPaid = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    // Sin "Fecha de Pago" ni "Cuenta" → la factura aún no ha recibido su pago:
    // se omite (pendiente), no es error y no consume nada.
    if (isCobroPending(row)) {
      pending++;
      detail.push({
        row: rowNum, status: 'pending', code: 'PENDING',
        fileNumber: row.invoiceNumber, number: null, viaDigits: false,
        clientFile: row.client, clientMatched: null,
        date: null, amount: null, accountName: null, accountCode: null,
        saldoBefore: null, saldoAfter: null, paid: false,
      });
      continue;
    }

    const validation = validateCobroRow(row, accounts, working, dupKeys);
    const base: CobroPreviewRow = {
      row: rowNum,
      status: validation.ok ? 'ok' : validation.code === 'ALREADY_APPLIED' ? 'omitted' : 'error',
      code: validation.code,
      error: validation.message,
      fileNumber: row.invoiceNumber,
      number: validation.invoice?.number || null,
      viaDigits: !!validation.viaDigits,
      clientFile: row.client,
      clientMatched: validation.invoice?.clientName || null,
      date: row.paymentDate,
      amount: validation.ok ? validation.amount! : row.amount ?? null,
      accountName: row.accountName,
      accountCode: validation.ok ? validation.account!.code : null,
      saldoBefore: validation.ok ? validation.saldoBefore! : null,
      saldoAfter: validation.ok ? validation.saldoAfter! : null,
      paid: false,
    };

    if (validation.ok && validation.invoice) {
      // Aplicar al snapshot para las filas siguientes del mismo lote
      const inv = working.find(w => w.id === validation.invoice!.id)!;
      inv.paidAmount = r2(inv.paidAmount + validation.amount!);
      // Registrar la clave en el índice: dos filas idénticas del MISMO archivo
      // → la segunda se omite como ya aplicada
      const key = cobroDupKey(validation.invoice.id, validation.amount!, validation.account!.id, validation.dateStr!);
      if (!dupKeys.has(validation.invoice.id)) dupKeys.set(validation.invoice.id, new Set());
      dupKeys.get(validation.invoice.id)!.add(key);
      const paid = validation.saldoAfter! <= COBRO_EPS;
      base.paid = paid;
      appliedTotal = r2(appliedTotal + validation.amount!);
      if (paid) markedPaid++;
    } else if (validation.code === 'ALREADY_APPLIED') {
      omitted++;
    } else {
      errors.push({ row: rowNum, error: validation.message });
    }

    detail.push(base);
  }

  return { rows: detail, errors, pending, omitted, appliedTotal, markedPaid };
}

// Manejo de errores de multer
importRouter.use((err: any, _req: any, res: any, _next: any) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(400).json({ error: 'El archivo es demasiado grande. Máximo 10MB.' });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err) {
    res.status(400).json({ error: err.message });
    return;
  }
});
