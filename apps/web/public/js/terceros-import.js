// terceros-import.js — carga masiva de Clientes/Proveedores desde CSV/XLSX.
//
// Vive en Administración → 📥 Carga de Terceros. Primero muestra un preview
// (nuevos, actualizaciones, sin cambios, conflictos y errores) y solo escribe
// cuando el usuario confirma. El backend recalcula el plan al aplicar, para no
// depender de una foto vieja de la BD.

let _tiArchivo = null;
let _tiPlan = null;
let _tiModo = 'completar';

function loadPanelTercerosImport() {
  const el = document.getElementById('terceros-import-content');
  if (!el) return;
  if (!el.dataset.armado) {
    el.innerHTML = `
      <div class="admin-form-card">
        <h4>📥 Carga de Terceros</h4>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0">
          Sube un Excel/CSV con clientes y proveedores mezclados. La columna <strong>TIPO</strong> decide si cada fila va a Cliente o Proveedor.
          Primero verás un preview; nada se guarda hasta confirmar.
        </p>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button onclick="descargarPlantillaTerceros()" style="padding:7px 14px;font-size:12px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">📄 Descargar plantilla</button>
        </div>
        <div id="ti-zone" style="border:2px dashed #d0d5dd;border-radius:12px;padding:24px;text-align:center;background:#f9fafb;cursor:pointer;margin-bottom:12px;transition:background .15s">
          <div style="font-size:28px;margin-bottom:6px">📂</div>
          <h3 style="margin:0 0 6px 0;color:#1a1a2e;font-size:15px">Arrastra tu archivo aquí o haz clic</h3>
          <p style="margin:0;color:#6b7280;font-size:12px">CSV o XLSX · máx. 10 MB · encabezados en la primera fila</p>
          <input type="file" id="ti-file" accept=".csv,.xlsx" style="display:none">
        </div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:12px">
          <span id="ti-file-name" style="font-size:12.5px;color:#374151"></span>
          <label style="font-size:12px;color:#374151;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="ti-modo" value="completar" checked> Completar campos vacíos
          </label>
          <label style="font-size:12px;color:#374151;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
            <input type="radio" name="ti-modo" value="actualizar"> Actualizar con el archivo
          </label>
        </div>
        <div id="ti-alert" class="hidden" style="padding:8px 12px;border-radius:8px;font-size:12.5px;margin-bottom:10px"></div>
        <div id="ti-resumen" class="hidden" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px"></div>
        <div id="ti-preview" class="hidden" style="margin-bottom:12px"></div>
        <div id="ti-actions" class="hidden" style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="ti-apply" style="padding:8px 18px;font-size:13px;background:#059669;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600">📥 Importar</button>
          <button onclick="irATercerosDesdeImport()" style="padding:8px 16px;font-size:13px;background:#e5e7eb;color:#374151;border:none;border-radius:8px;cursor:pointer">👥 Ver Terceros</button>
          <button id="ti-reset" style="padding:8px 16px;font-size:13px;background:#fff;color:#374151;border:1px solid #d1d5db;border-radius:8px;cursor:pointer">✕ Limpiar</button>
        </div>
      </div>`;
    el.dataset.armado = '1';
    eventosTercerosImport(el);
  }
}

function eventosTercerosImport(el) {
  const zone = el.querySelector('#ti-zone');
  const input = el.querySelector('#ti-file');
  zone.onclick = () => input.click();
  zone.ondragover = (e) => { e.preventDefault(); zone.style.background = '#f0f7ff'; };
  zone.ondragleave = () => { zone.style.background = '#f9fafb'; };
  zone.ondrop = (e) => {
    e.preventDefault();
    zone.style.background = '#f9fafb';
    const file = e.dataTransfer?.files?.[0];
    if (file) seleccionarArchivoTerceros(file);
  };
  input.onchange = () => {
    const file = input.files?.[0];
    if (file) seleccionarArchivoTerceros(file);
  };
  el.querySelectorAll('input[name="ti-modo"]').forEach((radio) => {
    radio.onchange = () => {
      if (!radio.checked) return;
      _tiModo = radio.value;
      if (_tiArchivo) previewTerceros();
    };
  });
  el.querySelector('#ti-apply').onclick = aplicarImportTerceros;
  el.querySelector('#ti-reset').onclick = limpiarImportTerceros;
}

