// conciliacion.js — Conciliación bancaria (panel del SPA y página suelta).
//
// Un solo markup y una sola lógica para los dos shells:
//   · SPA (index.html): router.js muestra #panel-conciliacion-content y llama a
//     loadPanelConciliacion(). El panel vive dentro de <main>, como los demás.
//   · /conciliacion.html: página suelta que monta el mismo panel y llama a
//     loadPanelConciliacion() al cargar (quedó para los enlaces viejos).
//
// No declara API_URL: en el SPA lo define core.js (un `const` global) y la página
// suelta no lo necesita. Declararlo acá chocaría con core.js.

const CONC_API = typeof API_URL === 'string' ? API_URL : '/api';

/** El panel se arma UNA vez: reabrirlo solo refresca cuentas e historial. */
let conciliacionRenderizada = false;
/** Extracto abierto (el detalle), o null si se está en la pantalla de subida. */
let currentStatement = null;
/** Catálogo de cuentas (GET /api/accounts) para resolver códigos a ids. */
let cuentasCatalogo = [];
/** Asientos del libro sin conciliar del último detalle (candidatos del vinculador). */
let currentUnmatchedBooks = [];
/** Fila del extracto que se está vinculando, y las partidas elegidas (lineId → monto). */
let vinculando = null;
let candidatos = [];
const seleccion = new Map();
/** Fila del extracto para la que se está creando el asiento que falta. */
let filaCreando = null;

/**
 * Muestra el panel: arma el markup la primera vez y refresca los datos que
 * cambian entre visitas (cuentas nuevas, extractos subidos desde otra pestaña).
 */
function loadPanelConciliacion() {
  const el = document.getElementById('panel-conciliacion-content');
  if (!el) return;
  if (!conciliacionRenderizada) {
    el.innerHTML = conciliacionHTML();
    conciliacionRenderizada = true;
    eventosDropZone();
    // El «?» va al lado del título, como en la página suelta (ayudaEnCabecera
    // ya lo sabe hacer); agregarlo al mapa del SPA lo borraría el innerHTML.
    const h1 = el.querySelector('h1');
    if (h1) ayudaEnCabecera(h1, 'conciliacion');
  }
  loadBankAccounts();
  loadHistory();
}

