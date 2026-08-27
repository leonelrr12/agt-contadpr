import { Router } from 'express';
import { requireQuota } from '../middleware/quota';
import { logAudit } from '../services/audit-log';
import { closeYear, computeYearBalances } from '../services/year-close';

export const yearCloseRouter = Router();

const YEAR_RE = /^\d{4}$/;

function resumenConTipo(balances: any) {
  return {
    totalIngresos: balances.totalIngresos,
    totalCostos: balances.totalCostos,
    totalGastos: balances.totalGastos,
    utilidadNeta: balances.utilidadNeta,
    pendientesRevision: balances.pendientesRevision || 0,
    saldosInvertidos: balances.saldosInvertidos || [],
    tipo: balances.utilidadNeta >= 0 ? 'GANANCIA' : 'PERDIDA',
  };
}

/** POST /api/year-close/:year — cierra el año fiscal (asiento CONFIRMADO isClosing). */
yearCloseRouter.post('/:year', requireQuota, async (req, res) => {
  const { year } = req.params;
  if (!YEAR_RE.test(year)) {
    res.status(400).json({ error: 'Año inválido. Formato: YYYY' });
    return;
  }
  try {
    const { entry, balances } = await closeYear(req.prisma, req.user!.companyId, req.user!.userId, year);

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'YEAR_CLOSED',
      entity: 'JournalEntry',
      entityId: entry.id,
      before: { year },
      after: { utilidadNeta: balances.utilidadNeta, lineCount: entry.lines.length },
    });

    res.status(201).json({
      year,
      cerrado: true,
      entry,
      resumen: resumenConTipo(balances),
    });
  } catch (e: any) {
    const status = e.status || 500;
    res.status(status).json({ error: e.message });
  }
});

/** GET /api/year-close/:year — estado del cierre del año. */
yearCloseRouter.get('/:year', async (req, res) => {
  const { year } = req.params;
  if (!YEAR_RE.test(year)) {
    res.status(400).json({ error: 'Año inválido. Formato: YYYY' });
    return;
  }
  try {
    const [existing, balances] = await Promise.all([
      req.prisma.journalEntry.findFirst({
        where: { companyId: req.user!.companyId, period: year, isClosing: true },
        // El MÁS RECIENTE: puede haber uno ANULADO y otro CONFIRMADO (re-cierre)
        orderBy: { createdAt: 'desc' },
        include: { lines: { include: { account: true } } },
      }),
      computeYearBalances(req.prisma, req.user!.companyId, year),
    ]);

    res.json({
      year,
      cerrado: !!existing && existing.status !== 'ANULADO',
      status: existing?.status || null,
      entry: existing || null,
      resumen: resumenConTipo(balances),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Gestión desde el Panel Admin de la empresa ──

const YEAR_CLOSE_KEY = process.env.YEAR_CLOSE_KEY || 'cierre123';

/** GET /api/year-close — lista los asientos de cierre de la empresa actual. */
yearCloseRouter.get('/', async (req, res) => {
  const entries = await req.prisma.journalEntry.findMany({
    where: { companyId: req.user!.companyId, isClosing: true },
    include: { lines: { select: { debit: true, credit: true } } },
    orderBy: { date: 'desc' },
  });
  res.json(entries.map((e: any) => ({
    id: e.id,
    period: e.period,
    date: e.date,
    status: e.status,
    description: e.description,
    lineCount: e.lines.length,
    totalDebit: Math.round(e.lines.reduce((s: number, l: any) => s + l.debit, 0) * 100) / 100,
    totalCredit: Math.round(e.lines.reduce((s: number, l: any) => s + l.credit, 0) * 100) / 100,
  })));
});

/**
 * POST /api/year-close/:id/anular — anula un asiento de cierre de la empresa
 * (requiere clave YEAR_CLOSE_KEY). Marca ANULADO sin reversión y libera la
 * guardia para re-cerrar desde Calendario Fiscal.
 */
yearCloseRouter.post('/:id/anular', async (req, res) => {
  const { clave } = req.body || {};
  if (clave !== YEAR_CLOSE_KEY) {
    res.status(403).json({ error: 'Clave incorrecta.' });
    return;
  }
  const entry = await req.prisma.journalEntry.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId, isClosing: true },
  });
  if (!entry) {
    res.status(404).json({ error: 'Asiento de cierre no encontrado' });
    return;
  }
  if (entry.status === 'ANULADO') {
    res.status(400).json({ error: 'El asiento de cierre ya está anulado' });
    return;
  }
  const updated = await req.prisma.journalEntry.update({
    where: { id: entry.id },
    data: { status: 'ANULADO' },
  });
  await logAudit(req.prisma, {
    userId: req.user!.userId,
    action: 'YEAR_CLOSE_ANNULED',
    entity: 'JournalEntry',
    entityId: entry.id,
    before: { status: entry.status, period: entry.period },
    after: { status: 'ANULADO' },
  }).catch(() => {});
  res.json({ success: true, entry: { id: updated.id, period: updated.period, status: updated.status } });
});
