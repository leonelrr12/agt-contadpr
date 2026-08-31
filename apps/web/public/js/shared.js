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

/** Pide una clave/contraseña con input type=password (el prompt() nativo no oculta el texto).
 *  Estilos inline: funciona en cualquier página sin depender de clases CSS del SPA. */
function askPassword(msg) {
  return new Promise(r => {
    const o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px';
    o.innerHTML = `<div style="background:#fff;border-radius:12px;max-width:380px;width:100%;padding:24px;box-shadow:0 10px 40px rgba(0,0,0,0.25);box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif">
      <div style="font-size:28px;text-align:center">🔐</div>
      <div style="font-size:14px;color:#1e293b;text-align:center;margin:8px 0 14px 0">${msg}</div>
      <input type="password" id="ask-password-input" placeholder="••••••••" autocomplete="off"
        style="width:100%;padding:10px;border:1px solid #d0d5dd;border-radius:8px;box-sizing:border-box;font-size:14px;font-family:inherit;margin-bottom:14px">
      <div style="display:flex;gap:8px">
        <button id="ask-password-cancel" style="flex:1;padding:10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;cursor:pointer;font-size:14px;font-family:inherit">Cancelar</button>
        <button id="ask-password-ok" style="flex:2;padding:10px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;font-family:inherit">Aceptar</button>
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
