import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requireRole } from '../middleware/auth';
import { createConceptSchema, updateConceptSchema } from '../validation/schemas';

export const conceptsRouter = Router();

/**
 * `keywords` vive como JSON en la BD, pero la API habla arrays: el panel muestra
 * las palabras separadas por coma y así se comparan (en minúsculas) contra el
 * texto de la factura.
 */
function parseKeywords(raw: unknown): string[] {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** Normaliza antes de guardar: minúsculas, sin repetir y sin vacías. */
function serializarKeywords(raw: string[]): string {
  return JSON.stringify([...new Set(raw.map(k => String(k).toLowerCase().trim()).filter(Boolean))]);
}

conceptsRouter.get('/', async (req, res) => {
  const concepts = await req.prisma.concept.findMany({
    where: { companyId: req.user!.companyId },
    include: { account: true },
    orderBy: { name: 'asc' },
  });
  res.json(concepts.map((c: any) => ({ ...c, keywords: parseKeywords(c.keywords) })));
});

conceptsRouter.post('/', requireRole('admin', 'superadmin'), validate(createConceptSchema), async (req, res) => {
  const { name, accountId, keywords } = req.body;
  const concept = await req.prisma.concept.create({
    data: {
      name, accountId, companyId: req.user!.companyId,
      ...(keywords !== undefined && { keywords: serializarKeywords(keywords) }),
    },
    include: { account: true },
  });
  res.status(201).json({ ...concept, keywords: parseKeywords(concept.keywords) });
});

conceptsRouter.put('/:id', requireRole('admin', 'superadmin'), validate(updateConceptSchema), async (req, res) => {
  const { name, accountId, isActive, keywords } = req.body;
  const concept = await req.prisma.concept.update({
    where: { id: req.params.id },
    data: {
      ...(name && { name }),
      ...(accountId && { accountId }),
      ...(isActive !== undefined && { isActive }),
      ...(keywords !== undefined && { keywords: serializarKeywords(keywords) }),
    },
  });
  res.json({ ...concept, keywords: parseKeywords(concept.keywords) });
});