/** El markup del panel. Se genera una vez por carga de pantalla. */
function conciliacionHTML() {
  // La página suelta conserva los atajos al chat; dentro del SPA sobran (el menú
  // ya está al lado y /index.html recargaría la app entera).
  const enSpa = !!document.getElementById('main');
  return `
<div class="reconcile-container">
  <div class="reconcile-header">
    <h1>🏦 Conciliación Bancaria</h1>
    <p>Sube tu extracto bancario o el estado de tu tarjeta de crédito (CSV/XLSX). El sistema matchea automáticamente contra los asientos registrados en esa cuenta.</p>
    ${enSpa ? '' : '<p style="margin-top:8px"><a href="/index.html" style="color:#1565c0;text-decoration:none;font-size:14px">← Volver al Chat</a></p>'}
  </div>

  <!-- Paso 1: Seleccionar cuenta y subir -->
  <div id="step-upload">
    <div class="form-grid" style="margin-bottom:16px">
      <div style="grid-column:1/-1">
        <label>🏦 Cuenta bancaria o tarjeta</label>
        <select id="bank-account-select">
          <option value="">Cargando cuentas...</option>
        </select>
      </div>
    </div>
    <div class="upload-zone" id="drop-zone">
      <div class="upload-zone-icon">🏦</div>
      <h3>Arrastra tu extracto aquí o haz clic para seleccionar</h3>
      <p>Formatos aceptados: CSV/XLSX del banco o del estado de la tarjeta (Banco General, Banistmo, etc.)</p>
      <input type="file" id="file-input" accept=".csv,.xlsx" style="display:none">
    </div>
  </div>

  <!-- Paso 2: Loading -->
  <div id="step-loading" class="loading hidden">
    <div class="spinner"></div>
    <p>Procesando extracto y buscando coincidencias...</p>
  </div>

  <!-- Paso 3: Detalle de conciliación -->
  <div id="step-detail" class="hidden">
    <div class="summary-cards" id="summary-cards"></div>
    <div id="aviso-conciliacion" class="hidden" style="padding:10px 14px;border-radius:8px;font-size:13px;margin-bottom:16px"></div>

    <div class="section">
      <div class="section-title section-matched">✅ Partidas Conciliadas</div>
      <div style="overflow-x:auto">
        <table class="data-table" id="matched-table">
          <thead><tr><th>Fecha</th><th>Descripción</th><th>Monto</th><th>Partidas del libro</th><th>Confianza</th><th></th></tr></thead>
          <tbody id="matched-tbody"></tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title section-unmatched">❌ Sin Conciliar — Extracto Bancario</div>
      <div style="overflow-x:auto">
        <table class="data-table" id="unmatched-table">
          <thead><tr><th>Fecha</th><th>Descripción</th><th>Ref</th><th>Débito</th><th>Crédito</th><th></th></tr></thead>
          <tbody id="unmatched-tbody"></tbody>
        </table>
      </div>
    </div>

    <div class="section">
      <div class="section-title section-book">📋 Sin Conciliar — Libros Contables (no en extracto)</div>
      <div style="overflow-x:auto">
        <table class="data-table" id="book-table">
          <thead><tr><th>Fecha</th><th>Descripción</th><th>Cuenta</th><th>Débito</th><th>Crédito</th></tr></thead>
          <tbody id="book-tbody"></tbody>
        </table>
      </div>
    </div>

    <div class="actions-bar">
      <button class="btn btn-primary" id="btn-rematch" onclick="rematchStatement()">🔄 Volver a conciliar</button>
      <button class="btn btn-secondary" onclick="resetView()">🆕 Nueva conciliación</button>
      <button class="btn btn-danger" onclick="eliminarExtracto()">🗑 Eliminar extracto</button>
      ${enSpa ? '' : '<a href="/index.html" class="btn btn-secondary" style="text-decoration:none">💬 Ir al Chat</a>'}
    </div>

    <!-- Vinculador: la fila del extracto contra una o varias partidas del libro -->
    <div id="pick-overlay" class="hidden" onclick="if (event.target === this) cerrarVinculador()">
      <div id="pick-card">
        <div id="pick-head"></div>
        <div id="pick-lista"></div>
        <div id="pick-pie"></div>
      </div>
    </div>

    <!-- Crear el asiento que falta: la fila está en el banco y no en libros. El lado
         del extracto ya se conoce, así que el contador elige UNA cuenta. -->
    <div id="entry-overlay" class="hidden" onclick="if (event.target === this) cerrarFormularioAsiento()">
      <div id="entry-card">
        <div id="entry-head"></div>
        <div id="entry-body">
          <div>
            <label for="e-descripcion">Descripción del asiento</label>
            <input type="text" id="e-descripcion" maxlength="200">
          </div>
          <div class="banco" id="e-banco"></div>
          <div style="margin-top:16px">
            <label for="e-contrapartida" id="e-etiqueta">La otra cuenta</label>
            <input type="text" class="buscar" id="e-buscar" placeholder="Filtrar por código o nombre…" oninput="filtrarContrapartidas()">
            <select id="e-contrapartida" size="7"></select>
            <div class="lado" id="e-lado"></div>
          </div>
          <div class="manual">
            ¿El asiento lleva más de dos cuentas (ITBMS, retenciones, varios conceptos)? Hacelo desde
            ${enSpa
              ? '<button type="button" class="conc-link" onclick="irARevisionDesdeConciliacion()">Revisión → ➕ Asiento Manual</button>'
              : '<a href="/index.html">Revisión → ➕ Asiento Manual</a>'}, que acepta el asiento completo.
          </div>
        </div>
        <div id="entry-pie">
          <button class="btn btn-secondary" onclick="cerrarFormularioAsiento()">Cancelar</button>
          <button class="btn btn-primary" id="e-crear" onclick="crearAsientoDesdeFila()">Crear asiento</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Statement history -->
  <div id="step-history" style="margin-top:40px">
    <h3 style="margin-bottom:16px">📋 Conciliaciones anteriores</h3>
    <div id="history-list"></div>
  </div>
</div>`;
}

/** Drag & drop del extracto. Se engancha una sola vez, al armar el panel. */
function eventosDropZone() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');
  if (!dropZone || !fileInput) return;
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) uploadFile(file);
  });
}

