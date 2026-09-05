// admin.js (6/14) — CRUD de cuentas/conceptos y configuración
/* ── Administración: Cuentas Contables ── */
let cuentasCache = [];

async function loadPanelCuentasAdmin() {
  const el = document.getElementById('cuentas-admin-content');
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    cuentasCache = await res.json();
    if (!cuentasCache.length) { el.innerHTML = '<div class="empty">No hay cuentas registradas</div>'; return; }
    document.getElementById('cuentas-admin-count').textContent = `${cuentasCache.length} cuentas`;
    // Árbol y mapas definidos abajo (heredados de panels.js)
    renderCuentaGroups(el, cuentasCache, true);
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar cuentas</div>'; }
}

function showCrearCuenta() {
  const form = document.getElementById('cuentas-admin-form');
  form.classList.remove('hidden');
  form.innerHTML = `
    <div class="admin-form-card">
      <h4>Nueva Cuenta Contable</h4>
      <div class="form-grid">
        <div><label>Código</label><input type="text" id="cuenta-code" placeholder="Ej: 1.1.03.03" oninput="sugerirPadrePorCodigo()"></div>
        <div><label>Nombre</label><input type="text" id="cuenta-name" placeholder="Ej: Caja Chica"></div>
        <div><label>Tipo</label><select id="cuenta-type">
          <option value="ACTIVO">Activo</option><option value="PASIVO">Pasivo</option>
          <option value="PATRIMONIO">Patrimonio</option><option value="INGRESO">Ingreso</option>
          <option value="COSTO">Costo</option><option value="GASTO">Gasto</option>
        </select></div>
        <div><label>Cuenta Padre (opcional — busca por código, ej. "1.1.03")</label>
          <input list="cuentas-padre-list" id="cuenta-parent-search" placeholder="Escribe el código del padre..." onchange="selectCuentaParentByCode(this.value)" autocomplete="off">
          <datalist id="cuentas-padre-list">
            ${cuentasCache.map(c => `<option value="${c.code}">${c.name} (${c.type})</option>`).join('')}
          </datalist>
          <input type="hidden" id="cuenta-parent" value="">
          <div id="cuenta-parent-info" style="font-size:11px;color:#6b7280;margin-top:2px"></div>
        </div>
      </div>
      <div style="margin-top:10px">
        <button class="btn-primary" onclick="saveCuenta()">💾 Guardar</button>
        <button class="btn-secondary" onclick="cancelCuentaForm()">Cancelar</button>
      </div>
    </div>`;
  form.scrollIntoView({ behavior: 'smooth' });
}

/** Sugiere el padre automáticamente: el código de la nueva cuenta menos su último nivel.
 *  Ej: creando "1.1.03.03" → padre sugerido "1.1.03" (si existe). */
function sugerirPadrePorCodigo() {
  const code = document.getElementById('cuenta-code').value.trim();
  const info = document.getElementById('cuenta-parent-info');
  const search = document.getElementById('cuenta-parent-search');
  const hidden = document.getElementById('cuenta-parent');
  if (!info || !search || !hidden) return;
  // Quitar el último nivel: "1.1.03.03" → "1.1.03"; "1.1.03" → "1.1"; "1.1" → "1"
  const parts = code.split('.').filter(Boolean);
  if (parts.length < 2) { info.textContent = ''; return; }
  parts.pop();
  const padreCode = parts.join('.');
  const padre = cuentasCache.find(c => c.code === padreCode);
  if (padre) {
    hidden.value = padre.id;
    search.value = padre.code;
    info.innerHTML = `<span style="color:#059669;font-weight:600">✅ Padre sugerido: ${padre.code} — ${padre.name}</span>`;
  } else {
    hidden.value = '';
    search.value = padreCode;
    info.innerHTML = `<span style="color:#f59e0b">⚠️ No existe la cuenta padre ${padreCode} — se creará sin padre (nivel 1)</span>`;
  }
}

