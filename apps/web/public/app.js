const API_URL = '/api';
let pendingResult = null;
let currentInput = '';
let dialogContext = null;
let ocrData = null;

function showInput(mode) {
  document.getElementById('quick-actions').classList.add('hidden');
  if (mode === 'factura') {
    document.getElementById('ocr-upload').classList.remove('hidden');
    return;
  }
  const input = document.getElementById('text-input');
  input.classList.remove('hidden');
  if (mode === 'escribir') {
    document.getElementById('message-input').placeholder = 'Ej: Compré combustible por $40 con tarjeta...';
  } else if (mode === 'voz') {
    document.getElementById('message-input').placeholder = 'Dicta tu transacción...';
  }
  document.getElementById('message-input').focus();
}

function cancelInput() {
  document.getElementById('text-input').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');
  document.getElementById('message-input').value = '';
}

/* ── OCR / Factura ── */
function openCamera() {
  document.getElementById('ocr-camera-input').click();
}
function openGallery() {
  document.getElementById('ocr-gallery-input').click();
}

function handleOCRFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    document.getElementById('ocr-preview-img').src = ev.target.result;
    document.getElementById('ocr-capture-actions').classList.add('hidden');
    document.getElementById('ocr-preview').classList.remove('hidden');
    document.getElementById('ocr-result').classList.add('hidden');
    // Auto-start OCR
    processOCRFile(file);
  };
  reader.readAsDataURL(file);
}

document.getElementById('ocr-camera-input').addEventListener('change', (e) => {
  handleOCRFile(e.target.files[0]);
});
document.getElementById('ocr-gallery-input').addEventListener('change', (e) => {
  handleOCRFile(e.target.files[0]);
});

function cancelOCR() {
  document.getElementById('ocr-upload').classList.add('hidden');
  document.getElementById('ocr-capture-actions').classList.remove('hidden');
  document.getElementById('ocr-preview').classList.add('hidden');
  document.getElementById('ocr-loading').classList.add('hidden');
  document.getElementById('ocr-result').classList.add('hidden');
  document.getElementById('ocr-camera-input').value = '';
  document.getElementById('ocr-gallery-input').value = '';
  document.getElementById('ocr-preview-img').src = '';
  ocrData = null;
  document.getElementById('quick-actions').classList.remove('hidden');
}

