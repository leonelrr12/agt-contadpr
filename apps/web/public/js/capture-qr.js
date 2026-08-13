// capture-qr.js (3/14) — QR, finalización de capturas y escapeHtml
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
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="qr-edit-date" value="${data.date || ''}" onchange="toggleDateWarning(this, this.value)"></div>
      <div class="ocr-field"><span>💰 Subtotal:</span><input type="number" step="0.01" id="qr-edit-subtotal" value="${data.subtotal ?? ''}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="qr-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>💰 Total:</span><input type="number" step="0.01" id="qr-edit-total" value="${data.total ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field" style="flex-direction:column;align-items:stretch;gap:4px"><span>📄 Texto:</span><textarea id="qr-edit-text" rows="3" style="width:100%">${escapeHtml((data.text || '').substring(0, 500))}</textarea></div>
    </div>`;
    document.getElementById('qr-result-text').innerHTML = html;
    setTimeout(() => { const el = document.getElementById('qr-edit-date'); if (el) toggleDateWarning(el, el.value); }, 0);
  } catch (err) {
    document.getElementById('qr-loading').classList.add('hidden');
    document.getElementById('qr-actions').classList.remove('hidden');
    await showAlert('Error: ' + err.message);
  }
}

// Colección de campos editables por prefijo de id (qr- / pdf-) + valores del dato extraído
function collectEditFields(prefix, data) {
  return {
    provider: document.getElementById(`${prefix}-edit-provider`)?.value?.trim() || data.provider || '',
    ruc: document.getElementById(`${prefix}-edit-ruc`)?.value?.trim() || data.ruc || '',
    invoiceNumber: document.getElementById(`${prefix}-edit-invoice`)?.value?.trim() || data.invoiceNumber || '',
    date: document.getElementById(`${prefix}-edit-date`)?.value || data.date || '',
    total: parseFloat(document.getElementById(`${prefix}-edit-total`)?.value) || data.total || 0,
    subtotal: parseFloat(document.getElementById(`${prefix}-edit-subtotal`)?.value) || data.subtotal || null,
    itbms: parseFloat(document.getElementById(`${prefix}-edit-itbms`)?.value) || data.itbms || null,
  };
}

// Finaliza un flujo de captura (QR o PDF): valida fecha, arma contexto y mensaje, y envía al chat
async function finalizeCapture(prefix, data) {
  const f = collectEditFields(prefix, data);
  const hasItbms = f.itbms != null && f.itbms > 0;

  // Validar rango de año: si la fecha está fuera de rango, usar la del datepicker
  let finalDate = f.date || null;
  if (finalDate && !isDateInRange(finalDate)) {
    finalDate = captureDate;
    toggleDateWarning(document.getElementById(`${prefix}-edit-date`), f.date);
  }

  dialogContext = {
    type: 'GASTO',
    source: 'pdf',
    amount: f.total,
    provider: f.provider,
    date: finalDate,
    itbms: hasItbms,
    itbmsAmount: f.itbms,
    invoiceNumber: f.invoiceNumber,
    concept: data.concept || null,
    ruc: f.ruc,
  };

  const conceptLabel = (dialogContext.concept && dialogContext.concept !== 'Gastos Varios') ? dialogContext.concept : 'productos';
  let message = f.provider ? `Compré ${conceptLabel} en ${f.provider}` : `Compré ${conceptLabel}`;
  if (f.total) message += ` por $${f.total}`;
  if (f.ruc) message += ` RUC ${f.ruc}`;
  if (f.invoiceNumber) message += `, factura ${f.invoiceNumber}`;
  if (hasItbms && f.subtotal) message += ` (subtotal $${f.subtotal}, ITBMS $${f.itbms})`;

  document.getElementById(`${prefix}-result`).classList.add('hidden');
  document.getElementById(`${prefix}-upload`).classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');

  const input = document.getElementById('message-input');
  input.value = message;
  await sendMessage();
}

async function sendQRResult() {
  if (!qrData) return;
  const data = qrData;
  qrData = null;
  await finalizeCapture('qr', data);
}

async function sendPDFResult() {
  if (!pdfData) return;
  const data = pdfData;
  pdfData = null;
  await finalizeCapture('pdf', data);
}

// Escapado único para HTML (texto y atributos): & < > " '
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

