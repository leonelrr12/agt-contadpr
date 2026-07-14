import { Router } from 'express';

export const configRouter = Router();

configRouter.get('/', (_req, res) => {
  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
  });
});

configRouter.put('/', (req, res) => {
  const { itbmsRate, itbmsEnabled } = req.body;

  if (itbmsRate !== undefined) {
    const rate = parseFloat(String(itbmsRate));
    if (isNaN(rate) || rate < 0 || rate > 20) {
      res.status(400).json({ error: 'Tasa de ITBMS debe estar entre 0 y 20' });
      return;
    }
    process.env.ITBMS_RATE = String(rate);
  }

  if (itbmsEnabled !== undefined) {
    process.env.ITBMS_ENABLED = itbmsEnabled ? 'true' : 'false';
  }

  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
  });
});
