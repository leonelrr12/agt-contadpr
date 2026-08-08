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
import { extractFromImage } from './ocr';
import { extractFromPDF } from './pdf-extractor';

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
 * Procesa un PDF de factura electrónica (DGI) enviado por WhatsApp.
 * Usa pdf-parse para extraer texto directamente (más preciso que OCR).
 */
export async function processWhatsAppPDF(
  prisma: any,
  phoneNumber: string,
  chatId: string,
  pdfUrl: string,
): Promise<string | null> {
  try {
    const pdfRes = await fetch(pdfUrl);
    if (!pdfRes.ok) return '❌ No pude descargar el PDF. Intenta de nuevo.';
    const buffer = Buffer.from(await pdfRes.arrayBuffer());

    const pdfData = await extractFromPDF(buffer, prisma);

    if (!pdfData.total && !pdfData.provider) {
      return `📄 No pude extraer datos del PDF (texto: ${(pdfData.text || '').substring(0, 100)}...). ¿Podrías describir la factura? Ej: "factura ENSA por $45.67"`;
    }

    // Construir resumen
    const summaryParts: string[] = [];
    if (pdfData.provider) summaryParts.push(`🏢 *Proveedor*: ${pdfData.provider}`);
    if (pdfData.ruc) summaryParts.push(`🔢 *RUC*: ${pdfData.ruc}`);
    if (pdfData.invoiceNumber) summaryParts.push(`📋 *Factura #*: ${pdfData.invoiceNumber}`);
    if (pdfData.total) summaryParts.push(`💰 *Total*: $${pdfData.total}`);
    if (pdfData.itbms) summaryParts.push(`📊 *ITBMS*: $${pdfData.itbms}`);
    if (pdfData.date) summaryParts.push(`📅 *Fecha*: ${pdfData.date}`);
    const summary = summaryParts.length > 0
      ? `📄 *Factura electrónica*\n\n${summaryParts.join('\n')}\n\n`
      : `📄 *Factura electrónica*\n\n`;

    // Extraer descripciones de items de la factura para mejorar clasificación
    const items = extractInvoiceItems(pdfData.text);
    const itemsDesc = items.length > 0 ? items.slice(0, 3).join(', ') : '';

    // Construir input sintético incluyendo items para clasificación por concepto.
    // Usar "compré" en vez de "pagué" para que clasifique como GASTO/COMPRA, no PAGO_PROVEEDOR.
    const parts: string[] = ['compré'];
    if (itemsDesc) parts.push(itemsDesc);
    if (pdfData.provider) parts.push(`en ${pdfData.provider}`);
    if (pdfData.total) parts.push(`$${pdfData.total}`);
    if (pdfData.date) parts.push(`del ${pdfData.date}`);
    if (pdfData.itbms) parts.push(`con ITBMS $${pdfData.itbms}`);
    const syntheticInput = parts.join(' ');

    const ocrContext: Record<string, any> = {};
    ocrContext.type = 'GASTO'; // DGI desde WhatsApp siempre es GASTO
    if (pdfData.provider) ocrContext.provider = pdfData.provider;
    if (pdfData.total) ocrContext.amount = pdfData.total;
    if (pdfData.date) ocrContext.date = pdfData.date;
    if (pdfData.ruc) ocrContext.ruc = pdfData.ruc;
    ocrContext.itbms = !!pdfData.itbms;
    ocrContext.source = 'pdf';
    if (items.length > 0) ocrContext.items = items;

    const context = { messages: [], extractedData: ocrContext };
    const link = await prisma.whatsAppLink.findFirst({
      where: { phoneNumber, verifiedAt: { not: null }, isActive: true },
    });

    const { OrchestratorAgent } = await import('@agt-contador/agents');
    const orchestrator = new OrchestratorAgent({
      prisma,
      companyId: link?.companyId || 'demo-company',
      userId: link?.companyId === 'demo-company' ? 'demo-user' : link?.companyId || 'demo-user',
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    });

    const result = await orchestrator.process(syntheticInput, context);

    if (result.prompt && !result.needsConfirmation) {
      const dialogData = (result.plan as any)?.dialog || {};
      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, syntheticInput);

      const missing = dialogData.missingFields || [];
      if (missing.length === 1 && missing[0] === 'paymentMethod') {
        setAwaitingPayment(chatId);
        return `${summary}${formatPaymentPrompt(dialogData)}`;
      }
      return `${summary}🤖 ${result.prompt}\n\n💡 _Responde con lo que falta, o *CANCELAR*._`;
    }

    if (result.needsConfirmation && result.prompt) {
      setPendingResult(chatId, result.result);
      return `${summary}${result.prompt}\n\n✏️ *CONFIRMAR* para guardar, *CANCELAR* para descartar.`;
    }

    return `${summary}_Revisa tu panel._`;
  } catch (err: any) {
    console.error('[WhatsApp] PDF error:', err.message);
    return '❌ Error al procesar el PDF. Intenta con otro archivo.';
  }
}

