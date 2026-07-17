const API_URL = '/api';

// ── Auth ──
function getToken() { return localStorage.getItem('agt_token'); }
function getUser() {
  try { return JSON.parse(localStorage.getItem('agt_user')); } catch { return null; }
}
function authFetch(url, options = {}) {
  const token = getToken();
  if (!token) { window.location.href = '/login.html'; return Promise.reject('No auth'); }
  return fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'Authorization': `Bearer ${token}`,
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
  }).then(res => {
    if (res.status === 401) { localStorage.clear(); window.location.href = '/login.html'; }
    return res;
  });
}

// Check auth on load
if (!getToken()) { window.location.href = '/login.html'; }

// ── Custom Dialogs (reemplazan alert/confirm nativos) ──
function showAlert(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
    overlay.innerHTML = `<div class="app-dialog">
      <div class="app-dialog-icon">⚠️</div>
      <div class="app-dialog-msg">${msg}</div>
      <div class="app-dialog-buttons">
        <button class="app-dialog-btn primary" id="dialog-ok">Aceptar</button>
      </div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dialog-ok').onclick = () => { overlay.remove(); resolve(true); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}
function showConfirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
    overlay.innerHTML = `<div class="app-dialog">
      <div class="app-dialog-icon">🤔</div>
      <div class="app-dialog-msg">${msg}</div>
      <div class="app-dialog-buttons">
        <button class="app-dialog-btn secondary" id="dialog-no">Cancelar</button>
        <button class="app-dialog-btn danger" id="dialog-yes">Confirmar</button>
      </div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#dialog-yes').onclick = () => { overlay.remove(); resolve(true); };
    overlay.querySelector('#dialog-no').onclick = () => { overlay.remove(); resolve(false); };
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
  });
}

// ── Hamburguesa móvil ──
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}
// Cerrar el drawer al hacer clic en cualquier opción del menú
document.addEventListener('click', function(e) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar || !sidebar.classList.contains('open')) return;
  if (e.target.closest('#sidebar .nav-link') || e.target.closest('#sidebar a')) {
    sidebar.classList.remove('open');
  }
});

// ── Subscription Info ──
async function loadSubscriptionInfo() {
  try {
    const res = await authFetch(`${API_URL}/subscription`);
    if (!res || !res.ok) return;
    const data = await res.json();
    const sub = data.subscription;
    if (!sub) return;

    // Mostrar el indicador
    const el = document.getElementById('sidebar-subscription');
    if (el) el.style.display = 'block';
    const planName = document.getElementById('sub-plan-name');
    if (planName) planName.textContent = `⚡ ${sub.plan}${sub.status === 'DEMO' ? ' (Demo)' : ''}`;
    const progressBar = document.getElementById('sub-progress-bar');
    if (progressBar) progressBar.style.width = `${Math.min(100, sub.usagePercent)}%`;
    const usageText = document.getElementById('sub-usage-text');
    if (usageText) usageText.textContent = `${sub.movementsUsed}/${sub.movementsLimit} movs`;
    const daysText = document.getElementById('sub-days-text');
    if (daysText) {
      if (sub.daysLeft <= 3) {
        daysText.textContent = `⚠️ ${sub.daysLeft} días`;
        daysText.style.color = '#dc2626';
      } else {
        daysText.textContent = `${sub.daysLeft} días`;
      }
    }
  } catch (e) {
    // Silencioso: si falla, simplemente no muestra el indicador
  }
}

let pendingResult = null;
let currentInput = '';
let dialogContext = null;
let ocrData = null;
let ocrAbortController = null;
let pendingClassification = null;

