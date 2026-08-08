/**
 * Servicio de integración WhatsApp via OpenWa API.
 * Maneja vinculación de números, envío de mensajes, registro de webhooks,
 * y sesiones multi-turn con contexto por chatId.
 */

import {
  getSession,
  createSession,
  touchSession,
  setDialogContext,
  setPendingResult,
  setEntityMatches,
  setAwaitingPayment,
  setOriginalInput,
  getOriginalInput,
  resetSession,
} from './wa-session-store';

const OPENWA_URL = process.env.OPENWA_API_URL || 'http://localhost:2785';
const OPENWA_KEY = process.env.OPENWA_API_KEY || '';
const OPENWA_SESSION = process.env.OPENWA_SESSION_NAME || 'contador507';
const APP_HOST = process.env.APP_HOST || `http://localhost:${process.env.PORT || 3001}`;

function waHeaders() {
  return {
    'X-API-Key': OPENWA_KEY,
    'Content-Type': 'application/json',
  };
}

/**
 * Envía un mensaje de texto por WhatsApp.
 */
export async function sendWhatsAppMessage(chatId: string, text: string): Promise<boolean> {
  if (!OPENWA_KEY) {
    console.log('[WhatsApp] No API key configured, skipping send');
    return false;
  }
  try {
    const sessions = await (await fetch(`${OPENWA_URL}/api/sessions`, { headers: waHeaders() })).json();
    const session = Array.isArray(sessions) ? sessions.find((s: any) => s.name === OPENWA_SESSION) || sessions.find((s: any) => s.status === 'CONNECTED') : null;
    if (!session) {
      console.error('[WhatsApp] No active session found');
      return false;
    }
    await fetch(`${OPENWA_URL}/api/sessions/${session.id}/messages/send-text`, {
      method: 'POST',
      headers: waHeaders(),
      body: JSON.stringify({ chatId, text }),
    });
    return true;
  } catch (err: any) {
    console.error('[WhatsApp] Send error:', err.message);
    return false;
  }
}

/**
 * Genera un código aleatorio de 6 dígitos.
 */
export function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ── Comandos de control para el flujo multi-turn ──
const CMD_CONFIRM = /^(confirmar|s[ií]|ok|dale|aceptar|yes)$/i;
const CMD_CANCEL = /^(cancelar|no|nop|abortar)$/i;
const CMD_RESET = /^(reiniciar|empezar de nuevo|nueva transacc[ió]on)$/i;

/**
 * Procesa un mensaje entrante de WhatsApp con soporte multi-turn.
 * Retorna la respuesta que se debe enviar al usuario.
 */