// Load bank accounts
async function loadBankAccounts() {
  const select = document.getElementById('bank-account-select');
  if (!select) return;
  // Reabrir el panel no puede cambiar la cuenta que el contador venía usando.
  const previo = select.value;
  try {
    const res = await authFetch(`${CONC_API}/accounts`);
    const accounts = await res.json();
    cuentasCatalogo = Array.isArray(accounts) ? accounts : [];
    // Bancos (1.1.02.*) y tarjetas de crédito (2.1.03.*): el estado de la
    // tarjeta se concilia con el mismo motor — el cargo es un crédito al pasivo
    // en libros, así que el par de signos es el mismo que el del banco.
    //
    // Solo cuentas HOJA (el endpoint trae `children`): el nodo padre 1.1.02 no
    // es conciliable por sí solo. Antes se descartaba con `!code.endsWith('.02')`,
    // que sacaba al padre pero se llevaba puesta la cuenta 1.1.02.02, una hoja
    // legítima — por eso el extracto de Banistmo no aparecía en el selector.
    const conciliables = cuentasCatalogo.filter(a => a.code
      && (a.code.startsWith('1.1.02') || a.code.startsWith('2.1.03'))
      && !(a.children || []).length);
    select.innerHTML = conciliables.length > 0
      ? conciliables.map(a => `<option value="${a.id}">${a.code} — ${a.name}</option>`).join('')
      : '<option value="">No hay cuentas de banco ni tarjetas configuradas</option>';
    if (conciliables.some(a => a.id === previo)) select.value = previo;
  } catch (e) {
    select.innerHTML = '<option value="">Error al cargar cuentas</option>';
  }
}

// Load history
async function loadHistory() {
  try {
    const res = await authFetch(`${CONC_API}/reconcile`);
    if (!res.ok) return;
    const statements = await res.json();

    if (!statements.length) {
      document.getElementById('history-list').innerHTML = '<div style="color:#6b7280;text-align:center;padding:16px">No hay conciliaciones anteriores</div>';
      return;
    }

    let html = '<div style="display:flex;flex-direction:column;gap:8px">';
    for (const s of statements) {
      const pct = s.totalRows > 0 ? Math.round(s.matchedCount / s.totalRows * 100) : 0;
      // El extracto que está abierto se marca: la grilla queda a la vista debajo del
      // detalle y sin la marca no se sabe en cuál se está parado.
      const abierta = currentStatement?.id === s.id;
      html += `<div style="background:${abierta ? '#eff6ff' : '#fff'};border:1px solid ${abierta ? '#1565c0' : '#e5e7eb'};border-left:5px solid ${abierta ? '#1565c0' : '#e5e7eb'};border-radius:8px;padding:12px;display:flex;justify-content:space-between;align-items:center;cursor:pointer" onclick="loadStatement('${s.id}')">
        <div>
          <strong>${esc(s.bankAccount?.name || 'Banco')}</strong>
          ${abierta ? '<span class="badge badge-abierta">abierta</span>' : ''}
          <span style="color:#6b7280;font-size:12px;margin-left:8px">${s.fileName || 'CSV'}</span>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">${new Date(s.uploadDate).toLocaleDateString('es-PA')} • ${s.matchedCount}/${s.totalRows} conciliados (${pct}%)</div>
        </div>
        <span class="badge ${pct === 100 ? 'badge-ok' : pct > 50 ? 'badge-warn' : 'badge-err'}">${pct}%</span>
      </div>`;
    }
    html += '</div>';
    document.getElementById('history-list').innerHTML = html;
  } catch (e) { /* silent */ }
}

async function uploadFile(file) {
  const bankAccountId = document.getElementById('bank-account-select').value;
  if (!bankAccountId) { showAlert('Seleccioná primero la cuenta bancaria o la tarjeta a conciliar.'); return; }

  document.getElementById('step-upload').classList.add('hidden');
  document.getElementById('step-detail').classList.add('hidden');
  document.getElementById('step-loading').classList.remove('hidden');

  const formData = new FormData();
  formData.append('file', file);
  formData.append('bankAccountId', bankAccountId);

  try {
    const res = await authFetch(`${CONC_API}/reconcile/upload`, { method: 'POST', body: formData });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
    const data = await res.json();

    document.getElementById('step-loading').classList.add('hidden');
    renderDetail(data);
  } catch (e) {
    showAlert('No se pudo subir el extracto: ' + esc(e.message));
    resetView();
  }
}

async function loadStatement(id) {
  document.getElementById('step-upload').classList.add('hidden');
  document.getElementById('step-loading').classList.remove('hidden');

  try {
    const res = await authFetch(`${CONC_API}/reconcile/${id}`);
    const data = await res.json();
    document.getElementById('step-loading').classList.add('hidden');
    renderDetail(data);
  } catch (e) {
    showAlert('No se pudo cargar el extracto: ' + esc(e.message));
    resetView();
  }
}

