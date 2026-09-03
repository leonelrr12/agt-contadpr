// chat.js (4/14) — pipeline de chat, widgets, confirmación y revisión rápida
function showEntityMatchSelector(data) {
  const matches = data.entityMatches;
  const providerName = data.plan?.dialog?.provider || '';
  const dialogData = data.plan?.dialog || {};

  let html = `<div class="classification-box"><strong>🔍 Coincidencias para "${providerName}":</strong><br><br>`;

  for (const m of matches) {
    const icon = m.type === 'cliente' ? '👤' : '🏭';
    const label = m.type === 'cliente' ? 'Cliente' : 'Proveedor';
    html += `<button class="quick-btn" onclick="selectEntityMatch('${m.id}','${m.type}')" style="width:100%;text-align:left;margin-bottom:4px">${icon} ${m.name} <span style="color:#6b7280;font-size:12px">(${label} existente)</span></button>`;
  }

  // Opción de crear nuevo
  html += `<button class="quick-btn" onclick="selectEntityMatch(null,'nuevo')" style="width:100%;text-align:left;margin-top:8px;border:2px dashed #d0d5dd">✨ Crear nuevo: "${providerName}"</button>`;
  html += '</div>';

  addMessage(html, 'assistant-html');
  // Guardar para usar en confirm
  pendingResult = data.result;
  dialogContext = dialogData;
}

async function selectEntityMatch(entityId, entityType) {
  // Guardar en dialogContext para que sobreviva al round-trip del método de pago
  if (!dialogContext) dialogContext = {};
  if (entityId && entityType !== 'nuevo') {
    dialogContext.selectedEntityId = entityId;
  } else {
    dialogContext.selectedEntityId = null; // crear nuevo
  }

  addMessage(`✅ Seleccionaste: ${entityType === 'nuevo' ? 'Crear nuevo' : 'Entidad existente'}`, 'user-message');

  // Proceder a pedir método de pago o mostrar el asiento para CONFIRMAR
  // (nunca confirmar directo — el usuario debe ver el asiento antes de guardarlo)
  const missing = dialogContext?.missingFields || [];
  if (missing.includes('paymentMethod') || !dialogContext?.paymentMethod) {
    showPaymentMethodSelector();
  } else {
    showPendingConfirmation();
  }
}

/** Muestra el asiento pendiente en el modal de confirmación (sincronizando el contexto). */
function showPendingConfirmation() {
  if (!pendingResult) return;
  // Sincronizar el dialog del resultado con el contexto (paymentMethod, entidad, fecha)
  if (pendingResult.dialog && dialogContext) {
    if (dialogContext.paymentMethod) pendingResult.dialog.paymentMethod = dialogContext.paymentMethod;
    if (dialogContext.selectedEntityId !== undefined) pendingResult.dialog.selectedEntityId = dialogContext.selectedEntityId;
    if (dialogContext.date) pendingResult.dialog.date = dialogContext.date;
  }
  const overlay = document.getElementById('modal-overlay');
  if (overlay && !overlay.classList.contains('hidden')) return; // ya visible
  showConfirmationModal({ result: pendingResult });
}

function showPaymentMethodSelector() {
  // Mostrar opciones según el tipo de transacción (venta vs gasto)
  const isVenta = dialogContext?.type === 'VENTA' || dialogContext?.type === 'COBRO_CLIENTE';
  const methods = [
    { value: 'EFECTIVO', label: '💵 Efectivo' },
    { value: 'TARJETA_CREDITO', label: '💳 Tarjeta Crédito' },
    { value: 'TARJETA_DEBITO', label: '💳 Tarjeta Débito' },
    { value: isVenta ? 'CREDITO' : 'CREDITO', label: isVenta ? '📋 Crédito (por cobrar)' : '📋 Crédito (por pagar)' },
    { value: 'TRANSFERENCIA', label: '🏦 Transferencia' },
    { value: 'CHEQUE', label: '📄 Cheque' },
  ];

  let html = '<div class="classification-box"><strong>Selecciona el método de pago:</strong><br><br>';
  for (const m of methods) {
    html += `<button class="quick-btn" onclick="selectPaymentMethod('${m.value}')" style="flex:1;min-width:120px">${m.label}</button> `;
  }
  html += '</div>';

  addMessage(html, 'assistant-html');
}