function showInput(mode) {
  stopQRScanner();
  document.getElementById('quick-actions').classList.add('hidden');
  document.getElementById('dgi-menu').classList.add('hidden');
  document.getElementById('qr-upload').classList.add('hidden');
  document.getElementById('ocr-upload').classList.add('hidden');
  document.getElementById('pdf-upload').classList.add('hidden');
  if (mode === 'factura') {
    document.getElementById('ocr-capture-actions').classList.remove('hidden');
    document.getElementById('ocr-preview').classList.add('hidden');
    document.getElementById('ocr-loading').classList.add('hidden');
    document.getElementById('ocr-result').classList.add('hidden');
    document.getElementById('ocr-result-text').innerHTML = '';
    document.getElementById('ocr-camera-input').value = '';
    document.getElementById('ocr-gallery-input').value = '';
    document.getElementById('ocr-preview-img').src = '';
    ocrData = null;
    document.getElementById('ocr-upload').classList.remove('hidden');
    return;
  }
  if (mode === 'pdf') {
    document.getElementById('pdf-actions').classList.remove('hidden');
    document.getElementById('pdf-loading').classList.add('hidden');
    document.getElementById('pdf-result').classList.add('hidden');
    document.getElementById('pdf-result-text').innerHTML = '';
    document.getElementById('pdf-file-input').value = '';
    pdfData = null;
    document.getElementById('pdf-upload').classList.remove('hidden');
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
  if (ocrAbortController) {
    ocrAbortController.abort();
    ocrAbortController = null;
  }
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
  ocrAbortController = new AbortController();
  const signal = ocrAbortController.signal;

  document.getElementById('ocr-loading').classList.remove('hidden');
  document.getElementById('ocr-status').textContent = 'Comprimiendo imagen...';

  try {
    const compressed = await new Promise((resolve, reject) => {
      new Compressor(file, {
        quality: 0.7,
        maxWidth: 1920,
        maxHeight: 1920,
        mimeType: 'image/jpeg',
        success: resolve,
        error: reject,
      });
    });

    document.getElementById('ocr-status').textContent = 'Analizando factura con OCR...';
    const formData = new FormData();
    formData.append('image', compressed, file.name);

    const res = await authFetch(`${API_URL}/ocr/extract`, {
      method: 'POST',
      body: formData,
      signal,
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al procesar');
    }

    const data = await res.json();
    ocrData = data;

    document.getElementById('ocr-loading').classList.add('hidden');
    document.getElementById('ocr-preview').classList.add('hidden');
    document.getElementById('ocr-result').classList.remove('hidden');

    let html = `<div class="ocr-extracted">
      <div class="ocr-field"><span>📄 Texto:</span><textarea id="ocr-edit-text" rows="3">${escapeHtml(data.text.substring(0, 500))}</textarea></div>
      <div class="ocr-field"><span>💰 Total:</span><input type="number" step="0.01" id="ocr-edit-total" value="${data.total ?? ''}"></div>
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="ocr-edit-date" value="${data.date || ''}"></div>
      <div class="ocr-field"><span>🏢 Proveedor:</span><input type="text" id="ocr-edit-provider" value="${escapeHtml(data.provider || '')}"></div>
      <div class="ocr-field"><span>🔢 RUC:</span><input type="text" id="ocr-edit-ruc" value="${escapeHtml(data.ruc || '')}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="ocr-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field"><span>🤖 Motor:</span><strong>${data.source === 'tesseract+llm' ? 'Tesseract + DeepSeek' : 'Tesseract'}</strong></div>
      <button class="ocr-toggle-img" onclick="toggleOCRImage()" style="margin-top:8px;font-size:12px;padding:6px 12px;background:none;border:1px solid #d0d5dd;border-radius:4px;cursor:pointer;color:#1a1a2e;width:100%">📷 Ver imagen</button>
    </div>`;
    document.getElementById('ocr-result-text').innerHTML = html;
  } catch (err) {
    if (err.name === 'AbortError') return;
    document.getElementById('ocr-loading').classList.add('hidden');
    document.getElementById('ocr-preview').classList.add('hidden');
    document.getElementById('ocr-capture-actions').classList.remove('hidden');
    await showAlert('Error: ' + err.message);
  }
}

function toggleOCRImage() {
  const el = document.getElementById('ocr-preview');
  const btn = document.querySelector('.ocr-toggle-img');
  if (!el || !btn) return;
  el.classList.toggle('hidden');
  btn.textContent = el.classList.contains('hidden') ? '📷 Ver imagen' : '📷 Ocultar imagen';
  if (!el.classList.contains('hidden')) {
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

async function correctAndSendOCR() {
  if (!ocrData) return;
  const corrected = {
    text: document.getElementById('ocr-edit-text')?.value?.trim() || ocrData.text,
    total: parseFloat(document.getElementById('ocr-edit-total')?.value) || null,
    date: document.getElementById('ocr-edit-date')?.value || null,
    provider: document.getElementById('ocr-edit-provider')?.value?.trim() || null,
    ruc: document.getElementById('ocr-edit-ruc')?.value?.trim() || null,
    itbms: parseFloat(document.getElementById('ocr-edit-itbms')?.value) || null,
  };

  try {
    await authFetch(`${API_URL}/ocr/correct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rawText: ocrData.text,
        correctedText: corrected.text,
        total: corrected.total,
        date: corrected.date,
        provider: corrected.provider,
        ruc: corrected.ruc,
        itbms: corrected.itbms,
      }),
    });
  } catch (_) {}

  ocrData.text = corrected.text;
  ocrData.total = corrected.total;
  ocrData.date = corrected.date;
  ocrData.provider = corrected.provider;
  ocrData.ruc = corrected.ruc;
  ocrData.itbms = corrected.itbms;

  await sendOCRResult();
}

async function sendOCRResult() {
  if (!ocrData || !ocrData.text) return;
  const data = ocrData;
  ocrData = null;

  const total = data.total;
  const provider = data.provider || null;

  dialogContext = {
    amount: total || 0,
    provider: provider,
    date: data.date || null,
    itbms: data.itbms != null,
  };

  const parts = [];
  if (provider) parts.push(`Compra a ${provider}`);
  else parts.push('Compra');
  if (total) parts.push(`por $${total}`);

  const text = parts.join(' ');

  document.getElementById('ocr-result').classList.add('hidden');
  document.getElementById('ocr-upload').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');

  const input = document.getElementById('message-input');
  input.value = text;
  await sendMessage();
}

/* ── PDF / Factura Electrónica ── */
let pdfData = null;

function openPDFPicker() {
  document.getElementById('pdf-file-input').click();
}

document.getElementById('pdf-file-input').addEventListener('change', (e) => {
  handlePDFFile(e.target.files[0]);
});

function handlePDFFile(file) {
  if (!file) return;
  document.getElementById('pdf-actions').classList.add('hidden');
  document.getElementById('pdf-loading').classList.remove('hidden');
  processPDFFile(file);
}

function cancelPDF() {
  document.getElementById('pdf-upload').classList.add('hidden');
  document.getElementById('pdf-actions').classList.remove('hidden');
  document.getElementById('pdf-loading').classList.add('hidden');
  document.getElementById('pdf-result').classList.add('hidden');
  document.getElementById('pdf-file-input').value = '';
  pdfData = null;
  document.getElementById('quick-actions').classList.remove('hidden');
}

async function processPDFFile(file) {
  document.getElementById('pdf-status').textContent = 'Extrayendo datos del PDF...';
  const formData = new FormData();
  formData.append('pdf', file);

  try {
    const res = await authFetch(`${API_URL}/factura/extract`, {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al procesar PDF');
    }
    const data = await res.json();
    pdfData = data;

    document.getElementById('pdf-loading').classList.add('hidden');
    document.getElementById('pdf-result').classList.remove('hidden');

    let html = `<div class="ocr-extracted">
      <div class="ocr-field"><span>🏢 Proveedor:</span><input type="text" id="pdf-edit-provider" value="${escapeHtml(data.provider || '')}"></div>
      <div class="ocr-field"><span>🔢 RUC:</span><input type="text" id="pdf-edit-ruc" value="${escapeHtml(data.ruc || '')}"></div>
      <div class="ocr-field"><span>🧾 Factura #:</span><input type="text" id="pdf-edit-invoice" value="${escapeHtml(data.invoiceNumber || '')}"></div>
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="pdf-edit-date" value="${data.date || ''}"></div>
      <div class="ocr-field"><span>💰 Subtotal:</span><input type="number" step="0.01" id="pdf-edit-subtotal" value="${data.subtotal ?? ''}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="pdf-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>💰 Total:</span><input type="number" step="0.01" id="pdf-edit-total" value="${data.total ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field"><span>🤖 Motor:</span><strong>${data.source === 'pdf-parse+llm' ? 'PDF + DeepSeek' : 'PDF'}</strong></div>
      <div class="ocr-field" style="flex-direction:column;align-items:stretch;gap:4px"><span>📄 Texto extraído:</span><textarea id="pdf-edit-text" rows="3" style="width:100%">${escapeHtml(data.text.substring(0, 500))}</textarea></div>
    </div>`;
    document.getElementById('pdf-result-text').innerHTML = html;
  } catch (err) {
    document.getElementById('pdf-loading').classList.add('hidden');
    document.getElementById('pdf-actions').classList.remove('hidden');
    await showAlert('Error: ' + err.message);
  }
}

/* ── DGI Menu (PDF / QR / URL) ── */
function showDGIMenu() {
  document.getElementById('quick-actions').classList.add('hidden');
  document.getElementById('dgi-menu').classList.remove('hidden');
}

function hideDGIMenu() {
  stopQRScanner();
  document.getElementById('dgi-menu').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');
}

/* ── QR Scanner ── */
let qrScannerInstance = null;

async function showQRScanner() {
  hideDGIMenu();
  document.getElementById('qr-scanner').classList.remove('hidden');
  document.getElementById('qr-reader-status').textContent = 'Iniciando cámara...';

  if (typeof Html5Qrcode === 'undefined') {
    document.getElementById('qr-reader-status').textContent = '❌ Error al cargar la librería QR. Recarga la página.';
    return;
  }

  qrScannerInstance = new Html5Qrcode('qr-reader');

  qrScannerInstance.start(
    { facingMode: 'environment' }, // cámara trasera
    {
      fps: 10,
      qrbox: { width: 250, height: 250 },
    },
    (decodedText) => {
      // QR detectado
      stopQRScanner();
      if (decodedText.startsWith('http://') || decodedText.startsWith('https://')) {
        document.getElementById('qr-url-input').value = decodedText;
        document.getElementById('qr-url-input').focus();
        // Abrir el input de URL con la URL precargada
        document.getElementById('qr-upload').classList.remove('hidden');
        document.getElementById('qr-scanner').classList.add('hidden');
        document.getElementById('qr-actions').classList.remove('hidden');
        document.getElementById('qr-loading').classList.add('hidden');
        document.getElementById('qr-result').classList.add('hidden');
        document.getElementById('quick-actions').classList.add('hidden');
      } else {
        showAlert('El QR no contiene una URL válida. Contenido: ' + decodedText.substring(0, 100)).then(() => {
          showQRScanner(); // reintentar
        });
      }
    },
    () => {
      // No hace falta mostrar nada en cada frame sin QR
    },
  ).catch((err) => {
    document.getElementById('qr-reader-status').textContent = '❌ Error al acceder a la cámara: ' + (err.message || 'permiso denegado');
    console.error('[QR] Error:', err);
  });
}

function stopQRScanner() {
  if (qrScannerInstance) {
    try {
      qrScannerInstance.stop().catch(() => {});
      qrScannerInstance.clear().catch(() => {});
    } catch (e) { /* ignore */ }
    qrScannerInstance = null;
  }
  document.getElementById('qr-scanner').classList.add('hidden');
  document.getElementById('qr-reader').innerHTML = '';
  document.getElementById('qr-reader-status').textContent = '';
}

function showQRInput() {
  hideDGIMenu();
  document.getElementById('qr-upload').classList.remove('hidden');
  document.getElementById('qr-url-input').value = '';
  document.getElementById('qr-url-input').focus();
}

function cancelQR() {
  stopQRScanner();
  document.getElementById('qr-upload').classList.add('hidden');
  document.getElementById('qr-loading').classList.add('hidden');
  document.getElementById('qr-result').classList.add('hidden');
  document.getElementById('qr-url-input').value = '';
  document.getElementById('quick-actions').classList.remove('hidden');
}

let qrData = null;

async function processQRUrl() {
  const url = document.getElementById('qr-url-input').value.trim();
  if (!url) { await showAlert('Pega la URL del PDF (puedes escanear un QR)'); return; }

  document.getElementById('qr-actions').classList.add('hidden');
  document.getElementById('qr-loading').classList.remove('hidden');
  document.getElementById('qr-status').textContent = 'Descargando PDF...';

  try {
    const res = await authFetch(`${API_URL}/factura/extract-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Error al procesar');
    }

    const data = await res.json();
    qrData = data;

    document.getElementById('qr-loading').classList.add('hidden');
    document.getElementById('qr-result').classList.remove('hidden');

    let html = `<div class="ocr-extracted">
      <div class="ocr-field"><span>🏢 Proveedor:</span><input type="text" id="qr-edit-provider" value="${escapeHtml(data.provider || '')}"></div>
      <div class="ocr-field"><span>🔢 RUC:</span><input type="text" id="qr-edit-ruc" value="${escapeHtml(data.ruc || '')}"></div>
      <div class="ocr-field"><span>🧾 Factura #:</span><input type="text" id="qr-edit-invoice" value="${escapeHtml(data.invoiceNumber || '')}"></div>
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="qr-edit-date" value="${data.date || ''}"></div>
      <div class="ocr-field"><span>💰 Subtotal:</span><input type="number" step="0.01" id="qr-edit-subtotal" value="${data.subtotal ?? ''}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="qr-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>💰 Total:</span><input type="number" step="0.01" id="qr-edit-total" value="${data.total ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field" style="flex-direction:column;align-items:stretch;gap:4px"><span>📄 Texto:</span><textarea id="qr-edit-text" rows="3" style="width:100%">${escapeHtml((data.text || '').substring(0, 500))}</textarea></div>
    </div>`;
    document.getElementById('qr-result-text').innerHTML = html;
  } catch (err) {
    document.getElementById('qr-loading').classList.add('hidden');
    document.getElementById('qr-actions').classList.remove('hidden');
    await showAlert('Error: ' + err.message);
  }
}

async function sendQRResult() {
  if (!qrData) return;
  const data = qrData;
  const provider = document.getElementById('qr-edit-provider')?.value?.trim() || data.provider || '';
  const ruc = document.getElementById('qr-edit-ruc')?.value?.trim() || data.ruc || '';
  const invoiceNumber = document.getElementById('qr-edit-invoice')?.value?.trim() || data.invoiceNumber || '';
  const date = document.getElementById('qr-edit-date')?.value || data.date || '';
  const total = parseFloat(document.getElementById('qr-edit-total')?.value) || data.total || 0;
  const subtotal = parseFloat(document.getElementById('qr-edit-subtotal')?.value) || data.subtotal || null;
  const itbms = parseFloat(document.getElementById('qr-edit-itbms')?.value) || data.itbms || null;
  const text = document.getElementById('qr-edit-text')?.value?.trim() || data.text || '';

  qrData = null;

  const hasItbms = itbms != null && itbms > 0;

  dialogContext = {
    amount: total,
    provider: provider,
    date: date || null,
    itbms: hasItbms,
    itbmsAmount: itbms,
    invoiceNumber: invoiceNumber,
    ruc: ruc,
  };

  let message = '';
  if (provider) message += `Compra a ${provider}`;
  else message += 'Compra';
  if (total) message += ` por $${total}`;
  if (invoiceNumber) message += `, factura ${invoiceNumber}`;
  if (hasItbms && subtotal) message += ` (subtotal $${subtotal}, ITBMS $${itbms})`;

  document.getElementById('qr-result').classList.add('hidden');
  document.getElementById('qr-upload').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');

  const input = document.getElementById('message-input');
  input.value = message;
  await sendMessage();
}

async function sendPDFResult() {
  if (!pdfData) return;
  const data = pdfData;
  const provider = document.getElementById('pdf-edit-provider')?.value?.trim() || data.provider || '';
  const ruc = document.getElementById('pdf-edit-ruc')?.value?.trim() || data.ruc || '';
  const invoiceNumber = document.getElementById('pdf-edit-invoice')?.value?.trim() || data.invoiceNumber || '';
  const date = document.getElementById('pdf-edit-date')?.value || data.date || '';
  const total = parseFloat(document.getElementById('pdf-edit-total')?.value) || data.total || 0;
  const subtotal = parseFloat(document.getElementById('pdf-edit-subtotal')?.value) || data.subtotal || null;
  const itbms = parseFloat(document.getElementById('pdf-edit-itbms')?.value) || data.itbms || null;
  const text = document.getElementById('pdf-edit-text')?.value?.trim() || data.text || '';

  pdfData = null;

  const hasItbms = itbms != null && itbms > 0;

  dialogContext = {
    amount: total,
    provider: provider,
    date: date || null,
    itbms: hasItbms,
    itbmsAmount: itbms,
    invoiceNumber: invoiceNumber,
    ruc: ruc,
  };

  let message = '';
  if (provider) message += `Compra a ${provider}`;
  else message += 'Compra';
  if (total) message += ` por $${total}`;
  if (invoiceNumber) message += `, factura ${invoiceNumber}`;
  if (hasItbms && subtotal) message += ` (subtotal $${subtotal}, ITBMS $${itbms})`;

  document.getElementById('pdf-result').classList.add('hidden');
  document.getElementById('pdf-upload').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');

  const input = document.getElementById('message-input');
  input.value = message;
  await sendMessage();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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

  // Proceder a pedir método de pago o confirmar
  const missing = dialogContext?.missingFields || [];
  if (missing.includes('paymentMethod') || !dialogContext?.paymentMethod) {
    showPaymentMethodSelector();
  } else {
    await confirmTransaction();
  }
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

  showLoading();

  try {
    const body = { input: text };
    if (dialogContext) body.context = { extractedData: dialogContext };
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
      if (missing.includes('paymentMethod')) {
        showPaymentMethodSelector();
      } else if (data.prompt.includes('clasificarlo manualmente')) {
        cancelInput();
        const match = data.prompt.match(/el concepto "([^"]+)"/);
        const concept = match ? match[1] : text;
        showClassificationUI(concept);
      } else {
        addMessage(data.prompt, 'assistant');
        showInput('escribir');
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
    // Si el usuario seleccionó una entidad existente, pasar el ID
    if (dialogContext?.selectedEntityId) {
      result.selectedEntityId = dialogContext.selectedEntityId;
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
      addUndoButton(entryId);
      updateSummary();
      loadSubscriptionInfo(); // Actualizar contador de movimientos
    } else {
      const errData = await res.json().catch(() => ({}));
      const msg = errData.error || 'Error al registrar. Intenta de nuevo.';
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
      updateSummary();
      loadSubscriptionInfo(); // Actualizar contador
    } catch (e) {
      await showAlert('Error al anular');
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

// El resumen rápido se movió al Dashboard — se mantiene como no-op para no romper llamadas existentes
function updateSummary() {}

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
document.querySelectorAll('#sidebar-nav .nav-link[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('#sidebar-nav .nav-link[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Helpers
    function hideAllPanels() {
      ['panel-recurring-content','recurring-form','panel-import-content',
       'panel-conciliacion-content','panel-taxcalendar-content','panel-whatsapp-content',
       'panel-auxiliares-content','panel-revision-content',
       'panel-informes-content','panel-admin-content'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
      });
      const rp = document.getElementById('reports-panel');
      document.body.style.overflow = '';
    }

    if (view === 'chat') {
      hideAllPanels();
      document.getElementById('chat-header').classList.remove('hidden');
      document.getElementById('chat-messages').classList.remove('hidden');
      document.getElementById('input-area').classList.remove('hidden');
      return;
    }

    // Ocultar chat para cualquier panel que no sea chat
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('chat-messages').classList.add('hidden');
    document.getElementById('input-area').classList.add('hidden');

    if (view === 'panel-recurring') { hideAllPanels(); loadPanelRecurring(); return; }
    if (view === 'panel-import') { hideAllPanels(); loadPanelImport(); return; }
    if (view === 'panel-conciliacion') { hideAllPanels(); loadPanelConciliacion(); return; }
    if (view === 'panel-taxcalendar') { hideAllPanels(); loadPanelTaxCalendar(); return; }
    if (view === 'panel-auxiliares') { hideAllPanels(); loadPanelAuxiliares(); return; }
    if (view === 'panel-revision') { hideAllPanels(); loadPanelRevision(); return; }
    if (view === 'panel-informes') { hideAllPanels(); loadPanelInformes(); return; }
    if (view === 'panel-whatsapp') { hideAllPanels(); loadPanelWhatsApp(); return; }

    // Admin panel — inline con tabs
    if (view === 'panel-admin') {
      hideAllPanels();
      document.getElementById('panel-admin-content').classList.remove('hidden');
      document.getElementById('cuentas-admin-content').classList.remove('hidden');
      document.getElementById('cuentas-admin-actions').classList.remove('hidden');
      clickAdminTab('cuentas-admin');
      return;
    }
  });
});

function clickAdminTab(panel) {
  document.querySelectorAll('#panel-tabs-admin button').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`#panel-tabs-admin button[data-panel="${panel}"]`);
  if (btn) btn.click();
}

function toggleReportsOpen() {
  const panel = document.getElementById('reports-panel');
  const overlay = document.getElementById('reports-overlay');
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    loadPanelDiario(); loadPanelBalance(); loadPanelResultados(); loadPanelDashboard(); loadPanelRevision();
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
    const parentTabs = btn.closest('.panel-tabs');
    parentTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    const target = document.getElementById('panel-' + btn.dataset.panel);
    if (target) target.classList.add('active');
    if (btn.dataset.panel === 'diario') diarioPage = 1;
    if (btn.dataset.panel === 'diario') loadPanelDiario();
    if (btn.dataset.panel === 'balance') loadPanelBalance();
    if (btn.dataset.panel === 'resultados') loadPanelResultados();
    if (btn.dataset.panel === 'dashboard') loadPanelDashboard();
    if (btn.dataset.panel === 'revision') loadPanelRevision();
  });
});