function renderDetail(data) {
  const { statement, unmatchedBooks, summary } = data;
  currentStatement = statement;
  currentUnmatchedBooks = unmatchedBooks || [];
  cerrarVinculador();

  document.getElementById('step-detail').classList.remove('hidden');

  // Summary
  document.getElementById('summary-cards').innerHTML = `
    <div class="summary-card ok"><div class="num">${summary.matched}</div><div class="label">Conciliados ✅</div></div>
    <div class="summary-card err"><div class="num">${summary.unmatched}</div><div class="label">Sin conciliar (extracto)</div></div>
    <div class="summary-card warn"><div class="num">${summary.unmatchedBookCount}</div><div class="label">Sin conciliar (libros)</div></div>
    <div class="summary-card"><div class="num">${summary.total}</div><div class="label">Total extracto</div></div>
  `;

  // Casi nada conciliado es la señal de que el archivo es de OTRA cuenta: el
  // matcher solo mira la cuenta elegida en el selector, y con un archivo de otro
  // banco (o de otra cuenta de la misma empresa) el resultado es esto — 2 de 49 —
  // sin ninguna pista de por qué. Pasó el 12-10 con el estado de 2810-1 (1.1.02.02)
  // subido como 6305-5 (1.1.02.03).
  const aviso = document.getElementById('aviso-conciliacion');
  const pocas = summary.total >= 10 && summary.matched / summary.total < 0.2;
  aviso.className = pocas ? 'section-title section-unmatched' : 'hidden';
  aviso.textContent = pocas
    ? `⚠️ Solo ${summary.matched} de ${summary.total} filas conciliaron. Revisá que la cuenta elegida sea la de ESTE archivo: el match es solo contra los asientos de esa cuenta.`
    : '';

  // Matched
  const matchedRows = statement.rows.filter(r => r.status === 'MATCHED');
  let mHtml = '';
  if (matchedRows.length === 0) {
    mHtml = '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:16px">No hay partidas conciliadas</td></tr>';
  } else {
    for (const r of matchedRows) {
      const partes = (r.matches || []);
      const etiqueta = partes.length > 1
        ? `<span class="badge badge-neutral">${partes.length} partidas</span>`
        : (r.matchedEntry ? `<span style="font-size:11px">${r.matchedEntry.id.slice(0, 8)}...</span>` : '—');
      mHtml += `<tr>
        <td>${new Date(r.date).toLocaleDateString('es-PA')}</td>
        <td>${esc(r.description)}</td>
        <td>${r.debit > 0 ? '$' + r.debit.toFixed(2) : r.credit > 0 ? '$' + r.credit.toFixed(2) : '—'}</td>
        <td>${etiqueta}</td>
        <td><span class="badge badge-ok">${(r.matchConfidence * 100).toFixed(0)}%</span></td>
        <td style="white-space:nowrap">
          <button class="btn btn-secondary btn-sm" onclick="abrirVinculador('${r.id}')">🔗 Partidas</button>
          <button class="btn btn-secondary btn-sm" onclick="unmatchRow('${r.id}')">Desvincular</button>
        </td>
      </tr>`;
    }
  }
  document.getElementById('matched-tbody').innerHTML = mHtml;

  // Unmatched bank
  const unmatchedRows = statement.rows.filter(r => r.status !== 'MATCHED');
  let uHtml = '';
  if (unmatchedRows.length === 0) {
    uHtml = '<tr><td colspan="6" style="text-align:center;color:#6b7280;padding:16px">¡Todas las partidas conciliadas!</td></tr>';
  } else {
    for (const r of unmatchedRows) {
      uHtml += `<tr>
        <td>${new Date(r.date).toLocaleDateString('es-PA')}</td>
        <td>${esc(r.description)}</td>
        <td>${r.reference || '—'}</td>
        <td>${r.debit > 0 ? '$' + r.debit.toFixed(2) : '—'}</td>
        <td>${r.credit > 0 ? '$' + r.credit.toFixed(2) : '—'}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-secondary btn-sm" onclick="abrirVinculador('${r.id}')">🔗 Vincular</button>
          <button class="btn btn-primary btn-sm" onclick="abrirFormularioAsiento('${r.id}')">+ Crear asiento</button>
        </td>
      </tr>`;
    }
  }
  document.getElementById('unmatched-tbody').innerHTML = uHtml;

  // Unmatched books
  let bHtml = '';
  if (unmatchedBooks.length === 0) {
    bHtml = '<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:16px">No hay partidas de libro sin conciliar en este período</td></tr>';
  } else {
    for (const e of unmatchedBooks.slice(0, 20)) {
      const bankLine = e.lines[0];
      bHtml += `<tr>
        <td>${new Date(e.date).toLocaleDateString('es-PA')}</td>
        <td>${esc(e.description)}</td>
        <td>${bankLine?.account?.name || '—'}</td>
        <td>${bankLine?.debit > 0 ? '$' + bankLine.debit.toFixed(2) : '—'}</td>
        <td>${bankLine?.credit > 0 ? '$' + bankLine.credit.toFixed(2) : '—'}</td>
      </tr>`;
    }
    if (unmatchedBooks.length > 20) {
      bHtml += `<tr><td colspan="5" style="text-align:center;color:#6b7280">... y ${unmatchedBooks.length - 20} más</td></tr>`;
    }
  }
  document.getElementById('book-tbody').innerHTML = bHtml;

  // La grilla de extractos de arriba se refresca acá, en el único sitio por el que
  // pasan TODAS las acciones que la cambian (subir, volver a conciliar, vincular,
  // desvincular): sin esto el extracto recién subido no aparecía en la lista —ni se
  // movían los porcentajes— hasta refrescar la página a mano.
  loadHistory();

  // Scroll to detail
  document.getElementById('step-detail').scrollIntoView({ behavior: 'smooth' });
}