async function processOCRFile(file) {
  document.getElementById('ocr-loading').classList.remove('hidden');
  document.getElementById('ocr-status').textContent = 'Analizando factura con OCR...';

  try {
    const formData = new FormData();
    formData.append('image', file);

    const res = await fetch(`${API_URL}/ocr/extract`, {
      method: 'POST',
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al procesar');
    }

    const data = await res.json();
    ocrData = data;

    document.getElementById('ocr-loading').classList.add('hidden');
    document.getElementById('ocr-result').classList.remove('hidden');

    let html = `<div class="ocr-extracted"><strong>Texto extraído:</strong><pre>${escapeHtml(data.text.substring(0, 500))}</pre>`;
    if (data.total) html += `<div class="ocr-field"><span>💰 Total:</span><strong>$${data.total.toFixed(2)}</strong></div>`;
    if (data.date) html += `<div class="ocr-field"><span>📅 Fecha:</span><strong>${data.date}</strong></div>`;
    if (data.provider) html += `<div class="ocr-field"><span>🏢 Proveedor:</span><strong>${escapeHtml(data.provider)}</strong></div>`;
    if (data.ruc) html += `<div class="ocr-field"><span>🔢 RUC:</span><strong>${escapeHtml(data.ruc)}</strong></div>`;
    if (data.itbms !== null) html += `<div class="ocr-field"><span>📊 ITBMS:</span><strong>${data.itbms}%</strong></div>`;
    html += `<div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>`;
    html += `<div class="ocr-field"><span>🤖 Motor:</span><strong>${data.source === 'tesseract+llm' ? 'Tesseract + DeepSeek' : 'Tesseract'}</strong></div>`;
    html += '</div>';
    document.getElementById('ocr-result-text').innerHTML = html;
  } catch (err) {
    document.getElementById('ocr-loading').classList.add('hidden');
    document.getElementById('ocr-preview').classList.add('hidden');
    document.getElementById('ocr-capture-actions').classList.remove('hidden');
    alert('Error: ' + err.message);
  }
}

async function sendOCRResult() {
  if (!ocrData || !ocrData.text) return;
  const text = ocrData.text.trim().substring(0, 500);
  document.getElementById('ocr-result').classList.add('hidden');
  document.getElementById('ocr-upload').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');
  ocrData = null;

  const input = document.getElementById('message-input');
  input.value = text;
  await sendMessage();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

  showLoading();

  try {
    const body = { input: text };
    if (dialogContext) body.context = { extractedData: dialogContext };
    const res = await fetch(`${API_URL}/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    removeLoading();

    if (data.needsConfirmation) {
      dialogContext = null;
      pendingResult = data.result;
      showConfirmationModal(data);
    } else if (data.prompt) {
      dialogContext = data.plan?.dialog || null;
      addMessage(data.prompt, 'assistant');
    }
  } catch (err) {
    removeLoading();
    handleLocalProcessing(text);
  }
  cancelInput();
}

function extractPaymentMethod(input) {
  const lower = input.toLowerCase();
  if (lower.includes('tarjeta') || lower.includes('tc') || lower.includes('credito') || lower.includes('tarjeta de credito') || lower.includes('tarjeta crédito')) return 'TARJETA_CREDITO';
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
  } else {
    pendingResult = {
      dialog: { type, amount, concept, paymentMethod, currency: 'USD', date: new Date().toISOString().split('T')[0], description: input },
      entry: generateMockEntry(type, concept, amount, paymentMethod)
    };
  }

  addMessage(response, 'assistant');

  if (missingFields.length === 0) {
    showConfirmationModal({
      needsConfirmation: true,
      result: pendingResult,
      prompt: ''
    });
  }
}

function generateMockEntry(type, concept, amount, paymentMethod) {
  const debit = [];
  const credit = [];

  if (type === 'GASTO' || type === 'COMPRA') {
    debit.push({ accountId: 'gasto', name: concept || 'Gasto', amount });
    if (paymentMethod === 'EFECTIVO') credit.push({ accountId: 'caja', name: 'Caja', amount });
    else if (paymentMethod === 'TARJETA_CREDITO') credit.push({ accountId: 'tarjeta', name: 'Tarjetas de Crédito', amount });
    else credit.push({ accountId: 'banco', name: 'Bancos', amount });
  } else if (type === 'VENTA') {
    if (paymentMethod === 'EFECTIVO') debit.push({ accountId: 'caja', name: 'Caja', amount });
    else debit.push({ accountId: 'clientes', name: 'Clientes', amount });
    credit.push({ accountId: 'ventas', name: 'Ventas', amount });
  } else if (type === 'COBRO_CLIENTE') {
    debit.push({ accountId: 'caja', name: 'Caja', amount });
    credit.push({ accountId: 'clientes', name: 'Clientes', amount });
  }

  return { debit, credit, description: `${type}: ${concept} - $${amount}` };
}

function addMessage(text, role) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `message ${role}`;

  if (role === 'assistant' && text.includes('Débito:') && text.includes('Crédito:')) {
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
    html += `• Concepto: ${dialog.concept}<br>`;
    html += `• Monto: $${dialog.amount}<br>`;
    if (dialog.paymentMethod) html += `• Pago: ${dialog.paymentMethod}<br>`;
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
  closeModal();
  addMessage('✅ Transacción confirmada. Registrando...', 'assistant');

  try {
    const res = await fetch(`${API_URL}/orchestrate/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result }),
    });
    if (res.ok) {
      const data = await res.json();
      const entryId = data.journalEntry.id;
      addMessage(`✅ **Transacción registrada exitosamente**\n\nAsiento #${entryId.slice(0,8)} registrado en el Libro Diario.`, 'assistant');
      addUndoButton(entryId);
      updateSummary();
    } else {
      addMessage('❌ Error al registrar. Intenta de nuevo.', 'assistant');
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
    const res = await fetch(`${API_URL}/journal?pageSize=5`);
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

function showConfirm(msg, okLabel, cb) {
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

function anularEntry(id, btn) {
  showConfirm('¿Estás seguro de anular este asiento?\nSe creará un asiento de reversión.', 'Sí, anular', async () => {
    if (btn) { btn.disabled = true; btn.textContent = 'Anulando...'; btn.style.opacity = '0.6'; }
    try {
      const res = await fetch(`${API_URL}/journal/${id}/anular`, { method: 'POST' });
      if (!res.ok) { const e = await res.json(); alert(e.error); if (btn) btn.remove(); return; }
      const data = await res.json();
      if (btn) btn.remove();
      addMessage(`↩ **Asiento anulado**\n\nAsiento de reversión #${data.reversal.id.slice(0,8)} creado.`, 'assistant');
      updateSummary();
    } catch (e) {
      alert('Error al anular');
      if (btn) btn.remove();
    }
  });
}

function simulateConfirm() {
  addMessage(`✅ **Transacción registrada exitosamente**\n\nAsiento registrado en el Libro Diario.`, 'assistant');
  updateSummary();
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

async function updateSummary() {
  try {
    const res = await fetch(`${API_URL}/reports/estado-resultados`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById('ventas-hoy').textContent = `$${data.ingresos.total || 0}`;
      document.getElementById('gastos-hoy').textContent = `$${data.gastos.total || 0}`;
      document.getElementById('utilidad-mes').textContent = `$${data.utilidadNeta || 0}`;
    }
    const cashRes = await fetch(`${API_URL}/reports/flujo-caja`);
    if (cashRes.ok) {
      const data = await cashRes.json();
      document.getElementById('saldo-caja').textContent = `$${data.saldoActual || 0}`;
    }
  } catch (e) {
    // fallback
  }
}

function toggleReports() {
  const panel = document.getElementById('reports-panel');
  const overlay = document.getElementById('reports-overlay');
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open');
  overlay.classList.toggle('hidden');
  document.body.style.overflow = isOpen ? '' : 'hidden';
  if (!isOpen) { loadPanelDiario(); loadPanelBalance(); loadPanelResultados(); loadPanelDashboard(); loadPanelCuentas(); loadPanelConceptos(); loadPanelRevision(); }
}

/* ── Sidebar navigation ── */
document.querySelectorAll('.nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (view === 'chat') {
      toggleReportsClose();
      return;
    }

    toggleReportsOpen();
    const panelBtn = document.querySelector(`.panel-tabs button[data-panel="${view.replace('panel-', '')}"]`);
    if (panelBtn) panelBtn.click();
  });
});

