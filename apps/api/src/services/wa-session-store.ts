/**
 * Session store para conversaciones de WhatsApp.
 * Mantiene dialogContext y pendingResult por chatId con TTL de 10 minutos.
 * Persiste a /tmp/wa-sessions.json para sobrevivir reinicios.
 */

const TTL_MS = 10 * 60 * 1000;
const PERSIST_FILE = '/tmp/wa-sessions.json';
const fs = require('fs');

export type WaState = 'idle' | 'collecting' | 'confirming' | 'awaiting_entity' | 'awaiting_payment' | 'awaiting_category';

interface WaSession {
  chatId: string;
  phoneNumber: string;
  dialogContext: Record<string, any> | null;
  pendingResult: any | null;
  entityMatches: any[] | null;
  originalInput: string | null;
  state: WaState;
  lastActivity: number;
}

const sessions = new Map<string, WaSession>();

// Restaurar sesiones del disco
try {
  if (fs.existsSync(PERSIST_FILE)) {
    const data = JSON.parse(fs.readFileSync(PERSIST_FILE, 'utf8'));
    for (const [chatId, s] of Object.entries(data)) {
      const session = s as WaSession;
      if (Date.now() - session.lastActivity < TTL_MS) {
        sessions.set(chatId, session);
      }
    }
    console.log(`[WA Session] ${sessions.size} sesiones restauradas de disco`);
  }
} catch (e) {}

// Persistir a disco (llamado en cada cambio de estado y cada 30s)
function persistSessions() {
  try {
    const data: Record<string, WaSession> = {};
    for (const [chatId, s] of sessions) data[chatId] = s;
    fs.writeFileSync(PERSIST_FILE, JSON.stringify(data));
  } catch {}
}
setInterval(persistSessions, 30_000);

// Limpieza de sesiones expiradas cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [chatId, s] of sessions) {
    if (now - s.lastActivity > TTL_MS) sessions.delete(chatId);
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
    chatId, phoneNumber,
    dialogContext: null, pendingResult: null, entityMatches: null,
    originalInput: null, state: 'idle', lastActivity: Date.now(),
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
  // Solo cambiar a 'collecting' si no está en un estado de espera activo
  if (s.state === 'idle') {
    s.state = 'collecting';
  }
  s.lastActivity = Date.now();
  persistSessions();
}

export function setPendingResult(chatId: string, result: any): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.pendingResult = result;
  s.state = 'confirming';
  s.lastActivity = Date.now();
  persistSessions();
}

export function setEntityMatches(chatId: string, matches: any[]): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.entityMatches = matches;
  s.state = 'awaiting_entity';
  s.lastActivity = Date.now();
  persistSessions();
}

export function setOriginalInput(chatId: string, text: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.originalInput = text;
  s.lastActivity = Date.now();
  persistSessions();
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
  persistSessions();
}

export function setAwaitingPayment(chatId: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.state = 'awaiting_payment';
  s.lastActivity = Date.now();
  persistSessions();
}

export function clearSession(chatId: string): void {
  const s = sessions.get(chatId);
  if (!s) return;
  s.dialogContext = null;
  s.pendingResult = null;
  s.entityMatches = null;
  s.state = 'idle';
  s.lastActivity = Date.now();
  persistSessions();
}

export function resetSession(chatId: string): void {
  sessions.delete(chatId);
  persistSessions();
}