/**
 * Vuelve a correr el matcher sobre el extracto YA cargado.
 *
 * El matching corre una sola vez, en la subida: si se corrige un criterio, si
 * el contador registra los asientos que faltaban o si quedaron emparejamientos
 * repetidos, había que borrar el extracto y volver a subirlo.
 */
async function rematchStatement() {
  if (!currentStatement) return;
  const btn = document.getElementById('btn-rematch');
  const texto = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ Conciliando...';
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}/rematch`, { method: 'POST' });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
    const data = await res.json();
    renderDetail(data);
    const r = data.rematch || {};
    const partes = [];
    if (r.nuevas) partes.push(`${r.nuevas} fila(s) conciliada(s)`);
    if (r.liberadas) partes.push(`${r.liberadas} repetida(s) liberada(s)`);
    if (r.vinculos) partes.push(`${r.vinculos} vínculo(s) reconstruido(s)`);
    showAlert(partes.length
      ? `✅ Listo: ${partes.join(' · ')}.`
      : '🔎 Sin cambios: no quedaron filas nuevas por conciliar.<br><br>Si esperabas más, revisá que la cuenta elegida sea la del archivo (el match es solo contra los asientos de esa cuenta).');
  } catch (e) {
    showAlert('No se pudo volver a conciliar: ' + esc(e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = texto;
  }
}

/**
 * Borra el extracto cargado (y con él sus filas y vínculos: la FK cascadea).
 *
 * Es la salida cuando el extracto se subió contra la cuenta equivocada —el
 * matcher solo mira la cuenta elegida, así que un archivo de otro banco queda
 * casi entero "sin conciliar" y no hay forma de reasignarlo.
 */
async function eliminarExtracto() {
  if (!currentStatement) return;
  const archivo = currentStatement.fileName || 'el extracto';
  const ok = await showConfirm(`¿Eliminar «${esc(archivo)}» y sus ${currentStatement.rows.length} filas?<br><br>Esta acción no se puede deshacer.`);
  if (!ok) return;
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}`, { method: 'DELETE' });
    if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
    // `resetView()` ya vuelve a pintar la grilla: el extracto borrado desaparece y, si
    // hubiera quedado marcado como abierto, se le cae la marca.
    resetView();
  } catch (e) { showAlert('Error: ' + esc(e.message)); }
}

async function unmatchRow(rowId) {
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId, entryId: null }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'No se pudo desvincular');
    renderDetail(body);
  } catch (e) { showAlert('Error: ' + esc(e.message)); }
}

/**
 * Vinculador: una fila del extracto contra UNA O VARIAS partidas del libro.
 *
 * El matcher empareja una línea contra una fila y por monto exacto, así que un
 * depósito que cobra varias facturas de una vez (el ACH de Inmobiliaria Don
 * Antonio del 20-feb: cuatro facturas por $17.353,68) no tiene contra qué
 * conciliarse solo. Acá el contador arma el vínculo y la suma tiene que dar.
 */
