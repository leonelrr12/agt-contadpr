// empresa.js (15/15) — Administración → Empresa: ficha fiscal + logo/sello.
//
// El alta de una empresa solo pide nombre y RUC (despacho.js): esto es lo que se
// completa después. El logo es el MISMO `Company.logo` que usa Facturas PDF, así
// que lo que se guarda acá aparece en el PDF de venta sin pasos extra.

let empresaPerfilActual = null;
/** Imágenes que el usuario pidió QUITAR (solo se manda si no eligió una nueva). */
let empresaQuitar = { logo: false, sello: false };

async function loadPanelEmpresa() {
  const el = document.getElementById('empresa-content');
  if (!el) return;
  el.innerHTML = '<div class="empty">Cargando perfil…</div>';
  try {
    const res = await authFetch(`${API_URL}/companies/current`);
    if (!res.ok) {
      el.innerHTML = '<div class="empty">No se pudo cargar el perfil de la empresa</div>';
      return;
    }
    empresaPerfilActual = await res.json();
    empresaQuitar = { logo: false, sello: false };
    el.innerHTML = renderEmpresaPerfil(empresaPerfilActual);
    initEmpresaDropzones();
  } catch {
    el.innerHTML = '<div class="empty">Error de conexión</div>';
  }
}

function renderEmpresaPerfil(d) {
  const v = (x) => escapeHtml(x || '');
  const dropzone = (name, label, dataUrl) => `
    <div>
      <label>${label}</label>
      <div class="emp-dropzone" id="emp-${name}-drop">
        <img id="emp-${name}-preview" class="emp-preview${dataUrl ? '' : ' hidden'}" src="${dataUrl || ''}" alt="${label}">
        <p class="emp-drop-text">Arrastrá una imagen o hacé clic para seleccionar</p>
        <p class="emp-drop-file" id="emp-${name}-file" data-tenia="${dataUrl ? '1' : '0'}">PNG, JPG o similar — máx. 2 MB</p>
        <input id="emp-${name}-input" type="file" accept="image/*" class="hidden">
      </div>
      <button type="button" class="btn-sm" id="emp-${name}-quitar" style="margin-top:6px${dataUrl ? '' : ';display:none'}">Quitar ${label.toLowerCase()}</button>
    </div>`;

  return `
    <div class="admin-form-card">
      <h4>🏢 Datos generales</h4>
      <div class="form-grid">
        <div style="grid-column:1/-1">
          <label>Nombre *</label>
          <input id="emp-nombre" maxlength="120" required value="${v(d.name)}">
        </div>
        <div>
          <label>RUC</label>
          <input id="emp-ruc" maxlength="50" value="${v(d.taxId)}" placeholder="8-733-2267">
        </div>
        <div>
          <label>DV</label>
          <input id="emp-dv" maxlength="2" value="${v(d.dv)}" placeholder="88">
          <div class="emp-note">El dígito verificador de la ficha de la DGI. Si pegás el RUC completo, se separa solo al guardar.</div>
        </div>
        <div>
          <label>Tipo de entidad</label>
          <input id="emp-tipo" maxlength="100" value="${v(d.tipoEntidad)}" placeholder="Persona natural / jurídica">
        </div>
        <div>
          <label>Actividad económica</label>
          <input id="emp-actividad" maxlength="100" value="${v(d.actividadEconomica)}">
        </div>
        <div>
          <label>No. patronal</label>
          <input id="emp-patronal" maxlength="100" value="${v(d.noPatronal)}">
        </div>
        <div>
          <label>Fecha de apertura</label>
          <input id="emp-apertura" type="date" value="${v(d.fechaApertura)}">
        </div>
      </div>
    </div>

    <div class="admin-form-card">
      <h4>📇 Contacto</h4>
      <div class="form-grid">
        <div style="grid-column:1/-1">
          <label>Dirección</label>
          <textarea id="emp-direccion" rows="2" maxlength="300" class="emp-textarea">${v(d.address)}</textarea>
        </div>
        <div>
          <label>Teléfono</label>
          <input id="emp-telefono" maxlength="50" value="${v(d.phone)}">
        </div>
        <div>
          <label>Email</label>
          <input id="emp-email" type="email" maxlength="150" value="${v(d.email)}">
        </div>
      </div>
    </div>

    <div class="admin-form-card">
      <h4>📝 Observaciones</h4>
      <textarea id="emp-observaciones" rows="4" maxlength="10000" class="emp-textarea">${v(d.observaciones)}</textarea>
      <div class="emp-note">Notas internas de esta empresa (acuerdos, pendientes, particularidades). No se imprimen ni afectan la contabilidad.</div>
    </div>

    <div class="admin-form-card">
      <h4>🖼 Imágenes</h4>
      <div class="form-grid">
        ${dropzone('logo', 'Logo', d.logoDataUrl)}
        ${dropzone('sello', 'Sello', d.selloDataUrl)}
      </div>
      <div class="emp-note" style="margin-top:8px">El logo sale en el PDF de las facturas de venta. El sello queda guardado para los documentos que lo lleven.</div>
    </div>

    <div style="display:flex;align-items:center;gap:12px;margin-top:4px">
      <button class="btn-primary" onclick="saveEmpresa()" style="padding:8px 18px;border:none;border-radius:8px;background:#1565c0;color:#fff;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">💾 Guardar</button>
      <span id="emp-saved-msg" style="display:none;color:#059669;font-size:13px;font-weight:600">✅ Guardado</span>
    </div>`;
}

