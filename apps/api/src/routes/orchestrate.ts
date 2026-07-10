import { Router } from 'express';
import { OrchestratorAgent } from '@agt-contador/agents';

export const orchestrateRouter = Router();

orchestrateRouter.post('/', async (req, res) => {
  const { input, context } = req.body;
  if (!input) { res.status(400).json({ error: 'input is required' }); return; }

  const orchestrator = new OrchestratorAgent({
    prisma: req.prisma,
    companyId: 'demo-company',
  });

  try {
    const result = await orchestrator.process(input, context);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

orchestrateRouter.post('/confirm', async (req, res) => {
  const { result } = req.body;
  if (!result) { res.status(400).json({ error: `result required. Got body keys: ${Object.keys(req.body).join(',')}` }); return; }

  const orchestrator = new OrchestratorAgent({
    prisma: req.prisma,
    companyId: 'demo-company',
  });

  try {
    const saved = await orchestrator.confirm(result);
    res.json(saved);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
