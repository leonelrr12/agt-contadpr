// email-facturas.js — Tarjeta «Facturas por correo» de Administración → Configuración.
//
// La contraseña del buzón NUNCA llega al navegador: si el campo va vacío, el PUT
// no la manda y el servidor deja la que tenía. Para borrarla hay un botón explícito
// (una contraseña vacía por descuido no puede apagar el buzón).
let efConfig = null;
let efBorrarPassword = false;

/** Los estados del ledger, con su color y su texto para el contador. */
const EF_ESTADOS = {
  DETECTADA: { color: '#1565c0', texto: 'detectada' },
  CARGADA: { color: '#059669', texto: 'cargada' },
  DUPLICADA: { color: '#92400e', texto: 'duplicada' },
  SIN_FACTURA: { color: '#6b7280', texto: 'sin factura' },
  SIN_ADJUNTOS: { color: '#6b7280', texto: 'sin adjuntos' },
  SIN_DATOS: { color: '#92400e', texto: 'sin datos legibles' },
  OTRO_CLIENTE: { color: '#6b7280', texto: 'de otro cliente' },
  SIN_CUENTA: { color: '#92400e', texto: 'sin cuenta de contrapartida' },
  SIN_CONCEPTO: { color: '#92400e', texto: 'sin concepto' },
  CUOTA: { color: '#92400e', texto: 'cuota agotada' },
  PROCESANDO: { color: '#6b7280', texto: 'procesando' },
  INTERRUMPIDO: { color: '#b91c1c', texto: 'interrumpido' },
  ERROR: { color: '#b91c1c', texto: 'error' },
};

const efEstado = (e) => EF_ESTADOS[e] || { color: '#6b7280', texto: String(e || '').toLowerCase() };

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
  efCargarLedger();
}

/** Los últimos correos que vio el sistema, con lo que encontró en cada uno. */
async function efCargarLedger() {
  const el = document.getElementById('email-facturas-ledger');
  if (!el) return;
  try {
    const res = await authFetch(`${API_URL}/facturas-email/mensajes?limit=25`);
    const mensajes = await res.json();
    el.innerHTML = efLedgerHTML(Array.isArray(mensajes) ? mensajes : []);
  } catch (e) {
    el.innerHTML = '';
  }
}

function efLedgerHTML(mensajes) {
  const filas = mensajes.length
    ? mensajes.map(efFilaLedger).join('')
    : '<div style="color:#6b7280;font-size:13px;padding:10px 0">Todavía no se revisó el buzón.</div>';

  return `
  <div class="admin-form-card">
    <h4>📨 Últimos correos revisados</h4>
    <p style="font-size:12px;color:#6b7280;margin:0 0 8px 0">
      El sistema lleva su propio registro de los correos que ya vio: lo que aparece acá no se vuelve a procesar.
    </p>
    ${filas}
  </div>`;
}

