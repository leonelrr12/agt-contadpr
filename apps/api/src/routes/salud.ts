import { Router } from 'express';
import { getSaludFinanciera } from '../services/salud';

export const saludRouter = Router();

/**
 * GET /api/salud — salud financiera: ratios, proyección de caja 3 meses,
 * alertas por reglas y narrativa IA (DeepSeek, con fallback sin LLM).
 * Query opcional: ?refresh=1 (bypassa la caché de 5 minutos).
 */
saludRouter.get('/', async (req, res) => {
  try {
    const refresh = req.query.refresh === '1';
    const data = await getSaludFinanciera(req.prisma, req.user!.companyId, { refresh });
    res.json(data);
  } catch (error: any) {
    console.error('[Salud] Error:', error?.message);
    res.status(500).json({ error: 'Error al calcular la salud financiera', detail: error?.message });
  }
});