export async function processWhatsAppMessage(
  prisma: any,
  phoneNumber: string,
  chatId: string,
  messageText: string,
): Promise<string | null> {
  const text = messageText.trim();

  // ── Comando HOLA ──
  if (/^hola$/i.test(text) || /^hi$/i.test(text) || /^inicio$/i.test(text)) {
    // Verificar si ya está vinculado
    const existingLink = await prisma.whatsAppLink.findFirst({
      where: { phoneNumber, verifiedAt: { not: null }, isActive: true },
    });

    if (existingLink) {
      // Ya vinculado: solo reiniciar sesión
      resetSession(chatId);
      return `🤖 *Contador507*: ¡Hola de nuevo! ¿Qué deseas registrar hoy?\n\nEj: _"compré gasolina por \$40 con tarjeta"_`;
    }

    // No vinculado: generar código
    resetSession(chatId);
    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.whatsAppLink.upsert({
      where: { phoneNumber },
      update: { code, codeExpires: expires, verifiedAt: null, companyId: null },
      create: { phoneNumber, code, codeExpires: expires },
    });

    return `🤖 *Contador507*: ¡Hola! Tu código de vinculación es:\n\n🔐 *${code}*\n\nIngresa este código en Configuración > WhatsApp en tu panel de Contador507.\n\n_El código expira en 10 minutos._`;
  }

  // ── Buscar si el número ya está vinculado ──
  const link = await prisma.whatsAppLink.findFirst({
    where: { phoneNumber, verifiedAt: { not: null }, isActive: true },
  });

  if (!link || !link.companyId) {
    return `🤖 *Contador507*: No reconozco tu número. Envía *HOLA* para vincularte a tu empresa, o regístrate en contador507.com.`;
  }

  // ── Cargar o crear sesión ──
  let waSession = getSession(chatId);
  if (!waSession) {
    waSession = createSession(chatId, phoneNumber);
  } else {
    touchSession(chatId);
  }

  // ── Comandos de control de sesión ──
  if (CMD_RESET.test(text)) {
    resetSession(chatId);
    return `🔄 Sesión reiniciada. ¿Qué deseas registrar?`;
  }

  if (CMD_CANCEL.test(text)) {
    if (waSession.state !== 'idle') {
      resetSession(chatId);
      return `❌ Transacción cancelada. ¿Qué deseas registrar ahora?`;
    }
  }

  // ── Estado CONFIRMING: esperando "CONFIRMAR" para guardar ──
  if (waSession.state === 'confirming' && waSession.pendingResult) {
    if (CMD_CONFIRM.test(text)) {
      return await handleConfirm(prisma, chatId, link, waSession);
    }
    // No es confirmación ni cancelación → reiniciar flujo con input nuevo
    resetSession(chatId);
  }

  // ── Estado AWAITING_ENTITY: esperando selección numérica o NUEVO ──
  if (waSession.state === 'awaiting_entity' && waSession.entityMatches) {
    if (/^nuev[oa]$/i.test(text)) {
      if (!waSession.dialogContext) waSession.dialogContext = {};
      waSession.dialogContext.selectedEntityId = null;
      return await afterEntitySelection(prisma, chatId, link, waSession);
    }
    const num = parseInt(text);
    if (num >= 1 && num <= waSession.entityMatches.length) {
      const match = waSession.entityMatches[num - 1];
      if (!waSession.dialogContext) waSession.dialogContext = {};
      waSession.dialogContext.selectedEntityId = match.id;
      return await afterEntitySelection(prisma, chatId, link, waSession);
    }
    return `❌ Opción inválida. Responde con un número del 1 al ${waSession.entityMatches.length}, o escribe *NUEVO*.`;
  }

  // ── Estado AWAITING_PAYMENT: esperando método de pago ──
  if (waSession.state === 'awaiting_payment') {
    const method = parsePaymentMethodReply(text);
    if (method) {
      if (!waSession.dialogContext) waSession.dialogContext = {};
      waSession.dialogContext.paymentMethod = method;
      // Reconstruir input para que dialogAgent no malinterprete "1"/"efectivo" como monto
      const originalText = getOriginalInput(chatId) || `${waSession.dialogContext.concept || ''} $${waSession.dialogContext.amount || 0} ${method}`;
      const context: any = { extractedData: waSession.dialogContext };
      return await processWithOrchestrator(prisma, chatId, link, originalText, context);
    }
    return `❌ No reconocí ese método de pago. Responde con: *Efectivo*, *Tarjeta*, *Crédito*, *Transferencia* o *Cheque*.`;
  }

  // ── Construir contexto desde la sesión e invocar orquestador ──
  const context: any = {};
  if (waSession.dialogContext) {
    context.extractedData = waSession.dialogContext;
  }

  return await processWithOrchestrator(prisma, chatId, link, text, context);
}

/**
 * Después de seleccionar entidad, decide si pedir método de pago o ir a confirmación.
 * Si paymentMethod ya está en el contexto (vino en el mensaje original como "crédito"),
 * re-procesa directo para obtener confirmación.
 */
async function afterEntitySelection(
  prisma: any,
  chatId: string,
  link: any,
  waSession: any,
): Promise<string> {
  if (waSession.dialogContext?.paymentMethod) {
    // Ya tiene método de pago → re-procesar para obtener confirmación
    const originalText = getOriginalInput(chatId) || '';
    const context: any = { extractedData: waSession.dialogContext };
    return await processWithOrchestrator(prisma, chatId, link, originalText, context);
  }
  // Falta método de pago → mostrar selector
  setAwaitingPayment(chatId);
  return formatPaymentPrompt(waSession.dialogContext);
}

