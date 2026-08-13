// core.js (1/14) — auth, dialogs, estado de captura, utilidades compartidas
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

// ── Capture Date (persistente entre registros) ──
// Usar fecha local sin pasar por toISOString (que usa UTC) para evitar cambio de día
const _now = new Date();
let captureDate = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
let dateBannerShown = false;

function formatDateForDisplay(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

// ── Validación de rango de año ──
function getYearRange() {
  const currentYear = new Date().getFullYear();
  return { min: currentYear - 1, max: currentYear + 1 };
}

function isDateInRange(dateStr) {
  if (!dateStr) return false;
  const parts = dateStr.split('-');
  if (parts.length !== 3) return false;
  const y = parseInt(parts[0]);
  const { min, max } = getYearRange();
  return y >= min && y <= max;
}

/** Muestra/oculta alerta de fecha fuera de rango junto a un input date. */
function toggleDateWarning(inputEl, dateStr) {
  if (!inputEl) return;
  const container = inputEl.closest('.ocr-field');
  if (!container) return;
  // Quitar warning existente
  const existing = container.querySelector('.date-range-warning');
  if (existing) existing.remove();

  if (dateStr && !isDateInRange(dateStr)) {
    const { min, max } = getYearRange();
    const warning = document.createElement('span');
    warning.className = 'date-range-warning';
    warning.textContent = `⚠️ Fuera de rango (${min}-${max}). Se usará la fecha del selector.`;
    container.appendChild(warning);
    inputEl.style.borderColor = '#f59e0b';
    inputEl.style.background = '#fffbeb';
  } else {
    inputEl.style.borderColor = '';
    inputEl.style.background = '';
  }
}

function showDateBanner() {
  if (dateBannerShown) return;
  dateBannerShown = true;
  const banner = document.getElementById('capture-date-banner');
  const bannerDate = document.getElementById('capture-date-banner-date');
  if (banner) {
    if (bannerDate) bannerDate.textContent = formatDateForDisplay(captureDate);
    banner.classList.remove('hidden');
  }
}

function dismissDateBanner() {
  const banner = document.getElementById('capture-date-banner');
  if (banner) banner.classList.add('hidden');
}

// Tag de estado único para asientos (diario, informes, revisión)
function statusTag(status, reviewNotes = '') {
  const classes = { BORRADOR: 'tag-draft', CONFIRMADO: 'tag-conf', RECHAZADO: 'tag-rejected', ANULADO: 'tag-void' };
  const title = status === 'RECHAZADO' && reviewNotes ? ` title="${escapeHtml(reviewNotes)}"` : '';
  return `<span class="tag ${classes[status] || ''}"${title}>${status}</span>`;
}

// Cuentas de detalle (excluye raíces) ordenadas por código numérico — compartido auxiliar/informes
function detailAccounts(accounts) {
  return (accounts || [])
    .filter(a => a.code.split('.').length >= 2)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}
let pendingClassification = null;

function showInput(mode, keepContext = false) {
  stopQRScanner();
  // Limpiar contexto solo al iniciar un registro nuevo, no en follow-ups
  if (!keepContext) {
    dialogContext = null;
    pendingResult = null;
    pendingClassification = null;
  }
  // PDF no oculta quick-actions (el diálogo de archivo es nativo, si cancela vuelve)
  if (mode !== 'pdf') {
    document.getElementById('quick-actions').classList.add('hidden');
  }
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
    document.getElementById('pdf-result').classList.add('hidden');
    document.getElementById('pdf-result-text').innerHTML = '';
    document.getElementById('pdf-file-input').value = '';
    pdfData = null;
    // Detectar si el usuario cancela el diálogo de archivos
    const onFocus = () => {
      window.removeEventListener('focus', onFocus);
      setTimeout(() => {
        if (!pdfData && document.getElementById('pdf-file-input').files.length === 0) {
          // Usuario canceló — restaurar menú DGI
          document.getElementById('dgi-menu').classList.remove('hidden');
        }
      }, 300);
    };
    window.addEventListener('focus', onFocus);
    document.getElementById('pdf-file-input').click();
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
  // Mostrar recordatorio de fecha al abrir el input de captura
  showDateBanner();
}

function cancelInput() {
  document.getElementById('text-input').classList.add('hidden');
  document.getElementById('quick-actions').classList.remove('hidden');
  document.getElementById('message-input').value = '';
  // NOTA: no limpiar dialogContext ni pendingResult aquí.
  // showEntityMatchSelector y needsConfirmation dependen de que persistan.
}

