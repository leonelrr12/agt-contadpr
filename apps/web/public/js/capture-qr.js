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

  // Validar rango de año: si la fecha está fuera de rango, usar la del datepicker
  let finalDate = date || null;
  if (finalDate && !isDateInRange(finalDate)) {
    finalDate = captureDate;
    toggleDateWarning(document.getElementById('qr-edit-date'), date);
  }

  dialogContext = {
    type: 'GASTO',
    source: 'pdf',
    amount: total,
    provider: provider,
    date: finalDate,
    itbms: hasItbms,
    itbmsAmount: itbms,
    invoiceNumber: invoiceNumber,
    concept: data.concept || null,
    ruc: ruc,
  };

  let message = '';
  const conceptLabel = (dialogContext.concept && dialogContext.concept !== 'Gastos Varios') ? dialogContext.concept : 'productos';
  if (provider) message += `Compré ${conceptLabel} en ${provider}`;
  else message += `Compré ${conceptLabel}`;
  if (total) message += ` por $${total}`;
  if (ruc) message += ` RUC ${ruc}`;
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

  // Validar rango de año: si la fecha está fuera de rango, usar la del datepicker
  let finalDate = date || null;
  if (finalDate && !isDateInRange(finalDate)) {
    finalDate = captureDate;
    toggleDateWarning(document.getElementById('pdf-edit-date'), date);
  }

  dialogContext = {
    type: 'GASTO',
    source: 'pdf',
    amount: total,
    provider: provider,
    date: finalDate,
    itbms: hasItbms,
    itbmsAmount: itbms,
    invoiceNumber: invoiceNumber,
    concept: data.concept || null,
    ruc: ruc,
  };

  let message = '';
  const conceptLabel = (dialogContext.concept && dialogContext.concept !== 'Gastos Varios') ? dialogContext.concept : 'productos';
  if (provider) message += `Compré ${conceptLabel} en ${provider}`;
  else message += `Compré ${conceptLabel}`;
  if (total) message += ` por $${total}`;
  if (ruc) message += ` RUC ${ruc}`;
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