// Admin panel tabs
document.querySelectorAll('#panel-tabs-admin button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-admin');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    // Mostrar/ocultar secciones
    const contentIds = {
      'cuentas-admin': ['cuentas-admin-content', 'cuentas-admin-actions', 'cuentas-admin-form'],
      'conceptos-admin': ['conceptos-admin-content', 'conceptos-admin-actions', 'conceptos-admin-form'],
      'config': ['config-content'],
    };
    // Ocultar todo
    document.querySelectorAll('#cuentas-admin-content, #cuentas-admin-actions, #cuentas-admin-form, #conceptos-admin-content, #conceptos-admin-actions, #conceptos-admin-form, #config-content').forEach(el => el.classList.add('hidden'));
    // Mostrar lo relevante
    const ids = contentIds[btn.dataset.panel] || [];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
    // Cargar datos
    if (btn.dataset.panel === 'cuentas-admin') loadPanelCuentasAdmin();
    if (btn.dataset.panel === 'conceptos-admin') loadPanelConceptosAdmin();
    if (btn.dataset.panel === 'config') loadPanelConfig();
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
  const provider = document.getElementById('filter-diario-provider').value;
  let url = `${API_URL}/journal?page=${diarioPage}&pageSize=${DIARIO_PAGE_SIZE}`;
  if (status) url += `&status=${status}`;
  if (from) url += `&startDate=${from}`;
  if (to) url += `&endDate=${to}`;
  if (provider) url += `&provider=${encodeURIComponent(provider)}`;
  try {
    const res = await authFetch(url);
    const data = await res.json();
    if (!data.entries || !data.entries.length) {
      el.innerHTML = '<div class="empty">No hay asientos registrados</div>';
      pagEl.innerHTML = '';
      return;
    }
    let html = '<table><thead><tr><th>Fecha</th><th>Descripción</th><th>Cuenta</th><th>Débito</th><th>Crédito</th><th>Proveedor</th><th>Estado</th></tr></thead><tbody>';
    for (const e of data.entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      let statusTag = '';
      if (e.status === 'BORRADOR') statusTag = '<span class="tag tag-draft">BORRADOR</span>';
      else if (e.status === 'CONFIRMADO') statusTag = '<span class="tag tag-conf">CONFIRMADO</span>';
      else if (e.status === 'RECHAZADO') statusTag = `<span class="tag tag-rejected" title="${e.reviewNotes || ''}">RECHAZADO</span>`;
      else if (e.status === 'ANULADO') statusTag = '<span class="tag tag-void">ANULADO</span>';
      const providerHtml = e.provider ? `<span style="font-size:11px;color:#6b7280">${e.provider}</span>` : '';
      const firstLine = e.lines[0];
      if (firstLine) {
        const canUndo = e.status === 'CONFIRMADO' && !e.description.startsWith('ANULACIÓN:');
        const undoBtn = canUndo ? `<button onclick="anularPanel('${e.id}')" class="btn-undo" title="Anular asiento">↩</button>` : '';
        html += `<tr><td>${date}</td><td>${e.description}${e.reviewNotes ? `<br><small style="color:#c62828">${e.reviewNotes}</small>` : ''}</td><td>${firstLine.account?.name || ''}</td><td class="debit">${firstLine.debit ? '$' + firstLine.debit.toFixed(2) : ''}</td><td class="credit">${firstLine.credit ? '$' + firstLine.credit.toFixed(2) : ''}</td><td>${providerHtml}</td><td>${statusTag} ${undoBtn}</td></tr>`;
      }
      for (let i = 1; i < e.lines.length; i++) {
        const line = e.lines[i];
        html += `<tr><td></td><td></td><td>${line.account?.name || ''}</td><td class="debit">${line.debit ? '$' + line.debit.toFixed(2) : ''}</td><td class="credit">${line.credit ? '$' + line.credit.toFixed(2) : ''}</td><td></td><td></td></tr>`;
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
  document.getElementById('filter-diario-provider').value = '';
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
    const res = await authFetch(url);
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
    const res = await authFetch(url);
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
    const res = await authFetch(`${API_URL}/reports/dashboard`);
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
    const res = await authFetch(`${API_URL}/accounts`);
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
    const res = await authFetch(`${API_URL}/concepts`);
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

/* ── Administración: Cuentas Contables ── */
let cuentasCache = [];

async function loadPanelCuentasAdmin() {
  const el = document.getElementById('cuentas-admin-content');
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    cuentasCache = await res.json();
    if (!cuentasCache.length) { el.innerHTML = '<div class="empty">No hay cuentas registradas</div>'; return; }
    document.getElementById('cuentas-admin-count').textContent = `${cuentasCache.length} cuentas`;

    const tipos = ['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'COSTO', 'GASTO'];
    const colores = { ACTIVO: '#1565c0', PASIVO: '#e65100', PATRIMONIO: '#6a1b9a', INGRESO: '#2e7d32', COSTO: '#c62828', GASTO: '#d84315' };
    const labels = { ACTIVO: 'Activos', PASIVO: 'Pasivos', PATRIMONIO: 'Patrimonio', INGRESO: 'Ingresos', COSTO: 'Costos', GASTO: 'Gastos' };

    let html = '';
    for (const tipo of tipos) {
      const filtradas = cuentasCache.filter(c => c.type === tipo && !c.parentId);
      if (!filtradas.length) continue;
      html += `<div class="cuenta-grupo"><div class="cuenta-tipo" style="background:${colores[tipo]}">${labels[tipo]}</div>`;
      for (const root of filtradas) {
        html += buildCuentaAdminTree(root, cuentasCache);
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar cuentas</div>'; }
}

function buildCuentaAdminTree(account, all, depth = 0) {
  const children = all.filter(c => c.parentId === account.id);
  const inactiveClass = !account.isActive ? ' style="opacity:0.5"' : '';
  let html = `<div class="cuenta-row" style="padding-left:${depth * 20 + 8}px"${inactiveClass}>
    <span class="cuenta-code">${account.code}</span>
    <span class="cuenta-name">${account.name}${!account.isActive ? ' (inactiva)' : ''}</span>
    <span class="cuenta-actions">
      <button onclick="editCuenta('${account.id}')" class="btn-sm" title="Editar">✏️</button>
    </span>
  </div>`;
  for (const child of children) {
    html += buildCuentaAdminTree(child, all, depth + 1);
  }
  return html;
}

function showCrearCuenta() {
  const form = document.getElementById('cuentas-admin-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4>Nueva Cuenta Contable</h4>
      <div class="form-grid">
        <div><label>Código</label><input type="text" id="cuenta-code" placeholder="Ej: 1.1.01"></div>
        <div><label>Nombre</label><input type="text" id="cuenta-name" placeholder="Ej: Caja Chica"></div>
        <div><label>Tipo</label><select id="cuenta-type">
          <option value="ACTIVO">Activo</option><option value="PASIVO">Pasivo</option>
          <option value="PATRIMONIO">Patrimonio</option><option value="INGRESO">Ingreso</option>
          <option value="COSTO">Costo</option><option value="GASTO">Gasto</option>
        </select></div>
        <div><label>Cuenta Padre (opcional)</label><select id="cuenta-parent"><option value="">— Ninguna —</option>
          ${cuentasCache.filter(c => !c.code.includes('.')).map(c => `<option value="${c.id}">${c.code} — ${c.name}</option>`).join('')}
        </select></div>
      </div>
      <div style="margin-top:10px">
        <button class="btn-primary" onclick="saveCuenta()">💾 Guardar</button>
        <button class="btn-secondary" onclick="cancelCuentaForm()">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth' });
}

function editCuenta(id) {
  const cuenta = cuentasCache.find(c => c.id === id);
  if (!cuenta) return;
  const form = document.getElementById('cuentas-admin-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4>Editar: ${cuenta.code} — ${cuenta.name}</h4>
      <div class="form-grid">
        <div><label>Nombre</label><input type="text" id="cuenta-name" value="${escapeHtml(cuenta.name)}"></div>
        <div><label>Activa</label><select id="cuenta-active">
          <option value="true" ${cuenta.isActive ? 'selected' : ''}>✅ Sí</option>
          <option value="false" ${!cuenta.isActive ? 'selected' : ''}>❌ No</option>
        </select></div>
      </div>
      <input type="hidden" id="cuenta-id" value="${cuenta.id}">
      <div style="margin-top:10px">
        <button class="btn-primary" onclick="saveCuenta()">💾 Guardar Cambios</button>
        <button class="btn-secondary" onclick="cancelCuentaForm()">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth' });
}

async function saveCuenta() {
  const id = document.getElementById('cuenta-id')?.value;
  const name = document.getElementById('cuenta-name')?.value?.trim();
  const active = document.getElementById('cuenta-active')?.value;
  const code = document.getElementById('cuenta-code')?.value?.trim();
  const type = document.getElementById('cuenta-type')?.value;
  const parentId = document.getElementById('cuenta-parent')?.value || null;

  try {
    let res;
    if (id) {
      // Editar
      res = await authFetch(`${API_URL}/accounts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, isActive: active === 'true' }),
      });
    } else {
      // Crear
      if (!code || !name || !type) { await showAlert('Código, Nombre y Tipo son requeridos'); return; }
      res = await authFetch(`${API_URL}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name, type, parentId }),
      });
    }
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }
    cancelCuentaForm();
    loadPanelCuentasAdmin();
  } catch (e) { await showAlert('Error de conexión'); }
}

function cancelCuentaForm() {
  document.getElementById('cuentas-admin-form').classList.add('hidden');
  document.getElementById('cuentas-admin-form').innerHTML = '';
}

/* ── Administración: Conceptos ── */
let conceptosCache = [];

async function loadPanelConceptosAdmin() {
  const el = document.getElementById('conceptos-admin-content');
  try {
    const res = await authFetch(`${API_URL}/concepts`);
    conceptosCache = await res.json();
    if (!conceptosCache.length) { el.innerHTML = '<div class="empty">No hay conceptos registrados</div>'; return; }
    document.getElementById('conceptos-admin-count').textContent = `${conceptosCache.length} conceptos`;

    let html = '<table><thead><tr><th>Concepto</th><th>Cuenta</th><th>Código</th><th>Activo</th><th></th></tr></thead><tbody>';
    for (const c of conceptosCache) {
      html += `<tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.account?.name || '—'}</td>
        <td class="cuenta-code">${c.account?.code || '—'}</td>
        <td>${c.isActive ? '✅' : '❌'}</td>
        <td>
          <button onclick="editConcepto('${c.id}')" class="btn-sm" title="Editar">✏️</button>
        </td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar conceptos</div>'; }
}

function showCrearConcepto() {
  const form = document.getElementById('conceptos-admin-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4>Nuevo Concepto</h4>
      <div class="form-grid">
        <div><label>Nombre del Concepto</label><input type="text" id="concepto-name" placeholder="Ej: Hosting"></div>
        <div><label>Cuenta Contable</label><select id="concepto-account">
          <option value="">— Selecciona —</option>
          ${cuentasCache.filter(a => a.isActive).map(a => `<option value="${a.id}">${a.code} — ${a.name}</option>`).join('')}
        </select></div>
      </div>
      <div style="margin-top:10px">
        <button class="btn-primary" onclick="saveConcepto()">💾 Guardar</button>
        <button class="btn-secondary" onclick="cancelConceptoForm()">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth' });
}

function editConcepto(id) {
  const c = conceptosCache.find(c => c.id === id);
  if (!c) return;
  const form = document.getElementById('conceptos-admin-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4>Editar: ${c.name}</h4>
      <div class="form-grid">
        <div><label>Nombre</label><input type="text" id="concepto-name" value="${escapeHtml(c.name)}"></div>
        <div><label>Cuenta Contable</label><select id="concepto-account">
          ${cuentasCache.filter(a => a.isActive).map(a => `<option value="${a.id}" ${a.id === c.accountId ? 'selected' : ''}>${a.code} — ${a.name}</option>`).join('')}
        </select></div>
        <div><label>Activo</label><select id="concepto-active">
          <option value="true" ${c.isActive ? 'selected' : ''}>✅ Sí</option>
          <option value="false" ${!c.isActive ? 'selected' : ''}>❌ No</option>
        </select></div>
      </div>
      <input type="hidden" id="concepto-id" value="${c.id}">
      <div style="margin-top:10px">
        <button class="btn-primary" onclick="saveConcepto()">💾 Guardar Cambios</button>
        <button class="btn-secondary" onclick="cancelConceptoForm()">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth' });
}

async function saveConcepto() {
  const id = document.getElementById('concepto-id')?.value;
  const name = document.getElementById('concepto-name')?.value?.trim();
  const accountId = document.getElementById('concepto-account')?.value;
  const isActive = document.getElementById('concepto-active')?.value;

  if (!name) { await showAlert('Nombre requerido'); return; }

  try {
    let res;
    if (id) {
      res = await authFetch(`${API_URL}/concepts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, accountId: accountId || undefined, isActive: isActive === 'true' }),
      });
    } else {
      if (!accountId) { await showAlert('Selecciona una cuenta contable'); return; }
      res = await authFetch(`${API_URL}/concepts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, accountId }),
      });
    }
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }
    cancelConceptoForm();
    loadPanelConceptosAdmin();
  } catch (e) { await showAlert('Error de conexión'); }
}

function cancelConceptoForm() {
  document.getElementById('conceptos-admin-form').classList.add('hidden');
  document.getElementById('conceptos-admin-form').innerHTML = '';
}

/* ── Administración: Configuración ── */
async function loadPanelConfig() {
  try {
    const res = await authFetch(`${API_URL}/config`);
    const cfg = await res.json();
    document.getElementById('config-itbms-rate').value = cfg.itbmsRate * 100;
    document.getElementById('config-itbms-enabled').value = cfg.itbmsEnabled ? 'true' : 'false';
  } catch (e) { /* keep defaults */ }
}

async function saveConfig() {
  const rate = parseFloat(document.getElementById('config-itbms-rate').value);
  const enabled = document.getElementById('config-itbms-enabled').value === 'true';

  if (isNaN(rate) || rate < 0 || rate > 20) { await showAlert('Tasa ITBMS debe estar entre 0 y 20'); return; }

  try {
    const res = await authFetch(`${API_URL}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itbmsRate: rate / 100, itbmsEnabled: enabled }),
    });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error); return; }
    const msg = document.getElementById('config-saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  } catch (e) { await showAlert('Error de conexión'); }
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
    const res = await authFetch(url);
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
    const res = await authFetch(`${API_URL}/journal/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'aprobar' }),
    });
    if (!res.ok) { const err = await res.json(); await showAlert(err.error); return; }
    loadPanelRevision();
    updateSummary();
    addMessage(`✅ Asiento #${id.slice(0,8)} aprobado por Contador Senior.`, 'assistant');
  } catch (e) {
    await showAlert('Error al aprobar');
    loadPanelRevision();
  }
}

