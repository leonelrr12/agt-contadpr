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

    if (view === 'chat') {
      document.getElementById('panel-tabs-admin').classList.add('hidden');
      return;
    }

    // Admin panels
    if (view === 'panel-cuentas-admin') { loadPanelCuentasAdmin(); }
    else if (view === 'panel-conceptos-admin') { loadPanelConceptosAdmin(); }
    else if (view === 'panel-config') { loadPanelConfig(); }
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
    // Solo desactivar botones dentro del mismo grupo de tabs
    const parentTabs = btn.closest('.panel-tabs');
    parentTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
    const target = document.getElementById('panel-' + btn.dataset.panel);
    if (target) target.classList.add('active');
    else {
      // intentar con sufijo (cuentas-admin, etc.)
      const alt = document.getElementById('panel-' + btn.dataset.panel);
      if (alt) alt.classList.add('active');
    }
    if (btn.dataset.panel === 'diario') diarioPage = 1;
    // Cargar datos del panel admin si aplica
    if (btn.dataset.panel === 'cuentas-admin') loadPanelCuentasAdmin();
    if (btn.dataset.panel === 'conceptos-admin') loadPanelConceptosAdmin();
    if (btn.dataset.panel === 'config') loadPanelConfig();
    // Cargar datos de reportes si aplica
    if (btn.dataset.panel === 'diario') loadPanelDiario();
    if (btn.dataset.panel === 'balance') loadPanelBalance();
    if (btn.dataset.panel === 'resultados') loadPanelResultados();
    if (btn.dataset.panel === 'dashboard') loadPanelDashboard();
    if (btn.dataset.panel === 'revision') loadPanelRevision();
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

async function rechazarAsiento(id) {
  const notes = prompt('Motivo del rechazo (opcional):');
  if (notes === null) return;
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
    addMessage(`❌ Asiento #${id.slice(0,8)} **rechazado**${notes ? ' — Motivo: ' + notes : ''}\n\nPuedes corregir la transacción y volver a enviarla. El creador verá el asiento como **RECHAZADO** en el Diario y podrá re-enviarlo.`, 'assistant');
  } catch (e) {
    await showAlert('Error al rechazar');
    loadPanelRevision();
  }
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
      document.getElementById('admin-section-label').style.display = 'block';
      document.getElementById('nav-cuentas-admin').style.display = 'block';
      document.getElementById('nav-conceptos-admin').style.display = 'block';
      document.getElementById('nav-config').style.display = 'block';
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
