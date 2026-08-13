import type { PrismaClient } from '@agt-contador/prisma-schema';
import { processDueItems } from './recurring-processor';
import { registerOpenWaWebhook } from './whatsapp-service';
import { generateUpcomingObligations } from './tax-calendar';

/**
 * Tareas de inicio del servidor, separadas del arranque del HTTP server.
 * Se ejecutan una vez, después de prisma.$connect().
 */
export async function runStartupTasks(prisma: PrismaClient): Promise<void> {
  // Registrar webhook de WhatsApp con OpenWa (no bloquea el arranque)
  registerOpenWaWebhook().catch(err => console.error('[WhatsApp] Webhook registration failed:', err.message));

  // Generar obligaciones fiscales para TODAS las empresas (no solo demo)
  const companies = await prisma.company.findMany({ select: { id: true } });
  const results = await Promise.allSettled(
    companies.map(c => generateUpcomingObligations(prisma, c.id)),
  );
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[TaxCalendar] Startup: ${failed}/${companies.length} empresas fallaron al generar obligaciones`);
  }

  // Procesar transacciones recurrentes vencidas
  const result = await processDueItems(prisma);
  if (result.processed > 0) {
    console.log(`[Recurring] Startup: ${result.processed} transacciones recurrentes procesadas`);
  }
  if (result.errors.length > 0) {
    console.warn(`[Recurring] Startup: ${result.errors.length} errores`);
  }
}

/**
 * Cron ligero: verificar recurrentes cada 30 minutos.
 */
export function startRecurringCron(prisma: PrismaClient): void {
  setInterval(() => {
    processDueItems(prisma).catch(() => {});
  }, 30 * 60 * 1000);
}
