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

/** Pide una clave/contraseña con input type=password (el prompt() nativo no oculta el texto). */
function askPassword(msg) {
  return new Promise(r => {
    const o = document.createElement('div');
    o.className = 'app-dialog-overlay';
    o.innerHTML = `<div class="app-dialog" style="max-width:380px">
      <div class="app-dialog-icon">🔐</div>
      <div class="app-dialog-msg">${msg}</div>
      <input type="password" id="ask-password-input" placeholder="••••••••" autocomplete="off"
        style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:6px;box-sizing:border-box;font-size:14px;margin:6px 0 14px 0">
      <div class="app-dialog-buttons">
        <button class="app-dialog-btn secondary" id="ask-password-cancel">Cancelar</button>
        <button class="app-dialog-btn primary" id="ask-password-ok">Aceptar</button>
      </div>
    </div>`;
    document.body.appendChild(o);
    const input = o.querySelector('#ask-password-input');
    const close = (val) => { o.remove(); r(val); };
    o.querySelector('#ask-password-ok').onclick = () => close(input.value);
    o.querySelector('#ask-password-cancel').onclick = () => close(null);
    o.addEventListener('click', e => { if (e.target === o) close(null); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); });
    input.focus();
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
