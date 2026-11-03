// init.js (7/14) — export, logout y bootstrap DOMContentLoaded
/* ── Exportar reportes ── */
async function exportReport(reportType, format = 'xlsx') {
  const from = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-from`);
  const to = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-to`);
  const statusEl = document.getElementById('filter-diario-status');

  let url = `${API_URL}/reports/export/${reportType}?format=${format}`;
  if (from && from.value) url += `&startDate=${from.value}`;
  if (to && to.value) url += `&endDate=${to.value}`;
  if (statusEl && reportType === 'diario' && statusEl.value) url += `&status=${statusEl.value}`;

  try {
    const res = await authFetch(url);
    if (!res.ok) {
      const err = await res.json();
      await showAlert('Error al exportar: ' + (err.error || 'Error desconocido'));
      return;
    }
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
    a.download = filenameMatch ? filenameMatch[1] : `${reportType}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
  } catch (e) {
    await showAlert('Error de conexión al exportar');
  }
}

/**
 * El nombre de la empresa en el sidebar. Si la cuenta trabaja en más de una
 * —un contador de despacho— pasa a ser un desplegable: cambiar de empresa pide
 * un token nuevo (el mismo usuario, otra empresa) y recarga la pantalla, así
 * todos los paneles se rearman con los datos de la empresa elegida.
 */
function pintarSelectorEmpresa(user) {
  const el = document.getElementById('sidebar-user-company');
  if (!el || !user) return;
  const empresas = user.empresas || [];
  const actual = user.company?.id;

  // «Mis empresas» se muestra cuando hay más de una —para cambiar entre ellas—
  // o cuando el rol puede CREAR una: es el único lugar donde se da de alta una
  // empresa, así que esconderlo para quien tiene una sola le cierra justamente
  // el camino que viene a buscar (el segundo cliente de un despacho).
  const puedeCrear = ['admin', 'superadmin'].includes(user.role);
  const nav = document.getElementById('nav-despacho-link');
  if (nav) nav.style.display = empresas.length > 1 || puedeCrear ? '' : 'none';

  if (empresas.length < 2) {
    el.textContent = user.company?.name || '';
    el.classList.remove('sb-empresa-select');
    return;
  }

  const opciones = empresas
    .map((e) => `<option value="${e.id}"${e.id === actual ? ' selected' : ''}>${e.name}${e.role === 'contador' ? ' (contador)' : ''}</option>`)
    .join('');

  if (el.tagName === 'SELECT') {
    el.innerHTML = opciones;
    return;
  }
  const sel = document.createElement('select');
  sel.id = 'sidebar-user-company';
  sel.className = 'sb-empresa-select';
  sel.title = 'Cambiar de empresa';
  sel.innerHTML = opciones;
  sel.addEventListener('change', () => cambiarEmpresa(sel.value));
  el.replaceWith(sel);
}

/** Cambia la empresa activa: token nuevo y recarga. */
async function cambiarEmpresa(companyId) {
  try {
    const res = await authFetch(`${API_URL}/auth/switch-company`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      await showAlert(e.error || 'No se pudo cambiar de empresa');
      return;
    }
    const data = await res.json();
    localStorage.setItem('agt_token', data.token);
    localStorage.setItem('agt_user', JSON.stringify(data.user));
    window.location.reload();
  } catch {
    await showAlert('Error de conexión');
  }
}

async function logout() {
  if (!await showConfirm('¿Cerrar sesión? Se perderá cualquier transacción no guardada.')) return;
  localStorage.removeItem('agt_token');
  localStorage.removeItem('agt_user');
  window.location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', () => {
  const user = getUser();

  // El usuario de depósito no tiene nada que hacer acá: la API le responde 403 a
  // todo menos Inventario. Se lo manda a su página desde el arranque, así vale
  // para cualquier entrada (login, marcador o URL directa) y no solo para el login.
  if (user?.role === 'inventario') {
    window.location.replace('/inventario.html');
    return;
  }
  // El usuario de nómina, igual: la API solo le responde Planilla y Empleados.
  if (user?.role === 'planilla') {
    window.location.replace('/planilla.html');
    return;
  }

  if (user) {
    document.getElementById('sidebar-user-name').textContent = user.name;
    const chip = document.getElementById('chat-company-chip');
    if (chip && user.company?.name) {
      chip.textContent = user.company.name;
      chip.title = `Empresa activa: ${user.company.name}`;
    }
    pintarSelectorEmpresa(user);
    // El rol y las empresas llegan con /auth/me (core.js), que puede resolver
    // después de este punto: cuando llega, se repinta.
    window.addEventListener('agt:sesion', (e) => pintarSelectorEmpresa(e.detail));
    // Iniciales del avatar (el nombre ya viene resuelto por la API)
    const avatar = document.getElementById('sidebar-user-avatar');
    if (avatar) {
      avatar.textContent = (user.name || '').trim().split(/\s+/).slice(0, 2).map(p => p[0]).join('').toUpperCase() || '·';
    }

    // Mostrar panel de administración solo a admins/contadores de la empresa
    if (user.role === 'admin' || user.role === 'contador' || user.role === 'superadmin') {
      // display = '' para que mande el CSS (.nav-link es flex: mantiene el gap icono/texto)
      document.getElementById('nav-admin-link').style.display = '';
    }
    // Inventario: lo usan los roles que pueden mover mercancía, y también el
    // usuario de depósito, que no ve nada más del sistema.
    if (['admin', 'contador', 'superadmin', 'inventario'].includes(user.role)) {
      document.getElementById('nav-inventario-link').style.display = '';
    }
    // Planilla: la usan los roles de la contabilidad y el usuario de nómina.
    if (['admin', 'contador', 'superadmin', 'planilla'].includes(user.role)) {
      document.getElementById('nav-planilla-link').style.display = '';
    }
    // SaaS Admin (control de accesos) SOLO para el dueño de la plataforma
    if (user.role === 'superadmin') {
      document.getElementById('nav-saas-link').style.display = '';
    }
    // Con la visibilidad por rol ya aplicada, los grupos que quedaron sin
    // opciones (p. ej. Administración para un contador) no deben mostrarse.
    actualizarGruposNav();
  }

  // Cargar info de suscripción
  loadSubscriptionInfo();

  const hora = new Date().getHours();
  const saludo = hora < 12 ? '¡Buenos días!' : hora < 19 ? '¡Buenas tardes!' : '¡Buenas noches!';
  addMessage(`${saludo} Soy tu agente contable. ¿Qué deseas registrar hoy?`, 'assistant');
  pintarSugerenciasChat();
  cargarChatHoy();

  // ── Inicializar date picker persistente ──
  const datePicker = document.getElementById('capture-date-picker');
  if (datePicker) {
    datePicker.value = captureDate;
    datePicker.addEventListener('change', () => {
      captureDate = datePicker.value;
      dateBannerShown = false; // re-mostrar banner si el usuario cambia la fecha
      // Actualizar también la fecha en el banner si está visible
      const bannerDate = document.getElementById('capture-date-banner-date');
      if (bannerDate) bannerDate.textContent = formatDateForDisplay(captureDate);
    });
  }
});

/* ── Inicio del chat: sugerencias y resumen del día ──
 * La pantalla de arranque era solo un saludo y una lista de ejemplos en texto.
 * Ahora el usuario ve el trabajo pendiente y puede entrar a las pantallas que
 * más usa sin recorrer el menú. */

const CHAT_SUGERENCIAS = [
  'Compré combustible por $40 con tarjeta',
  'Vendí $250 en efectivo',
  'Pagué la electricidad',
  'Compra de mercancía por $100 con ITBMS a Distribuidora XYZ, crédito',
  'Pago de ITBMS por $150',
];

function pintarSugerenciasChat() {
  const cont = document.getElementById('chat-messages');
  if (!cont) return;
  const div = document.createElement('div');
  div.className = 'chat-suggestions';
  const titulo = document.createElement('div');
  titulo.className = 'chat-suggestions-title';
  titulo.textContent = 'Prueba con un ejemplo (puedes editarlo antes de enviar):';
  div.appendChild(titulo);
  for (const texto of CHAT_SUGERENCIAS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'suggestion-chip';
    btn.textContent = texto;
    btn.addEventListener('click', () => usarSugerencia(texto));
    div.appendChild(btn);
  }
  cont.appendChild(div);
  cont.scrollTop = cont.scrollHeight;
}

function usarSugerencia(texto) {
  showInput('escribir');
  const input = document.getElementById('message-input');
  if (!input) return;
  input.value = texto;
  input.focus();
  input.setSelectionRange(texto.length, texto.length);
}

/** Navega a un panel como si se hubiera tocado su enlace del menú. */
function irAPanel(view) {
  const link = document.querySelector(`#sidebar-nav .nav-link[data-view="${view}"]`);
  if (link) link.click();
}