function toggleReportsOpen() {
  const panel = document.getElementById('reports-panel');
  const overlay = document.getElementById('reports-overlay');
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    loadPanelDiario(); loadPanelBalance(); loadPanelResultados(); loadPanelDashboard(); loadPanelCuentas(); loadPanelConceptos(); loadPanelRevision();
  }
}

function toggleReportsClose() {
  const panel = document.getElementById('reports-panel');
  const overlay = document.getElementById('reports-overlay');
  panel.classList.remove('open');
  overlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.querySelectorAll('.panel-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.panel-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('panel-' + btn.dataset.panel).classList.add('active');
    if (btn.dataset.panel === 'diario') diarioPage = 1;
  });
});

/* ── Diario state ── */
let diarioPage = 1;
const DIARIO_PAGE_SIZE = 20;

function filterPanelDiario() {
  diarioPage = 1;
  loadPanelDiario();
}

async function loadPanelDiario() {
  const el = document.getElementById('diario-content');
  const pagEl = document.getElementById('diario-pagination');
  const from = document.getElementById('filter-diario-from').value;
  const to = document.getElementById('filter-diario-to').value;
  const status = document.getElementById('filter-diario-status').value;
  let url = `${API_URL}/journal?page=${diarioPage}&pageSize=${DIARIO_PAGE_SIZE}`;
  if (status) url += `&status=${status}`;
  if (from) url += `&startDate=${from}`;
  if (to) url += `&endDate=${to}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.entries || !data.entries.length) {
      el.innerHTML = '<div class="empty">No hay asientos registrados</div>';
      pagEl.innerHTML = '';
      return;
    }
    let html = '<table><thead><tr><th>Fecha</th><th>Descripción</th><th>Cuenta</th><th>Débito</th><th>Crédito</th><th>Estado</th></tr></thead><tbody>';
    for (const e of data.entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      let statusTag = '';
      if (e.status === 'BORRADOR') statusTag = '<span class="tag tag-draft">BORRADOR</span>';
      else if (e.status === 'CONFIRMADO') statusTag = '<span class="tag tag-conf">CONFIRMADO</span>';
      else if (e.status === 'RECHAZADO') statusTag = `<span class="tag tag-rejected" title="${e.reviewNotes || ''}">RECHAZADO</span>`;
      else if (e.status === 'ANULADO') statusTag = '<span class="tag tag-void">ANULADO</span>';
      const firstLine = e.lines[0];
      if (firstLine) {
        const canUndo = e.status === 'CONFIRMADO' && !e.description.startsWith('ANULACIÓN:');
        const undoBtn = canUndo ? `<button onclick="anularPanel('${e.id}')" class="btn-undo" title="Anular asiento">↩</button>` : '';
        html += `<tr><td>${date}</td><td>${e.description}${e.reviewNotes ? `<br><small style="color:#c62828">${e.reviewNotes}</small>` : ''}</td><td>${firstLine.account?.name || ''}</td><td class="debit">${firstLine.debit ? '$' + firstLine.debit.toFixed(2) : ''}</td><td class="credit">${firstLine.credit ? '$' + firstLine.credit.toFixed(2) : ''}</td><td>${statusTag} ${undoBtn}</td></tr>`;
      }
      for (let i = 1; i < e.lines.length; i++) {
        const line = e.lines[i];
        html += `<tr><td></td><td></td><td>${line.account?.name || ''}</td><td class="debit">${line.debit ? '$' + line.debit.toFixed(2) : ''}</td><td class="credit">${line.credit ? '$' + line.credit.toFixed(2) : ''}</td><td></td></tr>`;
      }
    }
    el.innerHTML = html + '</tbody></table>';

    pagEl.innerHTML = '';
    if (data.totalPages > 1) {
      const prev = document.createElement('button');
      prev.textContent = '← Anterior';
      prev.disabled = diarioPage <= 1;
      prev.onclick = () => { if (diarioPage > 1) { diarioPage--; loadPanelDiario(); } };
      pagEl.appendChild(prev);
      const span = document.createElement('span');
      span.textContent = `Pág. ${data.page} de ${data.totalPages} (${data.total} asientos)`;
      pagEl.appendChild(span);
      const next = document.createElement('button');
      next.textContent = 'Siguiente →';
      next.disabled = diarioPage >= data.totalPages;
      next.onclick = () => { if (diarioPage < data.totalPages) { diarioPage++; loadPanelDiario(); } };
      pagEl.appendChild(next);
    }
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; pagEl.innerHTML = ''; }
}

function clearDiarioFilters() {
  document.getElementById('filter-diario-from').value = '';
  document.getElementById('filter-diario-to').value = '';
  document.getElementById('filter-diario-status').value = 'CONFIRMADO';
  diarioPage = 1;
  loadPanelDiario();
}

async function anularPanel(id) {
  await anularEntry(id, null);
  loadPanelDiario();
  loadPanelBalance();
  loadPanelResultados();
}

async function loadPanelBalance() {
  const el = document.getElementById('balance-content');
  const from = document.getElementById('filter-balance-from').value;
  const to = document.getElementById('filter-balance-to').value;
  let url = `${API_URL}/reports/balance-comprobacion`;
  if (from) url += `?startDate=${from}`;
  if (to) url += `${from ? '&' : '?'}endDate=${to}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.length) { el.innerHTML = '<div class="empty">No hay movimientos</div>'; return; }
    let html = '<table><thead><tr><th>Cuenta</th><th>Débitos</th><th>Créditos</th><th>Saldo</th></tr></thead><tbody>';
    for (const b of data) {
      const saldo = b.balanceType === 'DEUDOR' ? `<span class="debit">$${b.balance.toFixed(2)}</span>` : `<span class="credit">$${b.balance.toFixed(2)}</span>`;
      html += `<tr><td>${b.account.name}</td><td class="debit">${b.totalDebit ? '$' + b.totalDebit.toFixed(2) : ''}</td><td class="credit">${b.totalCredit ? '$' + b.totalCredit.toFixed(2) : ''}</td><td>${saldo}</td></tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}

function clearBalanceFilters() {
  document.getElementById('filter-balance-from').value = '';
  document.getElementById('filter-balance-to').value = '';
  loadPanelBalance();
}

async function loadPanelResultados() {
  const el = document.getElementById('resultados-content');
  const from = document.getElementById('filter-resultados-from').value;
  const to = document.getElementById('filter-resultados-to').value;
  let url = `${API_URL}/reports/estado-resultados`;
  if (from) url += `?startDate=${from}`;
  if (to) url += `${from ? '&' : '?'}endDate=${to}`;
  try {
    const res = await fetch(url);
    const d = await res.json();

    let html = '<div class="summary-grid">' +
      `<div class="card"><h3>Ingresos</h3><div class="value pos">$${d.ingresos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Costos</h3><div class="value neg">$${d.costos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Ganancia Bruta</h3><div class="value ${d.gananciaBruta >= 0 ? 'pos' : 'neg'}">$${d.gananciaBruta.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Gastos</h3><div class="value neg">$${d.gastos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Utilidad Neta</h3><div class="value ${d.utilidadNeta >= 0 ? 'pos' : 'neg'}">$${d.utilidadNeta.toFixed(2)}</div></div>` +
    '</div>';

    function items(title, obj) {
      const keys = Object.keys(obj);
      if (!keys.length) return '';
      let h = `<div class="card" style="margin-top:10px"><h3>${title}</h3>`;
      for (const [k, v] of Object.entries(obj)) {
        h += `<div class="line-item"><span>${k}</span><span class="amt">$${Math.abs(v).toFixed(2)}</span></div>`;
      }
      return h + '</div>';
    }

    html += items('Detalle de Ingresos', d.ingresos.detalle);
    html += items('Detalle de Costos', d.costos.detalle);
    html += items('Detalle de Gastos', d.gastos.detalle);
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}

function clearResultadosFilters() {
  document.getElementById('filter-resultados-from').value = '';
  document.getElementById('filter-resultados-to').value = '';
  loadPanelResultados();
}

/* ── Dashboard ── */
let dashboardCharts = [];

function destroyDashboardCharts() {
  dashboardCharts.forEach(c => c.destroy());
  dashboardCharts = [];
}

async function loadPanelDashboard() {
  const el = document.getElementById('dashboard-content');
  destroyDashboardCharts();
  if (typeof Chart === 'undefined') {
    el.innerHTML = '<div class="empty">Cargando librería de gráficos...</div>';
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch { el.innerHTML = '<div class="empty">Error al cargar gráficos. Recarga la página.</div>'; return; }
  }
  try {
    const res = await fetch(`${API_URL}/reports/dashboard`);
    const d = await res.json();

    let html = `
    <div class="dash-summary">
      <div class="dash-card dash-card-ing"><span>Ingresos</span><strong>$${d.resumen.totalIngresos.toFixed(2)}</strong></div>
      <div class="dash-card dash-card-gas"><span>Gastos</span><strong>$${d.resumen.totalGastos.toFixed(2)}</strong></div>
      <div class="dash-card dash-card-cost"><span>Costos</span><strong>$${d.resumen.totalCostos.toFixed(2)}</strong></div>
      <div class="dash-card ${d.resumen.utilidadNeta >= 0 ? 'dash-card-pos' : 'dash-card-neg'}"><span>Utilidad Neta</span><strong>$${d.resumen.utilidadNeta.toFixed(2)}</strong></div>
    </div>
    <div class="dash-grid">
      <div class="dash-chart-card"><h4>Ingresos vs Gastos por Mes</h4><canvas id="chart-monthly"></canvas></div>
      <div class="dash-chart-card"><h4>Gastos por Categoría</h4><canvas id="chart-gastos"></canvas></div>
    </div>`;

    if (d.topIngresos.length) {
      html += `<div class="dash-grid"><div class="dash-chart-card"><h4>Ingresos por Categoría</h4><canvas id="chart-ingresos"></canvas></div><div></div></div>`;
    }

    el.innerHTML = html;

    const months = d.monthly.map(m => {
      const [y, mo] = m.month.split('-');
      const dt = new Date(parseInt(y), parseInt(mo) - 1);
      return dt.toLocaleDateString('es-PA', { month: 'short', year: 'numeric' });
    });

    const ctx1 = document.getElementById('chart-monthly');
    if (ctx1) {
      dashboardCharts.push(new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [
            { label: 'Ingresos', data: d.monthly.map(m => m.ingresos), backgroundColor: '#2e7d32', borderRadius: 4 },
            { label: 'Gastos', data: d.monthly.map(m => m.gastos), backgroundColor: '#c62828', borderRadius: 4 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } },
          scales: { y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.06)' } }, x: { grid: { display: false } } },
        },
      }));
    }

    const ctx2 = document.getElementById('chart-gastos');
    if (ctx2 && d.topGastos.length) {
      const colors = ['#c62828', '#e53935', '#ef5350', '#e57373', '#ef9a9a', '#ffcdd2', '#b71c1c', '#d32f2f'];
      dashboardCharts.push(new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: d.topGastos.map(g => g.nombre),
          datasets: [{ data: d.topGastos.map(g => g.total), backgroundColor: colors.slice(0, d.topGastos.length) }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } } },
        },
      }));
    }

    const ctx3 = document.getElementById('chart-ingresos');
    if (ctx3 && d.topIngresos.length) {
      const colors = ['#2e7d32', '#388e3c', '#43a047', '#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#c8e6c9'];
      dashboardCharts.push(new Chart(ctx3, {
        type: 'doughnut',
        data: {
          labels: d.topIngresos.map(g => g.nombre),
          datasets: [{ data: d.topIngresos.map(g => g.total), backgroundColor: colors.slice(0, d.topIngresos.length) }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } } },
        },
      }));
    }
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar dashboard</div>'; }
}

/* ── Catálogo de Cuentas ── */
async function loadPanelCuentas() {
  const el = document.getElementById('cuentas-content');
  try {
    const res = await fetch(`${API_URL}/accounts`);
    const cuentas = await res.json();
    if (!cuentas.length) { el.innerHTML = '<div class="empty">No hay cuentas registradas</div>'; return; }

    const tipos = ['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'COSTO', 'GASTO'];
    const colores = { ACTIVO: '#1565c0', PASIVO: '#e65100', PATRIMONIO: '#6a1b9a', INGRESO: '#2e7d32', COSTO: '#c62828', GASTO: '#d84315' };
    const labels = { ACTIVO: 'Activos', PASIVO: 'Pasivos', PATRIMONIO: 'Patrimonio', INGRESO: 'Ingresos', COSTO: 'Costos', GASTO: 'Gastos' };

    let html = '';
    for (const tipo of tipos) {
      const filtradas = cuentas.filter(c => c.type === tipo && !c.parentId);
      if (!filtradas.length) continue;
      html += `<div class="cuenta-grupo"><div class="cuenta-tipo" style="background:${colores[tipo]}">${labels[tipo]}</div>`;
      for (const root of filtradas) {
        html += buildCuentaTree(root, cuentas);
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar cuentas</div>'; }
}

function buildCuentaTree(account, all, depth = 0) {
  const children = all.filter(c => c.parentId === account.id);
  let html = `<div class="cuenta-row" style="padding-left:${depth * 20 + 8}px">
    <span class="cuenta-code">${account.code}</span>
    <span class="cuenta-name">${account.name}</span>
  </div>`;
  for (const child of children) {
    html += buildCuentaTree(child, all, depth + 1);
  }
  return html;
}

/* ── Conceptos Contables ── */
async function loadPanelConceptos() {
  const el = document.getElementById('conceptos-content');
  try {
    const res = await fetch(`${API_URL}/concepts`);
    const concepts = await res.json();
    if (!concepts.length) { el.innerHTML = '<div class="empty">No hay conceptos registrados</div>'; return; }

    let html = '<table><thead><tr><th>Concepto</th><th>Cuenta Contable</th><th>Código</th><th>Confianza</th></tr></thead><tbody>';
    for (const c of concepts) {
      const pct = Math.round(c.confidence * 100);
      html += `<tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.account?.name || '—'}</td>
        <td class="cuenta-code">${c.account?.code || '—'}</td>
        <td><span class="tag tag-conf">${pct}%</span></td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar conceptos</div>'; }
}

/* ── Revisión de Asientos (Contador Senior) ── */
async function loadPanelRevision() {
  const el = document.getElementById('revision-content');
  const from = document.getElementById('filter-revision-from').value;
  const to = document.getElementById('filter-revision-to').value;
  let url = `${API_URL}/journal/pendientes`;
  if (from) url += `?startDate=${from}`;
  if (to) url += `${from ? '&' : '?'}endDate=${to}`;
  try {
    const res = await fetch(url);
    const entries = await res.json();
    if (!entries || !entries.length) {
      el.innerHTML = '<div class="empty">✅ No hay asientos pendientes de revisión</div>';
      document.getElementById('pendientes-badge').classList.add('hidden');
      return;
    }
    document.getElementById('pendientes-badge').textContent = entries.length;
    document.getElementById('pendientes-badge').classList.remove('hidden');

    let html = `<div style="margin-bottom:8px;font-size:13px;color:#6b7280">${entries.length} asiento(s) pendiente(s) de revisión</div>`;
    for (const e of entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      const totalDeb = e.lines.reduce((s, l) => s + l.debit, 0);
      const totalCred = e.lines.reduce((s, l) => s + l.credit, 0);
      const creador = e.createdBy?.name || 'N/A';
      html += `<div class="revision-card" data-id="${e.id}">
        <div class="rev-header">
          <span class="rev-date">${date}</span>
          <span class="rev-creator">por ${creador}</span>
        </div>
        <div class="rev-desc">${e.description}</div>
        <div class="rev-lines">`;
      for (const line of e.lines) {
        const name = line.account?.name || 'Cuenta';
        if (line.debit > 0) html += `<div class="rev-line"><span>${name}</span><span class="debit">$${line.debit.toFixed(2)}</span></div>`;
        if (line.credit > 0) html += `<div class="rev-line"><span>${name}</span><span class="credit">$${line.credit.toFixed(2)}</span></div>`;
      }
      html += `<div class="rev-line rev-total"><span>Total</span><span>Deb: $${totalDeb.toFixed(2)} / Cred: $${totalCred.toFixed(2)}</span></div>`;
      html += `</div>
        <div class="rev-actions">
          <button class="btn-approve" onclick="aprobarAsiento('${e.id}')">✅ Aprobar</button>
          <button class="btn-reject" onclick="rechazarAsiento('${e.id}')">❌ Rechazar</button>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div class="empty">Error al cargar pendientes</div>';
  }
}

function clearRevisionFilters() {
  document.getElementById('filter-revision-from').value = '';
  document.getElementById('filter-revision-to').value = '';
  loadPanelRevision();
}

async function aprobarAsiento(id) {
  const card = document.querySelector(`.revision-card[data-id="${id}"]`);
  if (card) {
    card.querySelector('.rev-actions').innerHTML = '<span style="color:#2e7d32;font-weight:600">APROBANDO...</span>';
  }
  try {
    const res = await fetch(`${API_URL}/journal/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'aprobar' }),
    });
    if (!res.ok) { const err = await res.json(); alert(err.error); return; }
    loadPanelRevision();
    updateSummary();
    addMessage(`✅ Asiento #${id.slice(0,8)} aprobado por Contador Senior.`, 'assistant');
  } catch (e) {
    alert('Error al aprobar');
    loadPanelRevision();
  }
}