function efFilaLedger(m) {
  const e = efEstado(m.estado);
  const cuando = m.recibidoAt || m.createdAt;
  const fecha = cuando ? new Date(cuando).toLocaleString('es-PA', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
  const facturas = Array.isArray(m.facturas) ? m.facturas : [];
  const adjuntos = Array.isArray(m.adjuntos) ? m.adjuntos : [];
  const detalleFacturas = facturas
    .map((f) => `${f.proveedor || 'Sin proveedor'}${f.total != null ? ` — $${Number(f.total).toFixed(2)}` : ''}${f.numeroFactura ? ` (${f.numeroFactura})` : ''} <span style="color:#6b7280">· ${f.via}</span>`)
    .join('<br>');
  const reprocesable = ['INTERRUMPIDO', 'ERROR', 'SIN_CUENTA', 'SIN_CONCEPTO', 'SIN_DATOS'].includes(m.estado);

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px;margin-bottom:8px;background:#fff">
    <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="font-size:13px;color:#1a1a2e;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${efEsc(m.asunto || '(sin asunto)')}</div>
        <div style="font-size:12px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${efEsc(m.remitente || '')}</div>
      </div>
      <div style="text-align:right;white-space:nowrap">
        <span style="font-size:11px;font-weight:700;color:${e.color}">${efEsc(e.texto)}</span>
        <div style="font-size:11px;color:#9ca3af">${fecha}</div>
      </div>
    </div>
    ${detalleFacturas ? `<div style="font-size:12px;color:#374151;margin-top:6px">${detalleFacturas}</div>` : ''}
    ${m.detalle ? `<div style="font-size:11px;color:#6b7280;margin-top:4px">${efEsc(m.detalle)}</div>` : ''}
    ${adjuntos.length ? `<div style="font-size:11px;color:#9ca3af;margin-top:4px">${adjuntos.length} adjunto(s): ${adjuntos.map((a) => efEsc(a.nombre || a.tipo || '—')).join(', ')}</div>` : ''}
    ${reprocesable ? `<div style="margin-top:6px"><button class="btn-secondary" style="padding:4px 10px;font-size:12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer" onclick="efReprocesar('${m.id}', this)">↻ Reprocesar</button></div>` : ''}
  </div>`;
}

async function efReprocesar(id, btn) {
  btn.disabled = true;
  btn.textContent = 'Reprocesando…';
  try {
    const res = await authFetch(`${API_URL}/facturas-email/mensajes/${id}/reprocesar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) await showAlert(data.error || 'No se pudo reprocesar');
    efCargarLedger();
  } catch (e) {
    await showAlert('Error de conexión');
    btn.disabled = false;
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
  set('ef-receptores', Array.isArray(cfg.receptorRucs) ? cfg.receptorRucs.join(', ') : (cfg.receptorRucs || ''));
  set('ef-cuenta', cfg.cuentaPagoId || '');
  set('ef-concepto', cfg.conceptoDefaultId || '');
  efCambioModo();
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
    ${cfg.isActive && (cfg.tienePassword || cfg.inboxAlias)
      ? '<div style="font-size:12px;color:#059669;font-weight:600;margin:6px 0">● Configurado y activo</div>'
      : '<div style="font-size:12px;color:#92400e;font-weight:600;margin:6px 0">● Sin terminar de configurar: completá los campos marcados y guardá con «Leer el buzón» en Sí</div>'}
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
        <select id="ef-modo" onchange="efCambioModo()" style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
          <option value="IMAP">IMAP — el buzón de la empresa</option>
          <option value="CENTRAL">Reenvío al buzón del sistema</option>
        </select>
        <div style="font-size:11px;color:#6b7280;margin-top:4px" id="ef-modo-nota"></div>
      </div>
      <div style="min-width:100%">
        <label>Dirección de reenvío ${cfg.inboxAlias ? '' : '<span style="color:#b91c1c">*</span>'}</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="text" id="ef-direccion" readonly value="${efEsc(cfg.direccionReenvio || '')}"
            placeholder="— sin generar —"
            style="flex:1;min-width:220px;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;font-family:ui-monospace,monospace;background:#f9fafb">
          <button type="button" class="btn-secondary" onclick="efCopiarDireccion()" style="padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;font-size:13px;font-family:inherit">📋 Copiar</button>
          <button type="button" class="btn-secondary" onclick="efGenerarAlias(this)" style="padding:8px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;font-size:13px;font-family:inherit">${cfg.inboxAlias ? '🔄 Rotar' : '✨ Generar'}</button>
        </div>
        <div style="font-size:11px;color:#6b7280;margin-top:4px">
          Los proveedores reenvían la factura a esa dirección (o la mandan directo) y el sistema la carga a nombre de esta empresa.
          ${cfg.inboxAlias ? 'Rotarla invalida la anterior en el acto.' : ''}
          Solo se abre el cuerpo de los correos dirigidos a una dirección registrada.
        </div>
      </div>
      <div style="grid-column:1/-1;border-top:1px solid #e5e7eb;padding-top:10px;margin-top:2px">
        <div style="font-size:12px;font-weight:700;color:#374151">🔑 Datos del buzón (modo IMAP)</div>
        <div style="font-size:11px;color:#6b7280">Lo que pide el servidor de correo de la empresa. En modo «Reenvío al buzón del sistema» no se usan.</div>
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
      <div style="min-width:100%">
        <label>Aceptar facturas a nombre de (opcional)</label>
        <input type="text" id="ef-receptores" placeholder="Tu cédula o RUC personal, ej: 8-123-4567 — separá varios con comas"
          style="width:100%;padding:9px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:14px;font-family:inherit">
        <div style="font-size:11px;color:#6b7280;margin-top:4px">
          Por defecto solo se cargan las facturas a nombre de la empresa. Si comprás a tu nombre personal (lo normal
          cuando la factura no lleva el RUC de la empresa), agregá acá esa cédula o RUC y esas facturas también entran.
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
      Con el modo <strong>Reenvío al buzón del sistema</strong> no hacen falta credenciales: alcanza con la dirección de reenvío.
    </div>
    <div style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <button class="btn-primary" id="ef-btn-guardar" onclick="efGuardar()" style="padding:8px 18px;border:none;border-radius:8px;background:#1565c0;color:#fff;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">💾 Guardar</button>
      <button class="btn-secondary" id="ef-btn-probar" onclick="efProbar()" style="padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">🔌 Probar conexión</button>
      <button class="btn-secondary" id="ef-btn-revisar" onclick="efRevisar()" style="padding:8px 18px;border:1px solid #d1d5db;border-radius:8px;background:#fff;color:#374151;font-weight:600;cursor:pointer;font-size:14px;font-family:inherit">🔄 Revisar ahora</button>
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

/** La nota que explica qué hace el modo elegido. */
function efCambioModo() {
  const modo = document.getElementById('ef-modo').value;
  const nota = document.getElementById('ef-modo-nota');
  if (!nota) return;
  nota.textContent =
    modo === 'CENTRAL'
      ? 'La empresa no da credenciales: los correos llegan por la dirección de reenvío.'
      : 'Se lee el buzón de la empresa con sus propias credenciales.';
}

/** Copia la dirección; en http (sin contexto seguro) `navigator.clipboard` no existe. */
function efCopiarDireccion() {
  const input = document.getElementById('ef-direccion');
  const texto = input?.value || '';
  if (!texto) { efMensaje('Todavía no hay dirección generada', '#92400e'); return; }
  const listo = () => efMensaje('📋 Dirección copiada', '#059669');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(texto).then(listo).catch(() => efCopiarViejo(input, listo));
  } else {
    efCopiarViejo(input, listo);
  }
}