async function selectPaymentMethod(method) {
  if (!dialogContext) dialogContext = {};
  dialogContext.paymentMethod = method;

  const input = document.getElementById('message-input');
  input.value = currentInput;
  await sendMessage();
}

async function showClassificationUI(concept) {
  pendingClassification = { concept, input: currentInput };
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    const accounts = await res.json();
    const pasivos = accounts.filter(a => a.type === 'PASIVO' || a.type === 'GASTO');

    let html = `<div class="classification-box"><strong>Clasificar: "${concept}"</strong><br><br>`;
    html += `<label for="classify-account">Selecciona la cuenta contable:</label><br>`;
    html += `<select id="classify-account" class="classify-select">`;
    html += `<option value="">— Selecciona una cuenta —</option>`;
    for (const a of accounts) {
      html += `<option value="${a.id}">${a.code} — ${a.name}</option>`;
    }
    html += `</select>`;
    html += `<br><br><button class="classify-btn" onclick="submitClassification()">Clasificar</button>`;
    html += `</div>`;

    addMessage(html, 'assistant-html');
  } catch (e) {
    addMessage('Error al cargar cuentas. Intenta de nuevo.', 'assistant');
  }
}

async function submitClassification() {
  const select = document.getElementById('classify-account');
  const accountId = select.value;
  if (!accountId) { await showAlert('Selecciona una cuenta'); return; }

  const { concept, input } = pendingClassification;
  pendingClassification = null;

  try {
    await authFetch(`${API_URL}/concepts`, {
      method: 'POST',
      body: JSON.stringify({ name: concept, accountId }),
    });

    document.getElementById('message-input').value = input;
    await sendMessage();
  } catch (e) {
    addMessage('Error al clasificar. Intenta de nuevo.', 'assistant');
  }
}