/**
 * Procesa una imagen de factura enviada por WhatsApp.
 * Descarga la imagen, ejecuta OCR y construye una transacción.
 */
export async function processWhatsAppImage(
  prisma: any,
  phoneNumber: string,
  chatId: string,
  imageUrl: string,
  caption?: string,
): Promise<string | null> {
  try {
    // Descargar imagen desde whatsapp-ai-bot
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return '❌ No pude descargar la imagen. Intenta de nuevo.';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    // OCR
    const ocrData = await extractFromImage(buffer, prisma);

    if (!ocrData.total && !ocrData.provider) {
      return `📷 No pude extraer datos de esta imagen (confianza: ${Math.round(ocrData.confidence * 100)}%). Asegúrate de que sea una factura legible.`;
    }

    // Construir texto para el orquestador — usar "compré" para clasificar como GASTO/COMPRA
    const parts: string[] = ['compré'];
    if (ocrData.provider) parts.push(`en ${ocrData.provider}`);
    if (ocrData.total) parts.push(`$${ocrData.total}`);
    if (ocrData.date) parts.push(`del ${ocrData.date}`);
    if (ocrData.itbms) parts.push(`con ITBMS $${ocrData.itbms}`);
    if (caption) parts.push(`(${caption})`);

    const syntheticInput = parts.join(' ');
    const ocrContext: Record<string, any> = {};
    ocrContext.type = 'GASTO'; // Factura desde WhatsApp siempre es GASTO
    if (ocrData.provider) ocrContext.provider = ocrData.provider;
    if (ocrData.total) ocrContext.amount = ocrData.total;
    if (ocrData.date) ocrContext.date = ocrData.date;
    if (ocrData.ruc) ocrContext.ruc = ocrData.ruc;
    ocrContext.itbms = !!ocrData.itbms;
    ocrContext.source = 'ocr';

    // Procesar con el orquestador usando contexto OCR pre-extraído
    const context = { messages: [], extractedData: ocrContext };
    const link = await prisma.whatsAppLink.findFirst({
      where: { phoneNumber, verifiedAt: { not: null }, isActive: true },
    });

    const { OrchestratorAgent } = await import('@agt-contador/agents');
    const orchestrator = new OrchestratorAgent({
      prisma,
      companyId: link?.companyId || 'demo-company',
      userId: link?.companyId === 'demo-company' ? 'demo-user' : link?.companyId || 'demo-user',
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    });

    // Construir resumen legible de lo extraído
    const summaryParts: string[] = [];
    if (ocrData.provider) summaryParts.push(`🏢 *Proveedor*: ${ocrData.provider}`);
    if (ocrData.total) summaryParts.push(`💰 *Total*: $${ocrData.total}`);
    if (ocrData.date) summaryParts.push(`📅 *Fecha*: ${ocrData.date}`);
    if (ocrData.itbms) summaryParts.push(`📊 *ITBMS*: $${ocrData.itbms}`);
    const ocrSummary = summaryParts.length > 0
      ? `📷 *Factura procesada*\n\n${summaryParts.join('\n')}\n\n`
      : `📷 *Factura procesada*\n\n`;

    const result = await orchestrator.process(syntheticInput, context);

    if (result.prompt && !result.needsConfirmation) {
      const dialogData = (result.plan as any)?.dialog || {};
      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, syntheticInput);

      const missing = dialogData.missingFields || [];
      if (missing.length === 1 && missing[0] === 'paymentMethod') {
        setAwaitingPayment(chatId);
        return `${ocrSummary}${formatPaymentPrompt(dialogData)}`;
      }

      return `${ocrSummary}🤖 ${result.prompt}\n\n💡 _Responde con lo que falta, o *CANCELAR*._`;
    }

    if (result.needsConfirmation && result.prompt) {
      setPendingResult(chatId, result.result);
      return `${ocrSummary}${result.prompt}\n\n✏️ *CONFIRMAR* para guardar, *CANCELAR* para descartar.`;
    }

    return `${ocrSummary}_Revisa tu panel para ver el asiento generado._`;
  } catch (err: any) {
    console.error('[WhatsApp] OCR error:', err.message);
    return '❌ Error al procesar la imagen. Intenta con una foto más clara.';
  }
}

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
      // Reconstruir input para que dialogAgent no malinterprete "1"/"efectivo" como monto.
      // Prioridad: texto original > reconstruir del contexto > fallback genérico
      let reprocessText = getOriginalInput(chatId);
      if (!reprocessText) {
        const ctx = waSession.dialogContext;
        const parts: string[] = [];
        if (ctx.type) parts.push(ctx.type.toLowerCase());
        if (ctx.concept) parts.push(ctx.concept);
        if (ctx.amount) parts.push(`$${ctx.amount}`);
        parts.push(method);
        reprocessText = parts.join(' ') || `pagué $${ctx.amount || 0} ${method}`;
      }
      const context: any = { extractedData: waSession.dialogContext };
      return await processWithOrchestrator(prisma, chatId, link, reprocessText, context);
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
    let reprocessText = getOriginalInput(chatId);
    if (!reprocessText) {
      const ctx = waSession.dialogContext;
      reprocessText = `pagué ${ctx.concept || ''} $${ctx.amount || 0} ${ctx.paymentMethod}`;
    }
    const context: any = { extractedData: waSession.dialogContext };
    return await processWithOrchestrator(prisma, chatId, link, reprocessText, context);
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

      const missing: string[] = dialogData.missingFields || [];

      // concept_category: auto-clasificar sin preguntar al usuario (solo una vez).
      if ((missing.includes('concept_category') || missing.includes('concept'))
          && !(dialogData as any)._autoClassified) {
        (dialogData as any)._autoClassified = true;
        const filteredMissing = missing.filter(m => m !== 'concept_category' && m !== 'concept');
        if (filteredMissing.length === 0) {
          dialogData.missingFields = [];
          setDialogContext(chatId, dialogData);
          const ctx: any = { extractedData: dialogData };
          const reprocessText = getOriginalInput(chatId) || text;
          return await processWithOrchestrator(prisma, chatId, link, reprocessText, ctx);
        }
        if (filteredMissing.length === 1 && filteredMissing[0] === 'paymentMethod') {
          dialogData.missingFields = filteredMissing;
          setDialogContext(chatId, dialogData);
          // No sobreescribir originalInput — preservar el texto del PDF
          setAwaitingPayment(chatId);
          return formatPaymentPrompt(dialogData);
        }
        missing.length = 0;
        missing.push(...filteredMissing);
      }

      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, text);

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

/** Extrae descripciones de items de una factura DGI. */
function extractInvoiceItems(pdfText: string): string[] {
  if (!pdfText) return [];
  // Buscar la sección de items: después de "Valor Item" y antes de "Desglose ITBMS"
  const lines = pdfText.split('\n');
  const items: string[] = [];
  let inItems = false;

  for (const line of lines) {
    if (/Valor\s*Item/i.test(line)) {
      inItems = true;
      continue;
    }
    if (/Desglose\s*ITBMS|Subtotal|Valor\s*Total/i.test(line)) {
      inItems = false;
      continue;
    }
    if (inItems) {
      const trimmed = line.trim();
      // Saltar cabeceras o líneas vacías
      if (!trimmed || /^(No\.|Código|Cantidad|Unidad|Precio)/i.test(trimmed)) continue;
      // La línea de item empieza con número seguido de descripción
      const match = trimmed.match(/^\d+\s+(.+?)(?:\s+\d+\.?\d*\s+)/);
      if (match) {
        const desc = match[1].trim();
        if (desc.length > 2 && desc.length < 80) items.push(desc);
      }
    }
  }
  return items;
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
      isActive: true,
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