function efCopiarViejo(input, listo) {
  input.removeAttribute('readonly');
  input.select();
  try { document.execCommand('copy'); listo(); } catch { efMensaje('No se pudo copiar: seleccionala a mano', '#b91c1c'); }
  input.setAttribute('readonly', 'readonly');
}

/** Genera o rota la dirección de reenvío (el alias que rutea los correos). */
async function efGenerarAlias(btn) {
  const hay = !!document.getElementById('ef-direccion')?.value;
  if (hay && !(await showConfirm('Rotar la dirección invalida la anterior: los correos que lleguen a la vieja dejan de cargarse. ¿Seguir?'))) return;
  btn.disabled = true;
  try {
    const res = await authFetch(`${API_URL}/facturas-email/inbox/generar`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { await showAlert(data.error || 'No se pudo generar la dirección'); return; }
    efConfig = data;
    efBorrarPassword = false;
    efPintar(data);
    efMensaje('✅ Dirección generada', '#059669');
  } catch (e) {
    await showAlert('Error de conexión');
  } finally {
    btn.disabled = false;
  }
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
    receptorRucs: val('ef-receptores').trim() || null,
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

/** De los nombres de campo de la API a los ids de la pantalla. */
const EF_CAMPOS = { imapHost: 'ef-host', imapUser: 'ef-user', imapPassword: 'ef-pass', imapFolder: 'ef-folder', cuentaPagoId: 'ef-cuenta' };

/**
 * Marca en rojo los campos que faltan y lleva la pantalla hasta ellos.
 *
 * El mensaje solo («faltan el servidor y el usuario») obliga a buscarlos en un
 * formulario largo; que el campo se pinte y la pantalla se acomode es lo que
 * hace que se vea DÓNDE se configura.
 */
function efSenalarCampos(campos) {
  for (const id of Object.values(EF_CAMPOS)) {
    const el = document.getElementById(id);
    if (el) el.style.borderColor = '#d1d5db';
  }
  const primeros = (campos || []).map((c) => EF_CAMPOS[c]).filter(Boolean);
  for (const id of primeros) {
    const el = document.getElementById(id);
    if (el) el.style.borderColor = '#dc2626';
  }
  const primero = primeros.length ? document.getElementById(primeros[0]) : null;
  if (primero) {
    primero.scrollIntoView({ behavior: 'smooth', block: 'center' });
    primero.focus({ preventScroll: true });
  }
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
    if (!res.ok) {
      efMensaje(data.error || 'No se pudo guardar', '#b91c1c');
      efSenalarCampos(data.campos);
      return;
    }
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

/**
 * «Revisar ahora»: barre el buzón. Guarda primero lo que está en pantalla —quien
 * toca el botón acaba de cambiar algo y espera que se use lo que escribió— y
 * después muestra lo que encontró.
 */
async function efRevisar() {
  const btn = document.getElementById('ef-btn-revisar');
  btn.disabled = true;
  efMensaje('Revisando el buzón…', '#6b7280');
  try {
    const guardado = await authFetch(`${API_URL}/facturas-email/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(efCuerpo()),
    });
    if (!guardado.ok) {
      const e = await guardado.json();
      efMensaje(`❌ ${e.error || 'No se pudo guardar antes de revisar'}`, '#b91c1c');
      efSenalarCampos(e.campos);
      return;
    }
    const res = await authFetch(`${API_URL}/facturas-email/revisar`, { method: 'POST' });
    const r = await res.json();
    efMensaje(
      r.ok
        ? `✅ ${r.revisados} correo(s), ${r.facturas} factura(s) detectada(s)`
        : `❌ ${r.detalle || r.codigo || 'No se pudo revisar'}`,
      r.ok ? '#059669' : '#b91c1c',
    );
    efCargarLedger();
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
