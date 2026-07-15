import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';

export const apiKeysRouter = Router();

// Todas las rutas requieren autenticación
apiKeysRouter.use(requireAuth);

/**
 * GET /api/keys — Listar API Keys del usuario (sin hash, solo metadatos)
 */
apiKeysRouter.get('/', async (req, res) => {
  const keys = await req.prisma.apiKey.findMany({
    where: { companyId: req.user!.companyId },
    select: {
      id: true,
      name: true,
      prefix: true,
      truncated: true,
      lastUsedAt: true,
      createdAt: true,
      expiresAt: true,
      isRevoked: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  res.json(keys);
});

/**
 * POST /api/keys — Generar nueva API Key
 * Body: { name: string }
 * Retorna la llave completa UNA SOLA VEZ
 */
apiKeysRouter.post('/', async (req, res) => {
  const { name } = req.body;

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'El nombre de la API Key es requerido (ej: "Producción", "Zapier")' });
    return;
  }

  // 1. Generar token aleatorio seguro (32 bytes = 64 caracteres hex)
  const rawToken = crypto.randomBytes(32).toString('hex');
  const apiKey = `sk_live_${rawToken}`;

  // 2. Versión truncada para mostrar en el dashboard
  const truncated = `${apiKey.slice(0, 15)}...${apiKey.slice(-4)}`;

  // 3. Hash SHA-256 para almacenar (nunca guardamos la llave en texto plano)
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // 4. Guardar solo el hash
  const key = await req.prisma.apiKey.create({
    data: {
      companyId: req.user!.companyId,
      name: name.trim(),
      keyHash,
      prefix: 'sk_live_',
      truncated,
    },
    select: {
      id: true,
      name: true,
      truncated: true,
      createdAt: true,
    },
  });

  // 5. Retornar la llave real SOLO ESTA VEZ
  res.status(201).json({
    key: {
      id: key.id,
      name: key.name,
      truncated: key.truncated,
      createdAt: key.createdAt,
    },
    apiKey, // ← El cliente debe copiarla AHORA. No se volverá a mostrar.
  });
});

/**
 * DELETE /api/keys/:id — Revocar API Key
 */
apiKeysRouter.delete('/:id', async (req, res) => {
  const key = await req.prisma.apiKey.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });

  if (!key) {
    res.status(404).json({ error: 'API Key no encontrada' });
    return;
  }

  await req.prisma.apiKey.update({
    where: { id: key.id },
    data: { isRevoked: true },
  });

  res.json({ message: 'API Key revocada exitosamente', id: key.id, name: key.name });
});