function showRejectDialog(id) {
  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:420px">
    <div class="app-dialog-icon">❌</div>
    <div class="app-dialog-msg">¿Rechazar este asiento?</div>
    <div style="margin:8px 0">
      <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">Motivo del rechazo (opcional):</label>
      <input id="reject-notes-input" placeholder="Ej: Monto incorrecto, cuenta equivocada..." style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px;box-sizing:border-box">
    </div>
    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="reject-cancel">Cancelar</button>
      <button class="app-dialog-btn danger" id="reject-confirm">Rechazar</button>
    </div></div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#reject-cancel').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelector('#reject-confirm').onclick = async () => {
    const notes = document.getElementById('reject-notes-input').value.trim();
    overlay.remove();
    await doRechazarAsiento(id, notes);
  };
}

async function doRechazarAsiento(id, notes) {
  const card = document.querySelector(`.revision-card[data-id="${id}"]`);
  if (card) {
    card.querySelector('.rev-actions').innerHTML = '<span style="color:#c62828;font-weight:600">RECHAZANDO...</span>';
  }
  try {
    const res = await authFetch(`${API_URL}/journal/${id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rechazar', notes: notes || '' }),
    });
    if (!res.ok) { const err = await res.json(); await showAlert(err.error); return; }
    loadPanelRevision();
    addMessage(`❌ Asiento #${id.slice(0,8)} **rechazado**${notes ? ' — Motivo: ' + notes : ''}\n\nPuedes corregir la transacción y volver a enviarla.`, 'assistant');
  } catch (e) {
    await showAlert('Error al rechazar');
    loadPanelRevision();
  }
}

async function rechazarAsiento(id) {
  showRejectDialog(id);
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

/* ── Exportar reportes ── */
async function exportReport(reportType, format = 'xlsx') {
  const from = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-from`);
  const to = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-to`);
  const statusEl = document.getElementById('filter-diario-status');

  let url = `${API_URL}/reports/export/${reportType}?format=${format}`;
  if (from && from.value) url += `&startDate=${from.value}`;
  if (to && to.value) url += `&endDate=${to.value}`;
  if (statusEl && reportType === 'diario' && statusEl.value) url += `&status=${statusEl.value}`;

  try {
    const res = await authFetch(url);
    if (!res.ok) {
      const err = await res.json();
      await showAlert('Error al exportar: ' + (err.error || 'Error desconocido'));
      return;
    }
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
    a.download = filenameMatch ? filenameMatch[1] : `${reportType}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
  } catch (e) {
    await showAlert('Error de conexión al exportar');
  }
}

async function logout() {
  if (!await showConfirm('¿Cerrar sesión? Se perderá cualquier transacción no guardada.')) return;
  localStorage.removeItem('agt_token');
  localStorage.removeItem('agt_user');
  window.location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', () => {
  // Mostrar info del usuario
  const user = getUser();
  if (user) {
    document.getElementById('sidebar-user-name').textContent = user.name;
    document.getElementById('sidebar-user-company').textContent = user.company?.name || '';

    // Mostrar admin solo a admins
    if (user.role === 'admin') {
      document.getElementById('nav-admin-link').style.display = 'block';
    }
  }

  // Cargar info de suscripción
  loadSubscriptionInfo();

  addMessage('¡Buenos días! Soy tu agente contable. ¿Qué deseas registrar hoy?', 'assistant');
  addMessage('Puedes escribir algo como:\n• "Compré combustible por $40 con tarjeta"\n• "Vendí $250 en efectivo"\n• "Pagué la electricidad"\n• "Compra de mercancía por $100 con ITBMS a Distribuidora XYZ, crédito"\n• "Vendí $200 en efectivo con ITBMS"\n• "Pago de ITBMS por $150"', 'assistant');
  updateSummary();

  // Cargar cuentas para el selector del Auxiliar
  loadAuxiliarAccounts();
});

// ── Auxiliar de Cuenta ──
let _auxiliarAccounts = [];

async function loadAuxiliarAccounts() {
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    if (!res || !res.ok) return;
    const accounts = await res.json();
    _auxiliarAccounts = accounts.filter(a => {
      // Solo cuentas de detalle (las que tienen hijos normalmente, o las de movimiento)
      const code = a.code;
      const parts = code.split('.');
      return parts.length >= 2; // excluir cuentas raíz (1, 2, 3, 4, 5, 6)
    }).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

    const sel = document.getElementById('auxiliar-account');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecciona una cuenta...</option>' +
      _auxiliarAccounts.map(a => `<option value="${a.id}">${a.code} — ${a.name}</option>`).join('');
  } catch (e) {
    console.error('Error cargando cuentas:', e);
  }
}

async function loadAuxiliar() {
  const accountId = document.getElementById('auxiliar-account').value;
  const from = document.getElementById('auxiliar-from').value;
  const to = document.getElementById('auxiliar-to').value;

  if (!accountId) {
    await showAlert('Selecciona una cuenta contable');
    return;
  }

  const el = document.getElementById('auxiliar-content');
  el.innerHTML = '<div class="empty">Cargando...</div>';

  try {
    const params = new URLSearchParams();
    if (from) params.set('startDate', from);
    if (to) params.set('endDate', to);
    const qs = params.toString();

    const res = await authFetch(`${API_URL}/journal/mayor/${accountId}${qs ? `?${qs}` : ''}`);
    if (!res || !res.ok) { el.innerHTML = '<div class="empty">Error al cargar</div>'; return; }

    const data = await res.json();
    if (!data.detail || !data.detail.length) {
      el.innerHTML = '<div class="empty">Sin movimientos en este período</div>';
      return;
    }

    const account = data.account;
    const fmt = (n) => n === 0 ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    el.innerHTML = `
      <div style="margin-bottom:12px">
        <strong style="font-size:16px">${account.code} — ${account.name}</strong>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">(${account.type})</span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:2px solid #e2e4e8">
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-size:11px">FECHA</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-size:11px">DETALLE</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">DÉBITO</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">CRÉDITO</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">SALDO</th>
            </tr>
          </thead>
          <tbody>
            ${data.detail.map(d => `
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:8px 12px;white-space:nowrap">${new Date(d.date).toLocaleDateString('es-PA')}</td>
                <td style="padding:8px 12px;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escHtml(d.description)}">${escHtml(d.description?.substring(0, 80) || '')}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap">${fmt(d.debit)}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap">${fmt(d.credit)}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap;font-weight:600;color:${d.balance >= 0 ? '#065f46' : '#991b1b'}">${fmt(d.balance)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid #1a1a2e;font-weight:700">
              <td colspan="2" style="padding:8px 12px">TOTALES</td>
              <td style="text-align:right;padding:8px 12px">${fmt(data.totals.totalDebit)}</td>
              <td style="text-align:right;padding:8px 12px">${fmt(data.totals.totalCredit)}</td>
              <td style="text-align:right;padding:8px 12px;color:${data.totals.finalBalance >= 0 ? '#065f46' : '#991b1b'}">${fmt(data.totals.finalBalance)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  } catch (e) {
    el.innerHTML = '<div class="empty">Error de conexión</div>';
  }
}

async function exportAuxiliar() {
  const accountId = document.getElementById('auxiliar-account').value;
  const from = document.getElementById('auxiliar-from').value;
  const to = document.getElementById('auxiliar-to').value;

  if (!accountId) { await showAlert('Selecciona una cuenta'); return; }

  try {
    const params = new URLSearchParams();
    if (from) params.set('startDate', from);
    if (to) params.set('endDate', to);
    const qs = params.toString();

    const res = await authFetch(`${API_URL}/journal/mayor/${accountId}${qs ? `?${qs}` : ''}`);
    if (!res || !res.ok) { await showAlert('Error al exportar'); return; }

    const data = await res.json();
    if (!data.detail || !data.detail.length) { await showAlert('Sin datos para exportar'); return; }

    // Generar CSV
    const account = data.account;
    let csv = `"${account.code} — ${account.name} (${account.type})"\n`;
    csv += 'Fecha,Detalle,Débito,Crédito,Saldo\n';
    for (const d of data.detail) {
      csv += `"${new Date(d.date).toLocaleDateString('es-PA')}","${(d.description || '').replace(/"/g, '""')}",${d.debit},${d.credit},${d.balance}\n`;
    }
    csv += `"TOTALES",,${data.totals.totalDebit},${data.totals.totalCredit},${data.totals.finalBalance}\n`;

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auxiliar_${account.code.replace(/\./g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    await showAlert('Error al exportar');
  }
}

function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Recurring Transactions Panel ──
let editingRecurringId = null;

async function loadPanelRecurring() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('recurring-form').classList.add('hidden');
  document.getElementById('panel-recurring-content').classList.remove('hidden');

  try {
    const res = await authFetch(`${API_URL}/recurring`);
    if (!res.ok) throw new Error('Error al cargar');
    const data = await res.json();
    const templates = data.templates || [];

    // Pending review
    const pendingDiv = document.getElementById('recurring-pending');
    const pendingCount = document.getElementById('recurring-pending-count');
    if (data.pendingReview > 0) {
      pendingDiv.style.display = 'block';
      pendingCount.textContent = data.pendingReview;
    } else {
      pendingDiv.style.display = 'none';
    }

    let html = '';
    if (templates.length === 0) {
      html = '<div class="empty" style="padding:32px;text-align:center;color:#6b7280">No hay transacciones recurrentes. Crea una para automatizar tus registros.</div>';
    } else {
      html = '<div style="display:flex;flex-direction:column;gap:12px">';
      for (const t of templates) {
        const freqLabel = { DAILY: 'Diario', WEEKLY: 'Semanal', MONTHLY: 'Mensual', YEARLY: 'Anual' }[t.frequency] || t.frequency;
        const nextRun = new Date(t.nextRunAt).toLocaleDateString('es-PA');
        const activeBadge = t.isActive
          ? '<span class="badge badge-ok">Activo</span>'
          : '<span class="badge badge-err">Pausado</span>';
        const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleDateString('es-PA') : '—';
        html += `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
            <div>
              <strong style="font-size:15px">${escHtml(t.description)}</strong>
              <div style="font-size:13px;color:#6b7280;margin-top:2px">${escHtml(t.concept || '')} • ${freqLabel} • $${t.amount.toFixed(2)}</div>
            </div>
            ${activeBadge}
          </div>
          <div style="display:flex;gap:16px;font-size:12px;color:#6b7280;margin-bottom:12px">
            <span>📅 Próximo: ${nextRun}</span>
            <span>📌 Último: ${lastRun}</span>
            <span>${t.requireConfirmation ? '🔍 Requiere confirmación' : '✅ Auto-confirmado'}</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary btn-sm" onclick="editRecurring('${t.id}')">✏️ Editar</button>
            <button class="btn-secondary btn-sm" onclick="toggleRecurring('${t.id}', ${!t.isActive})">${t.isActive ? '⏸ Pausar' : '▶️ Reanudar'}</button>
            <button class="btn-primary btn-sm" onclick="runRecurring('${t.id}')" style="background:#1565c0">▶️ Ejecutar ahora</button>
            <button class="btn-danger btn-sm" onclick="deleteRecurring('${t.id}')">🗑 Eliminar</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }
    document.getElementById('recurring-list').innerHTML = html;
  } catch (e) {
    document.getElementById('recurring-list').innerHTML = '<div class="empty">Error al cargar</div>';
  }
}

function showCreateRecurring() {
  editingRecurringId = null;
  document.getElementById('recurring-form-title').textContent = 'Nueva Transacción Recurrente';
  document.getElementById('rec-desc').value = '';
  document.getElementById('rec-amount').value = '';
  document.getElementById('rec-concept').value = '';
  document.getElementById('rec-type').value = 'GASTO';
  document.getElementById('rec-payment').value = '';
  document.getElementById('rec-freq').value = 'MONTHLY';
  document.getElementById('rec-day').value = '1';
  document.getElementById('rec-confirm').checked = true;
  document.getElementById('rec-save-btn').textContent = 'Guardar';
  toggleRecDayFields();
  document.getElementById('recurring-form').classList.remove('hidden');
}

function hideRecurringForm() {
  document.getElementById('recurring-form').classList.add('hidden');
  editingRecurringId = null;
}

async function editRecurring(id) {
  try {
    const res = await authFetch(`${API_URL}/recurring`);
    const data = await res.json();
    const t = (data.templates || []).find(t => t.id === id);
    if (!t) return;

    editingRecurringId = id;
    document.getElementById('recurring-form-title').textContent = 'Editar Transacción Recurrente';
    document.getElementById('rec-desc').value = t.description;
    document.getElementById('rec-amount').value = t.amount;
    document.getElementById('rec-concept').value = t.concept || '';
    document.getElementById('rec-type').value = t.type;
    document.getElementById('rec-payment').value = t.paymentMethod || '';
    document.getElementById('rec-freq').value = t.frequency;
    document.getElementById('rec-day').value = t.dayOfMonth || 1;
    document.getElementById('rec-confirm').checked = t.requireConfirmation;
    document.getElementById('rec-save-btn').textContent = 'Actualizar';
    toggleRecDayFields();
    document.getElementById('recurring-form').classList.remove('hidden');
  } catch (e) {
    await showAlert('Error al cargar plantilla');
  }
}

async function saveRecurring() {
  const body = {
    description: document.getElementById('rec-desc').value.trim(),
    amount: parseFloat(document.getElementById('rec-amount').value) || 0,
    concept: document.getElementById('rec-concept').value.trim() || undefined,
    type: document.getElementById('rec-type').value,
    paymentMethod: document.getElementById('rec-payment').value || null,
    frequency: document.getElementById('rec-freq').value,
    dayOfMonth: parseInt(document.getElementById('rec-day').value) || 1,
    requireConfirmation: document.getElementById('rec-confirm').checked,
  };

  if (!body.description || body.amount <= 0) {
    await showAlert('Descripción y monto son requeridos');
    return;
  }

  try {
    const url = editingRecurringId
      ? `${API_URL}/recurring/${editingRecurringId}`
      : `${API_URL}/recurring`;
    const method = editingRecurringId ? 'PUT' : 'POST';

    const res = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }

    hideRecurringForm();
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al guardar');
  }
}

async function runRecurring(id) {
  const ok = await showConfirm('¿Ejecutar esta transacción recurrente ahora? Se creará un asiento contable.');
  if (!ok) return;
  try {
    const res = await authFetch(`${API_URL}/recurring/${id}/run`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }
    const data = await res.json();
    if (data.executed) {
      await showAlert('✅ Asiento generado correctamente. Revisa el Diario.');
    } else {
      await showAlert('❌ ' + (data.error || 'No se pudo ejecutar'));
    }
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al ejecutar');
  }
}

async function toggleRecurring(id, isActive) {
  try {
    await authFetch(`${API_URL}/recurring/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive }),
    });
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al cambiar estado');
  }
}