/** Procesa el input con OrchestratorAgent y maneja el resultado según el flujo multi-turn. */
async function processWithOrchestrator(
  prisma: any,
  chatId: string,
  link: any,
  text: string,
  context: any,
): Promise<string> {
  const { OrchestratorAgent } = await import('@agt-contador/agents');
  const orchestrator = new OrchestratorAgent({
    prisma,
    companyId: link.companyId,
    userId: link.companyId === 'demo-company' ? 'demo-user' : link.companyId,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  });

  try {
    const result = await orchestrator.process(text, context);

    // ── Entity matches: mostrar selector numérico ──
    if (result.entityMatches && result.entityMatches.length > 0) {
      const dialogData = (result.plan as any)?.dialog || {};
      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, text);
      setEntityMatches(chatId, result.entityMatches);

      const providerName = dialogData.provider || 'proveedor';
      const matchLines = result.entityMatches
        .slice(0, 5)
        .map((m: any, i: number) => `  ${i + 1}. ${m.name} (${m.type === 'cliente' ? '👤 Cliente' : '🏭 Proveedor'})`)
        .join('\n');
      return `🔍 Encontré coincidencias para *${providerName}*:\n${matchLines}\n\nResponde con el número o escribe *NUEVO* para crear uno nuevo.`;
    }

    // ── Faltan campos → guardar contexto, pedir más info ──
    if (result.prompt && !result.needsConfirmation) {
      const dialogData = (result.plan as any)?.dialog || {};
      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, text);

      const missing = dialogData.missingFields || [];
      if (missing.length === 1 && missing[0] === 'paymentMethod') {
        setAwaitingPayment(chatId);
        return formatPaymentPrompt(dialogData);
      }

      return `🤖 ${result.prompt}\n\n💡 _Responde a este mensaje con lo que falta, o escribe *CANCELAR* para empezar de nuevo._`;
    }

    // ── Listo para confirmar ──
    if (result.needsConfirmation && result.prompt) {
      setPendingResult(chatId, result.result);
      return `${result.prompt}\n\n✏️ Escribe *CONFIRMAR* para guardar, o *CANCELAR* para descartar.`;
    }

    if (result.prompt) {
      return `🤖 ${result.prompt}`;
    }

    return `✅ Transacción procesada. Revisa tu panel.`;
  } catch (err: any) {
    console.error('[WhatsApp] Process error:', err.message);
    return `❌ Error al procesar: ${err.message || 'Intenta de nuevo'}`;
  }
}

/** Parsea la respuesta del usuario a un valor de método de pago. */
function parsePaymentMethodReply(text: string): string | null {
  const lower = text.toLowerCase().trim();
  // Por número
  const map: Record<string, string> = {
    '1': 'EFECTIVO', 'efectivo': 'EFECTIVO', 'cash': 'EFECTIVO',
    '2': 'TARJETA_CREDITO', 'tarjeta credito': 'TARJETA_CREDITO', 'tarjeta crédito': 'TARJETA_CREDITO', 'tarjeta de credito': 'TARJETA_CREDITO', 'tarjeta de crédito': 'TARJETA_CREDITO', 'tc': 'TARJETA_CREDITO',
    '3': 'TARJETA_DEBITO', 'tarjeta debito': 'TARJETA_DEBITO', 'tarjeta débito': 'TARJETA_DEBITO', 'tarjeta de debito': 'TARJETA_DEBITO', 'tarjeta de débito': 'TARJETA_DEBITO', 'debito': 'TARJETA_DEBITO',
    '4': 'CREDITO', 'credito': 'CREDITO', 'crédito': 'CREDITO',
    '5': 'TRANSFERENCIA', 'transferencia': 'TRANSFERENCIA', 'banco': 'TRANSFERENCIA', 'ach': 'TRANSFERENCIA',
    '6': 'CHEQUE', 'cheque': 'CHEQUE',
  };
  return map[lower] || null;
}

/** Confirma y guarda la transacción pendiente, retorna resumen. */
async function handleConfirm(
  prisma: any,
  chatId: string,
  link: any,
  waSession: any,
): Promise<string> {
  const { OrchestratorAgent } = await import('@agt-contador/agents');
  const orchestrator = new OrchestratorAgent({
    prisma,
    companyId: link.companyId,
    userId: link.companyId === 'demo-company' ? 'demo-user' : link.companyId,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  });

  try {
    const saved = await orchestrator.confirm(waSession.pendingResult);
    const entry = saved.journalEntry;
    const desc = entry?.description || 'Transacción';
    const id = (entry?.id || '').slice(0, 8);

    let response = `✅ *Registrado*: ${desc}\n📝 Asiento #${id} en BORRADOR`;

    if (saved.autoCreated) {
      const labels: Record<string, string> = {
        cliente_nuevo: '👤 Cliente nuevo',
        cliente_existente: '👤 Cliente existente',
        proveedor_nuevo: '🏭 Proveedor nuevo',
        proveedor_existente: '🏭 Proveedor existente',
      };
      response += `\n${labels[saved.autoCreated.type] || saved.autoCreated.type}: *${saved.autoCreated.name}*`;
    }

    resetSession(chatId);
    return response;
  } catch (err: any) {
    console.error('[WhatsApp] Confirm error:', err.message);
    resetSession(chatId);
    return `❌ Error al guardar: ${err.message || 'Intenta de nuevo'}`;
  }
}

