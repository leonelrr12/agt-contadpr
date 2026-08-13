// capture.js (2/14) — captura OCR, PDF y menú DGI
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
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="ocr-edit-date" value="${data.date || ''}" onchange="toggleDateWarning(this, this.value)"></div>
      <div class="ocr-field"><span>🏢 Proveedor:</span><input type="text" id="ocr-edit-provider" value="${escapeHtml(data.provider || '')}"></div>
      <div class="ocr-field"><span>🔢 RUC:</span><input type="text" id="ocr-edit-ruc" value="${escapeHtml(data.ruc || '')}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="ocr-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field"><span>🤖 Motor:</span><strong>${data.source === 'tesseract+llm' ? 'Tesseract + DeepSeek' : 'Tesseract'}</strong></div>
      <button class="ocr-toggle-img" onclick="toggleOCRImage()" style="margin-top:8px;font-size:12px;padding:6px 12px;background:none;border:1px solid #d0d5dd;border-radius:4px;cursor:pointer;color:#1a1a2e;width:100%">📷 Ver imagen</button>
    </div>`;
    document.getElementById('ocr-result-text').innerHTML = html;
    if (data.concept) {
      const conceptDiv = document.createElement('div'); conceptDiv.className = 'ocr-field';
      conceptDiv.innerHTML = '<span>📂 Concepto:</span><strong>' + escapeHtml(data.concept) + '</strong>';
      document.getElementById('ocr-result-text').querySelector('.ocr-extracted').appendChild(conceptDiv);
    }
    setTimeout(() => { const el = document.getElementById('ocr-edit-date'); if (el) toggleDateWarning(el, el.value); }, 0);
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

  // Validar rango de año: si la fecha está fuera de rango, usar la del datepicker
  let finalDate = data.date || null;
  if (finalDate && !isDateInRange(finalDate)) {
    finalDate = captureDate;
    toggleDateWarning(document.getElementById('ocr-edit-date'), data.date);
  }

  dialogContext = {
    type: 'GASTO',
    source: 'ocr',
    amount: total || 0,
    provider: provider,
    date: finalDate,
    itbms: data.itbms != null,
    itbmsAmount: data.itbms || null,
    concept: data.concept || null,
  };

  const parts = [];
  const conceptLabel = (dialogContext.concept && dialogContext.concept !== 'Gastos Varios') ? dialogContext.concept : 'productos';
  if (provider) parts.push(`Compré ${conceptLabel} en ${provider}`);
  else parts.push(`Compré ${conceptLabel}`);
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
  if (e.target.files[0]) handlePDFFile(e.target.files[0]);
});

function handlePDFFile(file) {
  if (!file) return;
  document.getElementById('pdf-upload').classList.remove('hidden');
  document.getElementById('pdf-actions').classList.add('hidden');
  document.getElementById('pdf-loading').classList.remove('hidden');
  document.getElementById('quick-actions').classList.add('hidden');
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
      <div class="ocr-field"><span>📅 Fecha:</span><input type="date" id="pdf-edit-date" value="${data.date || ''}" onchange="toggleDateWarning(this, this.value)"></div>
      <div class="ocr-field"><span>💰 Subtotal:</span><input type="number" step="0.01" id="pdf-edit-subtotal" value="${data.subtotal ?? ''}"></div>
      <div class="ocr-field"><span>📊 ITBMS:</span><input type="number" step="0.01" id="pdf-edit-itbms" value="${data.itbms ?? ''}"></div>
      <div class="ocr-field"><span>💰 Total:</span><input type="number" step="0.01" id="pdf-edit-total" value="${data.total ?? ''}"></div>
      <div class="ocr-field"><span>🎯 Confianza:</span><strong>${(data.confidence * 100).toFixed(0)}%</strong></div>
      <div class="ocr-field"><span>🤖 Motor:</span><strong>${data.source === 'pdf-parse+llm' ? 'PDF + DeepSeek' : 'PDF'}</strong></div>
      <div class="ocr-field" style="flex-direction:column;align-items:stretch;gap:4px"><span>📄 Texto extraído:</span><textarea id="pdf-edit-text" rows="3" style="width:100%">${escapeHtml(data.text.substring(0, 500))}</textarea></div>
    </div>`;
    document.getElementById('pdf-result-text').innerHTML = html;
    if (data.concept) {
      const conceptDiv = document.createElement('div'); conceptDiv.className = 'ocr-field';
      conceptDiv.innerHTML = '<span>📂 Concepto:</span><strong>' + escapeHtml(data.concept) + '</strong>';
      document.getElementById('pdf-result-text').querySelector('.ocr-extracted').appendChild(conceptDiv);
    }
    setTimeout(() => { const el = document.getElementById('pdf-edit-date'); if (el) toggleDateWarning(el, el.value); }, 0);
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