async function deleteRecurring(id) {
  const ok = await showConfirm('¿Eliminar esta transacción recurrente?');
  if (!ok) return;
  try {
    await authFetch(`${API_URL}/recurring/${id}`, { method: 'DELETE' });
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al eliminar');
  }
}

function toggleRecDayFields() {
  const freq = document.getElementById('rec-freq').value;
  const container = document.getElementById('rec-day-container');
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    container.style.display = 'block';
    document.querySelector('#rec-day-container label').textContent = 'Día del mes';
    document.getElementById('rec-day').min = 1;
    document.getElementById('rec-day').max = 31;
  } else if (freq === 'WEEKLY') {
    container.style.display = 'block';
    document.querySelector('#rec-day-container label').textContent = 'Día de semana (0=Dom)';
    document.getElementById('rec-day').min = 0;
    document.getElementById('rec-day').max = 6;
  } else {
    container.style.display = 'none';
  }
}

// ── WhatsApp Panel ──
async function loadPanelWhatsApp() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-recurring-content').classList.add('hidden');
  document.getElementById('recurring-form').classList.add('hidden');
  document.getElementById('panel-whatsapp-content').classList.remove('hidden');

  // Mostrar el número del bot de WhatsApp
  const botNumber = document.getElementById('wa-bot-number');
  // Intentar obtener de la config o usar default
  try {
    const res = await authFetch(`${API_URL}/config`);
    if (res.ok) {
      const config = await res.json();
      if (config.whatsappPhone) botNumber.textContent = config.whatsappPhone;
    }
  } catch {}

  await loadWhatsAppLinks();
}

