import { Router } from 'express';

export const configRouter = Router();

/**
 * Cuentas de planilla por columna del archivo maestro (Configuración →
 * Planilla). El campo en Company y la etiqueta legible para los errores.
 */
const PLANILLA_FIELDS: { field: string; label: string }[] = [
  { field: 'planillaSueldoId', label: 'Sueldo' },
  { field: 'planillaHorasExtrasId', label: 'Horas Extras' },
  { field: 'planillaDecimoId', label: 'Décimo III' },
  { field: 'planillaSSId', label: 'Seguro Social (SS)' },
  { field: 'planillaSEId', label: 'Seguro Educativo (SE)' },
  { field: 'planillaISRId', label: 'ISR' },
  { field: 'planillaBancoId', label: 'Neto a banco' },
];

const planillaSelect = Object.fromEntries(PLANILLA_FIELDS.map(f => [f.field, true]));

/**
 * Honorarios Profesionales (Configuración → Honorarios): cuenta del gasto
 * (DEBE) y del banco (HABER) que usa la carga masiva en Importar → Honorarios.
 */
const HONORARIOS_FIELDS: { field: string; label: string }[] = [
  { field: 'honorariosGastoId', label: 'Honorarios Profesionales (gasto)' },
  { field: 'honorariosBancoId', label: 'Banco (pago)' },
];

const honorariosSelect = Object.fromEntries(HONORARIOS_FIELDS.map(f => [f.field, true]));

/** Público: número de WhatsApp del bot (no requiere autenticación). */
export const publicConfigRouter = Router();
publicConfigRouter.get('/wa-phone', (_req, res) => {
  res.json({ phone: process.env.WA_BOT_PHONE || '+507 6403-4863' });
});

configRouter.get('/', async (req, res) => {
  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { declaraITBMS: true, bancoDefaultId: true, ...planillaSelect, ...honorariosSelect },
  });
  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
    declaraITBMS: company?.declaraITBMS ?? true,
    bancoDefaultId: company?.bancoDefaultId ?? null,
    waBotPhone: process.env.WA_BOT_PHONE || '+507 6403-4863',
    // Planilla (Configuración → Planilla): cuenta por cada columna del archivo
    planilla: Object.fromEntries(PLANILLA_FIELDS.map(f => [f.field, (company as any)?.[f.field] ?? null])),
    // Honorarios Profesionales (Configuración → Honorarios)
    honorarios: Object.fromEntries(HONORARIOS_FIELDS.map(f => [f.field, (company as any)?.[f.field] ?? null])),
  });
});

configRouter.put('/', async (req, res) => {
  const { itbmsRate, itbmsEnabled, declaraITBMS, bancoDefaultId } = req.body;

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

  if (bancoDefaultId !== undefined) {
    const bancoId = bancoDefaultId ? String(bancoDefaultId) : null;
    if (bancoId) {
      const acc = await req.prisma.account.findFirst({
        where: { id: bancoId, companyId: req.user!.companyId },
        select: { id: true },
      });
      if (!acc) {
        res.status(400).json({ error: 'La cuenta bancaria seleccionada no existe en esta empresa' });
        return;
      }
    }
    await req.prisma.company.update({
      where: { id: req.user!.companyId },
      data: { bancoDefaultId: bancoId },
    });
  }

  // Planilla: cuentas por columna (cada una debe existir en la empresa).
  // Acepta los campos planos o agrupados en "planilla": { planillaXxxId }.
  const planillaBody = (req.body as any).planilla ?? req.body;
  const planillaData: Record<string, string | null> = {};
  for (const { field, label } of PLANILLA_FIELDS) {
    const value = planillaBody[field];
    if (value === undefined) continue;
    const accId = value ? String(value) : null;
    if (accId) {
      const acc = await req.prisma.account.findFirst({
        where: { id: accId, companyId: req.user!.companyId },
        select: { id: true },
      });
      if (!acc) {
        res.status(400).json({ error: `La cuenta de "${label}" no existe en esta empresa` });
        return;
      }
    }
    planillaData[field] = accId;
  }
  if (Object.keys(planillaData).length > 0) {
    await req.prisma.company.update({
      where: { id: req.user!.companyId },
      data: planillaData,
    });
  }

  // Honorarios Profesionales: cuentas del gasto y del banco (existen en la empresa)
  const honorariosBody = (req.body as any).honorarios ?? req.body;
  const honorariosData: Record<string, string | null> = {};
  for (const { field, label } of HONORARIOS_FIELDS) {
    const value = honorariosBody[field];
    if (value === undefined) continue;
    const accId = value ? String(value) : null;
    if (accId) {
      const acc = await req.prisma.account.findFirst({
        where: { id: accId, companyId: req.user!.companyId },
        select: { id: true },
      });
      if (!acc) {
        res.status(400).json({ error: `La cuenta de "${label}" no existe en esta empresa` });
        return;
      }
    }
    honorariosData[field] = accId;
  }
  if (Object.keys(honorariosData).length > 0) {
    await req.prisma.company.update({
      where: { id: req.user!.companyId },
      data: honorariosData,
    });
  }

  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: { declaraITBMS: true, bancoDefaultId: true, ...planillaSelect, ...honorariosSelect },
  });
  res.json({
    itbmsRate: parseFloat(process.env.ITBMS_RATE || '') || 0.07,
    itbmsEnabled: process.env.ITBMS_ENABLED !== 'false',
    declaraITBMS: company?.declaraITBMS ?? true,
    bancoDefaultId: company?.bancoDefaultId ?? null,
    planilla: Object.fromEntries(PLANILLA_FIELDS.map(f => [f.field, (company as any)?.[f.field] ?? null])),
    honorarios: Object.fromEntries(HONORARIOS_FIELDS.map(f => [f.field, (company as any)?.[f.field] ?? null])),
  });
});
