import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { processWhatsAppMessage, processWhatsAppPDF, processWhatsAppDgiUrl, verifyCode, generateCode, sendWhatsAppMessage, isBatchActive, startBatch, endBatch, getBatch, setBatchMetodoPago, enqueueBatchItem, confirmBatch, buildBatchResumen } from '../services/whatsapp-service';

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
  const lockKey = req.body.from || req.body.chatId || 'unknown';
  await withUserLock(lockKey, () => handleWebhook(req, res));
});

async function handleWebhook(req: any, res: any): Promise<void> {
  try {
  const body = req.body;

  // Validar que sea un mensaje recibido
  if (body.event !== 'message.received') {
    return res.sendStatus(200);
  }

  const from = body.from;       // "50761234567"
  const chatId = body.chatId;   // "170527415103566@lid" — para enviar mensajes
  // Las respuestas van al JID clásICO número@c.us: verificado el 2026-08-21
  // con sesión re-enlazada — el @lid (170527415103566@s.whatsapp.net) NO
  // entrega; el clásico (50766733759@s.whatsapp.net) SÍ. El bot convierte
  // @c.us → @s.whatsapp.net.
  const replyChatId = from ? `${from}@c.us` : chatId;
  const sessionKey = from;      // número de teléfono — consistente como key de sesión
  // Compatible con OpenWA (body.body) y whatsapp-ai-bot (body.message)
  const msg = body.body || body.message || {};

  if (!from) return res.sendStatus(200);

  // Solo texto, URLs o PDFs: las imágenes (fotos/QR) ya no se procesan desde WS
  const messageText = msg.text || msg.caption || '';
  // Documentos con MIME de imagen (ej. QR enviado como "documento") se detectan
  // para responder con el mensaje guía (no se hace OCR ni lectura de QR).
  const isImage = msg.type === 'image' || (msg.type === 'document' && (msg.mediaMime || '').startsWith('image/'));
  const isDocument = msg.type === 'document';
  const imageUrl = msg.mediaUrl || null;
  const hasMedia = isImage || isDocument;

  if (!messageText && !hasMedia) {
    return res.sendStatus(200);
  }

  // Verificar vinculación, excepto para HOLA
  const isHola = /^hola$/i.test(messageText) || /^hi$/i.test(messageText) || /^inicio$/i.test(messageText);

  if (!isHola) {
    const linkCheck = await req.prisma.whatsAppLink.findFirst({
      where: { phoneNumber: from, verifiedAt: { not: null }, isActive: true },
    });
    if (!linkCheck || !linkCheck.companyId) {
      return res.sendStatus(200);
    }

    // Verificar suscripción activa
    const sub = await req.prisma.subscription.findFirst({
      where: { companyId: linkCheck.companyId, status: { in: ['DEMO', 'ACTIVE', 'GRANTED', 'GRACE'] } },
      include: { plan: true },
    });
    if (!sub) {
      await sendWhatsAppMessage(replyChatId,'⚠️ No tienes una suscripción activa. Contrata un plan en contador507.com/planes');
      return res.sendStatus(200);
    }
    if (new Date() > sub.periodEnd) {
      await req.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } }).catch(() => {});
      await sendWhatsAppMessage(replyChatId,'⚠️ Tu suscripción ha expirado. Renueva en contador507.com/planes');
      return res.sendStatus(200);
    }
    if (sub.movementsUsed >= sub.movementsLimit) {
      await sendWhatsAppMessage(replyChatId,`⚠️ Has alcanzado el límite de ${sub.movementsLimit} movimientos de tu plan *${sub.plan?.name || 'actual'}*. Espera la renovación o actualiza tu plan.`);
      return res.sendStatus(200);
    }
  }

  try {
    const isPDF = msg.mediaMime === 'application/pdf' || (imageUrl && imageUrl.endsWith('.pdf'));
    const mediaUrl = imageUrl;

    // URL del CUTE de una factura de la DGI (el enlace del QR de la factura
    // electrónica): detectarla y procesarla como factura en vez de texto.
    const dgiUrlMatch = messageText.match(/https?:\/\/[^\s]*dgi-fep\.mef\.gob\.pa[^\s]*/i);

    // Aviso inmediato de recepción: el procesamiento del PDF tarda
    // (descarga → extractor → DGI) y el usuario debe saber que está en marcha.
    if (isPDF && mediaUrl) {
      await sendWhatsAppMessage(replyChatId, '📥 Recibí tu PDF. Estoy procesándolo, te confirmo en un momento…');
    }

    // PDF: usar extractor de texto
    if (isPDF && mediaUrl) {
      const reply = await processWhatsAppPDF(req.prisma, from, sessionKey, mediaUrl);
      if (reply) await sendWhatsAppMessage(replyChatId,reply);
      return res.sendStatus(200);
    }

    // Imagen/QR: ya no se procesa OCR desde WS — solo texto o URL del CUTE.
    // Si el caption trae una URL de la DGI, cae a la rama de URL (batch o normal).
    if (isImage && imageUrl && !dgiUrlMatch) {
      await sendWhatsAppMessage(replyChatId, '📷 Ya no leo fotos ni QR por WhatsApp. Para facturas de la DGI pega la URL del CUTE (el enlace del QR), o describe la transacción en texto, ej: "compré gasolina $40 efectivo".');
      return res.sendStatus(200);
    }

    if (hasMedia && !imageUrl) {
      await sendWhatsAppMessage(replyChatId,'📷 No pude acceder al archivo. Describe la transacción: "compré gasolina $40 efectivo"');
      return res.sendStatus(200);
    }

    // ── Modo batch (carga masiva) ──
    if (isBatchActive(sessionKey)) {
      const st = getBatch(sessionKey)!;

      // 1) Elegir método de pago
      if (!st.metodoPago && /^[1-6]$/.test(messageText.trim())) {
        const metodos = ['💵 Efectivo', '💳 Tarjeta Crédito', '💳 Tarjeta Débito', '📋 Crédito', '🏦 Transferencia', '📄 Cheque'];
        setBatchMetodoPago(sessionKey, messageText.trim());
        await sendWhatsAppMessage(replyChatId, `✅ Método de pago: *${metodos[parseInt(messageText) - 1]}*\n\n📦 Envía las URLs o PDFs de las facturas. Escribe *fin* cuando termines.`);
        return res.sendStatus(200);
      }
      if (!st.metodoPago) {
        await sendWhatsAppMessage(replyChatId, '📦 Primero elige el método de pago:\n  1. 💵 Efectivo\n  2. 💳 Tarjeta Crédito\n  3. 💳 Tarjeta Débito\n  4. 📋 Crédito\n  5. 🏦 Transferencia\n  6. 📄 Cheque');
        return res.sendStatus(200);
      }

      // 2) Cancelar
      if (/^(xx|cancelar|nop)$/i.test(messageText.trim())) {
        endBatch(sessionKey);
        await sendWhatsAppMessage(replyChatId, '❌ Batch cancelado. Ninguna factura se registró.');
        return res.sendStatus(200);
      }

      // 3) Confirmar todas al final
      if (/^(ok|confirmar|si)$/i.test(messageText.trim()) && st.items.length > 0 && !st.procesando && st.queue.length === 0) {
        const msg = await confirmBatch(sessionKey);
        await sendWhatsAppMessage(replyChatId, msg);
        return res.sendStatus(200);
      }

      // 4) Terminar y mostrar resumen
      if (/^(fin|terminar|listo)$/i.test(messageText.trim())) {
        if (st.procesando || st.queue.length > 0) {
          st.finSolicitado = true;
          await sendWhatsAppMessage(replyChatId, `📦 Procesando ${st.queue.length + (st.procesando ? 1 : 0)} factura(s) pendientes... te envío el resumen en un momento.`);
        } else {
          const { mensaje } = buildBatchResumen(st);
          await sendWhatsAppMessage(replyChatId, mensaje);
        }
        return res.sendStatus(200);
      }

      // 5) Comando batch mientras hay uno activo → reiniciar
      if (/^(batch|qr2)$/i.test(messageText.trim())) {
        endBatch(sessionKey);
        startBatch(sessionKey, req.prisma, st.link);
        await sendWhatsAppMessage(replyChatId, '📦 *Modo batch reiniciado*\n\nElige el método de pago:\n  1. 💵 Efectivo\n  2. 💳 Tarjeta Crédito\n  3. 💳 Tarjeta Débito\n  4. 📋 Crédito\n  5. 🏦 Transferencia\n  6. 📄 Cheque');
        return res.sendStatus(200);
      }

      // 6) URL o PDF → encolar con ack inmediato (con deduplicación)
      if (dgiUrlMatch) {
        const n = enqueueBatchItem(sessionKey, 'url', dgiUrlMatch[0]);
        if (n === -1) await sendWhatsAppMessage(replyChatId, '⚠️ Esa URL ya la habías enviado en este batch. Envía la siguiente o *fin*.');
        else await sendWhatsAppMessage(replyChatId, `✅ Factura #${n} recibida. Envía la siguiente o *fin*.`);
        return res.sendStatus(200);
      }
      if (isPDF && mediaUrl) {
        const n = enqueueBatchItem(sessionKey, 'pdf', mediaUrl);
        if (n === -1) await sendWhatsAppMessage(replyChatId, '⚠️ Ese PDF ya lo habías enviado en este batch. Envía el siguiente o *fin*.');
        else await sendWhatsAppMessage(replyChatId, `✅ PDF #${n} recibido. Envía el siguiente o *fin*.`);
        return res.sendStatus(200);
      }
      if (messageText.trim() && !/^(\d+)$/.test(messageText.trim())) {
        await sendWhatsAppMessage(replyChatId, '📦 En modo batch: envía URLs de la DGI o PDFs de facturas. Escribe *fin* para terminar.');
        return res.sendStatus(200);
      }
    }

    // Activar modo batch (linkCheck está fuera de ámbito aquí — se busca de nuevo)
    if (/^(batch|qr2)$/i.test(messageText.trim())) {
      const batchLink = await req.prisma.whatsAppLink.findFirst({
        where: { phoneNumber: from, verifiedAt: { not: null }, isActive: true },
      });
      if (!batchLink?.companyId) {
        await sendWhatsAppMessage(replyChatId, '❌ Tu número no está vinculado a una empresa. Vincula en el panel web → Configuración → WhatsApp.');
        return res.sendStatus(200);
      }
      startBatch(sessionKey, req.prisma, batchLink);
      await sendWhatsAppMessage(replyChatId, '📦 *Modo batch activado*\n\nElige el método de pago:\n  1. 💵 Efectivo\n  2. 💳 Tarjeta Crédito\n  3. 💳 Tarjeta Débito\n  4. 📋 Crédito\n  5. 🏦 Transferencia\n  6. 📄 Cheque');
      return res.sendStatus(200);
    }

    if (dgiUrlMatch) {
      const reply = await processWhatsAppDgiUrl(req.prisma, from, sessionKey, dgiUrlMatch[0]);
      if (reply) await sendWhatsAppMessage(replyChatId, reply);
      return res.sendStatus(200);
    }

    const reply = await processWhatsAppMessage(req.prisma, from, sessionKey, messageText);
    if (reply) await sendWhatsAppMessage(replyChatId,reply);
  } catch (err: any) {
    console.error('[WhatsApp] Webhook error:', err.message);
    try {
      await sendWhatsAppMessage(replyChatId,'❌ Ocurrió un error. Intenta de nuevo más tarde.');
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
      `Envía un PDF de la DGI o pega la URL del CUTE (el enlace del QR).\n\n` +
      `💡 *Comandos*\n` +
      `• Responde con números para seleccionar opciones\n` +
      `• *OK* — guardar transacción\n` +
      `• *XX* — cancelar / empezar de nuevo\n` +
      `• *HOLA* — ver estas instrucciones\n` +
      `• *batch* — carga masiva de URLs o PDFs\n` +
      `• *saldo* / *banco* — ver saldos bancarios`;
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