function abrirVinculador(rowId) {
  const row = (currentStatement?.rows || []).find(r => r.id === rowId);
  if (!row) return;
  vinculando = row;
  seleccion.clear();

  const esEntrada = (row.credit || 0) > 0; // entra plata al banco
  const montoFila = esEntrada ? row.credit : row.debit;

  // Las partidas ya vinculadas a esta fila van primero —para poder editarlas—;
  // las demás salen de los asientos sin conciliar de la cuenta del extracto.
  const ya = (row.matches || []).map(m => ({
    lineId: m.lineId, date: m.entry?.date, descripcion: m.entry?.description,
    disponible: esEntrada ? (m.line?.debit || 0) : (m.line?.credit || 0), ya: true,
  }));
  const libres = [];
  for (const e of currentUnmatchedBooks) {
    for (const l of (e.lines || [])) {
      const disponible = esEntrada ? l.debit : l.credit;
      if (!(disponible > 0)) continue; // la partida está del otro lado de la fila
      libres.push({ lineId: l.id, date: e.date, descripcion: e.description, disponible, ya: false });
    }
  }
  candidatos = [...ya, ...libres];
  for (const m of row.matches || []) seleccion.set(m.lineId, Math.round(m.amount * 100) / 100);

  document.getElementById('pick-head').innerHTML = `
    <h3>🔗 Vincular partidas del libro</h3>
    <div class="fila"><b>${esc(row.description)}</b> · ${new Date(row.date).toLocaleDateString('es-PA')} · ${esEntrada ? 'entrada' : 'salida'} de <b>$${montoFila.toFixed(2)}</b></div>
    <input class="buscar" id="pick-buscar" placeholder="Buscar partida por descripción..." oninput="renderLista()">`;
  document.getElementById('pick-overlay').classList.remove('hidden');
  renderLista();
  document.getElementById('pick-buscar').focus();
}

function renderLista() {
  const row = vinculando;
  if (!row) return;
  const esEntrada = (row.credit || 0) > 0;
  const montoFila = esEntrada ? row.credit : row.debit;
  const q = (document.getElementById('pick-buscar')?.value || '').trim().toLowerCase();
  const visibles = candidatos.filter(c => !q || String(c.descripcion || '').toLowerCase().includes(q));

  let html = '<table><thead><tr><th style="width:34px"></th><th>Fecha</th><th>Partida del libro</th><th class="num">Monto</th><th class="num">Aplicar</th></tr></thead><tbody>';
  if (!visibles.length) {
    html += '<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:16px">No hay partidas sin conciliar que coincidan con la búsqueda.</td></tr>';
  }
  for (const c of visibles) {
    const marcada = seleccion.has(c.lineId);
    html += `<tr class="${c.ya ? 'ya' : ''}">
      <td><input type="checkbox" ${marcada ? 'checked' : ''} onchange="toggleLinea('${c.lineId}')"></td>
      <td>${c.date ? new Date(c.date).toLocaleDateString('es-PA') : '—'}</td>
      <td>${esc(c.descripcion)}${c.ya ? ' <span class="badge badge-ok">vinculada</span>' : ''}</td>
      <td class="num">$${c.disponible.toFixed(2)}</td>
      <td class="num">${marcada ? `<input type="number" step="0.01" min="0" value="${seleccion.get(c.lineId).toFixed(2)}" onchange="cambiarMonto('${c.lineId}', this.value)">` : '—'}</td>
    </tr>`;
  }
  html += '</tbody></table>';
  document.getElementById('pick-lista').innerHTML = html;

  const total = Math.round([...seleccion.values()].reduce((s, v) => s + v, 0) * 100) / 100;
  const dif = Math.round((total - montoFila) * 100) / 100;
  const cuadra = Math.abs(dif) <= 0.02;
  const estado = cuadra ? 'ok' : (dif < 0 ? 'falta' : 'sobra');
  const detalle = cuadra ? 'Cuadra ✔' : (dif < 0 ? `Faltan $${Math.abs(dif).toFixed(2)}` : `Sobra $${dif.toFixed(2)}`);
  document.getElementById('pick-pie').innerHTML = `
    <div class="cuadre ${estado}">Fila: <b>$${montoFila.toFixed(2)}</b> · Seleccionado: <b>$${total.toFixed(2)}</b> · <b>${detalle}</b></div>
    <div class="acciones">
      ${(row.matches || []).length ? '<button class="btn btn-secondary" onclick="quitarVinculo()">Quitar vínculo</button>' : ''}
      <button class="btn btn-secondary" onclick="cerrarVinculador()">Cancelar</button>
      <button class="btn btn-primary" id="btn-guardar-vinculo" ${cuadra && seleccion.size ? '' : 'disabled'} onclick="guardarVinculo()">Guardar vínculo</button>
    </div>`;
}

function toggleLinea(lineId) {
  const c = candidatos.find(x => x.lineId === lineId);
  if (!c) return;
  if (seleccion.has(lineId)) seleccion.delete(lineId);
  else seleccion.set(lineId, Math.round(c.disponible * 100) / 100);
  renderLista();
}