async function rechazarAsiento(id) {
  const notes = prompt('Motivo del rechazo (opcional):');
  if (notes === null) return;
  const card = document.querySelector(`.revision-card[data-id="${id}"]`);
  if (card) {
    card.querySelector('.rev-actions').innerHTML = '<span style="color:#c62828;font-weight:600">RECHAZANDO...</span>';
  }
  try {
    const res = await fetch(`${API_URL}/journal/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rechazar', notes: notes || '' }),
    });
    if (!res.ok) { const err = await res.json(); alert(err.error); return; }
    loadPanelRevision();
    addMessage(`❌ Asiento #${id.slice(0,8)} **rechazado**${notes ? ' — Motivo: ' + notes : ''}\n\nPuedes corregir la transacción y volver a enviarla. El creador verá el asiento como **RECHAZADO** en el Diario y podrá re-enviarlo.`, 'assistant');
  } catch (e) {
    alert('Error al rechazar');
    loadPanelRevision();
  }
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  addMessage('¡Buenos días! Soy tu agente contable. ¿Qué deseas registrar hoy?', 'assistant');
  addMessage('Puedes escribir algo como:\n• "Compré combustible por $40 con tarjeta"\n• "Vendí $250 en efectivo"\n• "Pagué la electricidad"', 'assistant');
  updateSummary();
});