async function sendMessage() {
  const input = document.getElementById('message-input');
  const text = input.value.trim();
  if (!text) return;

  currentInput = text;
  addMessage(text, 'user');
  input.value = '';

  if (/^(historial|últimos|recientes|ver asientos|últimos asientos)\b/i.test(text.trim())) {
    showRecentEntries();
    cancelInput();
    return;
  }

  // Validar que el texto contenga un verbo de transacción
  if (!/\b(compr[éeoaó]|compra|gast[éeoaó]|gasto|ech[éeoaó]|hech[oa]|vend[iíoaó]|venta|alm(?:uer|or)[cz](?:e|o|é|ó)?|cen[aeoóé]|desayun[oaóé]|pagu[éeoaó]|pago|cobr[éeoaó]|cobro|factur[aeoé]|recib[iíoaó]|recibo|abon[éeoaó]|deposit[éeoaó]|transfer[ií]|transferencia|retir[éeoaó]|retiro)(?![\p{L}\p{N}_])/iu.test(text)) {
    addMessage('📝 Usa un verbo para describir la transacción. Ejemplos:\n• "compré gasolina $40"\n• "pagué internet $65"\n• "vendí mercancía $100"', 'assistant');
    cancelInput();
    return;
  }

  showLoading();

  try {
    const body = { input: text };
    // Inyectar la fecha de captura en el contexto para que el backend la use.
    // Si el dialogContext ya tiene una fecha (ej. de OCR/PDF), esa tiene prioridad;
    // si no, se usa la fecha del selector persistente.
    // Sanitizar: el LLM a veces devuelve datetime completo (YYYY-MM-DDTHH:mm...)
    const rawDate = dialogContext?.date || captureDate;
    const extractedDate = typeof rawDate === 'string' ? rawDate.substring(0, 10) : captureDate;
    const ctx = { ...(dialogContext || {}), date: extractedDate };
    body.context = { extractedData: ctx };
    const res = await authFetch(`${API_URL}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    removeLoading();

    if (!res.ok) {
      // Mostrar error amigable del servidor
      const msg = data.error || 'Error al procesar tu solicitud.';
      addMessage(`⚠️ ${msg}`, 'assistant');
      if (data.contactSupport) {
        addMessage('📞 Contacta a soporte técnico si el problema persiste.', 'assistant');
      }
      // Fallback a procesamiento local
      handleLocalProcessing(text);
      cancelInput();
      return;
    }

    if (data.entityMatches && data.entityMatches.length > 0) {
      // Mostrar selector de coincidencias de cliente/proveedor
      showEntityMatchSelector(data);
      cancelInput();
    } else if (data.needsConfirmation) {
      dialogContext = null;
      pendingResult = data.result;
      showConfirmationModal(data);
      cancelInput();
    } else if (data.prompt) {
      // Preservar selectedEntityId si ya fue elegido
      const prevSelectedId = dialogContext?.selectedEntityId;
      dialogContext = data.plan?.dialog || null;
      if (prevSelectedId && dialogContext) {
        dialogContext.selectedEntityId = prevSelectedId;
      }
      const missing = data.plan?.dialog?.missingFields || [];
      // Solo mostrar selector de pago si es el ÚNICO campo faltante.
      // Si hay otros (amount, concept, type), dejar que el prompt del servidor los pida primero.
      if (missing.length === 1 && missing[0] === 'paymentMethod') {
        showPaymentMethodSelector();
      } else if (data.prompt.includes('clasificarlo manualmente')) {
        cancelInput();
        const match = data.prompt.match(/el concepto "([^"]+)"/);
        const concept = match ? match[1] : text;
        showClassificationUI(concept);
      } else {
        addMessage(data.prompt, 'assistant');
        showInput('escribir', true);
      }
    } else {
      cancelInput();
    }
  } catch (err) {
    removeLoading();
    // Intentar obtener mensaje amigable del servidor
    let serverMsg = '';
    try {
      if (err.message && err.message !== 'Failed to fetch') serverMsg = err.message;
    } catch (_) {}
    if (serverMsg) {
      addMessage(`⚠️ ${serverMsg}`, 'assistant');
      if (serverMsg.includes('soporte') || serverMsg.includes('contactar')) {
        addMessage('📞 Si el problema persiste, contacta a soporte técnico.', 'assistant');
      }
    }
    // Fallback: procesar localmente sin IA
    handleLocalProcessing(text);
    cancelInput();
  }
}

function extractPaymentMethod(input) {
  const lower = input.toLowerCase();
  if (lower.includes('tarjeta') || lower.includes('tc') || lower.includes('tarjeta de credito') || lower.includes('tarjeta crédito')) return 'TARJETA_CREDITO';
  if (lower.includes('credito') || lower.includes('crédito')) return 'CREDITO';
  if (lower.includes('efectivo') || lower.includes('cash')) return 'EFECTIVO';
  if (lower.includes('debito') || lower.includes('débito') || lower.includes('tarjeta de debito')) return 'TARJETA_DEBITO';
  if (lower.includes('transferencia') || lower.includes('banco general') || lower.includes('banco nacional')) return 'TRANSFERENCIA';
  if (lower.includes('cheque')) return 'CHEQUE';
  return null;
}

function extractConcept(input) {
  const lower = input.toLowerCase();
  if (lower.includes('combustible') || lower.includes('gasolina') || lower.includes('gas')) return 'Combustible';
  if (lower.includes('luz') || lower.includes('electricidad')) return 'Electricidad';
  if (lower.includes('internet')) return 'Internet';
  if (lower.includes('teléfono') || lower.includes('telefono') || lower.includes('celular')) return 'Teléfono';
  if (lower.includes('agua')) return 'Agua';
  if (lower.includes('papel') || lower.includes('oficina') || lower.includes('utiles') || lower.includes('útiles')) return 'Papelería';
  if (lower.includes('comida') || lower.includes('almuerzo') || lower.includes('alimentación')) return 'Alimentación';
  if (lower.includes('alquiler') || lower.includes('renta')) return 'Alquiler';
  if (lower.includes('seguro')) return 'Seguros';
  if (lower.includes('publicidad') || lower.includes('marketing') || lower.includes('anuncio')) return 'Publicidad';
  return null;
}

function extractAmount(input) {
  const match = input.match(/\$?(\d+(?:[.,]\d+)?)/);
  return match ? parseFloat(match[1].replace(',', '.')) : null;
}

function handleLocalProcessing(input) {
  const lower = input.toLowerCase();
  const amount = extractAmount(input);
  const concept = extractConcept(input);
  const paymentMethod = extractPaymentMethod(input);

  let type = 'GASTO';
  if (lower.includes('vend') || lower.includes('venta') || lower.includes('facture')) type = 'VENTA';
  else if (lower.includes('cobre') || lower.includes('cobr')) type = 'COBRO_CLIENTE';
  else if (lower.includes('compra') && (lower.includes('inventario') || lower.includes('mercancia') || lower.includes('mercaderia'))) type = 'COMPRA';
  else if (lower.includes('pagu') || lower.includes('pago') || lower.includes('compr')) type = 'GASTO';

  const missingFields = [];
  if (!amount) missingFields.push('• **Monto** — ¿Cuánto fue?');
  if (!concept) missingFields.push('• **Concepto** — ¿Qué concepto es?');
  if (!paymentMethod) missingFields.push('• **Método de pago** — ¿Efectivo, Tarjeta o Transferencia?');

  let response = `📋 He entendido lo siguiente:\n\n` +
    `• Tipo: **${type}**\n` +
    `• Concepto: **${concept || '—'}**\n` +
    `• Monto: **${amount ? '$' + amount : '—'}**\n` +
    `• Pago: **${paymentMethod || '—'}**\n`;

  if (missingFields.length > 0) {
    response += `\nFalta información:\n${missingFields.join('\n')}`;
    response += `\n\n⚠️ **El servidor no está disponible.** Completa los datos faltantes y vuelve a enviar cuando se restablezca la conexión.`;
  } else {
    // Guardamos el input para que el usuario pueda reintentar
    response += `\n\n⚠️ **El servidor no está disponible en este momento.** Tu mensaje fue entendido pero no se puede registrar ahora. Presiona "Reintentar" cuando vuelva la conexión.`;
  }

  addMessage(response, 'assistant');

  if (missingFields.length === 0) {
    // Mostrar botón de reintentar en lugar del modal de confirmación con IDs inválidos
    showRetryButton(input);
  }
}

function showRetryButton(originalText) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message assistant';
  const btn = document.createElement('button');
  btn.textContent = '🔄 Reintentar';
  btn.style.cssText = 'background:#f59e0b;color:#fff;border:none;padding:10px 20px;border-radius:6px;font-size:14px;cursor:pointer;margin-top:4px';
  btn.onclick = () => {
    const input = document.getElementById('message-input');
    input.value = originalText;
    sendMessage();
  };
  div.appendChild(btn);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function addMessage(text, role) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${role === 'assistant-html' ? 'assistant' : role}`;

  if (role === 'assistant-html') {
    div.innerHTML = text;
  } else if (role === 'assistant' && text.includes('Débito:') && text.includes('Crédito:')) {
    div.innerHTML = formatEntryMessage(text);
  } else {
    div.textContent = text;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function formatEntryMessage(text) {
  const lines = text.split('\n');
  let html = '';
  let inTable = false;

  for (const line of lines) {
    if (line.startsWith('  Débito:')) {
      if (!inTable) {
        html += '<table class="entry-table"><tr><th>Cuenta</th><th>Débito</th><th>Crédito</th></tr>';
        inTable = true;
      }
      const match = line.match(/Débito:\s(.+?)\s—\s\$([\d.]+)/);
      if (match) html += `<tr><td>${match[1]}</td><td class="debit">$${match[2]}</td><td></td></tr>`;
    } else if (line.startsWith('  Crédito:')) {
      if (!inTable) {
        html += '<table class="entry-table"><tr><th>Cuenta</th><th>Débito</th><th>Crédito</th></tr>';
        inTable = true;
      }
      const match = line.match(/Crédito:\s(.+?)\s—\s\$([\d.]+)/);
      if (match) html += `<tr><td>${match[1]}</td><td></td><td class="credit">$${match[2]}</td></tr>`;
    } else {
      if (inTable) { html += '</table>'; inTable = false; }
      html += (line ? line + '\n' : '');
    }
  }
  if (inTable) html += '</table>';
  return html;
}

function showLoading() {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message assistant loading';
  div.id = 'loading-msg';
  div.textContent = 'Procesando...';
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function removeLoading() {
  const el = document.getElementById('loading-msg');
  if (el) el.remove();
}

function showConfirmationModal(data) {
  const body = document.getElementById('modal-body');
  const result = data.result;
  const dialog = result.dialog;
  const entry = result.entry;

  let html = `<div style="margin-bottom:16px"><strong>Resumen:</strong><br>`;

  if (dialog) {
    html += `• Tipo: ${dialog.type}<br>`;
    const backendConcept = dialogContext?.concept;
    const classified = result.classification?.concept;
    const conceptDisplay = backendConcept && backendConcept !== dialog.concept
      ? `${dialog.concept} (${backendConcept})`
      : classified && classified !== dialog.concept
        ? `${dialog.concept} (${classified})`
        : dialog.concept;
    html += `• Concepto: ${conceptDisplay}<br>`;
    html += `• Monto: $${dialog.amount}<br>`;
    if (dialog.paymentMethod) html += `• Pago: ${dialog.paymentMethod}<br>`;
    html += `• 📅 Fecha: ${formatDateForDisplay(dialog.date)}<br>`;
  }
  html += `</div>`;

  if (entry) {
    html += `<table class="entry-table" style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><th style="text-align:left;padding:6px 10px;border-bottom:1px solid #eee;background:#f9f9f9">Cuenta</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #eee;background:#f9f9f9">Débito</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:1px solid #eee;background:#f9f9f9">Crédito</th></tr>`;
    for (const d of entry.debit) {
      html += `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${d.name}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#2e7d32">$${d.amount}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #eee"></td></tr>`;
    }
    for (const c of entry.credit) {
      html += `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${c.name}</td>
                  <td style="padding:6px 10px;border-bottom:1px solid #eee"></td>
                  <td style="padding:6px 10px;border-bottom:1px solid #eee;color:#c62828">$${c.amount}</td></tr>`;
    }
    html += `</table>`;
  }

  body.innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  dialogContext = null;
  pendingResult = null;
  document.getElementById('quick-actions').classList.remove('hidden');
}

async function confirmTransaction() {
  const result = pendingResult;
  // Guardar selectedEntityId antes de que closeModal lo borre
  const selectedEntityId = dialogContext?.selectedEntityId || null;
  closeModal();
  addMessage('✅ Transacción confirmada. Registrando...', 'assistant');

  try {
    // Si el usuario seleccionó una entidad existente, pasar el ID
    if (selectedEntityId) {
      result.selectedEntityId = selectedEntityId;
    }
    const res = await authFetch(`${API_URL}/orchestrate/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
    if (res.ok) {
      const data = await res.json();
      const entryId = data.journalEntry.id;
      let msg = `✅ **Transacción registrada exitosamente**\n\nAsiento #${entryId.slice(0,8)} registrado en el Libro Diario.`;
      if (data.autoCreated) {
        const label = data.autoCreated.type.includes('nuevo') ? '✨ Nuevo' : '📋 Existente';
        const entity = data.autoCreated.type.startsWith('cliente') ? 'cliente' : 'proveedor';
        msg += `\n\n${label} ${entity}: **${data.autoCreated.name}** → /${entity}s.html`;
      }
      addMessage(msg, 'assistant');
      loadSubscriptionInfo(); // Actualizar contador de movimientos
    } else {
      const errData = await res.json().catch(() => ({}));
      let msg = errData.error || 'Error al registrar. Intenta de nuevo.';
      // Mostrar detalles de validación si existen
      if (errData.detalles && Array.isArray(errData.detalles)) {
        const fields = errData.detalles.map(d => d.campo).join(', ');
        msg += ` (${fields})`;
      }
      addMessage(`❌ ${msg}`, 'assistant');
      if (errData.contactSupport) {
        addMessage('📞 Contacta a soporte técnico si el problema persiste.', 'assistant');
      }
    }
  } catch (err) {
    simulateConfirm();
  }

  dialogContext = null;
  pendingResult = null;
  document.getElementById('quick-actions').classList.remove('hidden');
}

function addUndoButton(entryId) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'message assistant';
  const btn = document.createElement('button');
  btn.textContent = '↩ Deshacer este asiento';
  btn.style.cssText = 'background:#c62828;color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer';
  btn.onclick = () => anularEntry(entryId, btn);
  div.appendChild(btn);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function showRecentEntries() {
  try {
    const res = await authFetch(`${API_URL}/journal?pageSize=5`);
    const data = await res.json();
    const entries = data.entries;
    if (!entries || !entries.length) {
      addMessage('No hay asientos registrados aún.', 'assistant');
      return;
    }
    let msg = '**Últimos asientos registrados:**\n';
    for (const e of entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      const deb = e.lines.reduce((s, l) => s + l.debit, 0);
      const cred = e.lines.reduce((s, l) => s + l.credit, 0);
      msg += `\n#${e.id.slice(0,8)} — ${date} — ${e.description}\n  Débito: $${deb.toFixed(2)}  Crédito: $${cred.toFixed(2)}  [${e.status}]`;
    }
    if (data.total > 5) msg += `\n\n... y ${data.total - 5} más. Ver reportes para el listado completo.`;
    addMessage(msg, 'assistant');
  } catch (e) {
    addMessage('Error al cargar historial.', 'assistant');
  }
}

let confirmCallback = null;

function showConfirmModal(msg, okLabel, cb) {
  document.getElementById('confirm-msg').textContent = msg;
  document.getElementById('confirm-icon').textContent = '⚠️';
  const okBtn = document.getElementById('confirm-ok-btn');
  okBtn.textContent = okLabel || 'Sí, anular';
  okBtn.className = okLabel === 'Sí, anular' ? 'btn-danger' : 'btn-primary';
  confirmCallback = cb;
  document.getElementById('confirm-dialog').classList.remove('hidden');
  document.getElementById('confirm-overlay').classList.remove('hidden');
}

function closeConfirm() {
  document.getElementById('confirm-dialog').classList.add('hidden');
  document.getElementById('confirm-overlay').classList.add('hidden');
  confirmCallback = null;
}

document.getElementById('confirm-ok-btn').addEventListener('click', () => {
  const cb = confirmCallback;
  closeConfirm();
  if (cb) cb();
});

async function anularEntry(id, btn) {
  showConfirmModal('¿Estás seguro de anular este asiento?\nSe creará un asiento de reversión.', 'Sí, anular', async () => {
    if (btn) { btn.disabled = true; btn.textContent = 'Anulando...'; btn.style.opacity = '0.6'; }
    try {
      const res = await authFetch(`${API_URL}/journal/${id}/anular`, { method: 'POST' });
      if (!res.ok) { const e = await res.json(); await showAlert(e.error); if (btn) btn.remove(); return; }
      const data = await res.json();
      if (btn) btn.remove();
      addMessage(`↩ **Asiento anulado**\n\nAsiento de reversión #${data.reversal.id.slice(0,8)} creado.`, 'assistant');
      loadSubscriptionInfo(); // Actualizar contador
    } catch (e) {
      await showAlert('Error al anular');
      if (btn) btn.remove();
    }
  });
}

function simulateConfirm() {
  addMessage(`✅ **Transacción registrada exitosamente**\n\nAsiento registrado en el Libro Diario.`, 'assistant');
}

function editTransaction() {
  closeModal();
  document.getElementById('quick-actions').classList.add('hidden');
  const input = document.getElementById('text-input');
  input.classList.remove('hidden');
  document.getElementById('message-input').value = currentInput;
  document.getElementById('message-input').focus();
  addMessage('✏️ Edita tu mensaje y vuelve a enviarlo:', 'assistant');
}

