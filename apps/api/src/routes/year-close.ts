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
