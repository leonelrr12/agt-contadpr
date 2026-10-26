// terceros.js — panel «Terceros»: maestro de clientes y proveedores.
//
// Un solo listado con la clasificación (Cliente/Proveedor) y búsqueda en
// pantalla por nombre, RUC, DV, teléfono, email o dirección. Los datos salen de
// los endpoints existentes (/clients y /suppliers), que ya devuelven el perfil
// fiscal descifrado; filtrar acá evita reconsultar la API en cada tecla.

let _terceros = [];
let _tercerosCargando = false;

/** Mismos roles que pueden crear/editar clientes y proveedores en la API. */
function puedeEditarTerceros() {
  return ['admin', 'contador', 'superadmin'].includes(getUser()?.role);
}

function loadPanelTerceros() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-terceros-content').classList.remove('hidden');
  const btn = document.getElementById('terceros-nuevo-btn');
  if (btn) btn.style.display = puedeEditarTerceros() ? '' : 'none';
  loadTerceros();
}

async function loadTerceros() {
  const list = document.getElementById('terceros-list');
  if (!list) return;
  if (_tercerosCargando) return;
  _tercerosCargando = true;
  list.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando terceros...</div>';
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/clients`), authFetch(`${API_URL}/suppliers`)]);
    if (!rc.ok || !rs.ok) {
      list.innerHTML = '<div class="empty">Error al cargar terceros</div>';
      return;
    }
    const [clients, suppliers] = await Promise.all([rc.json(), rs.json()]);
    _terceros = [
      ...(Array.isArray(clients) ? clients : []).map((c) => ({ tipo: 'Cliente', data: c })),
      ...(Array.isArray(suppliers) ? suppliers : []).map((s) => ({ tipo: 'Proveedor', data: s })),
    ];
    renderTerceros();
  } catch (e) {
    list.innerHTML = '<div class="empty">Error de conexión</div>';
  } finally {
    _tercerosCargando = false;
  }
}

/** Todo lo que el buscador puede mirar, sin distinguir mayúsculas ni tildes.
 *  Incluye el RUC/teléfono en dígitos para que "34224075526" encuentre
 *  "342-240-75526-50" y "50760000000" encuentre "+507 6000-0000". */
function terceroHaystack(t) {
  const d = t.data || {};
  const digitos = (v) => String(v ?? '').replace(/\D/g, '');
  const rucCompleto = d.dv ? `${d.taxId || ''}-${d.dv}` : (d.taxId || '');
  return normalizeSearch([
    t.tipo,
    d.name,
    d.tradeName,
    d.contactName,
    d.taxId,
    d.dv,
    rucCompleto,
    digitos(d.taxId),
    digitos(d.phone),
    d.phone,
    d.email,
    d.address,
    d.location,
    d.taxIdType,
  ].join(' '));
}

function renderTerceros() {
  const list = document.getElementById('terceros-list');
  const resumen = document.getElementById('terceros-resumen');
  if (!list || !resumen) return;

  const raw = document.getElementById('terceros-search')?.value?.trim() || '';
  const terms = normalizeSearch(raw).split(/\s+/).filter(Boolean);
  const shown = terms.length
    ? _terceros.filter((t) => {
        const hay = terceroHaystack(t);
        return terms.every((term) => hay.includes(term));
      })
    : _terceros;

  const clientes = _terceros.filter((t) => t.tipo === 'Cliente').length;
  const proveedores = _terceros.filter((t) => t.tipo === 'Proveedor').length;
  resumen.textContent = `${_terceros.length} tercero(s): ${clientes} cliente(s) y ${proveedores} proveedor(es)`
    + (terms.length ? ` · mostrando ${shown.length}` : '');

  if (!_terceros.length) {
    list.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Todavía no hay clientes ni proveedores registrados.<br><span style="font-size:12px">Se crean al emitir facturas o al registrar una compra/gasto.</span></div>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div style="text-align:center;padding:32px;color:#6b7280">🔍 Sin coincidencias para «${escapeHtml(raw)}»</div>`;
    return;
  }

  const badge = (tipo) => tipo === 'Cliente'
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600">👤 Cliente</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:600">🏭 Proveedor</span>';

  const puede = puedeEditarTerceros();
  const rows = shown.map((t) => {
    const d = t.data || {};
    const nombre = escapeHtml(d.name || '—');
    const comercial = d.tradeName && d.tradeName !== d.name
      ? `<div style="font-size:11px;color:#6b7280">${escapeHtml(d.tradeName)}</div>`
      : '';
    const celdas = [
      badge(t.tipo),
      `<div style="font-weight:600">${nombre}</div>${comercial}`,
      escapeHtml(d.taxId || '—'),
      escapeHtml(d.dv || '—'),
      escapeHtml(d.phone || '—'),
      escapeHtml(d.email || '—'),
      escapeHtml(d.address || '—'),
    ];
    if (puede) {
      celdas.push(
        `<button onclick="abrirTerceroModal('${t.tipo}', '${d.id}')" title="Editar ${t.tipo.toLowerCase()}" style="padding:3px 8px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">✏️</button> `
        + `<button onclick="eliminarTercero('${t.tipo}', '${d.id}')" title="Eliminar ${t.tipo.toLowerCase()}" style="padding:3px 8px;font-size:11px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer">🗑️</button>`,
      );
    }
    return celdas;
  });

  list.innerHTML = buildInformesTable(
    ['Clasificación', 'Nombre', 'RUC', 'DV', 'Teléfono', 'Email', 'Dirección', ...(puede ? ['Acciones'] : [])],
    rows,
  );
}

