import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { processWhatsAppMessage, processWhatsAppImage, processWhatsAppPDF, verifyCode, generateCode, sendWhatsAppMessage } from '../services/whatsapp-service';

export const whatsappRouter = Router();

// ── Rutas públicas (sin auth) ──
// Webhook: llamado por OpenWa, no por el usuario

// Lock por usuario para evitar race conditions (múltiples webhooks simultáneos)
const userLocks = new Map<string, Promise<void>>();

function withUserLock(chatId: string, fn: () => Promise<void>): Promise<void> {
  const prev = userLocks.get(chatId) || Promise.resolve();
  const next = prev.then(fn, fn);
  userLocks.set(chatId, next);
  next.finally(() => {
    if (userLocks.get(chatId) === next) userLocks.delete(chatId);
  });
  return next;
}

/**
 * POST /api/whatsapp/webhook
 * Recibe mensajes de WhatsApp via OpenWa.
 * Endpoint público — no requiere JWT (el API Key de OpenWa lo protege).
 */
whatsappRouter.post('/webhook', async (req, res) => {
  const body = req.body;
  const chatId = body.chatId || body.from || 'unknown';

  // Serializar por usuario para evitar race conditions
  await withUserLock(chatId, () => handleWebhook(req, res));
  // La respuesta ya fue enviada por handleWebhook — no hacer nada aquí
});

async function handleWebhook(req: any, res: any): Promise<void> {
  try {
  const body = req.body;

  // Validar que sea un mensaje recibido
  if (body.event !== 'message.received') {
    return res.sendStatus(200);
  }

  const from = body.from;       // "50761234567"
  const chatId = body.chatId;   // "50761234567@c.us"
  // Compatible con OpenWA (body.body) y whatsapp-ai-bot (body.message)
  const msg = body.body || body.message || {};

  if (!from) return res.sendStatus(200);

  // Solo procesar texto o imágenes
  const messageText = msg.text || msg.caption || '';
  const isImage = msg.type === 'image';
  const isDocument = msg.type === 'document';
  const imageUrl = msg.mediaUrl || null;
  const hasMedia = isImage || isDocument;

  if (!messageText && !hasMedia) {
    return res.sendStatus(200);
  }

  // Verificar vinculación, excepto para HOLA (que inicia el proceso de vinculación)
  const isHola = /^hola$/i.test(messageText) || /^hi$/i.test(messageText) || /^inicio$/i.test(messageText);

  if (!isHola) {
    const link = await req.prisma.whatsAppLink.findFirst({
      where: { phoneNumber: from, verifiedAt: { not: null }, isActive: true },
    });
    if (!link || !link.companyId) {
      return res.sendStatus(200); // Silencioso: el número no está vinculado
    }
  }

  try {
    const isPDF = msg.mediaMime === 'application/pdf' || (imageUrl && imageUrl.endsWith('.pdf'));
    const mediaUrl = imageUrl;

    // PDF: usar extractor de texto (más preciso que OCR de imagen)
    if (isPDF && mediaUrl) {
      const reply = await processWhatsAppPDF(req.prisma, from, chatId, mediaUrl);
      if (reply) await sendWhatsAppMessage(chatId, reply);
      return res.sendStatus(200);
    }

    // Imagen: usar OCR
    if (isImage && imageUrl) {
      const reply = await processWhatsAppImage(req.prisma, from, chatId, imageUrl, messageText);
      if (reply) await sendWhatsAppMessage(chatId, reply);
      return res.sendStatus(200);
    }

    if (hasMedia && !imageUrl) {
      await sendWhatsAppMessage(chatId, '📷 No pude acceder al archivo. Describe la transacción: "compré gasolina $40 efectivo"');
      return res.sendStatus(200);
    }

    const reply = await processWhatsAppMessage(req.prisma, from, chatId, messageText);
    if (reply) await sendWhatsAppMessage(chatId, reply);
  } catch (err: any) {
    console.error('[WhatsApp] Webhook error:', err.message);
    try {
      await sendWhatsAppMessage(chatId, '❌ Ocurrió un error. Intenta de nuevo más tarde.');
    } catch {}
  }

  res.sendStatus(200);
  } catch (_err: any) {
    res.sendStatus(200);
  }
}

// ── Rutas protegidas (requieren JWT) ──

/**
 * GET /api/whatsapp/links
 * Lista los números vinculados a la empresa actual.
 */
whatsappRouter.get('/links', requireAuth, async (req, res) => {
  const links = await req.prisma.whatsAppLink.findMany({
    where: { companyId: req.user!.companyId },
    orderBy: { createdAt: 'desc' },
  });

  res.json(links.map((l: any) => ({
    id: l.id,
    phoneNumber: l.phoneNumber,
    label: l.label,
    verifiedAt: l.verifiedAt,
    isActive: l.isActive,
    createdAt: l.createdAt,
  })));
});

/**
 * POST /api/whatsapp/verify
 * Verifica un código de vinculación para el número proporcionado.
 */
whatsappRouter.post('/verify', requireAuth, async (req, res) => {
  const { phoneNumber, code } = req.body;

  if (!phoneNumber || !code) {
    res.status(400).json({ error: 'Número de teléfono y código son requeridos' });
    return;
  }

  const result = await verifyCode(req.prisma, phoneNumber, code, req.user!.companyId);

  // Enviar mensaje de bienvenida por WhatsApp al verificar exitosamente
  if (result.success) {
    const chatId = `${phoneNumber}@c.us`;
    const welcomeMsg =
      `✅ *Contador507 vinculado correctamente*\n\n` +
      `📝 *Registrar transacciones*\n` +
      `Escribe tu gasto o venta. Ejemplos:\n` +
      `_"compré gasolina por $40"_\n` +
      `_"pagué internet $65"_\n\n` +
      `📄 *Facturas*\n` +
      `Envía una foto de la factura o un PDF de la DGI.\n\n` +
      `💡 *Comandos*\n` +
      `• Responde con números para seleccionar opciones\n` +
      `• *OK* — guardar transacción\n` +
      `• *XX* — cancelar / empezar de nuevo\n` +
      `• *HOLA* — ver estas instrucciones`;
    sendWhatsAppMessage(chatId, welcomeMsg).catch(() => {});
  }

  res.json(result);
});

/**
 * POST /api/whatsapp/generate-code
 * Genera un nuevo código para un número (útil si expiró).
 */
whatsappRouter.post('/generate-code', requireAuth, async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    res.status(400).json({ error: 'Número de teléfono requerido' });
    return;
  }

  const code = generateCode();
  const expires = new Date(Date.now() + 10 * 60 * 1000);

  await req.prisma.whatsAppLink.upsert({
    where: { phoneNumber },
    update: { code, codeExpires: expires, verifiedAt: null, companyId: null },
    create: { phoneNumber, code, codeExpires: expires },
  });

  res.json({ success: true, message: 'Código generado. El usuario debe enviar HOLA al bot de WhatsApp para recibirlo.' });
});

/**
 * DELETE /api/whatsapp/links/:id
 * Desvincula un número de la empresa.
 */
whatsappRouter.delete('/links/:id', requireAuth, async (req, res) => {
  const link = await req.prisma.whatsAppLink.findFirst({
    where: { id: req.params.id, companyId: req.user!.companyId },
  });

  if (!link) { res.status(404).json({ error: 'Vínculo no encontrado' }); return; }

  await req.prisma.whatsAppLink.update({
    where: { id: req.params.id },
    data: { isActive: false, companyId: null, verifiedAt: null },
  });

  res.json({ success: true });
});
