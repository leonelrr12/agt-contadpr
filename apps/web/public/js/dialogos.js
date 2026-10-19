// dialogos.js — avisos, confirmaciones y prompts de toda la app.
// Reemplaza alert()/confirm()/prompt() nativos con un diálogo propio, accesible
// y consistente. Se carga ANTES de core.js (SPA) y de shared.js (páginas
// standalone). Los estilos viven en dialogos.css.

let _dialogosAbiertos = 0;
let _overflowPrevio = null;
const _pilaDialogos = [];

const _DIALOGO_ICONOS = { error: '❌', success: '✅', warning: '⚠️', question: '🤔', info: 'ℹ️' };
const _DIALOGO_TITULOS = {
  error: 'No se pudo completar',
  success: 'Listo',
  warning: 'Atención',
  question: 'Confirmar',
  info: 'Aviso',
};

/** El tipo sale del emoji con el que ya empiezan muchos mensajes de la app. */
function _tipoDialogo(mensaje) {
  const s = String(mensaje ?? '').trimStart();
  if (s.startsWith('❌')) return 'error';
  if (s.startsWith('✅')) return 'success';
  if (s.startsWith('⚠️')) return 'warning';
  if (s.startsWith('🤔') || s.startsWith('❓')) return 'question';
  return 'info';
}

function _limpiarMensajeDialogo(mensaje) {
  return String(mensaje ?? '').replace(/^\s*(?:❌|✅|⚠️|🤔|❓|ℹ️)\s*/, '');
}

function _escapeAttrDialogo(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Crea el overlay y devuelve una promesa con el valor del botón elegido.
 * `normalizar` permite que el botón primario devuelva el contenido del input
 * (showPrompt) en vez de un booleano.
 */
function _abrirDialogo({ tipo, icono, titulo, mensaje, input, botones, valorEscape, normalizar }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'app-dialog-overlay';
    overlay.setAttribute('role', 'presentation');

    const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const idTitulo = `app-dialog-title-${sufijo}`;
    const idInput = `app-dialog-input-${sufijo}`;
    const box = document.createElement('div');
    box.className = 'app-dialog';
    box.dataset.type = tipo;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', idTitulo);

    box.innerHTML = `
      <div class="app-dialog-icon" aria-hidden="true">${icono}</div>
      <div class="app-dialog-title" id="${idTitulo}">${titulo}</div>
      ${mensaje ? `<div class="app-dialog-msg">${mensaje}</div>` : ''}
      ${input ? `<input class="app-dialog-input" id="${idInput}" type="${input.type || 'text'}" placeholder="${_escapeAttrDialogo(input.placeholder)}" value="${_escapeAttrDialogo(input.value)}" autocomplete="off">` : ''}
      <div class="app-dialog-buttons">
        ${botones.map((b, i) => `<button type="button" class="app-dialog-btn ${b.variant || 'secondary'}" data-idx="${i}">${b.label}</button>`).join('')}
      </div>`;
    overlay.appendChild(box);
    const anterior = document.activeElement;
    document.body.appendChild(overlay);
    _pilaDialogos.push(overlay);

    if (_dialogosAbiertos++ === 0) {
      _overflowPrevio = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }

    const inputEl = input ? box.querySelector(`#${idInput}`) : null;
    const botonesEls = [...box.querySelectorAll('.app-dialog-btn')];
    const idxPrimario = botones.findIndex((b) => b.primary);

    const cerrar = (valor) => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      const i = _pilaDialogos.indexOf(overlay);
      if (i >= 0) _pilaDialogos.splice(i, 1);
      if (--_dialogosAbiertos === 0) {
        document.body.style.overflow = _overflowPrevio || '';
        _overflowPrevio = null;
      }
      if (anterior && anterior.isConnected && typeof anterior.focus === 'function') anterior.focus();
      resolve(valor);
    };

    const onKey = (e) => {
      // Solo el diálogo de arriba responde a Escape/Enter.
      if (_pilaDialogos[_pilaDialogos.length - 1] !== overlay) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        cerrar(valorEscape);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        // Si el foco ya está en un botón, el navegador lo activa solo.
        if (document.activeElement?.classList?.contains('app-dialog-btn')) return;
        e.preventDefault();
        if (idxPrimario >= 0) botonesEls[idxPrimario].click();
      }
    };
    document.addEventListener('keydown', onKey);

    botonesEls.forEach((btn, i) => {
      btn.addEventListener('click', () => {
        const def = botones[i];
        cerrar(normalizar ? normalizar(def.value, inputEl) : def.value);
      });
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cerrar(valorEscape);
    });

    requestAnimationFrame(() => {
      if (inputEl) {
        inputEl.focus();
        if (inputEl.select) inputEl.select();
      } else if (idxPrimario >= 0) {
        botonesEls[idxPrimario].focus();
      }
    });
  });
}

