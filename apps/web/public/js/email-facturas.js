// email-facturas.js — Tarjeta «Facturas por correo» de Administración → Configuración.
//
// La contraseña del buzón NUNCA llega al navegador: si el campo va vacío, el PUT
// no la manda y el servidor deja la que tenía. Para borrarla hay un botón explícito
// (una contraseña vacía por descuido no puede apagar el buzón).
let efConfig = null;
let efBorrarPassword = false;

function efEsc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadPanelEmailFacturas() {
  const card = document.getElementById('email-facturas-card');
  if (!card) return;
  try {
    const res = await authFetch(`${API_URL}/facturas-email/config`);
    if (!res.ok) throw new Error('No se pudo cargar la configuración');
    efConfig = await res.json();
    efBorrarPassword = false;
    efPintar(efConfig);
  } catch (e) {
    card.innerHTML = '<div class="admin-form-card"><h4>📧 Facturas por correo</h4><div style="color:#b91c1c;font-size:13px">No se pudo cargar la configuración del buzón.</div></div>';
  }
}

/**
 * Pinta el formulario y le carga los valores guardados. Los `<option>` se
 * generan sin `selected` y el valor se asigna después: es una sola forma de
 * pintar y no dos (el HTML con el seleccionado adentro y el JS afuera).
 */
function efPintar(cfg) {
  const card = document.getElementById('email-facturas-card');
  card.innerHTML = efFormularioHTML(cfg);
  const set = (id, valor) => { const el = document.getElementById(id); if (el) el.value = valor; };
  set('ef-activo', cfg.isActive ? 'true' : 'false');
  set('ef-modo', cfg.modo || 'IMAP');
  set('ef-host', cfg.imapHost || '');
  set('ef-port', cfg.imapPort || 993);
  set('ef-user', cfg.imapUser || '');
  set('ef-folder', cfg.imapFolder || 'INBOX');
  set('ef-marcar', cfg.marcarLeido ? 'true' : 'false');
  set('ef-mover', cfg.carpetaMover || '');
  set('ef-cuenta', cfg.cuentaPagoId || '');
  set('ef-concepto', cfg.conceptoDefaultId || '');
}

function efFormularioHTML(cfg) {
  const optCuenta = (c) => `<option value="${c.id}">${efEsc(c.code)} — ${efEsc(c.name)}</option>`;
  const optConcepto = (c) => `<option value="${c.id}">${efEsc(c.name)}</option>`;

  // Sin cuentas de banco no hay nada que elegir: se dice qué falta y dónde se crea.
  const sinCuentas = !cfg.cuentasPago.length
    ? `<div style="grid-column:1/-1;font-size:12px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px">
         No hay cuentas de banco en el catálogo. Créalas en <strong>Administración → Cuentas</strong> con el código 1.1.02.* para poder elegir la contrapartida.</div>`
    : '';

  const tienePass = cfg.tienePassword;
  const estado = efEstadoHTML(cfg);

  return `
  <div class="admin-form-card">
    <h4>📧 Facturas por correo</h4>
    <p style="font-size:12px;color:#6b7280;margin:0 0 4px 0">
      Lee el buzón que le indiques y carga las facturas DGI que mandan los proveedores
      (PDF adjunto, XML o link del CUTE) como <strong>asiento BORRADOR</strong>, para aprobar en Revisión.
    </p>
    <div class="form-grid">
      ${sinCuentas}
      <div>
        <label>Leer el buzón</label>
        <select id="ef-activo" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="false">❌ No</option>
          <option value="true">✅ Sí</option>
        </select>
      </div>
      <div>
        <label>Modo</label>
        <select id="ef-modo" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="IMAP">IMAP — el buzón de la empresa</option>
          <option value="CENTRAL" disabled>Reenvío al buzón del sistema (próximamente)</option>
        </select>
      </div>
      <div>
        <label>Servidor IMAP</label>
        <input type="text" id="ef-host" placeholder="imap.gmail.com" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
      </div>
      <div>
        <label>Puerto</label>
        <input type="number" id="ef-port" value="993" min="1" max="65535" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
      </div>
      <div>
        <label>Usuario</label>
        <input type="text" id="ef-user" placeholder="facturas@miempresa.com" autocomplete="off" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
      </div>
      <div>
        <label>Contraseña ${tienePass ? '<span style="color:#059669">(guardada)</span>' : ''}</label>
        <input type="password" id="ef-pass" autocomplete="new-password"
          placeholder="${tienePass ? '•••••••• (vacío = sin cambios)' : 'Contraseña o app password'}"
          style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
        <div id="ef-pass-nota" style="font-size:11px;color:#6b7280;margin-top:4px">
          ${tienePass
            ? '<a href="#" onclick="efMarcarBorrarPassword();return false" style="color:#b91c1c">Borrar la contraseña guardada</a>'
            : 'Se guarda cifrada. En Gmail, con verificación en dos pasos, hay que usar una <strong>app password</strong>.'}
        </div>
      </div>
      <div>
        <label>Carpeta</label>
        <input type="text" id="ef-folder" placeholder="INBOX" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
      </div>
      <div style="min-width:100%">
        <label>Cuenta de contrapartida <span style="color:#b91c1c">*</span></label>
        <select id="ef-cuenta" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="">— Sin definir —</option>
          ${cfg.cuentasPago.map(optCuenta).join('')}
        </select>
        <div style="font-size:11px;color:#6b7280;margin-top:4px">
          Los asientos acreditan esta cuenta de banco (método ${efEsc(cfg.metodoPago)}). La compra es al contado:
          nunca Caja ni cuentas por pagar.
        </div>
      </div>
      <div>
        <label>Concepto por defecto (opcional)</label>
        <select id="ef-concepto" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="">— Ninguno —</option>
          ${cfg.conceptos.map(optConcepto).join('')}
        </select>
      </div>
      <div>
        <label>Marcar los correos como leídos</label>
        <select id="ef-marcar" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="false">❌ No</option>
          <option value="true">✅ Sí</option>
        </select>
      </div>
      <div>
        <label>Mover a la carpeta (opcional)</label>
        <input type="text" id="ef-mover" placeholder="Ej: Procesados" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
      </div>
    </div>
    <div style="font-size:11px;color:#6b7280;margin-top:8px">
      El sistema lleva su propio registro de los correos ya leídos: no hace falta marcar ni mover nada en el buzón.
    </div>
    <div style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <button class="btn-primary" id="ef-btn-guardar" onclick="efGuardar()" style="padding:8px 18px;border:none;border-radius:8px;background:#1565c0;color:#fff;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">💾 Guardar</button>
      <button class="btn-secondary" id="ef-btn-probar" onclick="efProbar()" style="padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">🔌 Probar conexión</button>
      <span id="ef-msg" style="font-size:13px;font-weight:600"></span>
    </div>
    ${estado}
  </div>`;
}

