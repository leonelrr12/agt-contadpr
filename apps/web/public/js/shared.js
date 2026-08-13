// shared.js — helpers comunes de las páginas standalone (admin, api-keys, conciliación).
// Cargar antes del <script> inline de cada página. No lo usa el SPA (index.html).

// ── Diálogos (reemplazan alert/confirm nativos) ──
function showAlert(msg) {
  return new Promise(r => {
    const o = document.createElement('div');
    o.className = 'app-dialog-overlay';
    o.innerHTML = `<div class="app-dialog"><div class="app-dialog-icon">⚠️</div><div class="app-dialog-msg">${msg}</div><div class="app-dialog-buttons"><button class="app-dialog-btn primary">Aceptar</button></div></div>`;
    document.body.appendChild(o);
    o.querySelector('button').onclick = () => { o.remove(); r(true); };
    o.addEventListener('click', e => { if (e.target === o) { o.remove(); r(false); } });
  });
}

function showConfirm(msg) {
  return new Promise(r => {
    const o = document.createElement('div');
    o.className = 'app-dialog-overlay';
    o.innerHTML = `<div class="app-dialog"><div class="app-dialog-icon">🤔</div><div class="app-dialog-msg">${msg}</div><div class="app-dialog-buttons"><button class="app-dialog-btn secondary">Cancelar</button><button class="app-dialog-btn danger">Confirmar</button></div></div>`;
    document.body.appendChild(o);
    o.querySelectorAll('button')[1].onclick = () => { o.remove(); r(true); };
    o.querySelectorAll('button')[0].onclick = () => { o.remove(); r(false); };
    o.addEventListener('click', e => { if (e.target === o) { o.remove(); r(false); } });
  });
}

// ── Auth ──
function getToken() { return localStorage.getItem('agt_token'); }
function getUser() { try { return JSON.parse(localStorage.getItem('agt_user')); } catch { return null; } }
function logout() { localStorage.clear(); window.location = '/login.html'; }

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
