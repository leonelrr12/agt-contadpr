import { Router } from 'express';
import { OrchestratorAgent } from '@agt-contador/agents';
import { validate } from '../middleware/validate';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { orchestrateSchema, orchestrateConfirmSchema } from '../validation/schemas';

export const orchestrateRouter = Router();

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
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});