function cambiarMonto(lineId, valor) {
  const c = candidatos.find(x => x.lineId === lineId);
  const n = Math.round(Number(valor) * 100) / 100;
  if (!c || !(n > 0)) { seleccion.delete(lineId); renderLista(); return; }
  if (n > c.disponible + 0.02) {
    showAlert(`El monto no puede superar el de la partida ($${c.disponible.toFixed(2)}).`);
    renderLista();
    return;
  }
  seleccion.set(lineId, n);
  renderLista();
}

function cerrarVinculador() {
  vinculando = null;
  seleccion.clear();
  document.getElementById('pick-overlay').classList.add('hidden');
}

async function guardarVinculo() {
  if (!vinculando) return;
  const btn = document.getElementById('btn-guardar-vinculo');
  const links = [...seleccion.entries()].map(([lineId, amount]) => ({ lineId, amount }));
  btn.disabled = true;
  btn.textContent = '⏳ Guardando...';
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId: vinculando.id, links }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'No se pudo vincular');
    renderDetail(body);
  } catch (e) {
    showAlert('No se pudo guardar el vínculo: ' + esc(e.message));
    btn.disabled = false;
    btn.textContent = 'Guardar vínculo';
  }
}

async function quitarVinculo() {
  if (!vinculando) return;
  const rowId = vinculando.id;
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}/match`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rowId, entryId: null }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'No se pudo quitar el vínculo');
    renderDetail(body);
  } catch (e) { showAlert('Error: ' + esc(e.message)); }
}

/**
 * Crear el asiento que falta desde una fila del extracto.
 *
 * El movimiento del banco YA se conoce —es la fila, con su fecha, su monto y su
 * cuenta—, así que el asiento son dos líneas y al contador solo le falta **una**
 * cuenta: la contrapartida. Antes eran dos `prompt()` pidiendo el CÓDIGO de cada
 * cuenta, y lo que se escribía se mandaba crudo como clave foránea.
 *
 * Si el asiento necesita más de dos cuentas (ITBMS, retenciones, varios conceptos),
 * este formulario no alcanza: eso se arma en Revisión → Asiento Manual.
 */

/**
 * Las cuentas que se pueden elegir: hojas (el nodo padre no se postea) y activas,
 * por código. Las bloqueadas sí van —la API las rechaza con el nombre de la cuenta—
 * para que el contador vea por qué no puede usar la que tenía en mente. La cuenta
 * del extracto queda fuera: no puede ser contrapartida de sí misma.
 */
function cuentasParaElegir(exceptoId = null) {
  return cuentasCatalogo
    .filter(a => a.isActive !== false && !(a.children || []).length && a.id !== exceptoId)
    .slice()
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'es'));
}

/** Llena la lista de la contrapartida; el filtro va por código o por nombre. */
function llenarContrapartidas(filtro = '') {
  const select = document.getElementById('e-contrapartida');
  const previo = select.value;
  const q = filtro.trim().toLowerCase();
  const cuentas = cuentasParaElegir(currentStatement?.bankAccountId || null).filter(a =>
    !q || String(a.code).toLowerCase().includes(q) || String(a.name).toLowerCase().includes(q));

  // La opción vacía solo va sin filtro: es el "todavía no elegí".
  const opciones = (q ? [] : ['<option value="">— elegí una cuenta —</option>'])
    .concat(cuentas.map(a => `<option value="${a.id}">${esc(a.code)} — ${esc(a.name)}</option>`));
  select.innerHTML = opciones.join('') || '<option value="">Sin cuentas que coincidan</option>';

  // Lo elegido se conserva mientras siga en la lista (el filtro se escribe después
  // de elegir): si desapareció, la lista vuelve a "elegí una cuenta".
  select.value = cuentas.some(a => a.id === previo) ? previo : '';
  const elegida = select.selectedOptions[0];
  if (elegida) elegida.scrollIntoView({ block: 'nearest' });
}

function filtrarContrapartidas() {
  llenarContrapartidas(document.getElementById('e-buscar').value);
}

function abrirFormularioAsiento(rowId) {
  const row = (currentStatement?.rows || []).find(r => r.id === rowId);
  if (!row) return;
  filaCreando = row;

  const sale = (row.debit || 0) > 0;              // la plata SALE de la cuenta del extracto
  const monto = sale ? row.debit : row.credit;
  // El id sale de `bankAccountId` (columna del extracto): el `bankAccount` que
  // devuelve la API trae solo código y nombre.
  const bancoCode = currentStatement?.bankAccount?.code || '';
  const bancoNombre = currentStatement?.bankAccount?.name || '';

  // El lado del extracto queda FIJO, y del lado que le toca: si la plata sale de la
  // cuenta se ACREDITA; si entra, se DEBITA. Lo elige el contador es la otra cuenta.
  document.getElementById('entry-head').innerHTML = `
    <h3>➕ Crear el asiento que falta</h3>
    <div class="fila"><b>${esc(row.description)}</b> · ${new Date(row.date).toLocaleDateString('es-PA')} · ${sale ? 'salida' : 'entrada'} de <b>$${monto.toFixed(2)}</b></div>
    <div class="nota">Nace en BORRADOR con la fecha de la fila, por ese monto, y queda conciliado con ella. Lo aprueba el contador desde Revisión.</div>`;

  document.getElementById('e-banco').innerHTML = `
    <div class="etiqueta">${sale ? 'Crédito' : 'Débito'} · movimiento del extracto (fijo)</div>
    <div><b>${esc(bancoCode)}</b> — ${esc(bancoNombre)} · $${monto.toFixed(2)}</div>`;

  document.getElementById('e-etiqueta').textContent = sale
    ? 'Cuenta del débito — qué se pagó o a quién'
    : 'Cuenta del crédito — de dónde salió la plata';
  document.getElementById('e-lado').textContent = sale
    ? 'El asiento debita esta cuenta y acredita la del extracto.'
    : 'El asiento debita la del extracto y acredita esta cuenta.';

  document.getElementById('e-descripcion').value = row.description || '';
  document.getElementById('e-buscar').value = '';
  // La lista arranca vacía: si no, al abrir otra fila quedaría elegida la cuenta de
  // la fila anterior (un gasto que se arrastra sin que nadie lo mire).
  document.getElementById('e-contrapartida').innerHTML = '';
  llenarContrapartidas();

  document.getElementById('entry-overlay').classList.remove('hidden');
  const boton = document.getElementById('e-crear');
  boton.disabled = false;
  boton.textContent = 'Crear asiento';
  document.getElementById('e-buscar').focus();
}

function cerrarFormularioAsiento() {
  filaCreando = null;
  document.getElementById('entry-overlay').classList.add('hidden');
}

async function crearAsientoDesdeFila() {
  const row = filaCreando;
  if (!row) return;

  const bancoId = currentStatement?.bankAccountId || null;
  const contrapartida = document.getElementById('e-contrapartida').value;
  if (!bancoId) { showAlert('No pude identificar la cuenta del extracto.'); return; }
  if (!contrapartida) { showAlert('Elegí la cuenta de la contrapartida.'); return; }
  if (contrapartida === bancoId) { showAlert('La contrapartida no puede ser la cuenta del extracto.'); return; }

  // El monto es el de la fila —es el movimiento que se está registrando— y la fecha
  // la hereda el asiento: no se editan acá.
  const amount = (row.debit || 0) > 0 ? row.debit : row.credit;
  const sale = (row.debit || 0) > 0;
  const description = document.getElementById('e-descripcion').value.trim();

  const boton = document.getElementById('e-crear');
  boton.disabled = true;
  boton.textContent = 'Creando…';
  try {
    const res = await authFetch(`${CONC_API}/reconcile/${currentStatement.id}/create-entry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rowId: row.id,
        amount,
        description,
        debitAccountId: sale ? contrapartida : bancoId,
        creditAccountId: sale ? bancoId : contrapartida,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No se pudo crear el asiento');
    cerrarFormularioAsiento();
    await loadStatement(currentStatement.id);
  } catch (e) {
    showAlert('Error: ' + esc(e.message));
    boton.disabled = false;
    boton.textContent = 'Crear asiento';
  }
}

function resetView() {
  currentStatement = null;
  document.getElementById('step-upload').classList.remove('hidden');
  document.getElementById('step-detail').classList.add('hidden');
  document.getElementById('step-loading').classList.add('hidden');
  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = '';
  // Se vuelve a pintar la grilla para que se le caiga la marca de "abierta".
  loadHistory();
}

/**
 * El atajo del formulario del asiento: en el SPA cambia de panel (sin recargar);
 * en la página suelta lleva a la app.
 */
function irARevisionDesdeConciliacion() {
  cerrarFormularioAsiento();
  const nav = document.querySelector('#sidebar-nav .nav-link[data-view="panel-revision"]');
  if (nav) nav.click();
  else window.location.href = '/index.html';
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}
