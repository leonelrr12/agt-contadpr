import { Router } from 'express';

export const configRouter = Router();

/** Público: número de WhatsApp del bot (no requiere autenticación). */
export const publicConfigRouter = Router();
publicConfigRouter.get('/wa-phone', (_req, res) => {
  res.json({ phone: process.env.WA_BOT_PHONE || '+507 6403-4863' });
});

configRouter.get('/', async (req, res) => {
  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { declaraITBMS: true },
  });
  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
    declaraITBMS: company?.declaraITBMS ?? true,
    waBotPhone: process.env.WA_BOT_PHONE || '+507 6403-4863',
  });
});

configRouter.put('/', async (req, res) => {
  const { itbmsRate, itbmsEnabled, declaraITBMS } = req.body;

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

  if (declaraITBMS !== undefined) {
    await req.prisma.company.update({
      where: { id: req.user!.companyId },
      data: { declaraITBMS: !!declaraITBMS },
    });
  }

  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { declaraITBMS: true },
  });
  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
    declaraITBMS: company?.declaraITBMS ?? true,
  });
});