/** Selecciona el padre por el código digitado/buscado (LIKE sobre el código). */
function selectCuentaParentByCode(val) {
  const code = String(val || '').trim();
  const info = document.getElementById('cuenta-parent-info');
  const hidden = document.getElementById('cuenta-parent');
  if (!code) { hidden.value = ''; if (info) info.textContent = ''; return; }
  // Buscar coincidencia exacta primero; si no, la cuenta cuyo código inicia con el texto
  const padre = cuentasCache.find(c => c.code === code)
    || cuentasCache.filter(c => c.code.startsWith(code) && c.code !== document.getElementById('cuenta-code').value.trim()).sort((a, b) => a.code.length - b.code.length)[0];
  if (padre) {
    hidden.value = padre.id;
    document.getElementById('cuenta-parent-search').value = padre.code;
    info.innerHTML = `<span style="color:#059669;font-weight:600">✅ Padre: ${padre.code} — ${padre.name}</span>`;
  } else {
    hidden.value = '';
    info.innerHTML = `<span style="color:#f59e0b">⚠️ No se encontró la cuenta "${code}"</span>`;
  }
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
    const declaraEl = document.getElementById('config-declara-itbms');
    if (declaraEl) declaraEl.value = cfg.declaraITBMS !== false ? 'true' : 'false';
  } catch (e) { /* keep defaults */ }
}

async function saveConfig() {
  const rate = parseFloat(document.getElementById('config-itbms-rate').value);
  const enabled = document.getElementById('config-itbms-enabled').value === 'true';
  const declaraEl = document.getElementById('config-declara-itbms');
  const declaraITBMS = declaraEl ? declaraEl.value === 'true' : true;

  if (isNaN(rate) || rate < 0 || rate > 20) { await showAlert('Tasa ITBMS debe estar entre 0 y 20'); return; }

  try {
    const res = await authFetch(`${API_URL}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itbmsRate: rate / 100, itbmsEnabled: enabled, declaraITBMS }),
    });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error); return; }
    const msg = document.getElementById('config-saved-msg');
    msg.style.display = 'inline';
    setTimeout(() => { msg.style.display = 'none'; }, 2000);
  } catch (e) { await showAlert('Error de conexión'); }
}

document.getElementById('message-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Mapas compartidos con el panel de administración (admin.js)
const CUENTA_TIPOS = ['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'COSTO', 'GASTO'];
const CUENTA_COLORES = { ACTIVO: '#1565c0', PASIVO: '#e65100', PATRIMONIO: '#6a1b9a', INGRESO: '#2e7d32', COSTO: '#c62828', GASTO: '#d84315' };
const CUENTA_LABELS = { ACTIVO: 'Activos', PASIVO: 'Pasivos', PATRIMONIO: 'Patrimonio', INGRESO: 'Ingresos', COSTO: 'Costos', GASTO: 'Gastos' };

// Render agrupado del plan de cuentas; admin=true agrega estado inactivo y botón editar
function renderCuentaGroups(el, cuentas, admin = false) {
  if (!cuentas.length) { el.innerHTML = '<div class="empty">No hay cuentas registradas</div>'; return; }
  let html = '';
  for (const tipo of CUENTA_TIPOS) {
    const filtradas = cuentas.filter(c => c.type === tipo && !c.parentId);
    if (!filtradas.length) continue;
    html += `<div class="cuenta-grupo"><div class="cuenta-tipo" style="background:${CUENTA_COLORES[tipo]}">${CUENTA_LABELS[tipo]}</div>`;
    for (const root of filtradas) {
      html += buildCuentaTree(root, cuentas, 0, admin);
    }
    html += '</div>';
  }
  el.innerHTML = html;
}

function buildCuentaTree(account, all, depth = 0, admin = false) {
  const children = all.filter(c => c.parentId === account.id);
  const inactiveStyle = admin && !account.isActive ? ' style="opacity:0.5"' : '';
  const inactiveLabel = admin && !account.isActive ? ' (inactiva)' : '';
  const actions = admin
    ? `<span class="cuenta-actions"><button onclick="editCuenta('${account.id}')" class="btn-sm" title="Editar">✏️</button></span>`
    : '';
  let html = `<div class="cuenta-row" style="padding-left:${depth * 20 + 8}px"${inactiveStyle}>
    <span class="cuenta-code">${account.code}</span>
    <span class="cuenta-name">${account.name}${inactiveLabel}</span>
    ${actions}
  </div>`;
  for (const child of children) {
    html += buildCuentaTree(child, all, depth + 1, admin);
  }
  return html;
}

// ── Cierres de año fiscal (Panel Admin de la empresa) ──
async function loadPanelCierresAdmin() {
  const el = document.getElementById('cierres-admin-list');
  if (!el) return;
  el.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:#6b7280">Cargando...</td></tr>';
  try {
    const res = await authFetch(`${API_URL}/year-close`);
    const d = await res.json();
    if (!Array.isArray(d) || !d.length) {
      el.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:#6b7280">No hay asientos de cierre. Usa Calendario Fiscal para cerrar el año.</td></tr>';
      return;
    }
    el.innerHTML = d.map(c => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0"><strong>${escapeHtml(c.period || '—')}</strong></td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${new Date(c.date).toLocaleDateString('es-PA')}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${c.status === 'ANULADO' ? '<span style="color:#dc2626">ANULADO</span>' : '<span style="color:#059669">CONFIRMADO</span>'}</td>
        <td style="text-align:right;padding:8px 10px;border-bottom:1px solid #f0f0f0">$${(c.totalDebit || 0).toFixed(2)}</td>
        <td style="text-align:right;padding:8px 10px;border-bottom:1px solid #f0f0f0">$${(c.totalCredit || 0).toFixed(2)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${c.status !== 'ANULADO' ? `<button onclick="promptAnnulEmpresaCierre('${c.id}')" style="padding:4px 10px;font-size:11px;background:#dc2626;color:#fff;border:none;border-radius:5px;cursor:pointer">🗑 Anular</button>` : ''}</td>
      </tr>`).join('');
  } catch (e) {
    el.innerHTML = '<tr><td colspan="6" style="padding:16px;text-align:center;color:#dc2626">Error al cargar</td></tr>';
  }
}

