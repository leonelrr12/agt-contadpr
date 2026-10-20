/**
 * Configuración del PAC por empresa (Administración → Empresa).
 *
 * Solo `admin`/`superadmin`: son las credenciales fiscales del cliente, no del
 * contador que lleva sus libros. El módulo Facturas PDF es el que emite; sin el
 * add-on no se configura ni se prueba (misma regla que el resto del módulo).
 *
 * La API nunca devuelve la API key ni la contraseña Basic: solo `apiKeySet` y
 * `basicPasswordSet`. Para cambiarlas se envían; un campo vacío conserva la que
 * estaba guardada.
 */
import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { requireModulo } from '../middleware/modulo';
import { logAudit } from '../services/audit-log';
import { PacError } from '../services/pac';
import {
  getPacConfigView,
  savePacConfig,
  testPacConnection,
} from '../services/pac/company-config';
import type { PacConfigInput } from '../services/pac/company-config';

export const pacRouter = Router();

pacRouter.use(requireRole('admin', 'superadmin'));
pacRouter.use(requireModulo('facturas-pdf'));

function responderError(res: any, err: unknown, contexto: string): void {
  if (err instanceof PacError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`[PAC] ${contexto}:`, (err as Error)?.message);
  res.status(500).json({ error: `No se pudo ${contexto}. Probá de nuevo.` });
}

// GET /api/pac/config — ficha segura (sin secretos)
pacRouter.get('/config', async (req, res) => {
  try {
    const view = await getPacConfigView(req.prisma, req.user!.companyId);
    res.json(view);
  } catch (err) {
    responderError(res, err, 'cargar la configuración del PAC');
  }
});

// PUT /api/pac/config — crea o actualiza la ficha de la empresa
pacRouter.put('/config', async (req, res) => {
  try {
    const view = await savePacConfig(
      req.prisma,
      req.user!.companyId,
      (req.body ?? {}) as PacConfigInput,
    );

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'PAC_CONFIG_UPDATED',
      entity: 'PacConfig',
      entityId: req.user!.companyId,
      after: {
        provider: view.provider,
        environment: view.environment,
        companyUuid: view.companyUuid,
        pos: view.pos,
        branchUuid: view.branchUuid,
        branchCode: view.branchCode,
        basicUser: view.basicUser,
        enabled: view.enabled,
        apiKeySet: view.apiKeySet,
        basicPasswordSet: view.basicPasswordSet,
      },
    }).catch(() => {});

    res.json(view);
  } catch (err) {
    responderError(res, err, 'guardar la configuración del PAC');
  }
});

// POST /api/pac/config/test — prueba credenciales SIN emitir un documento
pacRouter.post('/config/test', async (req, res) => {
  try {
    const result = await testPacConnection(req.prisma, req.user!.companyId);

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'PAC_CONFIG_TESTED',
      entity: 'PacConfig',
      entityId: req.user!.companyId,
      after: { ok: result.ok, status: result.status ?? null },
    }).catch(() => {});

    res.json(result);
  } catch (err) {
    responderError(res, err, 'probar la conexión con el PAC');
  }
});
