import { Router } from 'express';
import { OrchestratorAgent } from '@agt-contador/agents';
import { validate } from '../middleware/validate';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { orchestrateSchema, orchestrateConfirmSchema } from '../validation/schemas';

export const orchestrateRouter = Router();

/**
 * Traduce errores técnicos a mensajes amigables para el usuario.
 */
function friendlyError(err: any): { status: number; userMessage: string; detail: string; contactSupport: boolean } {
  const msg = err?.message || String(err);

  // Errores de DeepSeek / LLM
  if (msg.includes('Authentication Fails') || msg.includes('api key') || msg.includes('401')) {
    return {
      status: 503,
      userMessage: 'El servicio de inteligencia artificial no está disponible en este momento.',
      detail: 'La clave de API del servicio IA no es válida o ha expirado.',
      contactSupport: true,
    };
  }
  if (msg.includes('Rate limit') || msg.includes('429') || msg.includes('rate_limit')) {
    return {
      status: 503,
      userMessage: 'El servicio de IA está temporalmente saturado. Intenta de nuevo en unos segundos.',
      detail: msg,
      contactSupport: false,
    };
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) {
    return {
      status: 503,
      userMessage: 'No se pudo conectar con el servicio de IA. Revisa tu conexión e inténtalo de nuevo.',
      detail: msg,
      contactSupport: false,
    };
  }

  // Errores de base de datos
  if (msg.includes('Cuenta contable no encontrada') || msg.includes('Account not found')) {
    return {
      status: 400,
      userMessage: 'No se encontró una cuenta contable para este concepto. Ve a Administración > Cuentas para verificar que tu plan de cuentas esté completo.',
      detail: msg,
      contactSupport: false,
    };
  }
  if (msg.includes('Can\'t reach database') || msg.includes('PrismaClient')) {
    return {
      status: 503,
      userMessage: 'El servicio no está disponible en este momento. Estamos trabajando para resolverlo.',
      detail: msg,
      contactSupport: true,
    };
  }

  // Errores de validación / lógica
  if (msg.includes('No se pudo determinar') || msg.includes('missingFields')) {
    return {
      status: 422,
      userMessage: msg,
      detail: msg,
      contactSupport: false,
    };
  }

  // Error desconocido
  return {
    status: 500,
    userMessage: 'Ocurrió un error inesperado al procesar tu solicitud. Por favor, inténtalo de nuevo.',
    detail: msg,
    contactSupport: true,
  };
}

orchestrateRouter.post('/', validate(orchestrateSchema), async (req, res) => {
  const { input, context } = req.body;

  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  const orchestrator = new OrchestratorAgent({
    prisma: req.prisma,
    companyId: req.user!.companyId,
    userId: req.user!.userId,
    deepseekApiKey,
  });

  try {
    const result = await orchestrator.process(input, context);
    res.json(result);
  } catch (error: any) {
    const fe = friendlyError(error);
    console.error('[Orchestrate] Error:', fe.detail);
    res.status(fe.status).json({
      error: fe.userMessage,
      detail: fe.detail,
      contactSupport: fe.contactSupport,
    });
  }
});

orchestrateRouter.post('/confirm', requireQuota, validate(orchestrateConfirmSchema), async (req, res) => {
  const { result } = req.body;

  const deepseekApiKey = process.env.DEEPSEEK_API_KEY;
  const orchestrator = new OrchestratorAgent({
    prisma: req.prisma,
    companyId: req.user!.companyId,
    userId: req.user!.userId,
    deepseekApiKey,
  });

  try {
    const saved = await orchestrator.confirm(result);

    // Incrementar contador de uso
    await incrementUsage(req);

    res.json(saved);
  } catch (error: any) {
    const fe = friendlyError(error);
    console.error('[Orchestrate/Confirm] Error:', fe.detail);
    res.status(fe.status).json({
      error: fe.userMessage,
      detail: fe.detail,
      contactSupport: fe.contactSupport,
    });
  }
});
