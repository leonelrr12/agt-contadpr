import type { PrismaClient } from '@agt-contador/prisma-schema';

/**
 * Registra una acción en el AuditLog.
 */
export async function logAudit(
  prisma: PrismaClient,
  params: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entity: params.entity,
        entityId: params.entityId,
        before: params.before ? JSON.stringify(params.before) : null,
        after: params.after ? JSON.stringify(params.after) : null,
      },
    });
  } catch (e) {
    // No interrumpir la operación principal si falla el log
    console.error('[AuditLog] Error al registrar:', e);
  }
}
