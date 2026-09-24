import { Router } from 'express';
import { getSaludFinanciera, normalizarMeses } from '../services/salud';

export const saludRouter = Router();

/**
 * GET /api/salud — salud financiera: ratios, proyección de caja, alertas por
 * reglas y narrativa IA (DeepSeek, con fallback sin LLM).
 * Query opcional: ?refresh=1 (bypassa la caché de 5 minutos) y ?meses=3|6|12
 * (horizonte de la proyección; cualquier otro valor cae a 3 sin dar error).
 */
saludRouter.get('/', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const meses = normalizarMeses(req.query.meses);
    const data = await getSaludFinanciera(req.prisma, req.user!.companyId, { refresh, meses });
    res.json(data);
  } catch (error: any) {
    console.error('[Salud] Error:', error?.message);
    res.status(500).json({ error: 'Error al calcular la salud financiera', detail: error?.message });
  }
});
