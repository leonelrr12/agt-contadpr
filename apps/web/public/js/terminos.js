// terminos.js — aviso de (re)aceptación de los Términos y Condiciones.
//
// Se muestra cuando la cuenta no tiene constancia de aceptación (las creadas
// antes de que existiera el registro) o aceptó una versión vieja: lo dice
// /api/auth/me en `terms.needsAcceptance`. Bloquea la pantalla a propósito,
// pero SIEMPRE deja cerrar sesión — nadie queda atrapado en el aviso.
//
// Lo cargan los tres shells (index, planilla, inventario). En index.html el
// chequeo reusa la respuesta de /auth/me que core.js ya pide; en los módulos,
// verificarTerminos() la pide por su cuenta.
(function () {
  const API = '/api';
  let abierto = false;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
    .trm-overlay { position: fixed; inset: 0; z-index: 10000; background: rgba(15,17,26,.72); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .trm-card { background: #fff; border-radius: 14px; max-width: 520px; width: 100%; max-height: 90dvh; overflow: auto; padding: 28px 26px 20px; box-shadow: 0 24px 60px rgba(0,0,0,.35); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #333; }
    .trm-card h2 { font-size: 20px; color: #1a1a2e; margin: 0 0 8px; }
    .trm-card p { font-size: 14px; line-height: 1.6; margin: 0 0 10px; }
    .trm-card a { color: #1565c0; }
    .trm-check { display: flex; gap: 10px; align-items: flex-start; font-size: 13.5px; line-height: 1.5; background: #f8fafc; border: 1px solid #e2e4e8; border-radius: 10px; padding: 12px 14px; margin: 14px 0 16px; cursor: pointer; }
    .trm-check input { width: 17px; height: 17px; margin-top: 1px; accent-color: #1565c0; flex: 0 0 auto; cursor: pointer; }
    .trm-btn { width: 100%; padding: 12px; border: none; border-radius: 9px; background: #1565c0; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .trm-btn:disabled { opacity: .5; cursor: not-allowed; }
    .trm-pie { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 14px; font-size: 12.5px; color: #6b7280; }
    .trm-pie a { color: #6b7280; }
    .trm-err { display: none; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px; }
    .trm-err.show { display: block; }
  `;

  function mostrar(terms) {
    if (abierto) return;
    abierto = true;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const overlay = document.createElement('div');
    overlay.className = 'trm-overlay';
    overlay.innerHTML = `
      <div class="trm-card" role="dialog" aria-modal="true" aria-labelledby="trm-titulo">
        <h2 id="trm-titulo">Actualizamos los Términos y Condiciones</h2>
        <p>Para seguir usando Contador507 necesitamos tu aceptación de la versión vigente
           (<strong>${esc(terms && terms.currentVersion)}</strong>). Podés leer los documentos completos antes de aceptar:</p>
        <p>
          <a href="/terminos-y-condiciones.html" target="_blank" rel="noopener">Términos y Condiciones</a> ·
          <a href="/politica-de-privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>
        </p>
        <div class="trm-err" id="trm-err"></div>
        <label class="trm-check" for="trm-ok">
          <input type="checkbox" id="trm-ok">
          <span>He leído y acepto los Términos y Condiciones y la Política de Privacidad.</span>
        </label>
        <button type="button" class="trm-btn" id="trm-aceptar" disabled>Aceptar y continuar</button>
        <div class="trm-pie">
          <span>Tu aceptación queda registrada con fecha y versión.</span>
          <a href="#" id="trm-salir">Cerrar sesión</a>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const check = overlay.querySelector('#trm-ok');
    const btn = overlay.querySelector('#trm-aceptar');
    const err = overlay.querySelector('#trm-err');

    check.addEventListener('change', () => { btn.disabled = !check.checked; });
    check.focus();

    overlay.querySelector('#trm-salir').addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.clear();
      window.location.href = '/login.html';
    });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      err.classList.remove('show');
      btn.textContent = 'Guardando…';
      try {
        const token = localStorage.getItem('agt_token');
        const r = await fetch(`${API}/auth/accept-terms`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error('respuesta ' + r.status);
        // Recarga: el shell vuelve a arrancar con la aceptación ya registrada
        // (el usuario guardado en localStorage no lleva el estado de términos).
        window.location.reload();
      } catch {
        btn.disabled = false;
        btn.textContent = 'Aceptar y continuar';
        err.textContent = 'No se pudo registrar tu aceptación. Revisá tu conexión e intentá de nuevo.';
        err.classList.add('show');
      }
    });
  }

  /**
   * Verifica el estado y muestra el aviso si hace falta.
   * @param {object} [datosMe] Respuesta ya obtenida de /api/auth/me (evita el request extra).
   */
  async function verificarTerminos(datosMe) {
    if (abierto) return;
    try {
      let data = datosMe;
      if (!data) {
        const token = localStorage.getItem('agt_token');
        if (!token) return;
        const r = await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) return;
        data = await r.json();
      }
      if (data && data.terms && data.terms.needsAcceptance) mostrar(data.terms);
    } catch { /* sin red: no es este aviso el que tiene que reportarlo */ }
  }

  window.verificarTerminos = verificarTerminos;
})();
