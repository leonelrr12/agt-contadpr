import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Una factura por PDF/URL entra con el concepto YA pre-clasificado (el gate de
 * `classifyByKeywords` lo propone desde el proveedor o los ítems). El flujo NO
 * debe preguntar Gasto/Inventario en ese caso: el trabajador se contesta solo
 * "1" y esa respuesta PISABA el concepto con la palabra "GASTO", mandando la
 * factura a Gastos Varios aunque el pre-clasificador hubiera acertado.
 *
 * El caso real (09-10): "Cappuccino Lg" + "Muffin Blueberry" de VORTEX
 * INVESTMENT S.A. → el gate proponía Refrigerios y el asiento salía en 6.08.01.
 *
 * La marca `_conceptSelected` se ponía solo dentro del bloque que exige
 * `missing` con concept/concept_category — y con el concepto ya resuelto el
 * diálogo no los lista. Este test fija que la marca se ponga igual.
 */

vi.mock('../wa-session-store', () => {
  const sessions = new Map<string, any>();
  const mk = () => ({
    chatId: '', phoneNumber: '', dialogContext: null, pendingResult: null,
    entityMatches: null, originalInput: null, pendingFactura: null, state: 'idle', lastActivity: 0,
  });
  const s = (chatId: string) => sessions.get(chatId);
  return {
    createSession: (chatId: string, phoneNumber: string) => sessions.set(chatId, { ...mk(), chatId, phoneNumber }),
    getSession: (chatId: string) => s(chatId),
    touchSession: () => {},
    setDialogContext: (chatId: string, ctx: any) => { const x = s(chatId); if (x) x.dialogContext = ctx; },
    setPendingResult: (chatId: string, r: any) => { const x = s(chatId); if (x) { x.pendingResult = r; x.state = 'confirming'; } },
    setEntityMatches: () => {},
    setAwaitingPayment: (chatId: string) => { const x = s(chatId); if (x) x.state = 'awaiting_payment'; },
    setAwaitingCategory: (chatId: string) => { const x = s(chatId); if (x) x.state = 'awaiting_category'; },
    setOriginalInput: (chatId: string, t: string) => { const x = s(chatId); if (x) x.originalInput = t; },
    getOriginalInput: (chatId: string) => s(chatId)?.originalInput ?? null,
    setPendingFactura: (chatId: string, f: any) => { const x = s(chatId); if (x) x.pendingFactura = f; },
    getPendingFactura: (chatId: string) => s(chatId)?.pendingFactura ?? null,
    resetSession: (chatId: string) => { const x = s(chatId); if (x) { x.dialogContext = null; x.pendingResult = null; x.state = 'idle'; } },
  };
});

import { processWhatsAppMessage } from '../whatsapp-service';
import { createSession, getSession, setDialogContext } from '../wa-session-store';

const CHAT = 'test-cat';
const PHONE = '50760000000';

const prisma = (workerAccountId: string | null = null) => ({
  whatsAppLink: {
    findFirst: async () => ({
      id: 'l1', phoneNumber: PHONE, companyId: 'demo', workerAccountId,
      verifiedAt: new Date(), isActive: true,
    }),
  },
  user: { findFirst: async () => ({ id: 'u1', companyId: 'demo', role: 'admin', isActive: true }) },
  concept: { findMany: async () => [], findFirst: async () => null },
  account: { findMany: async () => [] },
});

/** Contexto tal como lo arma processWhatsAppPDF cuando el gate acierta. */
const ctxDeFactura = () => ({
  type: 'GASTO',
  concept: 'Refrigerios',
  amount: 8.98,
  provider: 'VORTEX INVESTMENT S.A.',
  source: 'pdf',
});

describe('factura con concepto pre-clasificado: no se pregunta Gasto/Inventario', () => {
  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY; // sin LLM: camino determinista (regex)
    createSession(CHAT, PHONE);
  });

  it('pide la forma de pago, conserva el concepto y marca la sesión', async () => {
    setDialogContext(CHAT, ctxDeFactura());

    // Celular de la EMPRESA: el reply es el del flujo, sin el auto-resolvedor.
    const reply = await processWhatsAppMessage(prisma() as any, PHONE, CHAT, 'compré café por $8.98');

    expect(reply).not.toMatch(/Tipo de compra/i);
    expect(reply).toMatch(/¿Cómo se pagó\?/i);

    const s = getSession(CHAT)!;
    expect((s.dialogContext as any).concept).toBe('Refrigerios');
    expect((s.dialogContext as any)._conceptSelected).toBe(true);
    expect(s.state).toBe('awaiting_payment');
  });

  it('sin concepto previo, el selector Gasto/Inventario sigue apareciendo', async () => {
    // Comportamiento que NO se cambia: una compra sin concepto resuelto se pregunta.
    const reply = await processWhatsAppMessage(prisma() as any, PHONE, CHAT, 'compré café por $8.98');

    expect(reply).toMatch(/Tipo de compra/i);
    expect(getSession(CHAT)!.state).toBe('awaiting_category');
  });

  it('desde el celular del TRABAJADOR el concepto sobrevive a los pasos automáticos', async () => {
    setDialogContext(CHAT, ctxDeFactura());

    const reply = await processWhatsAppMessage(prisma('w1') as any, PHONE, CHAT, 'compré café por $8.98');

    // El auto-resolvedor contesta pago (REEMBOLSO) y termina en la confirmación:
    // lo que no puede pasar es que la pregunta de categoría pise el concepto.
    expect(reply).not.toMatch(/Tipo de compra/i);
    expect(reply).toMatch(/Refrigerios/);
  });
});
