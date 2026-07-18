/**
 * Servicio de integración WhatsApp via OpenWa API.
 * Maneja vinculación de números, envío de mensajes, y registro de webhooks.
 */

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
    const session = Array.isArray(sessions) ? sessions.find((s: any) => s.name === OPENWA_SESSION || s.status === 'CONNECTED') : null;
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

/**
 * Procesa un mensaje entrante de WhatsApp.
 * Retorna la respuesta que se debe enviar al usuario.
 */
export async function processWhatsAppMessage(
  prisma: any,
  phoneNumber: string,
  chatId: string,
  messageText: string,
): Promise<string | null> {
  const text = messageText.trim();

  // ── Comando HOLA / Vinculación ──
  if (/^hola$/i.test(text) || /^hi$/i.test(text) || /^inicio$/i.test(text)) {
    const code = generateCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutos

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

  // ── Número vinculado: procesar transacción ──
  const { OrchestratorAgent } = await import('@agt-contador/agents');
  const orchestrator = new OrchestratorAgent({
    prisma,
    companyId: link.companyId,
    userId: link.companyId === 'demo-company' ? 'demo-user' : link.companyId,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  });

  try {
    const result = await orchestrator.process(text);

    if (result.prompt && !result.needsConfirmation) {
      return `🤖 ${result.prompt}`;
    }

    if (result.needsConfirmation && result.prompt) {
      // Guardar pending result temporalmente (simplificado: auto-confirmar)
      const confirmed = await orchestrator.confirm(result.result);
      const entry = confirmed.journalEntry;
      return `✅ *Registrado*: ${result.prompt?.split('\n')[0] || 'Transacción'}\n📝 Asiento #${(entry.id || '').slice(0, 8)} en BORRADOR`;
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
