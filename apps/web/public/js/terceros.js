// terceros.js — panel «Terceros»: maestro de clientes y proveedores.
//
// Un solo listado con la clasificación (Cliente/Proveedor) y búsqueda en
// pantalla por nombre, RUC, DV, teléfono, email o dirección. Los datos salen de
// los endpoints existentes (/clients y /suppliers), que ya devuelven el perfil
// fiscal descifrado; filtrar acá evita reconsultar la API en cada tecla.

let _terceros = [];
let _tercerosCargando = false;

function loadPanelTerceros() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-terceros-content').classList.remove('hidden');
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

  const rows = shown.map((t) => {
    const d = t.data || {};
    const nombre = escapeHtml(d.name || '—');
    const comercial = d.tradeName && d.tradeName !== d.name
      ? `<div style="font-size:11px;color:#6b7280">${escapeHtml(d.tradeName)}</div>`
      : '';
    return [
      badge(t.tipo),
      `<div style="font-weight:600">${nombre}</div>${comercial}`,
      escapeHtml(d.taxId || '—'),
      escapeHtml(d.dv || '—'),
      escapeHtml(d.phone || '—'),
      escapeHtml(d.email || '—'),
      escapeHtml(d.address || '—'),
    ];
  });

  list.innerHTML = buildInformesTable(
    ['Clasificación', 'Nombre', 'RUC', 'DV', 'Teléfono', 'Email', 'Dirección'],
    rows,
  );
}
