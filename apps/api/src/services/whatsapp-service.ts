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
  setAwaitingCategory,
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
const CMD_CONFIRM = /^(ok|confirmar|s[ií]|dale|aceptar|yes)$/i;
const CMD_CANCEL = /^(xx|cancelar|no|nop|abortar)$/i;
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

    // Extraer items para mostrar en resumen
    const items = extractInvoiceItems(pdfData.text);
    const itemsDesc = items.length > 0 ? items.slice(0, 3).join(', ') : '';

    // Construir resumen (items van después de fecha)
    const summaryParts: string[] = [];
    if (pdfData.provider) summaryParts.push(`🏢 *Proveedor*: ${pdfData.provider}`);
    if (pdfData.ruc) summaryParts.push(`🔢 *RUC*: ${pdfData.ruc}`);
    if (pdfData.invoiceNumber) summaryParts.push(`📋 *Factura #*: ${pdfData.invoiceNumber}`);
    if (pdfData.total) summaryParts.push(`💰 *Total*: $${pdfData.total}`);
    if (pdfData.itbms) summaryParts.push(`📊 *ITBMS*: $${pdfData.itbms}`);
    if (pdfData.date) summaryParts.push(`📅 *Fecha*: ${pdfData.date}`);
    // Los items se usan para clasificar, no se muestran
    const summary = summaryParts.length > 0
      ? `📄 *Factura electrónica*\n\n${summaryParts.join('\n')}\n\n`
      : `📄 *Factura electrónica*\n\n`;

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
    ocrContext.type = 'GASTO';
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

    // Delegar a processWithOrchestrator para manejo unificado de missing fields
    setOriginalInput(chatId, syntheticInput);
    const reply = await processWithOrchestrator(prisma, chatId, link, syntheticInput, context);
    return reply ? `${summary}${reply}` : null;
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
    // NO poner concept — dejar que el dialogAgent pida concept_category
    if (ocrData.provider) ocrContext.provider = ocrData.provider;
    if (ocrData.total) ocrContext.amount = ocrData.total;
    if (ocrData.date) ocrContext.date = ocrData.date;
    if (ocrData.ruc) ocrContext.ruc = ocrData.ruc;
    ocrContext.itbms = !!ocrData.itbms;
    ocrContext.source = 'ocr';

    // Construir resumen de lo extraído por OCR
    const summaryParts: string[] = [];
    if (ocrData.provider) summaryParts.push(`🏢 *Proveedor*: ${ocrData.provider}`);
    if (ocrData.total) summaryParts.push(`💰 *Total*: $${ocrData.total}`);
    if (ocrData.date) summaryParts.push(`📅 *Fecha*: ${ocrData.date}`);
    if (ocrData.itbms) summaryParts.push(`📊 *ITBMS*: $${ocrData.itbms}`);

    const context = { messages: [], extractedData: ocrContext };
    const link = await prisma.whatsAppLink.findFirst({
      where: { phoneNumber, verifiedAt: { not: null }, isActive: true },
    });

    // Delegar a processWithOrchestrator para manejo unificado
    setOriginalInput(chatId, syntheticInput);
    const reply = await processWithOrchestrator(prisma, chatId, link, syntheticInput, context);
    if (!reply) return null;
    const ocrPrefix = summaryParts.length > 0
      ? `📷 *Factura procesada*\n\n${summaryParts.join('\n')}\n\n`
      : `📷 *Factura procesada*\n\n`;
    return `${ocrPrefix}${reply}`;
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
      return `🤖 *Contador507* — ¿Qué deseas registrar?\n\n📝 _\"compré gasolina por \$40\"_\n📄 _Envía un PDF o foto de factura_\n\n💡 *OK* = guardar | *XX* = cancelar | *HOLA* = ayuda`;
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

  // ── Determinar intención del mensaje ──
  const lower = text.toLowerCase().trim();
  const isConfirm = CMD_CONFIRM.test(text);
  const isCancel = CMD_CANCEL.test(text);
  const categoryReply = parseCategoryReply(text);         // "Gastos Varios", "otra", o null
  const paymentReply = parsePaymentMethodReply(text);     // "EFECTIVO", "TARJETA_CREDITO", etc
  const hasCtx = !!waSession.dialogContext;
  const ctx = waSession.dialogContext || {};
  const conceptSelected = !!(ctx as any)._conceptSelected;
  const customCategoryPending = !!(ctx as any)._awaitingCustomCategory;

  // ── 1. Comandos globales ──
  if (isCancel && hasCtx) { resetSession(chatId); return `❌ Transacción cancelada. ¿Qué deseas registrar ahora?`; }
  if (CMD_RESET.test(text)) { resetSession(chatId); return `🔄 Sesión reiniciada. ¿Qué deseas registrar?`; }

  // ── 2. Confirmación (OK guarda, cualquier otra cosa reinicia) ──
  if (waSession.pendingResult) {
    if (isConfirm) return await handleConfirm(prisma, chatId, link, waSession);
    // Si hay pendingResult pero no es OK ni XX, ignorar y seguir
  }

  // ── 3. Categoría custom pendiente (el usuario debe escribir el nombre) ──
  if (customCategoryPending) {
    (ctx as any).concept = text.trim().substring(0, 60);
    (ctx as any)._awaitingCustomCategory = false;
    (ctx as any)._conceptSelected = true;
    return await advanceAfterCategory(prisma, chatId, link, waSession);
  }

  // ── 4. Respuesta de categoría ("1"=Gastos Varios, "2"=Otra) ──
  if (categoryReply && hasCtx && !conceptSelected) {
    if (categoryReply === 'otra') {
      (ctx as any)._awaitingCustomCategory = true;
      return 'Escribe el nombre de la categoría (ej: _Papelería, Refrigerios, Mantenimiento_):';
    }
    (ctx as any).concept = categoryReply;
    (ctx as any)._conceptSelected = true;
    return await advanceAfterCategory(prisma, chatId, link, waSession);
  }

  // ── 5. Respuesta de pago (solo si ya se seleccionó concepto) ──
  if (paymentReply && hasCtx && conceptSelected) {
    (ctx as any).paymentMethod = paymentReply;
    let reprocessText = getOriginalInput(chatId);
    if (!reprocessText) {
      const parts: string[] = [];
      if ((ctx as any).type) parts.push((ctx as any).type.toLowerCase());
      if ((ctx as any).concept) parts.push((ctx as any).concept);
      if ((ctx as any).amount) parts.push(`$${(ctx as any).amount}`);
      parts.push(paymentReply);
      reprocessText = parts.join(' ');
    }
    return await processWithOrchestrator(prisma, chatId, link, reprocessText, { messages: [], extractedData: ctx as any });
  }

  // ── 6. Entity matches ──
  if (waSession.entityMatches && hasCtx) {
    if (/^nuev[oa]$/i.test(lower)) {
      (ctx as any).selectedEntityId = null;
      return await afterEntitySelection(prisma, chatId, link, waSession);
    }
    const num = parseInt(text);
    if (num >= 1 && num <= waSession.entityMatches.length) {
      (ctx as any).selectedEntityId = waSession.entityMatches[num - 1].id;
      return await afterEntitySelection(prisma, chatId, link, waSession);
    }
  }

  // ── 7. Default: nueva transacción ──
  const context: any = {};
  if (hasCtx && !conceptSelected) {
    // Si hay contexto pero no se ha procesado, pasarlo (puede ser un follow-up no reconocido)
    context.extractedData = ctx;
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
  if ((waSession.dialogContext as any)?.paymentMethod) {
    let reprocessText = getOriginalInput(chatId) || `pagué ${(waSession.dialogContext as any).concept || ''} $${(waSession.dialogContext as any).amount || 0} ${(waSession.dialogContext as any).paymentMethod}`;
    return await processWithOrchestrator(prisma, chatId, link, reprocessText, { messages: [], extractedData: waSession.dialogContext });
  }
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
      const missing: string[] = [...(dialogData.missingFields || [])];

      // Orden fijo: 1º categoría → 2º forma de pago → 3º resto
      const hasConcept = missing.includes('concept_category') || missing.includes('concept');
      const hasPayment = missing.includes('paymentMethod');

      // Preservar campos del contexto existente Y del contexto original (ocrContext)
      const existingCtx = getSession(chatId)?.dialogContext;
      if (existingCtx?.paymentMethod) (dialogData as any).paymentMethod = existingCtx.paymentMethod;
      if (existingCtx?.amount && !dialogData.amount) (dialogData as any).amount = existingCtx.amount;
      if (existingCtx?._conceptSelected) (dialogData as any)._conceptSelected = true;
      if (existingCtx?.concept) (dialogData as any).concept = existingCtx.concept;
      // Forzar type y source desde el contexto de entrada (PDF/OCR)
      const inputCtx = context?.extractedData;
      if (inputCtx?.type) (dialogData as any).type = inputCtx.type;
      if (inputCtx?.source) (dialogData as any).source = inputCtx.source;

      // Quitar concept_category si ya fue seleccionada
      if ((missing.includes('concept_category') || missing.includes('concept')) && (dialogData as any)._conceptSelected) {
        missing.length = 0;
        const rest = (dialogData.missingFields || []).filter((m: string) => m !== 'concept_category' && m !== 'concept');
        missing.push(...rest);
      }

      // Guardar contexto DESPUÉS de decidir el estado
      setDialogContext(chatId, dialogData);
      setOriginalInput(chatId, text);

      // Si es PDF/imagen: usar el concepto clasificado por el orquestador
      const isMedia = (dialogData as any).source === 'pdf' || (dialogData as any).source === 'ocr';
      if (isMedia && !(dialogData as any)._conceptSelected) {
        const classifiedConcept = (result.plan as any)?.classification?.concept;
        if (classifiedConcept && classifiedConcept !== (dialogData as any).concept) {
          // El orquestador clasificó a algo más específico (ej. Alimentación vs RINCON KG)
          (dialogData as any).concept = classifiedConcept;
          (dialogData as any)._conceptSelected = true;
        } else if ((dialogData as any).concept && (dialogData as any).concept !== 'Gastos Varios') {
          (dialogData as any)._conceptSelected = true;
        } else if (missing.includes('concept_category')) {
          setAwaitingCategory(chatId);
          return formatCategoryPrompt(dialogData);
        }
      }

      // Si falta forma de pago Y no se ha seleccionado categoría → categoría primero
      if (missing.includes('paymentMethod') && !(dialogData as any)._conceptSelected) {
        setAwaitingCategory(chatId);
        return formatCategoryPrompt(dialogData);
      }

      // Si falta forma de pago → mostrar pago
      if (missing.includes('paymentMethod')) {
        setAwaitingPayment(chatId);
        return formatPaymentPrompt(dialogData);
      }

      // 3. Nada falta → confirmación
      if (missing.length === 0) {
        const { OrchestratorAgent: OA2 } = await import('@agt-contador/agents');
        const o2 = new OA2({ prisma, companyId: link.companyId, userId: link.companyId === 'demo-company' ? 'demo-user' : link.companyId, deepseekApiKey: process.env.DEEPSEEK_API_KEY });
        const r2 = await o2.process(text, { messages: [], extractedData: dialogData });
        if (r2.needsConfirmation && r2.prompt) { setPendingResult(chatId, r2.result); return r2.prompt; }
        if (r2.prompt) return r2.prompt;
      }

      // 4. Otros
      return `🤖 ${result.prompt}\n\n💡 _Responde a este mensaje con lo que falta, o escribe *XX* para empezar de nuevo._`;
    }

    // ── Listo para confirmar ──
    if (result.needsConfirmation && result.prompt) {
      setPendingResult(chatId, result.result);
      return `${result.prompt}\n\n✏️ Escribe *OK* para guardar, o *XX* para descartar.`;
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

    const s = getSession(chatId);
    if (s) { s.pendingResult = null; s.dialogContext = null; s.originalInput = null; }
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

/** Formatea el prompt de categoría. */
function formatCategoryPrompt(_dialogData: any): string {
  return `📂 *Clasificar gasto*\n\n 1. Gastos Varios\n 2. Otra (especificar)\n\nResponde *1* o *2*.`;
}

/** Parsea la respuesta de categoría. */
function parseCategoryReply(text: string): string | null {
  const t = text.toLowerCase().trim();
  if (t === '1' || t === 'gastos varios' || t === 'varios') return 'Gastos Varios';
  if (t === '2' || t === 'otra' || t === 'otro' || t === 'especificar') return 'otra';
  // Si no es 1 ni 2 pero estamos en modo custom, devolver custom
  return null;
}

/** Avanza después de seleccionar categoría: verifica qué falta y muestra el siguiente paso. */
async function advanceAfterCategory(prisma: any, chatId: string, link: any, waSession: any): Promise<string> {
  const ctx = waSession.dialogContext!;
  (ctx as any)._conceptSelected = true;

  if (!(ctx as any).paymentMethod) {
    return formatPaymentPrompt(ctx);
  }

  // Todo completo: re-ejecutar orquestador con contexto completo para obtener confirmación
  const reprocessText = getOriginalInput(chatId) || `compré ${ctx.concept} $${ctx.amount || 0} ${ctx.paymentMethod}`;
  const { OrchestratorAgent: OA3 } = await import('@agt-contador/agents');
  const o3 = new OA3({
    prisma, companyId: link.companyId,
    userId: link.companyId === 'demo-company' ? 'demo-user' : link.companyId,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  });
  const result3 = await o3.process(reprocessText, { messages: [], extractedData: ctx });

  if (result3.needsConfirmation && result3.prompt) {
    setPendingResult(chatId, result3.result);
    // Limpiar el texto del resultado — quitar "Asiento contable" si el monto está mal
    return result3.prompt;
  }

  // Si el orquestador aún reporta concept_category, forzar confirmación
  const missing = (result3.plan as any)?.dialog?.missingFields || [];
  if (missing.includes('concept_category')) {
    // El concepto ya fue seleccionado — forzar confirmación
    setPendingResult(chatId, result3.result);
    return result3.prompt || `✅ *${ctx.concept}* — $${ctx.amount}\n\n✏️ Escribe *OK* para guardar, o *XX* para descartar.`;
  }

  if (result3.prompt) return result3.prompt;
  return `✅ Transacción lista. Escribe *OK* para guardar.`;
}

/** Formatea el prompt de método de pago con opciones numeradas. */
function formatPaymentPrompt(dialogData: any): string {
  const concept = (dialogData as any)?.concept || '';
  const conceptLine = concept && concept !== 'Gastos Varios' ? `📂 *Concepto*: ${concept}\n\n` : '';
  const isVenta = dialogData.type === 'VENTA' || dialogData.type === 'COBRO_CLIENTE';
  const methods = [
    '💵 Efectivo', '💳 Tarjeta Crédito', '💳 Tarjeta Débito',
    isVenta ? '📋 Crédito (por cobrar)' : '📋 Crédito (por pagar)',
    '🏦 Transferencia', '📄 Cheque',
  ];
  const lines = methods.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
  return `${conceptLine}💳 *¿Cómo se pagó?*\n${lines}\n\nResponde con el número o el nombre del método.`;
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