async function loadWhatsAppLinks() {
  try {
    const res = await authFetch(`${API_URL}/whatsapp/links`);
    if (!res.ok) throw new Error('Error');
    const links = await res.json();

    const el = document.getElementById('wa-links-list');
    if (!links.length) {
      el.innerHTML = '<div style="color:#6b7280;text-align:center;padding:16px;background:#f9fafb;border-radius:8px">No hay números vinculados aún. Vincula tu WhatsApp para empezar.</div>';
      return;
    }

    let html = '<div style="display:flex;flex-direction:column;gap:8px">';
    for (const l of links) {
      const verified = l.verifiedAt ? '✅' : '⏳';
      const date = l.verifiedAt ? new Date(l.verifiedAt).toLocaleDateString('es-PA') : 'Pendiente';
      html += `<div style="display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px">
        <div>
          <strong>${verified} ${l.phoneNumber}</strong>
          <span style="font-size:11px;color:#6b7280;margin-left:8px">${l.label || ''}</span>
          <div style="font-size:11px;color:#6b7280">Vinculado: ${date}</div>
        </div>
        <button class="btn-danger btn-sm" onclick="unlinkWhatsApp('${l.id}')">🗑 Desvincular</button>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('wa-links-list').innerHTML = '<div style="color:#dc2626">Error al cargar</div>';
  }
}

async function verifyWhatsAppCode() {
  const phone = document.getElementById('wa-phone').value.trim();
  const code = document.getElementById('wa-code').value.trim();

  if (!phone || !code) {
    await showAlert('Ingresa tu número de WhatsApp y el código de 6 dígitos.');
    return;
  }

  try {
    const res = await authFetch(`${API_URL}/whatsapp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, code }),
    });

    const data = await res.json();
    if (!res.ok) { await showAlert(data.error || 'Error al verificar'); return; }

    await showAlert(data.message);
    document.getElementById('wa-code').value = '';
    document.getElementById('wa-phone').value = '';
    await loadWhatsAppLinks();
  } catch (e) {
    await showAlert('Error de conexión');
  }
}

async function unlinkWhatsApp(id) {
  const ok = await showConfirm('¿Desvincular este número de WhatsApp?');
  if (!ok) return;
  try {
    await authFetch(`${API_URL}/whatsapp/links/${id}`, { method: 'DELETE' });
    await loadWhatsAppLinks();
  } catch (e) {
    await showAlert('Error al desvincular');
  }
}

/* ── Panel: Importar (inline) ── */
let importInlineFile = null;
let importInlinePreview = null;

function loadPanelImport() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-import-content').classList.remove('hidden');
  // Inicializar fecha por defecto
  const dateInput = document.getElementById('import-inline-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  // Drag & drop + file input
  const zone = document.getElementById('import-inline-zone');
  const fileInput = document.getElementById('import-inline-file');
  zone.onclick = () => fileInput.click();
  zone.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  zone.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) handleImportInlineFile(f);
  };
  fileInput.onchange = e => {
    const f = e.target.files[0];
    if (f) handleImportInlineFile(f);
  };
}

async function handleImportInlineFile(file) {
  importInlineFile = file;
  document.getElementById('import-inline-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-loading-text').textContent = 'Analizando archivo...';

  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await authFetch(`${API_URL}/import/preview`, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); resetImportInline(); return; }
    importInlinePreview = await res.json();
    document.getElementById('import-inline-loading').classList.add('hidden');
    renderImportInlinePreview();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

function renderImportInlinePreview() {
  if (!importInlinePreview) return;
  const { totalRows, previewRows } = importInlinePreview;
  document.getElementById('import-inline-total').textContent = totalRows;
  const errs = previewRows.filter(r => !r.date || !r.amount || r.amount <= 0);
  document.getElementById('import-inline-ok').textContent = Math.max(0, previewRows.length - errs.length) + (totalRows > 20 ? '+' : '');
  document.getElementById('import-inline-err').textContent = errs.length;
  document.getElementById('import-inline-summary').classList.remove('hidden');

  // Tabla preview (primeras 20 filas)
  const thead = document.getElementById('import-inline-thead');
  thead.innerHTML = '<tr><th>#</th><th>Fecha</th><th>Descripción</th><th>Monto</th><th>Concepto</th><th>Cuenta</th><th>Conf</th></tr>';
  let html = '';
  previewRows.forEach((r, i) => {
    const conf = r.classification;
    html += `<tr>
      <td>${i+1}</td><td>${r.date||'—'}</td><td>${escHtml(r.description||'')}</td>
      <td>${r.amount?'$'+r.amount.toFixed(2):'—'}</td><td>${escHtml(r.concept||'')}</td>
      <td>${conf?escHtml(conf.concept):'—'}</td>
      <td>${conf?Math.round(conf.confidence*100)+'%':'—'}</td></tr>`;
  });
  document.getElementById('import-inline-tbody').innerHTML = html;
  document.getElementById('import-inline-preview').classList.remove('hidden');
  document.getElementById('import-inline-execute').classList.remove('hidden');
}

async function executeImportInline() {
  if (!importInlineFile) return;
  const total = importInlinePreview.totalRows;
  const importDate = document.getElementById('import-inline-date').value;
  const dateLabel = new Date(importDate+'T12:00:00').toLocaleDateString('es-PA',{year:'numeric',month:'long',day:'numeric'});

  const ok = await showConfirm(`¿Importar ${total} transacciones?\n\n📅 Fecha: ${dateLabel}\n\n⚠️ Verifica la fecha. Los asientos se crearán como BORRADOR.`);
  if (!ok) return;

  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-execute').classList.add('hidden');
  document.getElementById('import-inline-loading-text').textContent = `Importando ${total} transacciones...`;

  const formData = new FormData();
  formData.append('file', importInlineFile);
  formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/import/execute-all`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      await showAlert(`✅ Importación completada: ${result.success} de ${result.total} exitosas.${result.errors.length ? `\n${result.errors.length} errores.` : ''}`);
    } else {
      await showAlert(`❌ ${result.error || 'Error'}`);
    }
    resetImportInline();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

function resetImportInline() {
  importInlineFile = null;
  importInlinePreview = null;
  document.getElementById('import-inline-file').value = '';
  document.getElementById('import-inline-file-name').textContent = '';
  document.getElementById('import-inline-preview').classList.add('hidden');
  document.getElementById('import-inline-summary').classList.add('hidden');
  document.getElementById('import-inline-execute').classList.add('hidden');
  document.getElementById('import-inline-loading').classList.add('hidden');
}

/* ── Panel: Conciliación (inline) ── */
function loadPanelConciliacion() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-conciliacion-content').classList.remove('hidden');
  loadConciliacionList();
}

async function loadConciliacionList() {
  const el = document.getElementById('conciliacion-inline-list');
  try {
    const res = await authFetch(`${API_URL}/reconcile`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; return; }
    const statements = await res.json();
    if (!statements.length) {
      el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">No hay extractos bancarios. Sube uno para comenzar.</div>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Archivo</th><th>Fecha subida</th><th>Estado</th><th>Filas</th><th></th></tr></thead><tbody>';
    for (const s of statements) {
      html += `<tr>
        <td><strong>${escHtml(s.fileName||'Extracto')}</strong></td>
        <td>${new Date(s.uploadDate).toLocaleDateString('es-PA')}</td>
        <td>${s.status}</td>
        <td>${s._count?.rows||'—'}</td>
        <td><button class="btn-sm" onclick="window.open('/conciliacion.html','_blank')">🔍 Abrir</button></td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

function showConciliacionUpload() {
  const el = document.getElementById('conciliacion-inline-upload');
  el.classList.remove('hidden');
  const fileInput = document.getElementById('conciliacion-inline-file');
  el.onclick = () => fileInput.click();
  el.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) uploadConciliacionFile(f);
  };
  fileInput.onchange = e => { const f = e.target.files[0]; if (f) uploadConciliacionFile(f); };
}

async function uploadConciliacionFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await authFetch(`${API_URL}/reconcile/upload`, { method: 'POST', body: formData });
    if (res.ok) { await showAlert('✅ Extracto subido. Redirigiendo a conciliación...'); window.open('/conciliacion.html','_blank'); }
    else { const e = await res.json(); await showAlert(e.error || 'Error al subir'); }
  } catch (e) { await showAlert('Error de conexión'); }
  document.getElementById('conciliacion-inline-upload').classList.add('hidden');
  loadConciliacionList();
}

/* ── Panel: Auxiliares (sidebar) ── */
function loadPanelAuxiliares() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-auxiliares-content').classList.remove('hidden');
  clickAuxTab('cuenta');
}