function initEmpresaDropzones() {
  for (const name of ['logo', 'sello']) {
    const zone = document.getElementById(`emp-${name}-drop`);
    const input = document.getElementById(`emp-${name}-input`);
    const preview = document.getElementById(`emp-${name}-preview`);
    const fileLabel = document.getElementById(`emp-${name}-file`);
    const quitar = document.getElementById(`emp-${name}-quitar`);
    if (!zone || !input) continue;

    const mostrarArchivo = (file) => {
      if (!file || !String(file.type || '').startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        preview.src = e.target.result;
        preview.classList.remove('hidden');
      };
      reader.readAsDataURL(file);
      fileLabel.textContent = file.name;
      empresaQuitar[name] = false;
    };

    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => mostrarArchivo(input.files?.[0]));

    ['dragover', 'dragenter'].forEach((ev) => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.add('emp-dropzone-hover');
    }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
      e.preventDefault();
      zone.classList.remove('emp-dropzone-hover');
    }));
    zone.addEventListener('drop', (e) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file || !String(file.type || '').startsWith('image/')) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      mostrarArchivo(file);
    });

    if (quitar) quitar.addEventListener('click', () => {
      input.value = '';
      preview.src = '';
      preview.classList.add('hidden');
      fileLabel.textContent = 'PNG, JPG o similar — máx. 2 MB';
      empresaQuitar[name] = fileLabel.dataset.tenia === '1';
      quitar.style.display = 'none';
    });
  }
}

async function saveEmpresa() {
  const nombre = document.getElementById('emp-nombre').value.trim();
  if (!nombre) {
    await showAlert('El nombre de la empresa es obligatorio.');
    return;
  }

  const form = new FormData();
  form.append('name', nombre);
  form.append('taxId', document.getElementById('emp-ruc').value.trim());
  form.append('dv', document.getElementById('emp-dv').value.trim());
  form.append('tipoEntidad', document.getElementById('emp-tipo').value.trim());
  form.append('actividadEconomica', document.getElementById('emp-actividad').value.trim());
  form.append('noPatronal', document.getElementById('emp-patronal').value.trim());
  form.append('fechaApertura', document.getElementById('emp-apertura').value);
  form.append('address', document.getElementById('emp-direccion').value.trim());
  form.append('phone', document.getElementById('emp-telefono').value.trim());
  form.append('email', document.getElementById('emp-email').value.trim());
  form.append('observaciones', document.getElementById('emp-observaciones').value);

  for (const name of ['logo', 'sello']) {
    const file = document.getElementById(`emp-${name}-input`)?.files?.[0];
    if (file) form.append(name, file);
    else if (empresaQuitar[name]) form.append(name === 'logo' ? 'removeLogo' : 'removeSello', 'true');
  }

  try {
    const res = await authFetch(`${API_URL}/companies/current`, { method: 'PATCH', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await showAlert(data.error || 'No se pudo guardar el perfil de la empresa.');
      return;
    }

    // El nombre de la empresa se ve en el sidebar y en el selector de empresas:
    // se actualiza la sesión local para no tener que recargar la página.
    const u = getUser() || {};
    if (u.company) {
      u.company.name = data.name;
      u.company.taxId = data.taxId;
    }
    if (Array.isArray(u.empresas)) {
      u.empresas = u.empresas.map((e) => (e.id === data.id ? { ...e, name: data.name } : e));
    }
    localStorage.setItem('agt_user', JSON.stringify(u));
    if (typeof pintarSelectorEmpresa === 'function') pintarSelectorEmpresa(u);

    await loadPanelEmpresa();
    const msg = document.getElementById('emp-saved-msg');
    if (msg) {
      msg.style.display = 'inline';
      setTimeout(() => { msg.style.display = 'none'; }, 2000);
    }
  } catch {
    await showAlert('Error de conexión');
  }
}
