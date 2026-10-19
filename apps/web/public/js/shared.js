// shared.js — helpers comunes de las páginas standalone (admin, api-keys, conciliación).
// Cargar antes del <script> inline de cada página. No lo usa el SPA (index.html).
// Los diálogos (showAlert/showConfirm/showPrompt/askPassword) viven en js/dialogos.js.

// ── Auth ──
function getToken() { return localStorage.getItem('agt_token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('agt_user')); } catch { return null; } }
function logout() { localStorage.clear(); window.location = '/login.html'; }

/**
 * Escribe el nombre de la empresa en el encabezado de un módulo.
 *
 * Planilla e Inventario son pantallas de UNA sola empresa y no lo dicen en ningún
 * lado: con más de un cliente abierto, saber en cuál estás parado no puede depender
 * de la URL. El nombre sale del usuario guardado en el login (`agt_user`), que ya
 * trae la empresa; si falta, se pregunta a la API en vez de dejar el hueco en blanco.
 */
async function pintarEmpresaEnTitulo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = getUser()?.company?.name || '';
  if (el.textContent) return;
  try {
    const res = await authFetch('/api/auth/me');
    if (!res.ok) return;
    const u = await res.json();
    el.textContent = u.company?.name || '';
  } catch { /* sin nombre antes que un error en el encabezado */ }
}

function authFetch(url, opts = {}) {
  const token = getToken();
  if (!token) { window.location = '/login.html'; return Promise.reject('No auth'); }
  return fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Authorization': `Bearer ${token}`,
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
  }).then(r => {
    if (r.status === 401) { localStorage.clear(); window.location = '/login.html'; }
    return r;
  });
}

// Alias async (usado por admin.html) — retorna undefined en 401/sin token, como el original
async function api(url, opts = {}) {
  const token = getToken();
  if (!token) { window.location = '/login.html'; return; }
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'Authorization': `Bearer ${token}`,
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
  });
  if (res.status === 401) { localStorage.clear(); window.location = '/login.html'; return; }
  return res;
}