/** Estado de la última corrida (lo llena el barrido; vacío hasta que exista). */
function efEstadoHTML(cfg) {
  if (!cfg.ultimaCorridaAt && !cfg.ultimoEstado) return '';
  const cuando = cfg.ultimaCorridaAt ? new Date(cfg.ultimaCorridaAt).toLocaleString('es-PA') : '';
  const color = cfg.ultimoEstado === 'OK' ? '#059669' : '#92400e';
  return `<div style="margin-top:10px;font-size:12px;color:${color}">
    Última revisión: ${cuando}${cfg.ultimoEstado ? ` — ${efEsc(cfg.ultimoEstado)}` : ''}
    ${cfg.ultimoDetalle ? `<div style="color:#6b7280">${efEsc(cfg.ultimoDetalle)}</div>` : ''}
  </div>`;
}

function efMarcarBorrarPassword() {
  efBorrarPassword = !efBorrarPassword;
  const nota = document.getElementById('ef-pass-nota');
  const input = document.getElementById('ef-pass');
  if (efBorrarPassword) {
    nota.innerHTML = '<span style="color:#b91c1c">La contraseña guardada se borrará al guardar.</span> <a href="#" onclick="efMarcarBorrarPassword();return false" style="color:#1565c0">Deshacer</a>';
    input.value = '';
    input.disabled = true;
  } else {
    input.disabled = false;
    nota.innerHTML = '<a href="#" onclick="efMarcarBorrarPassword();return false" style="color:#b91c1c">Borrar la contraseña guardada</a>';
  }
}

/** Lo que se manda al servidor: solo la contraseña que el usuario escribió. */
function efCuerpo() {
  const val = (id) => document.getElementById(id).value;
  const cuerpo = {
    isActive: val('ef-activo') === 'true',
    modo: val('ef-modo'),
    imapHost: val('ef-host').trim() || null,
    imapPort: parseInt(val('ef-port'), 10) || 993,
    imapUser: val('ef-user').trim() || null,
    imapFolder: val('ef-folder').trim() || 'INBOX',
    marcarLeido: val('ef-marcar') === 'true',
    carpetaMover: val('ef-mover').trim() || null,
    cuentaPagoId: val('ef-cuenta') || null,
    conceptoDefaultId: val('ef-concepto') || null,
  };
  const pass = val('ef-pass');
  if (efBorrarPassword) cuerpo.imapPassword = null;
  else if (pass) cuerpo.imapPassword = pass;
  return cuerpo;
}

function efMensaje(texto, color) {
  const el = document.getElementById('ef-msg');
  el.style.color = color;
  el.textContent = texto;
}

async function efGuardar() {
  const btn = document.getElementById('ef-btn-guardar');
  btn.disabled = true;
  efMensaje('Guardando…', '#6b7280');
  try {
    const res = await authFetch(`${API_URL}/facturas-email/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(efCuerpo()),
    });
    const data = await res.json();
    if (!res.ok) { efMensaje(data.error || 'No se pudo guardar', '#b91c1c'); return; }
    // El servidor devuelve lo que quedó guardado (con `tienePassword` al día):
    // se repinta con eso y recién ahí se confirma, que el repintado borra el aviso.
    efConfig = data;
    efBorrarPassword = false;
    efPintar(data);
    efMensaje('✅ Guardado', '#059669');
  } catch (e) {
    efMensaje('Error de conexión', '#b91c1c');
  } finally {
    btn.disabled = false;
  }
}

async function efProbar() {
  const btn = document.getElementById('ef-btn-probar');
  btn.disabled = true;
  efMensaje('Probando…', '#6b7280');
  try {
    // Se prueba lo que está escrito en pantalla, sin guardarlo: para eso está.
    const cuerpo = efCuerpo();
    const res = await authFetch(`${API_URL}/facturas-email/probar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const data = await res.json();
    if (data.ok) {
      efMensaje(`✅ Conexión correcta (${data.carpetas.length} carpetas)`, '#059669');
    } else {
      efMensaje(`❌ ${data.error || 'No se pudo conectar'}`, '#b91c1c');
    }
  } catch (e) {
    efMensaje('Error de conexión', '#b91c1c');
  } finally {
    btn.disabled = false;
  }
}