// Tabs de Auxiliares
document.querySelectorAll('#panel-tabs-auxiliares button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-auxiliares');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    clickAuxTab(btn.dataset.aux);
  });
});

function clickAuxTab(tab) {
  const btns = document.querySelectorAll('#panel-tabs-auxiliares button');
  btns.forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
  const active = document.querySelector(`#panel-tabs-auxiliares button[data-aux="${tab}"]`);
  if (active) { active.classList.add('active'); active.style.color = '#1a1a2e'; active.style.borderBottomColor = '#1565c0'; }
  const sub = document.getElementById('aux-sidebar-content');
  sub.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Cargando...</div>';
  if (tab === 'cuenta') loadAuxCuenta(sub);
  else if (tab === 'cxc') loadAuxCxC(sub);
  else if (tab === 'cxp') loadAuxCxP(sub);
}

/* ── Panel: Revisión (sidebar) ── */
function loadPanelRevision() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-revision-content').classList.remove('hidden');
  loadRevisionList();
}

async function loadRevisionList() {
  const el = document.getElementById('revision-inline-list');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/journal/pendientes`);
    const d = await res.json();
    if (!d || !d.length) {
      el.innerHTML = '<div style="text-align:center;padding:48px;color:#059669;font-size:15px">✅ No hay asientos pendientes de revisión</div>';
      return;
    }
    let html = '';
    for (const e of d) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      html += `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px">
        <div style="font-size:24px">📝</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px">${escHtml(e.description||'Sin descripción')}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:4px">📅 ${date} · 👤 ${escHtml(e.createdBy?.name||'—')} · ${e.lines?.length||0} líneas</div>
        </div>
        <div>
          <button class="btn-sm" onclick="reviewApprove('${e.id}')" style="padding:6px 14px;font-size:12px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;margin-right:6px">✅ Aprobar</button>
          <button class="btn-sm" onclick="reviewReject('${e.id}')" style="padding:6px 14px;font-size:12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer">❌ Rechazar</button>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

async function reviewApprove(id) {
  try {
    const res = await authFetch(`${API_URL}/journal/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'aprobar' }) });
    if (res.ok) { loadRevisionList(); await showAlert('✅ Asiento aprobado'); }
  } catch (e) { await showAlert('Error'); }
}

async function reviewReject(id) {
  try {
    const res = await authFetch(`${API_URL}/journal/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rechazar' }) });
    if (res.ok) { loadRevisionList(); }
  } catch (e) { await showAlert('Error'); }
}

/* ── Panel: Informes (inline) ── */
function loadPanelInformes() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-informes-content').classList.remove('hidden');
  // Activar tab Diario por defecto
  clickInformeTab('diario');
}

// Tabs de informes
document.querySelectorAll('#panel-tabs-informes button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-informes');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    clickInformeTab(btn.dataset.informe);
  });
});

function clickInformeTab(informe) {
  const btns = document.querySelectorAll('#panel-tabs-informes button');
  btns.forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
  const active = document.querySelector(`#panel-tabs-informes button[data-informe="${informe}"]`);
  if (active) { active.classList.add('active'); active.style.color = '#1a1a2e'; active.style.borderBottomColor = '#1565c0'; }
  showInformesLoading();
  const loaders = { diario: loadReportDiario, balance: loadReportBalance, resultados: loadReportResultados, dashboard: loadReportDashboard };
  if (loaders[informe]) loaders[informe]();
}

function showInformesLoading() {
  document.getElementById('informes-inline-result').innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando reporte...</div>';
}

let _informesChart = null;