function descargarPlantillaTerceros() {
  window.open(`${API_URL}/terceros/import/template?token=${encodeURIComponent(getToken())}`, '_blank');
}

function irATercerosDesdeImport() {
  document.querySelector('#sidebar-nav .nav-link[data-view="panel-terceros"]')?.click();
}

function mostrarAlertaImport(mensaje, tipo = 'error') {
  const el = document.getElementById('ti-alert');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = mensaje;
  el.style.background = tipo === 'error' ? '#fef2f2' : tipo === 'ok' ? '#ecfdf5' : '#eff6ff';
  el.style.color = tipo === 'error' ? '#991b1b' : tipo === 'ok' ? '#065f46' : '#1d4ed8';
  el.style.border = `1px solid ${tipo === 'error' ? '#fecaca' : tipo === 'ok' ? '#a7f3d0' : '#bfdbfe'}`;
}

function ocultarAlertaImport() {
  document.getElementById('ti-alert')?.classList.add('hidden');
}

function seleccionarArchivoTerceros(file) {
  const nombre = String(file?.name || '');
  if (!/\.(csv|xlsx)$/i.test(nombre)) {
    mostrarAlertaImport('Formato no soportado. Usa un archivo .xlsx o .csv.');
    return;
  }
  _tiArchivo = file;
  _tiPlan = null;
  const nameEl = document.getElementById('ti-file-name');
  if (nameEl) nameEl.textContent = `📄 ${nombre}`;
  document.getElementById('ti-preview')?.classList.add('hidden');
  document.getElementById('ti-resumen')?.classList.add('hidden');
  document.getElementById('ti-actions')?.classList.add('hidden');
  ocultarAlertaImport();
  previewTerceros();
}

