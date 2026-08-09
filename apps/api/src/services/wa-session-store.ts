/**
 * Session store para conversaciones de WhatsApp.
 * Mantiene dialogContext y pendingResult por chatId con TTL de 10 minutos.
 *
 * Flujo multi-turn:
 *   1. Usuario envía "compré gasolina $40"
 *   2. Orchestrator detecta falta paymentMethod → guarda contexto, pide método
 *   3. Usuario responde "efectivo" → carga contexto, merge, continúa
 *   4. Orchestrator pide confirmación → guarda pendingResult, pide "CONFIRMAR"
 *   5. Usuario envía "CONFIRMAR" → confirma transacción
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutos

export type WaState = 'idle' | 'collecting' | 'confirming' | 'awaiting_entity' | 'awaiting_payment' | 'awaiting_category';

interface WaSession {
  chatId: string;
  phoneNumber: string;
  dialogContext: Record<string, any> | null;
  pendingResult: any | null;
  entityMatches: any[] | null;    // matches de proveedor/cliente para selección numérica
  originalInput: string | null;    // texto original de la transacción para re-procesamiento
  state: WaState;
  lastActivity: number;
}

const sessions = new Map<string, WaSession>();

// Limpieza periódica de sesiones expiradas (cada 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [chatId, s] of sessions) {
    if (now - s.lastActivity > TTL_MS) {
      sessions.delete(chatId);
    }
  }
}, 5 * 60 * 1000);

export function getSession(chatId: string): WaSession | undefined {
  const s = sessions.get(chatId);
  if (!s) return undefined;
  if (Date.now() - s.lastActivity > TTL_MS) {
    sessions.delete(chatId);
    return undefined;
  }
  return s;
}

export function createSession(chatId: string, phoneNumber: string): WaSession {
  const s: WaSession = {
    chatId,
    phoneNumber,
    dialogContext: null,
    pendingResult: null,
    entityMatches: null,
    originalInput: null,
    state: 'idle',
    lastActivity: Date.now(),
  };
  sessions.set(chatId, s);
  return s;
}

export function touchSession(chatId: string): void {
  const s = sessions.get(chatId);
  if (s) s.lastActivity = Date.now();
}

export function setDialogContext(chatId: string, ctx: Record<string, any> | null): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.dialogContext = ctx;
  s.state = 'collecting';
  s.lastActivity = Date.now();
}

export function setPendingResult(chatId: string, result: any): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.pendingResult = result;
  s.state = 'confirming';
  s.lastActivity = Date.now();
}

export function setEntityMatches(chatId: string, matches: any[]): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.entityMatches = matches;
  s.state = 'awaiting_entity';
  s.lastActivity = Date.now();
}

export function setOriginalInput(chatId: string, text: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.originalInput = text;
  s.lastActivity = Date.now();
}

export function getOriginalInput(chatId: string): string | null {
  const s = sessions.get(chatId);
  return s?.originalInput || null;
}

export function setAwaitingCategory(chatId: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.state = 'awaiting_category';
  s.lastActivity = Date.now();
}

export function setAwaitingPayment(chatId: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.state = 'awaiting_payment';
  s.lastActivity = Date.now();
}

export function clearSession(chatId: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.dialogContext = null;
  s.pendingResult = null;
  s.entityMatches = null;
  s.state = 'idle';
  s.lastActivity = Date.now();
}

export function resetSession(chatId: string): void {
  sessions.delete(chatId);
}