async function loadReportDiario() {
  const el = document.getElementById('informes-inline-result');
  try {
    const res = await authFetch(`${API_URL}/journal?limit=20`);
    const d = await res.json();
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const rows = (d.entries||[]).map(e => {
      const debit = e.lines?.reduce((s,l)=>s+(l.debit||0),0)||0;
      const credit = e.lines?.reduce((s,l)=>s+(l.credit||0),0)||0;
      return [new Date(e.date).toLocaleDateString('es-PA'), escHtml(e.description||''), `<span style="color:#2e7d32">${fmt(debit)}</span>`, `<span style="color:#c62828">${fmt(credit)}</span>`];
    });
    el.innerHTML = getInformesExportBar('diario') + buildInformesTable(['Fecha','Descripción','Débito','Crédito'], rows);
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
async function loadReportBalance() {
  const el = document.getElementById('informes-inline-result');
  try {
    const res = await authFetch(`${API_URL}/reports/balance-comprobacion`);
    const d = await res.json();
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const rows = (d||[]).map(a => [
      escHtml(a.account?.code), escHtml(a.account?.name),
      `<span style="color:#2e7d32">${fmt(a.totalDebit||0)}</span>`,
      `<span style="color:#c62828">${fmt(a.totalCredit||0)}</span>`,
      `<strong style="color:${a.balanceType==='DEUDOR'?'#2e7d32':'#c62828'}">${a.balanceType==='DEUDOR'?'+':'−'}${fmt(Math.abs(a.balance||0)).replace('$','')}</strong>`
    ]);
    el.innerHTML = getInformesExportBar('balance-comprobacion') + buildInformesTable(['Código','Cuenta','Débito','Crédito','Saldo'], rows);
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
async function loadReportResultados() {
  const el = document.getElementById('informes-inline-result');
  try {
    const res = await authFetch(`${API_URL}/reports/estado-resultados`);
    const d = await res.json();
    const items = (obj) => Object.entries(obj||{}).map(([k,v]) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escHtml(k)}</td><td style="text-align:right;padding:6px 10px;border-bottom:1px solid #e5e7eb;font-weight:600">$${Number(v).toLocaleString()}</td></tr>`).join('');
    el.innerHTML = getInformesExportBar('estado-resultados') + `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <h3 style="font-size:14px;color:#2e7d32;margin:0 0 8px 0">📈 Ingresos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
            ${items(d.ingresos?.detalle||{})}
            <tfoot><tr style="border-top:2px solid #1a1a2e;background:#f0fdf4"><td style="padding:8px 10px"><strong>Total Ingresos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#2e7d32">$${d.ingresos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot>
          </table>
        </div>
        <div>
          <h3 style="font-size:14px;color:#c62828;margin:0 0 8px 0">📉 Gastos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
            ${items(d.gastos?.detalle||{})}
            <tfoot><tr style="border-top:2px solid #1a1a2e;background:#fef2f2"><td style="padding:8px 10px"><strong>Total Gastos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#c62828">$${d.gastos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot>
          </table>
        </div>
      </div>
      ${d.costos?.total ? `<div style="margin-top:8px"><h3 style="font-size:14px;color:#e65100;margin:0 0 8px 0">🏭 Costos</h3><table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">${items(d.costos?.detalle||{})}<tfoot><tr style="border-top:2px solid #1a1a2e"><td style="padding:8px 10px"><strong>Total Costos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#e65100">$${d.costos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot></table></div>` : ''}
      <div style="margin-top:16px;padding:14px;background:#f0f9ff;border-radius:8px;text-align:center;font-size:16px;font-weight:700;color:#1a1a2e">
        💰 Ganancia Bruta: <span style="color:${(d.gananciaBruta||0)>=0?'#2e7d32':'#c62828'}">$${(d.gananciaBruta||0).toLocaleString()}</span>
        &nbsp;|&nbsp;
        📊 Utilidad Neta: <span style="color:${(d.utilidadNeta||0)>=0?'#2e7d32':'#c62828'}">$${(d.utilidadNeta||0).toLocaleString()}</span>
      </div>`;
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
async function loadReportDashboard() {
  const el = document.getElementById('informes-inline-result');
  try {
    const res = await authFetch(`${API_URL}/reports/dashboard`);
    if (!res || !res.ok) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const d = await res.json();
    const r = d.resumen || {};
    el.innerHTML = `
      <div class="stats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px">
        <div style="background:#fff;border-radius:8px;padding:14px;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Ingresos</div><div style="font-size:20px;font-weight:700;color:#2e7d32">$${r.totalIngresos.toLocaleString()}</div></div>
        <div style="background:#fff;border-radius:8px;padding:14px;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Gastos</div><div style="font-size:20px;font-weight:700;color:#c62828">$${r.totalGastos.toLocaleString()}</div></div>
        <div style="background:#fff;border-radius:8px;padding:14px;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Utilidad Neta</div><div style="font-size:20px;font-weight:700;color:${r.utilidadNeta>=0?'#2e7d32':'#c62828'}">$${r.utilidadNeta.toLocaleString()}</div></div>
        <div style="background:#fff;border-radius:8px;padding:14px;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:11px;color:#6b7280;text-transform:uppercase;margin-bottom:4px">Meses</div><div style="font-size:20px;font-weight:700;color:#1a1a2e">${r.meses||'—'}</div></div>
      </div>
      <canvas id="dashboardChart" height="200"></canvas>`;
    if (_informesChart) _informesChart.destroy();
    const ctx = document.getElementById('dashboardChart');
    if (ctx && d.monthly && d.monthly.length && typeof Chart !== 'undefined') {
      _informesChart = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: d.monthly.map(m => m.month),
          datasets: [
            { label: 'Ingresos', data: d.monthly.map(m => m.ingresos), backgroundColor: '#10b981' },
            { label: 'Gastos', data: d.monthly.map(m => m.gastos), backgroundColor: '#ef4444' }
          ]
        },
        options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
      });
    }
  } catch(e) { el.innerHTML = '<div class="empty">Error de conexión</div>'; }
}
function loadReportAuxiliares() {
  const el = document.getElementById('informes-inline-result');
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn-primary active" onclick="switchAuxTab('cuenta',this)" style="padding:8px 16px;font-size:13px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">📒 Cuenta</button>
      <button class="btn-secondary" onclick="switchAuxTab('cxc',this)" style="padding:8px 16px;font-size:13px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;cursor:pointer">👥 CxC</button>
      <button class="btn-secondary" onclick="switchAuxTab('cxp',this)" style="padding:8px 16px;font-size:13px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;cursor:pointer">🏭 CxP</button>
    </div>
    <div id="aux-sub-content"></div>`;
  switchAuxTab('cuenta');
}

function switchAuxTab(tab, btn) {
  if (btn) {
    document.querySelectorAll('#informes-inline-result button').forEach(b => { b.style.background = '#e5e7eb'; b.style.color = '#374151'; });
    btn.style.background = '#1565c0'; btn.style.color = '#fff';
  }
  const sub = document.getElementById('aux-sub-content');
  sub.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Cargando...</div>';
  if (tab === 'cuenta') loadAuxCuenta(sub);
  else if (tab === 'cxc') loadAuxCxC(sub);
  else if (tab === 'cxp') loadAuxCxP(sub);
}

async function loadAuxCuenta(el) {
  el.innerHTML = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center"><select id="informes-aux-select" onchange="loadAuxiliarData()" style="padding:8px;border:1px solid #d1d5db;border-radius:6px;min-width:280px"><option value="">Selecciona una cuenta...</option></select><input type="date" id="aux-from" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px"><input type="date" id="aux-to" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px"><button onclick="loadAuxiliarData()" style="padding:8px 14px;border:1px solid #1565c0;border-radius:6px;background:#1565c0;color:#fff;cursor:pointer;font-size:12px">🔍 Buscar</button></div><div id="informes-aux-data"><div style="text-align:center;padding:32px;color:#6b7280">Selecciona una cuenta</div></div>';
  try { const res = await authFetch(`${API_URL}/accounts`); const accounts = await res.json(); const sel = document.getElementById('informes-aux-select'); const sorted = accounts.filter(a => a.code.split('.').length >= 2).sort((a,b) => a.code.localeCompare(b.code, undefined, {numeric:true})); if (sel) sorted.forEach(a => { sel.innerHTML += `<option value="${a.id}">${a.code} — ${a.name}</option>`; }); } catch(e) {}
}
async function loadAuxiliarData() {
  const id = document.getElementById('informes-aux-select')?.value;
  if (!id) return;
  const from = document.getElementById('aux-from')?.value || '';
  const to = document.getElementById('aux-to')?.value || '';
  const params = new URLSearchParams();
  if (from) params.set('startDate', from);
  if (to) params.set('endDate', to);
  const el = document.getElementById('informes-aux-data');
  el.innerHTML = 'Cargando...';
  try {
    const res = await authFetch(`${API_URL}/journal/mayor/${id}?${params}`);
    const d = await res.json();
    if (!d.detail || !d.detail.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Sin movimientos</div>'; return; }
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    el.innerHTML = `<div style="margin-bottom:8px;font-weight:600">${d.account.code} — ${d.account.name}</div>` +
      buildInformesTable(['Fecha','Detalle','Débito','Crédito','Saldo'],
        d.detail.map(e => [new Date(e.date).toLocaleDateString('es-PA'), escHtml(e.description||''), `<span style="color:#2e7d32">${fmt(e.debit||0)}</span>`, `<span style="color:#c62828">${fmt(e.credit||0)}</span>`, `<strong>${fmt(e.balance||0)}</strong>`]));
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}
async function loadAuxCxC(el) {
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/clients`), authFetch(`${API_URL}/clients/report/summary`)]);
    if (!rc || !rs) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const clients = await rc.json(), sum = await rs.json();
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">'+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Clientes</div><div style="font-size:20px;font-weight:700">${sum.totalClients}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Por Cobrar</div><div style="font-size:20px;font-weight:700;color:#f59e0b">$${sum.totalDue.toLocaleString()}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Vencidas</div><div style="font-size:20px;font-weight:700;color:#ef4444">${sum.overdueInvoices}</div></div>`+
    '</div>';
    html += clients.filter(c => c.totalDue > 0).length
      ? buildInformesTable(['Cliente','RUC','Pendiente','Facturas',''], clients.filter(c => c.totalDue > 0).map(c => [escHtml(c.name), escHtml(c.taxId||'—'), `<span style="color:#c62828;font-weight:600">$${c.totalDue.toLocaleString()}</span>`, c.invoiceCount||'—', `<button onclick="toggleFacturas('${c.id}','invoices')" style="padding:4px 10px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📋 Ver</button><div id="detalle-${c.id}" class="hidden" style="margin-top:8px"></div>`]))
      : '<div style="text-align:center;padding:24px;color:#6b7280">Sin clientes con saldo pendiente</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}
async function loadAuxCxP(el) {
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/suppliers`), authFetch(`${API_URL}/suppliers/report/summary`)]);
    if (!rc || !rs) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const supps = await rc.json(), sum = await rs.json();
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">'+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Proveedores</div><div style="font-size:20px;font-weight:700">${sum.totalSuppliers}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Por Pagar</div><div style="font-size:20px;font-weight:700;color:#f59e0b">$${sum.totalOwed.toLocaleString()}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Vencidas</div><div style="font-size:20px;font-weight:700;color:#ef4444">${sum.overdueBills}</div></div>`+
    '</div>';
    html += supps.filter(s => s.totalOwed > 0).length
      ? buildInformesTable(['Proveedor','RUC','Pendiente','Facturas',''], supps.filter(s => s.totalOwed > 0).map(s => [escHtml(s.name), escHtml(s.taxId||'—'), `<span style="color:#c62828;font-weight:600">$${s.totalOwed.toLocaleString()}</span>`, s.billCount||'—', `<button onclick="toggleFacturas('${s.id}','bills')" style="padding:4px 10px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📋 Ver</button><div id="detalle-${s.id}" class="hidden" style="margin-top:8px"></div>`]))
      : '<div style="text-align:center;padding:24px;color:#6b7280">Sin proveedores con saldo pendiente</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}

async function toggleFacturas(entityId, type) {
  const det = document.getElementById('detalle-' + entityId);
  if (!det.classList.contains('hidden')) { det.classList.add('hidden'); return; }
  det.classList.remove('hidden');
  det.innerHTML = '<div style="text-align:center;padding:12px;color:#6b7280">Cargando...</div>';
  const url = type === 'invoices' ? `${API_URL}/clients/${entityId}/invoices` : `${API_URL}/suppliers/${entityId}/bills`;
  try {
    const res = await authFetch(url);
    const items = await res.json();
    if (!items || !items.length) { det.innerHTML = '<div style="text-align:center;padding:12px;color:#6b7280">Sin facturas</div>'; return; }
    const fmt = n => '$'+n.toLocaleString('en-US',{minimumFractionDigits:2});
    const rows = items.map(f => {
      const statusLabel = { PENDIENTE: '⏳ Pendiente', VENCIDA: '🔴 Vencida', PAGADA: '✅ Pagada' };
      const statusColor = { PENDIENTE: '#f59e0b', VENCIDA: '#dc2626', PAGADA: '#059669' };
      return [
        f.number || '—',
        new Date(f.date).toLocaleDateString('es-PA'),
        new Date(f.dueDate).toLocaleDateString('es-PA'),
        fmt(f.amount || f.total || 0),
        `<span style="color:${statusColor[f.status]||'#6b7280'};font-weight:600;font-size:11px">${statusLabel[f.status]||f.status}</span>`
      ];
    });
    det.innerHTML = '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin-top:4px">'+
      buildInformesTable(['N° Factura','Fecha','Vence','Monto','Estado'], rows)+'</div>';
  } catch(e) { det.innerHTML = '<div style="color:#dc2626;padding:8px">Error al cargar</div>'; }
}

/* ── Export helpers ── */
function getInformesExportBar(type) {
  return `<div style="display:flex;gap:6px;margin-bottom:12px">
    <button onclick="exportInforme('${type}','xlsx')" style="padding:5px 12px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📥 Excel</button>
    <button onclick="exportInforme('${type}','csv')" style="padding:5px 12px;font-size:11px;background:#333;color:#fff;border:none;border-radius:4px;cursor:pointer">CSV</button>
  </div>`;
}
function exportInforme(type, format) {
  window.open(`${API_URL}/reports/export/${type}?format=${format}`, '_blank');
}

function buildInformesTable(headers, rows) {
  let h = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>';
  for (const th of headers) h += `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase">${th}</th>`;
  h += '</tr></thead><tbody>';
  for (const row of rows) {
    h += '<tr>';
    for (const td of row) h += `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${td}</td>`;
    h += '</tr>';
  }
  h += '</tbody></table></div>';
  return h;
}

/* ── Panel: Calendario Fiscal (inline) ── */
function loadPanelTaxCalendar() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-taxcalendar-content').classList.remove('hidden');
  loadTaxCalendarInline();
}

async function loadTaxCalendarInline() {
  const el = document.getElementById('taxcalendar-inline-list');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/tax-calendar`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; return; }
    const data = await res.json();
    const overdue = data.overdue || [];
    const upcoming = data.upcoming || [];

    if (!overdue.length && !upcoming.length) {
      el.innerHTML = '<div style="text-align:center;padding:48px;color:#059669;font-size:15px">✅ No hay obligaciones fiscales pendientes</div>';
      return;
    }

    const tipoIcono = { ITBMS: '🧾', ISR: '💰', CSS: '🏥', AVISO: '📋', TASA_UNICA: '📊' };
    const tipoLabel = { ITBMS: 'Declaración ITBMS', ISR: 'Impuesto sobre la Renta', CSS: 'Seguro Social', AVISO: 'Aviso de Operación', TASA_UNICA: 'Tasa Única' };

    function renderCard(o, isOverdue) {
      const due = new Date(o.dueDate);
      const dias = Math.ceil((due - Date.now()) / 86400000);
      const icon = tipoIcono[o.type] || '📌';
      const label = tipoLabel[o.type] || o.type;
      const statusColor = isOverdue ? '#dc2626' : dias <= 7 ? '#f59e0b' : '#059669';
      const statusBg = isOverdue ? '#fef2f2' : dias <= 7 ? '#fffbeb' : '#f0fdf4';
      const badge = isOverdue ? '🔴 Vencida' : dias <= 7 ? '🟡 Próxima' : '🟢 Al día';
      const diasText = isOverdue ? `${Math.abs(dias)} días de retraso` : dias === 0 ? 'Vence hoy' : `${dias} días restantes`;

      return `<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${statusColor};border-radius:10px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px">
        <div style="font-size:32px">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:#1a1a2e">${escHtml(label)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">${escHtml(o.label)}</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap">
            <span style="font-size:12px;color:${statusColor};font-weight:600">📅 ${due.toLocaleDateString('es-PA',{month:'short',day:'numeric',year:'numeric'})}</span>
            <span style="font-size:11px;background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:10px;font-weight:600">${badge} · ${diasText}</span>
            ${o.estimatedAmount ? `<span style="font-size:13px;font-weight:700;color:#1a1a2e">$${o.estimatedAmount.toFixed(2)}</span>` : ''}
          </div>
        </div>
        ${o.status !== 'COMPLETED' ? `<button class="btn-sm" onclick="markTaxObligationComplete('${o.id}')" style="padding:4px 10px;font-size:11px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✅ Marcar</button>` : '<span style="font-size:11px;color:#059669;font-weight:600">✅ Completado</span>'}
      </div>`;
    }

    let html = '';
    if (overdue.length) {
      html += `<div style="margin-bottom:20px"><h3 style="font-size:15px;color:#dc2626;margin:0 0 10px 0">🔴 Vencidas (${overdue.length})</h3>`;
      html += overdue.map(o => renderCard(o, true)).join('');
      html += '</div>';
    }
    if (upcoming.length) {
      html += `<div><h3 style="font-size:15px;color:#1a1a2e;margin:0 0 10px 0">📅 Próximas (${upcoming.length})</h3>`;
      html += upcoming.map(o => renderCard(o, false)).join('');
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

async function markTaxObligationComplete(id) {
  try {
    const res = await authFetch(`${API_URL}/tax-calendar/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    if (res.ok) { loadTaxCalendarInline(); }
  } catch (e) { /* ignore */ }
}
