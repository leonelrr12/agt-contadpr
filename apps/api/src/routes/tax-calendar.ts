import { Router } from 'express';
import { generateUpcomingObligations, getTaxCalendarSummary } from '../services/tax-calendar';

export const taxCalendarRouter = Router();

// GET /api/tax-calendar — resumen completo
taxCalendarRouter.get('/', async (req, res) => {
  try {
    // Generar obligaciones pendientes si no existen
    await generateUpcomingObligations(req.prisma, req.user!.companyId);

    const summary = await getTaxCalendarSummary(req.prisma, req.user!.companyId);
    res.json(summary);
  } catch (error: any) {
    console.error('[TaxCalendar] Error:', error);
    res.status(500).json({ error: 'Error al cargar el calendario fiscal', detail: error?.message });
  }
});

// PATCH /api/tax-calendar/:id — actualizar estado o monto
taxCalendarRouter.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const { status, actualAmount, notes } = req.body;

  const obl = await req.prisma.taxObligation.findFirst({
    where: { id, companyId: req.user!.companyId },
  });
  if (!obl) { res.status(404).json({ error: 'Obligación no encontrada' }); return; }

  const data: any = {};
  if (status) {
    data.status = status;
    if (status === 'COMPLETED') data.completedAt = new Date();
    if (status === 'PENDING') data.completedAt = null;
  }
  if (actualAmount !== undefined) data.actualAmount = actualAmount;
  if (notes !== undefined) data.notes = notes;

  const updated = await req.prisma.taxObligation.update({ where: { id }, data });
  res.json(updated);
});

// POST /api/tax-calendar/regenerate — fuerza regeneración de obligaciones
taxCalendarRouter.post('/regenerate', async (req, res) => {
  try {
    const count = await generateUpcomingObligations(req.prisma, req.user!.companyId);
    const summary = await getTaxCalendarSummary(req.prisma, req.user!.companyId);
    res.json({ ...summary, generated: count });
  } catch (error: any) {
    res.status(500).json({ error: error?.message });
  }
});
