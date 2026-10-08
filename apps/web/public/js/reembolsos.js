// reembolsos.js — panel 💵 Reembolsos: lo que cada TRABAJADOR adelantó de su
// bolsillo (compras de insumos, comida, materia prima) y su pago.
//
// El trabajador no tiene usuario: su identidad es el celular desde el que manda
// las facturas por WhatsApp. Acá el contador ve el detalle por celular, abre la
// factura de la DGI, y paga: pagar APRUEBA los asientos que seguían en borrador
// y genera el asiento del pago contra el banco (lo hace el backend en una sola
// transacción — ver services/reembolsos.ts).

let _reembTrabajadores = [];
let _reembDetalle = null;      // { worker, facturas }
let _reembTab = 'trabajadores'; // 'trabajadores' | 'facturas'
let _reembFiltros = { texto: '', desde: '', hasta: '', estado: '' };
let _reembFacturas = [];
let _reembSeleccion = new Set();
let _reembCuentasPago = null;

const REEMB_ESTADO = {
  PENDIENTE: { texto: 'Pendiente', color: '#92400e', bg: '#fffbeb' },
  PAGADO: { texto: 'Pagado', color: '#059669', bg: '#ecfdf5' },
};

function reembMoney(n) {
  return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** "50761234567" → "+507 6123-4567" (solo para leerlo; se guarda sin formato). */
function reembCelular(p) {
  const d = String(p || '').replace(/\D/g, '');
  if (d.length === 11) return `+${d.slice(0, 3)} ${d.slice(3, 7)}-${d.slice(7)}`;
  return d || '—';
}

/** Fecha local de hoy en 'YYYY-MM-DD' (mediodía local, como todo el sistema). */
function reembHoy() {
  const h = new Date();
  return `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
}

function reembFechaCorta(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function reembPuedePagar() {
  return ['admin', 'contador', 'superadmin'].includes(getUser()?.role);
}

/** El contenedor donde pintan todas las vistas del panel (bajo las pestañas). */
function reembEl() {
  return document.getElementById('reemb-tab-content') || document.getElementById('reembolsos-inline-list');
}

/* ── Entrada del panel ── */
async function loadPanelReembolsos(tab) {
  if (tab) _reembTab = tab;
  _reembDetalle = null;
  _reembSeleccion = new Set();
  document.getElementById('reembolsos-inline-list').innerHTML = `
    <div style="display:flex;gap:4px;border-bottom:1px solid #e5e7eb;margin-bottom:16px">
      ${reembTabBtn('trabajadores', '👷 Trabajadores')}
      ${reembTabBtn('facturas', '🧾 Facturas recibidas')}
    </div>
    <div id="reemb-tab-content"><div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div></div>`;
  if (_reembTab === 'facturas') await reembCargarFacturas();
  else await reembCargarTrabajadores();
}

function reembTabBtn(id, texto) {
  const activo = _reembTab === id;
  return `<button onclick="loadPanelReembolsos('${id}')" style="padding:8px 16px;border:none;background:none;cursor:pointer;font-weight:600;font-size:13px;color:${activo ? '#1a1a2e' : '#6b7280'};border-bottom:2px solid ${activo ? '#1565c0' : 'transparent'};margin-bottom:-2px">${texto}</button>`;
}

async function reembCargarTrabajadores() {
  const el = reembEl();
  try {
    const res = await authFetch(`${API_URL}/reembolsos/trabajadores`);
    if (!res.ok) throw new Error();
    _reembTrabajadores = await res.json();
    reembPintarTrabajadores();
  } catch {
    el.innerHTML = '<div class="empty">No se pudo cargar la lista de trabajadores</div>';
  }
}

/* ── Facturas recibidas: el archivo consultable (con o sin trabajador) ── */
async function reembCargarFacturas() {
  const el = reembEl();
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando facturas...</div>';
  const q = new URLSearchParams();
  if (_reembFiltros.texto) q.set('texto', _reembFiltros.texto);
  if (_reembFiltros.desde) q.set('desde', _reembFiltros.desde);
  if (_reembFiltros.hasta) q.set('hasta', _reembFiltros.hasta);
  if (_reembFiltros.estado) q.set('estado', _reembFiltros.estado);
  try {
    const res = await authFetch(`${API_URL}/reembolsos/facturas?${q.toString()}`);
    if (!res.ok) throw new Error();
    _reembFacturas = await res.json();
    reembPintarFacturas();
  } catch {
    el.innerHTML = '<div class="empty">No se pudieron cargar las facturas</div>';
  }
}

function reembPintarFacturas() {
  const el = reembEl();
  const f = _reembFiltros;
  const total = _reembFacturas.reduce((a, x) => a + Number(x.total || 0), 0);
  let html = `
    <div class="admin-form-card" style="margin-bottom:14px">
      <div class="form-grid">
        <div><label>Buscar</label><input type="text" id="reemb-f-texto" value="${escapeHtml(f.texto)}" placeholder="Proveedor, Nº de factura o RUC"></div>
        <div><label>Desde</label><input type="date" id="reemb-f-desde" value="${f.desde}"></div>
        <div><label>Hasta</label><input type="date" id="reemb-f-hasta" value="${f.hasta}"></div>
        <div><label>Estado</label><select id="reemb-f-estado">
          <option value="">Todas</option>
          <option value="PENDIENTE" ${f.estado === 'PENDIENTE' ? 'selected' : ''}>Pendiente de reembolso</option>
          <option value="PAGADO" ${f.estado === 'PAGADO' ? 'selected' : ''}>Pagada</option>
        </select></div>
      </div>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center">
        <button class="btn-primary" style="padding:7px 14px;font-size:13px" onclick="reembBuscar()">🔍 Buscar</button>
        <button class="btn-secondary" style="padding:7px 14px;font-size:13px" onclick="reembLimpiarFiltros()">Limpiar</button>
        <span style="font-size:12px;color:#6b7280">${_reembFacturas.length} factura(s) — ${reembMoney(total)}</span>
      </div>
    </div>`;

  if (!_reembFacturas.length) {
    el.innerHTML = html + '<div class="empty" style="padding:24px;text-align:center">No hay facturas con esos filtros.</div>';
    return;
  }

  html += '<table><thead><tr><th>Fecha</th><th>Proveedor</th><th>Nº</th><th>RUC</th><th style="text-align:right">Total</th><th>De quién</th><th>Asiento</th><th>Factura</th></tr></thead><tbody>';
  for (const x of _reembFacturas) {
    const est = x.journalEntry?.status;
    const asiento = est === 'CONFIRMADO' ? '<span style="color:#059669">✓</span>'
      : est === 'RECHAZADO' ? '<span style="color:#dc2626">✗</span>'
      : `<span style="color:#92400e">●</span>`;
    html += `<tr>
      <td>${reembFechaCorta(x.fecha)}</td>
      <td>${escapeHtml(x.proveedor || '—')}</td>
      <td class="cuenta-code">${escapeHtml(x.numeroFactura || '—')}</td>
      <td class="cuenta-code">${escapeHtml(x.rucEmisor || '—')}</td>
      <td style="text-align:right">${reembMoney(x.total)}</td>
      <td>${x.worker ? escapeHtml(x.worker.nombre) : '<span style="color:#6b7280">Empresa</span>'}
        ${x.status === 'PAGADO' ? ' <span style="font-size:11px;color:#059669">pagada</span>' : ''}</td>
      <td style="text-align:center">${asiento}</td>
      <td>${x.dgiUrl ? `<a href="${escapeHtml(x.dgiUrl)}" target="_blank" rel="noopener">Ver ↗</a>` : '<span style="color:#9ca3af">sin URL</span>'}</td>
    </tr>`;
  }
  el.innerHTML = html + '</tbody></table>';
}

function reembBuscar() {
  _reembFiltros = {
    texto: document.getElementById('reemb-f-texto')?.value?.trim() || '',
    desde: document.getElementById('reemb-f-desde')?.value || '',
    hasta: document.getElementById('reemb-f-hasta')?.value || '',
    estado: document.getElementById('reemb-f-estado')?.value || '',
  };
  reembCargarFacturas();
}

function reembLimpiarFiltros() {
  _reembFiltros = { texto: '', desde: '', hasta: '', estado: '' };
  reembCargarFacturas();
}

/** Botón de alta + formulario, compartidos por la lista vacía y la lista con datos. */
function reembAltaHtml() {
  if (!reembPuedePagar()) return '';
  return `<div style="margin-bottom:14px">
    <button class="btn-primary" onclick="reembolsosFormAlta()" style="padding:8px 16px;font-size:13px">➕ Nuevo trabajador</button>
    <div id="reemb-alta-form" class="hidden" style="margin-top:12px"></div>
  </div>`;
}

function reembolsosFormAlta() {
  const form = document.getElementById('reemb-alta-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4 style="margin:0 0 4px 0">Nuevo trabajador</h4>
      <p style="margin:0 0 12px 0;font-size:12px;color:#6b7280">
        Su identidad es el <strong>celular</strong>. Cuando ese número esté vinculado a WhatsApp y mande una factura,
        el gasto nace a su nombre. Si el número todavía no está vinculado, se engancha solo al verificarlo.
      </p>
      <div class="form-grid">
        <div><label>Nombre</label><input type="text" id="reemb-nombre" placeholder="Ej: Juan Pérez"></div>
        <div><label>Celular</label><input type="text" id="reemb-celular" placeholder="Ej: 50761234567"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn-primary" onclick="reembolsosGuardarTrabajador()">💾 Guardar</button>
        <button class="btn-secondary" onclick="document.getElementById('reemb-alta-form').classList.add('hidden')">Cancelar</button>
      </div>
    </div>`;
}

async function reembolsosGuardarTrabajador() {
  const nombre = document.getElementById('reemb-nombre')?.value?.trim();
  const phoneNumber = document.getElementById('reemb-celular')?.value?.trim();
  if (!nombre) { await showAlert('El nombre es requerido'); return; }
  if (String(phoneNumber || '').replace(/\D/g, '').length < 8) { await showAlert('El celular es requerido (ej. 50761234567)'); return; }
  try {
    const res = await authFetch(`${API_URL}/reembolsos/trabajadores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre, phoneNumber }),
    });
    const data = await res.json();
    if (!res.ok) { await showAlert(data.error || 'No se pudo guardar'); return; }
    await showAlert(data.celularEnlazado
      ? `✅ ${nombre} registrado con su celular ya vinculado: sus facturas caerán a su nombre.`
      : `✅ ${nombre} registrado. Falta que ese celular se vincule a WhatsApp (envía HOLA y verifica el código): ahí se engancha solo.`);
    loadPanelReembolsos();
  } catch { await showAlert('Error de conexión'); }
}

function reembPintarTrabajadores() {
  const el = reembEl();
  if (!_reembTrabajadores.length) {
    el.innerHTML = reembAltaHtml() + `<div class="empty" style="padding:32px;text-align:center">
      Todavía no hay trabajadores registrados.<br><br>
      <span style="font-size:13px">Un trabajador se identifica con su <strong>celular</strong>: cuando ese número manda una factura por WhatsApp,
      el gasto nace a su nombre y aparece acá para reembolsarlo.</span>
    </div>`;
    return;
  }

  let html = reembAltaHtml() + '<table><thead><tr><th>Trabajador</th><th>Celular</th><th style="text-align:right">Pendiente</th><th style="text-align:center">Facturas</th><th></th></tr></thead><tbody>';
  for (const t of _reembTrabajadores) {
    const pendientes = Number(t.saldoPendiente || 0);
    html += `<tr${t.isActive ? '' : ' style="opacity:.5"'}>
      <td><strong>${escapeHtml(t.nombre)}</strong>${t.isActive ? '' : ' <span style="font-size:11px;color:#6b7280">(inactivo)</span>'}
        ${t.employee ? `<div style="font-size:11px;color:#6b7280">Planilla: ${escapeHtml(t.employee.nombre)}</div>` : ''}
        ${t.supplier ? `<div style="font-size:11px;color:#6b7280">Honorarios: ${escapeHtml(t.supplier.name)}</div>` : ''}</td>
      <td class="cuenta-code">${reembCelular(t.phoneNumber)}</td>
      <td style="text-align:right;font-weight:${pendientes > 0 ? '700' : '400'};color:${pendientes > 0 ? '#92400e' : '#6b7280'}">${reembMoney(pendientes)}</td>
      <td style="text-align:center">${(t.links || []).length ? '📱' : '—'}</td>
      <td><button class="btn-sm" onclick="reembolsosVerDetalle('${t.id}')">Ver detalle</button></td>
    </tr>`;
  }
  el.innerHTML = html + '</tbody></table>';
}

/* ── Detalle de un trabajador ── */
async function reembolsosVerDetalle(workerId) {
  const el = reembEl();
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando facturas...</div>';
  _reembSeleccion = new Set();
  try {
    const [resT, resF] = await Promise.all([
      authFetch(`${API_URL}/reembolsos/trabajadores`),
      authFetch(`${API_URL}/reembolsos/facturas?workerId=${encodeURIComponent(workerId)}`),
    ]);
    const trabajadores = await resT.json();
    const facturas = await resF.json();
    _reembTrabajadores = trabajadores;
    _reembDetalle = { worker: trabajadores.find(t => t.id === workerId), facturas };
    reembPintarDetalle();
  } catch {
    el.innerHTML = '<div class="empty">No se pudo cargar el detalle</div>';
  }
}

function reembPintarDetalle() {
  const el = reembEl();
  const { worker: t, facturas } = _reembDetalle;
  if (!t) { el.innerHTML = '<div class="empty">Trabajador no encontrado</div>'; return; }

  const pendientes = facturas.filter(f => f.status === 'PENDIENTE');
  const pagadas = facturas.filter(f => f.status === 'PAGADO');

  let html = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div>
        <button class="btn-secondary" onclick="loadPanelReembolsos('trabajadores')" style="padding:6px 12px;font-size:12px">← Volver</button>
        <h3 style="margin:10px 0 0 0;color:#1a1a2e">${escapeHtml(t.nombre)}</h3>
        <p style="margin:2px 0 0 0;color:#6b7280;font-size:13px">${reembCelular(t.phoneNumber)}
          ${(t.links || []).length ? '· celular vinculado ✅' : '· <span style="color:#dc2626">celular sin vincular a WhatsApp</span>'}</p>
      </div>
      <div style="text-align:right">
        <div style="font-size:12px;color:#6b7280">Pendiente de reembolso</div>
        <div style="font-size:24px;font-weight:700;color:${Number(t.saldoPendiente) > 0 ? '#92400e' : '#059669'}">${reembMoney(t.saldoPendiente)}</div>
      </div>
    </div>`;

  if (!pendientes.length && !pagadas.length) {
    el.innerHTML = html + '<div class="empty" style="padding:24px;text-align:center">Este trabajador todavía no tiene facturas registradas.</div>';
    return;
  }

  // ── Pendientes (seleccionables) ──
  if (pendientes.length) {
    html += `<table><thead><tr>
        <th style="width:28px"></th><th>Fecha</th><th>Proveedor</th><th>Nº factura</th>
        <th style="text-align:right">Total</th><th>Asiento</th><th>Factura DGI</th>
      </tr></thead><tbody>`;
    for (const f of pendientes) {
      const est = f.journalEntry?.status;
      const asiento = est === 'CONFIRMADO'
        ? '<span style="color:#059669">✓ Aprobado</span>'
        : `<span style="color:#92400e">● ${escapeHtml(est || 'sin asiento')}</span>`;
      html += `<tr>
        <td><input type="checkbox" ${reembPuedePagar() ? '' : 'disabled'} onchange="reembMarcar('${f.id}', this.checked)" ${_reembSeleccion.has(f.id) ? 'checked' : ''}></td>
        <td>${reembFechaCorta(f.fecha)}</td>
        <td>${escapeHtml(f.proveedor || '—')}</td>
        <td class="cuenta-code">${escapeHtml(f.numeroFactura || '—')}</td>
        <td style="text-align:right">${reembMoney(f.total)}</td>
        <td style="font-size:12px">${asiento}</td>
        <td>${f.dgiUrl ? `<a href="${escapeHtml(f.dgiUrl)}" target="_blank" rel="noopener">Ver factura ↗</a>` : '<span style="color:#9ca3af">sin URL</span>'}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    if (reembPuedePagar()) {
      html += `<div id="reemb-pago-bloque" style="margin-top:16px">
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
          <label style="font-size:13px;display:flex;align-items:center;gap:6px">
            <input type="checkbox" onchange="reembMarcarTodo(this.checked)"> Seleccionar todas
          </label>
          <button class="btn-primary" onclick="reembolsosAbrirPago()">💵 Reembolsar seleccionadas</button>
          <span id="reemb-total-sel" style="font-size:13px;color:#6b7280"></span>
        </div>
        <div id="reemb-pago-form" class="hidden" style="margin-top:14px"></div>
      </div>`;
    }
  }

  // ── Historial de pagos ──
  if (pagadas.length) {
    html += `<h4 style="margin:24px 0 8px 0;color:#1a1a2e">Pagos hechos</h4>
      <table><thead><tr><th>Fecha</th><th>Proveedor</th><th style="text-align:right">Total</th><th>Pago</th></tr></thead><tbody>`;
    for (const f of pagadas) {
      html += `<tr style="opacity:.75">
        <td>${reembFechaCorta(f.fecha)}</td>
        <td>${escapeHtml(f.proveedor || '—')}</td>
        <td style="text-align:right">${reembMoney(f.total)}</td>
        <td style="font-size:12px;color:#059669">✓ ${f.reimbursement ? reembFechaCorta(f.reimbursement.fecha) : 'pagado'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
  }

  el.innerHTML = html;
  reembActualizarTotal();
}

function reembMarcar(id, checked) {
  if (checked) _reembSeleccion.add(id); else _reembSeleccion.delete(id);
  reembActualizarTotal();
}

function reembMarcarTodo(checked) {
  const { facturas } = _reembDetalle;
  _reembSeleccion = new Set(checked ? facturas.filter(f => f.status === 'PENDIENTE').map(f => f.id) : []);
  reembPintarDetalle();
}

function reembTotalSeleccionado() {
  const ids = _reembSeleccion;
  return _reembDetalle.facturas.filter(f => ids.has(f.id)).reduce((a, f) => a + Number(f.total || 0), 0);
}

function reembActualizarTotal() {
  const span = document.getElementById('reemb-total-sel');
  if (!span) return;
  const n = _reembSeleccion.size;
  span.textContent = n ? `${n} factura(s) seleccionada(s) — ${reembMoney(reembTotalSeleccionado())}` : 'Ninguna factura seleccionada';
}

/* ── Pago ── */
async function reembolsosAbrirPago() {
  if (!_reembSeleccion.size) { await showAlert('Selecciona al menos una factura'); return; }
  const form = document.getElementById('reemb-pago-form');
  if (!_reembCuentasPago) {
    try {
      const r = await authFetch(`${API_URL}/reembolsos/cuentas-pago`);
      _reembCuentasPago = await r.json();
    } catch { _reembCuentasPago = []; }
  }
  const opciones = (_reembCuentasPago || []).map(c => `<option value="${c.id}">${c.code} — ${escapeHtml(c.name)}</option>`).join('');
  const seleccionadas = _reembDetalle.facturas.filter(f => _reembSeleccion.has(f.id));
  const porAprobar = seleccionadas.filter(f => f.journalEntry?.status !== 'CONFIRMADO').length;

  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4 style="margin:0 0 4px 0">Pagar ${reembMoney(reembTotalSeleccionado())} a ${escapeHtml(_reembDetalle.worker.nombre)}</h4>
      <p style="margin:0 0 12px 0;font-size:12px;color:#6b7280">
        Se agrupan ${seleccionadas.length} factura(s) en un solo pago.
        ${porAprobar ? `<strong>${porAprobar} asiento(s) en borrador se van a aprobar con este pago.</strong>` : ''}
      </p>
      <div class="form-grid">
        <div><label>Cuenta de pago</label><select id="reemb-cuenta">${opciones || '<option value="">— no hay bancos configurados —</option>'}</select></div>
        <div><label>Fecha del pago</label><input type="date" id="reemb-fecha" value="${reembHoy()}"></div>
        <div style="grid-column:1/-1"><label>Notas <span style="font-weight:400;color:#6b7280">(opcional)</span></label><input type="text" id="reemb-notas" placeholder="Ej: pagado en efectivo el viernes"></div>
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button class="btn-primary" onclick="reembolsosConfirmarPago()">💵 Confirmar pago</button>
        <button class="btn-secondary" onclick="document.getElementById('reemb-pago-form').classList.add('hidden')">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function reembolsosConfirmarPago() {
  const cuentaBancoId = document.getElementById('reemb-cuenta')?.value;
  const fecha = document.getElementById('reemb-fecha')?.value;
  const notas = document.getElementById('reemb-notas')?.value || null;
  if (!cuentaBancoId) { await showAlert('Selecciona la cuenta de pago'); return; }

  const total = reembTotalSeleccionado();
  const ok = await showConfirm(`¿Pagar ${reembMoney(total)} a ${_reembDetalle.worker.nombre}? Se generará el asiento del pago y las facturas quedarán marcadas como pagadas.`);
  if (!ok) return;

  try {
    const res = await authFetch(`${API_URL}/reembolsos/pagar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workerId: _reembDetalle.worker.id,
        claimIds: [..._reembSeleccion],
        cuentaBancoId, fecha, notas,
      }),
    });
    const data = await res.json();
    if (!res.ok) { await showAlert(data.error || 'No se pudo pagar'); return; }
    await showAlert(`✅ Pago registrado: ${reembMoney(data.total)} por ${data.facturas} factura(s)${data.aprobadas ? ` (${data.aprobadas} aprobada(s))` : ''}.`);
    reembolsosVerDetalle(_reembDetalle.worker.id);
  } catch {
    await showAlert('Error de conexión');
  }
}