async function cargarChatHoy() {
  const el = document.getElementById('chat-hoy');
  if (!el) return;
  let pendientes = null;
  try {
    const res = await authFetch(`${API_URL}/journal/pendientes`);
    if (res && res.ok) pendientes = (await res.json()).length;
  } catch { /* sin datos: la tarjeta muestra "—" */ }

  const cards = [
    {
      view: 'panel-revision',
      num: pendientes === null ? '—' : pendientes,
      label: 'Pendientes de revisión',
      cls: pendientes ? 'alerta' : 'ok',
    },
    { view: 'panel-import', num: '📥', label: 'Importar movimientos', cls: '' },
    { view: 'panel-conciliacion', num: '🏦', label: 'Conciliar banco', cls: '' },
    { view: 'panel-informes', num: '📊', label: 'Ver informes', cls: '' },
  ];
  el.innerHTML = '';
  for (const c of cards) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `hoy-card ${c.cls}`.trim();
    btn.innerHTML = `<span class="hoy-num">${c.num}</span><span class="hoy-lbl">${c.label}</span>`;
    btn.addEventListener('click', () => irAPanel(c.view));
    el.appendChild(btn);
  }
  // Si el usuario ya se fue a un panel mientras cargaba, no reaparecer encima.
  const chatVisible = !document.getElementById('chat-messages')?.classList.contains('hidden');
  if (chatVisible) el.classList.remove('hidden');
}