/**
 * Aviso con un solo botón. Acepta `{ type, title, icon, okText }` para afinar
 * el tono; por defecto lo deduce del emoji inicial del mensaje.
 */
function showAlert(msg, opciones = {}) {
  const tipo = opciones.type || _tipoDialogo(msg);
  return _abrirDialogo({
    tipo,
    icono: opciones.icon || _DIALOGO_ICONOS[tipo] || _DIALOGO_ICONOS.info,
    titulo: opciones.title || _DIALOGO_TITULOS[tipo] || _DIALOGO_TITULOS.info,
    mensaje: _limpiarMensajeDialogo(msg),
    botones: [{ label: opciones.okText || 'Aceptar', value: true, variant: 'primary', primary: true }],
    valorEscape: true,
  });
}

/**
 * Confirmación Cancelar/Confirmar. Devuelve true/false.
 * Las acciones destructivas se pintan en rojo automáticamente.
 */
function showConfirm(msg, opciones = {}) {
  const tipo = opciones.type || (_tipoDialogo(msg) === 'info' ? 'question' : _tipoDialogo(msg));
  const peligroso = opciones.danger ??
    /anular|borrar|eliminar|revertir|rechazar|cerrar el año|revocar|descartar/i.test(String(msg));
  return _abrirDialogo({
    tipo,
    icono: opciones.icon || (peligroso ? '⚠️' : (_DIALOGO_ICONOS[tipo] || '🤔')),
    titulo: opciones.title || (_DIALOGO_TITULOS[tipo] || 'Confirmar'),
    mensaje: _limpiarMensajeDialogo(msg),
    botones: [
      { label: opciones.cancelText || 'Cancelar', value: false, variant: 'secondary' },
      {
        label: opciones.confirmText || (peligroso ? 'Sí, continuar' : 'Confirmar'),
        value: true,
        variant: peligroso ? 'danger' : 'primary',
        primary: true,
      },
    ],
    valorEscape: false,
  });
}

/**
 * Pide un texto. Devuelve el valor escrito o null si se cancela.
 * Acepta `{ title, placeholder, value, inputType, okText, cancelText, icon }`.
 */
function showPrompt(msg, opciones = {}) {
  return _abrirDialogo({
    tipo: 'question',
    icono: opciones.icon || '✍️',
    titulo: opciones.title || 'Escribí un dato',
    mensaje: _limpiarMensajeDialogo(msg),
    input: {
      type: opciones.inputType || 'text',
      placeholder: opciones.placeholder || '',
      value: opciones.value || '',
    },
    botones: [
      { label: opciones.cancelText || 'Cancelar', value: null, variant: 'secondary' },
      { label: opciones.okText || 'Aceptar', value: true, variant: 'primary', primary: true },
    ],
    valorEscape: null,
    normalizar: (valor, inputEl) => (valor === true ? (inputEl ? inputEl.value : '') : null),
  });
}

/** Clave/contraseña: el prompt nativo no oculta el texto. */
function askPassword(msg) {
  return showPrompt(msg, {
    title: 'Clave de administrador',
    placeholder: '••••••••',
    inputType: 'password',
    icon: '🔐',
    okText: 'Aceptar',
  });
}