/** Formatea el prompt de método de pago con opciones numeradas. */
function formatPaymentPrompt(dialogData: any): string {
  const isVenta = dialogData.type === 'VENTA' || dialogData.type === 'COBRO_CLIENTE';
  const methods = [
    '💵 Efectivo',
    '💳 Tarjeta Crédito',
    '💳 Tarjeta Débito',
    isVenta ? '📋 Crédito (por cobrar)' : '📋 Crédito (por pagar)',
    '🏦 Transferencia',
    '📄 Cheque',
  ];
  const lines = methods.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
  return `💳 *¿Cómo se pagó?*\n${lines}\n\nResponde con el número o el nombre del método.`;
}

/**
 * Verifica un código de vinculación.
 * Si es válido, asocia el número a la companyId.
 */
export async function verifyCode(
  prisma: any,
  phoneNumber: string,
  code: string,
  companyId: string,
): Promise<{ success: boolean; message: string }> {
  const link = await prisma.whatsAppLink.findFirst({
    where: { phoneNumber, code },
  });

  if (!link) {
    return { success: false, message: 'Código inválido. Asegúrate de haber enviado HOLA al número de WhatsApp del bot primero.' };
  }

  if (link.codeExpires && new Date() > link.codeExpires) {
    return { success: false, message: 'El código ha expirado. Envía HOLA de nuevo para recibir uno nuevo.' };
  }

  await prisma.whatsAppLink.update({
    where: { id: link.id },
    data: {
      companyId,
      verifiedAt: new Date(),
      code: null,
      codeExpires: null,
    },
  });

  return { success: true, message: '¡WhatsApp vinculado correctamente! Ya puedes registrar transacciones desde tu celular.' };
}

/**
 * Registra el webhook de Contador507 en OpenWa al iniciar.
 */
export async function registerOpenWaWebhook(): Promise<void> {
  if (!OPENWA_KEY) {
    console.log('[WhatsApp] No OPENWA_API_KEY — saltando registro de webhook');
    return;
  }

  const webhookUrl = `${APP_HOST}/api/whatsapp/webhook`;

  try {
    const sessionsRes = await fetch(`${OPENWA_URL}/api/sessions`, { headers: waHeaders() });
    const sessions = await sessionsRes.json();
    if (!Array.isArray(sessions)) return;

    let session = sessions.find((s: any) => s.name === OPENWA_SESSION);
    if (!session) {
      // Crear sesión
      const createRes = await fetch(`${OPENWA_URL}/api/sessions`, {
        method: 'POST',
        headers: waHeaders(),
        body: JSON.stringify({ name: OPENWA_SESSION }),
      });
      session = await createRes.json();
      console.log('[WhatsApp] Sesión creada:', session?.id);
    }

    if (!session?.id) return;

    // Verificar si el webhook ya existe
    const whRes = await fetch(`${OPENWA_URL}/api/sessions/${session.id}/webhooks`, {
      headers: waHeaders(),
    });
    const webhooks = await whRes.json();

    if (Array.isArray(webhooks) && webhooks.some((w: any) => w.url === webhookUrl)) {
      console.log('[WhatsApp] Webhook ya registrado en', webhookUrl);
      return;
    }

    // Registrar webhook
    await fetch(`${OPENWA_URL}/api/sessions/${session.id}/webhooks`, {
      method: 'POST',
      headers: waHeaders(),
      body: JSON.stringify({
        url: webhookUrl,
        events: ['message.received'],
      }),
    });

    console.log('[WhatsApp] Webhook registrado:', webhookUrl);
  } catch (err: any) {
    console.error('[WhatsApp] Error registrando webhook:', err.message);
  }
}