async function previewTerceros() {
  if (!_tiArchivo) return;
  ocultarAlertaImport();
  const preview = document.getElementById('ti-preview');
  if (preview) {
    preview.classList.remove('hidden');
    preview.innerHTML = '<div style="text-align:center;padding:20px;color:#6b7280">Leyendo archivo...</div>';
  }
  try {
    const fd = new FormData();
    fd.append('file', _tiArchivo);
    fd.append('modo', _tiModo);
    const res = await authFetch(`${API_URL}/terceros/import/preview`, { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      mostrarAlertaImport(data.error || 'No se pudo leer el archivo');
      if (preview) preview.innerHTML = '';
      return;
    }
    _tiPlan = data;
    renderPlanImportTerceros(data);
  } catch (e) {
    mostrarAlertaImport('Error de conexión');
    if (preview) preview.innerHTML = '';
  }
}

function renderPlanImportTerceros(data) {
  const res = data.resumen || {};
  const resumen = document.getElementById('ti-resumen');
  const preview = document.getElementById('ti-preview');
  const actions = document.getElementById('ti-actions');
  if (!resumen || !preview) return;

  const cards = [
    ['Nuevos', res.nuevo || 0, '#059669'],
    ['Actualizan', res.actualiza || 0, '#1565c0'],
    ['Aplicados', res.aplicado || 0, '#047857'],
    ['Sin cambios', res.sin_cambios || 0, '#6b7280'],
    ['Conflictos/Errores', (res.conflicto || 0) + (res.error || 0) + (res.repetida || 0), '#dc2626'],
  ];
  resumen.innerHTML = cards.map(([label, value, color]) =>
    `<div style="background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
      <div style="font-size:20px;font-weight:700;color:${color}">${value}</div>
      <div style="font-size:11px;color:#6b7280">${label}</div>
    </div>`).join('');
  resumen.classList.remove('hidden');

  const estado = (e) => ({
    nuevo: ['🆕 Nuevo', '#059669'],
    actualiza: ['✏️ Actualiza', '#1565c0'],
    sin_cambios: ['— Sin cambios', '#6b7280'],
    conflicto: ['⚠️ Conflicto', '#b45309'],
    error: ['❌ Error', '#dc2626'],
    repetida: ['↩ Repetida', '#6b7280'],
    aplicado: ['✅ Aplicado', '#047857'],
  }[e] || [e, '#6b7280']);

  const filas = (data.filas || []).slice(0, 500).map((f) => {
    const [label, color] = estado(f.estado);
    return [
      String(f.fila),
      escapeHtml(f.tipo || ''),
      escapeHtml(f.name || '—'),
      escapeHtml(f.taxId || '—'),
      escapeHtml(f.dv || '—'),
      `<span style="color:${color};font-weight:600;font-size:11px">${label}</span>`,
      escapeHtml(f.detalle || ''),
    ];
  });
  preview.innerHTML = (data.filas || []).length > 500
    ? `<div style="font-size:11.5px;color:#b45309;margin-bottom:6px">Mostrando las primeras 500 filas de ${data.filas.length}.</div>`
    : '';
  preview.innerHTML += buildInformesTable(
    ['Fila', 'Tipo', 'Nombre', 'RUC', 'DV', 'Estado', 'Detalle'],
    filas,
  );
  preview.classList.remove('hidden');

  const aplicables = (res.nuevo || 0) + (res.actualiza || 0);
  const apply = document.getElementById('ti-apply');
  if (apply) {
    apply.disabled = aplicables === 0;
    apply.style.opacity = aplicables === 0 ? '0.55' : '1';
    apply.style.cursor = aplicables === 0 ? 'not-allowed' : 'pointer';
    apply.textContent = `📥 Importar ${aplicables} fila(s)`;
  }
  actions?.classList.remove('hidden');
}

async function aplicarImportTerceros() {
  if (!_tiArchivo || !_tiPlan) return;
  const res = _tiPlan.resumen || {};
  const aplicables = (res.nuevo || 0) + (res.actualiza || 0);
  if (!aplicables) return;
  const ok = await showConfirm(
    `¿Importar ${aplicables} tercero(s)?\n\n${res.nuevo || 0} nuevo(s) y ${res.actualiza || 0} actualización(es).\n\nLos conflictos y errores no se aplican.`,
  );
  if (!ok) return;

  const btn = document.getElementById('ti-apply');
  if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }
  try {
    const fd = new FormData();
    fd.append('file', _tiArchivo);
    fd.append('modo', _tiModo);
    const response = await authFetch(`${API_URL}/terceros/import/apply`, { method: 'POST', body: fd });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      mostrarAlertaImport(data.error || 'No se pudo importar');
      if (btn) { btn.disabled = false; btn.textContent = `📥 Importar ${aplicables} fila(s)`; }
      return;
    }
    _tiPlan = data;
    renderPlanImportTerceros(data);
    mostrarAlertaImport(`✅ ${data.aplicadas || 0} tercero(s) importado(s). Revisa Terceros.`, 'ok');
  } catch (e) {
    mostrarAlertaImport('Error de conexión');
    if (btn) { btn.disabled = false; btn.textContent = `📥 Importar ${aplicables} fila(s)`; }
  }
}

function limpiarImportTerceros() {
  _tiArchivo = null;
  _tiPlan = null;
  const input = document.getElementById('ti-file');
  if (input) input.value = '';
  const nameEl = document.getElementById('ti-file-name');
  if (nameEl) nameEl.textContent = '';
  document.getElementById('ti-resumen')?.classList.add('hidden');
  document.getElementById('ti-preview')?.classList.add('hidden');
  document.getElementById('ti-actions')?.classList.add('hidden');
  ocultarAlertaImport();
}