/** Formulario único de alta/edición. El tipo solo se elige al crear. */
function abrirTerceroModal(tipo, id) {
  if (!puedeEditarTerceros()) return;
  const esEdicion = !!id;
  const item = esEdicion ? _terceros.find((t) => t.tipo === tipo && t.data.id === id) : null;
  if (esEdicion && !item) { showAlert('No se encontró el tercero'); return; }
  const d = item?.data || {};
  const tipoInicial = esEdicion ? tipo : (tipo === 'Proveedor' ? 'Proveedor' : 'Cliente');
  const val = (k) => escapeHtml(d[k] || '');
  const campo = 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px';
  const label = 'font-size:11px;color:#6b7280;display:block;margin-bottom:3px';
  const tiposId = ['', 'RUC', 'CEDULA', 'PASAPORTE'].map((v) =>
    `<option value="${v}"${(d.taxIdType || '') === v ? ' selected' : ''}>${v === '' ? '— Sin clasificar —' : v === 'CEDULA' ? 'Cédula' : v === 'PASAPORTE' ? 'Pasaporte' : 'RUC'}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.id = 'tercero-modal-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:720px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:4px">${esEdicion ? '✏️ Editar' : '➕ Nuevo'} tercero</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">El RUC, DV y la dirección se usan para facturar electrónicamente y para el Anexo DGI.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      <div>
        <label style="${label}">Tipo *</label>
        ${esEdicion
          ? `<div style="padding:8px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;font-size:13px">${tipoInicial === 'Cliente' ? '👤 Cliente' : '🏭 Proveedor'}</div>`
          : `<select id="tercero-tipo" style="${campo}"><option value="Cliente"${tipoInicial === 'Cliente' ? ' selected' : ''}>👤 Cliente</option><option value="Proveedor"${tipoInicial === 'Proveedor' ? ' selected' : ''}>🏭 Proveedor</option></select>`}
      </div>
      <div>
        <label style="${label}">Nombre / Razón social *</label>
        <input id="tercero-name" maxlength="200" value="${val('name')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Nombre comercial</label>
        <input id="tercero-tradeName" maxlength="200" value="${val('tradeName')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">RUC / Cédula (sin DV)</label>
        <input id="tercero-taxId" maxlength="30" value="${val('taxId')}" placeholder="8-733-2267" style="${campo}">
      </div>
      <div>
        <label style="${label}">DV (dígito verificador)</label>
        <input id="tercero-dv" maxlength="2" value="${val('dv')}" placeholder="88" style="${campo}">
      </div>
      <div>
        <label style="${label}">Tipo de identificación</label>
        <select id="tercero-taxIdType" style="${campo}">${tiposId}</select>
      </div>
      <div>
        <label style="${label}">Teléfono</label>
        <input id="tercero-phone" maxlength="40" value="${val('phone')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Email</label>
        <input id="tercero-email" type="email" maxlength="120" value="${val('email')}" style="${campo}">
      </div>
      <div style="grid-column:1/-1">
        <label style="${label}">Dirección</label>
        <input id="tercero-address" maxlength="300" value="${val('address')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Ubicación DGI (PP-DD-CC)</label>
        <input id="tercero-location" maxlength="8" value="${val('location')}" placeholder="8-8-8" style="${campo}">
      </div>
      <div>
        <label style="${label}">Persona de contacto</label>
        <input id="tercero-contactName" maxlength="120" value="${val('contactName')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Plazo de pago (días, proveedores)</label>
        <input id="tercero-paymentTerms" maxlength="20" value="${val('paymentTerms') || '30'}" style="${campo}">
      </div>
      <div style="grid-column:1/-1">
        <label style="${label}">Notas</label>
        <textarea id="tercero-notes" rows="2" maxlength="500" style="${campo}">${escapeHtml(d.notes || '')}</textarea>
      </div>
    </div>
    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="tercero-cancel">Cancelar</button>
      <button class="app-dialog-btn primary" id="tercero-save">💾 Guardar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#tercero-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#tercero-save').onclick = () => guardarTercero(overlay, tipoInicial, id);
  setTimeout(() => document.getElementById('tercero-name')?.focus(), 0);
}

async function guardarTercero(overlay, tipoInicial, id) {
  const v = (field) => document.getElementById(field)?.value.trim() || '';
  const tipo = id ? tipoInicial : (document.getElementById('tercero-tipo')?.value || 'Cliente');
  const nombre = v('tercero-name');
  if (!nombre) { await showAlert('El nombre es obligatorio'); return; }
  const dv = v('tercero-dv');
  if (dv && !/^\d{1,2}$/.test(dv)) { await showAlert('El DV debe ser de 1 o 2 dígitos.'); return; }
  const location = v('tercero-location');
  if (location && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(location)) {
    await showAlert('La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).');
    return;
  }
  const email = v('tercero-email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await showAlert('El email no es válido.'); return; }

  const body = {
    name: nombre,
    taxId: v('tercero-taxId') || null,
    dv: dv || null,
    taxIdType: v('tercero-taxIdType') || null,
    phone: v('tercero-phone') || null,
    email: email || null,
    address: v('tercero-address') || null,
    location: location || null,
    tradeName: v('tercero-tradeName') || null,
    contactName: v('tercero-contactName') || null,
    notes: v('tercero-notes') || null,
  };
  if (tipo === 'Proveedor') body.paymentTerms = v('tercero-paymentTerms') || '30';

  const save = overlay.querySelector('#tercero-save');
  save.disabled = true;
  save.textContent = 'Guardando...';
  try {
    const url = `${API_URL}/${tipo === 'Cliente' ? 'clients' : 'suppliers'}${id ? '/' + encodeURIComponent(id) : ''}`;
    const res = await authFetch(url, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await showAlert(`❌ ${data.error || 'No se pudo guardar el tercero'}`);
      save.disabled = false;
      save.textContent = '💾 Guardar';
      return;
    }
    overlay.remove();
    await showAlert(`✅ ${tipo} ${id ? 'actualizado' : 'creado'}.`);
    loadTerceros();
  } catch (e) {
    await showAlert('Error de conexión');
    save.disabled = false;
    save.textContent = '💾 Guardar';
  }
}

async function eliminarTercero(tipo, id) {
  if (!puedeEditarTerceros()) return;
  const item = _terceros.find((t) => t.tipo === tipo && t.data.id === id);
  const nombre = item?.data?.name || 'este tercero';
  const ok = await showConfirm(`¿Eliminar ${tipo.toLowerCase()} "${nombre}"?\n\nSolo se puede si no tiene facturas, retenciones o cuentas de trabajador asociadas.`);
  if (!ok) return;
  try {
    const url = `${API_URL}/${tipo === 'Cliente' ? 'clients' : 'suppliers'}/${encodeURIComponent(id)}`;
    const res = await authFetch(url, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { await showAlert(`❌ ${data.error || 'No se pudo eliminar'}`); return; }
    await showAlert('✅ Tercero eliminado.');
    loadTerceros();
  } catch (e) { await showAlert('Error de conexión'); }
}