function promptAnnulEmpresaCierre(id) {
  askPassword('Ingresa la clave para anular el asiento de cierre:').then(clave => {
    if (clave) annulEmpresaCierre(id, clave);
  });
}

async function annulEmpresaCierre(id, clave) {
  try {
    const res = await authFetch(`${API_URL}/year-close/${id}/anular`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clave }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('❌ ' + (e.error || 'Error al anular'));
      return;
    }
    alert('✅ Asiento de cierre anulado. Puedes volver a cerrar el año desde Calendario Fiscal.');
    loadPanelCierresAdmin();
  } catch (e) { alert('❌ Error de conexión'); }
}

/* ── Usuarios de la empresa (admin/superadmin) ── */
async function loadPanelUsuariosAdmin() {
  const me = getUser();
  const btn = document.getElementById('tab-usuarios-admin');
  if (btn) btn.style.display = (me?.role === 'contador') ? 'none' : '';
  if (me?.role === 'contador') return;
  const list = document.getElementById('usuarios-admin-list');
  const count = document.getElementById('usuarios-admin-count');
  try {
    const res = await authFetch(`${API_URL}/users`);
    if (!res.ok) { list.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:#dc2626">Sin permiso para ver usuarios</td></tr>'; return; }
    const users = await res.json();
    count.textContent = `${users.length} usuario(s) de la empresa`;
    if (!users.length) {
      list.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:#6b7280">Sin usuarios adicionales. Crea el primero con "+ Nuevo usuario".</td></tr>';
      return;
    }
    const roleBadge = r => ({ admin: ['Dueño', '#7c3aed', '#f5f3ff'], contador: ['Contador', '#0369a1', '#f0f9ff'], asistente: ['Asistente', '#6b7280', '#f3f4f6'] }[r] || [r, '#6b7280', '#f3f4f6']);
    const rows = users.map(u => {
      const [rl, rc, rb] = roleBadge(u.role);
      const esYo = me && u.id === me.id;
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${escapeHtml(u.name)}${esYo ? ' <span style="font-size:10px;color:#6b7280">(tú)</span>' : ''}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${escapeHtml(u.email)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0"><span style="font-size:11px;background:${rb};color:${rc};padding:2px 8px;border-radius:10px;font-weight:600">${rl}</span></td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${u.isActive ? '<span style="color:#059669;font-size:12px;font-weight:600">✅ Activo</span>' : '<span style="color:#dc2626;font-size:12px;font-weight:600">⛔ Desactivado</span>'}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap">
          ${esYo || u.role === 'admin' || u.role === 'superadmin' ? '' : `<button onclick="openEditarUsuario('${u.id}')" style="padding:4px 9px;font-size:11px;background:#4b5563;color:#fff;border:none;border-radius:4px;cursor:pointer">✏️</button>
          <button onclick="${u.isActive ? 'desactivarUsuario' : 'reactivarUsuario'}('${u.id}')" style="padding:4px 9px;font-size:11px;background:${u.isActive ? '#ef4444' : '#059669'};color:#fff;border:none;border-radius:4px;cursor:pointer">${u.isActive ? '⛔' : '▶️'}</button>`}
          <button onclick="resetPassUsuario('${u.id}')" title="Enviar email de reset de contraseña" style="padding:4px 9px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">🔁</button>
        </td>
      </tr>`;
    });
    list.innerHTML = rows.join('');
  } catch (e) { list.innerHTML = '<tr><td colspan="5" style="padding:16px;text-align:center;color:#dc2626">Error de conexión</td></tr>'; }
}

function openCrearUsuario() {
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:420px">
    <div style="font-weight:700;font-size:16px;margin-bottom:14px">👥 Nuevo usuario</div>
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Nombre</label>
    <input id="nu-name" placeholder="Nombre completo" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Email</label>
    <input id="nu-email" type="email" placeholder="usuario@empresa.com" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Rol</label>
    <select id="nu-rol" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
      <option value="contador">Contador — registra y revisa la contabilidad</option>
      <option value="asistente">Asistente — acceso básico</option>
    </select>
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Contraseña inicial (mín. 6 caracteres — entrégasela al usuario)</label>
    <input id="nu-pass" type="password" placeholder="••••••••" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <div style="font-size:11px;color:#6b7280;margin-top:8px">💡 También puedes enviar un email de restablecimiento desde el listado (🔁).</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button class="app-dialog-btn" onclick="this.closest('.app-dialog-overlay').remove()">Cancelar</button>
      <button class="app-dialog-btn primary" onclick="guardarUsuarioNuevo(this)">💾 Crear</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

async function guardarUsuarioNuevo(btn) {
  const body = {
    name: document.getElementById('nu-name').value,
    email: document.getElementById('nu-email').value,
    role: document.getElementById('nu-rol').value,
    password: document.getElementById('nu-pass').value,
  };
  const res = await authFetch(`${API_URL}/users`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!res.ok) { await showAlert(`❌ ${d.error || 'Error'}`); return; }
  btn.closest('.app-dialog-overlay').remove();
  await showAlert(`✅ Usuario creado (${d.role}): ${escapeHtml(d.name)}`);
  loadPanelUsuariosAdmin();
}

async function openEditarUsuario(id) {
  const res = await authFetch(`${API_URL}/users`);
  const users = await res.json();
  const u = users.find(x => x.id === id);
  if (!u) return;
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:420px">
    <div style="font-weight:700;font-size:16px;margin-bottom:14px">✏️ Editar usuario — ${escapeHtml(u.name)}</div>
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Nombre</label>
    <input id="eu-name" value="${escapeHtml(u.name || '')}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Rol</label>
    <select id="eu-rol" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">
      <option value="contador" ${u.role === 'contador' ? 'selected' : ''}>Contador</option>
      <option value="asistente" ${u.role === 'asistente' ? 'selected' : ''}>Asistente</option>
    </select>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button class="app-dialog-btn" onclick="this.closest('.app-dialog-overlay').remove()">Cancelar</button>
      <button class="app-dialog-btn primary" onclick="guardarUsuarioEditado('${id}', this)">💾 Guardar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

async function guardarUsuarioEditado(id, btn) {
  const body = { name: document.getElementById('eu-name').value, role: document.getElementById('eu-rol').value };
  const res = await authFetch(`${API_URL}/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await res.json();
  if (!res.ok) { await showAlert(`❌ ${d.error || 'Error'}`); return; }
  btn.closest('.app-dialog-overlay').remove();
  loadPanelUsuariosAdmin();
}

async function desactivarUsuario(id) {
  const ok = await showConfirm('¿Desactivar este usuario? No podrá iniciar sesión hasta reactivarlo.');
  if (!ok) return;
  const res = await authFetch(`${API_URL}/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: false }),
  });
  const d = await res.json();
  if (!res.ok) { await showAlert(`❌ ${d.error || 'Error'}`); return; }
  loadPanelUsuariosAdmin();
}
async function reactivarUsuario(id) {
  const res = await authFetch(`${API_URL}/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isActive: true }),
  });
  const d = await res.json();
  if (!res.ok) { await showAlert(`❌ ${d.error || 'Error'}`); return; }
  loadPanelUsuariosAdmin();
}

async function resetPassUsuario(id) {
  const res = await authFetch(`${API_URL}/users`);
  const users = await res.json();
  const u = users.find(x => x.id === id);
  if (!u) return;
  const ok = await showConfirm(`¿Enviar email de restablecimiento de contraseña a <strong>${escapeHtml(u.email)}</strong>?`);
  if (!ok) return;
  const r2 = await fetch(`${API_URL}/auth/forgot-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: u.email }),
  });
  const d = await r2.json().catch(() => ({}));
  await showAlert(d.success || d.ok ? '✅ Email de restablecimiento enviado.' : (d.error ? `❌ ${d.error}` : '✅ Si el correo existe, se envió el enlace.'));
}
