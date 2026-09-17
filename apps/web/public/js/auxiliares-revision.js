// auxiliares-revision.js (10/14) — panel auxiliares y revisión de asientos
/* ── Panel: Auxiliares (sidebar) ── */
function loadPanelAuxiliares() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-auxiliares-content').classList.remove('hidden');
  clickAuxTab('cuenta');
}

// Tabs de Auxiliares
document.querySelectorAll('#panel-tabs-auxiliares button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-auxiliares');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    clickAuxTab(btn.dataset.aux);
  });
});

function clickAuxTab(tab) {
  const btns = document.querySelectorAll('#panel-tabs-auxiliares button');
  btns.forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
  const active = document.querySelector(`#panel-tabs-auxiliares button[data-aux="${tab}"]`);
  if (active) { active.classList.add('active'); active.style.color = '#1a1a2e'; active.style.borderBottomColor = '#1565c0'; }
  const sub = document.getElementById('aux-sidebar-content');
  sub.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Cargando...</div>';
  if (tab === 'cuenta') loadAuxCuenta(sub);
  else if (tab === 'cxc') loadAuxCxC(sub);
  else if (tab === 'cxp') loadAuxCxP(sub);
  else if (tab === 'anexos') loadAuxAnexos(sub);
}

/* ── Panel: Revisión (sidebar) ── */
function loadPanelRevision() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-revision-content').classList.remove('hidden');
  // Asiento Manual: solo admin/superadmin (mismo criterio que ✏️ Editar)
  const role = getUser()?.role;
  const btnManual = document.getElementById('btn-asiento-manual');
  if (btnManual) btnManual.style.display = (role === 'admin' || role === 'superadmin') ? 'inline-block' : 'none';
  // Modo 1-click: SIEMPRE apagado al entrar (no persiste entre visitas).
  // Al activarlo se avisa de lo que implica y se pide confirmación (cancelar
  // lo deja apagado); apagarlo no requiere aviso.
  const oneClick = document.getElementById('revision-oneclick');
  if (oneClick) {
    oneClick.checked = false;
    oneClick.onchange = async () => {
      if (!oneClick.checked) return;
      const ok = await showConfirm('⚡ Modo 1-click\n\nCon un solo click en ✅ Aprobar los asientos se confirman AL INSTANTE, sin diálogo de confirmación.\n\n⚠️ Un asiento aprobado ya no se puede editar: solo se puede anular y emitir uno nuevo.\n\n¿Activar el modo 1-click?');
      if (!ok) oneClick.checked = false;
    };
  }
  loadRevisionList();
}

/** Último resultado de /journal/pendientes: fuente del buscador (filtrar no vuelve a pedir datos). */
let revisionEntries = [];

async function loadRevisionList() {
  const el = document.getElementById('revision-inline-list');
  // Al refrescar con la lista ya visible no se vacía (evita el parpadeo);
  // "Cargando..." solo la primera vez o cuando no hay tarjetas.
  if (!el.querySelector('[id^="rev-entry-"]')) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  }
  try {
    const res = await authFetch(`${API_URL}/journal/pendientes`);
    const d = await res.json();
    revisionEntries = Array.isArray(d) ? d : [];
    renderRevisionList();
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

/** Normaliza para buscar sin distinguir mayúsculas ni tildes ("viatico" → "viático"). */
function normalizeSearch(s) {
  return String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** ¿El asiento casa con el buscador? Todas las palabras deben aparecer en la
 *  descripción, el proveedor o alguna de sus cuentas (código o nombre), así
 *  "planilla agosto" exige ambas y "viatico" encuentra "Viático". */
function entryMatches(e, terms) {
  if (!terms.length) return true;
  const hay = normalizeSearch([
    e.description,
    e.provider,
    ...(e.lines || []).flatMap(l => [l.account?.code, l.account?.name]),
  ].join(' '));
  return terms.every(t => hay.includes(t));
}

/** Pinta la lista ya cargada aplicando el filtro del buscador (sin volver a pedir datos). */
function renderRevisionList() {
  const el = document.getElementById('revision-inline-list');
  if (!el) return;
  const raw = document.getElementById('revision-search')?.value.trim() || '';
  const terms = normalizeSearch(raw).split(/\s+/).filter(Boolean);
  const shown = revisionEntries.filter(e => entryMatches(e, terms));

  if (!revisionEntries.length) {
    el.innerHTML = '<div style="text-align:center;padding:48px;color:#059669;font-size:15px">✅ No hay asientos pendientes de revisión</div>';
    updateRevisionCount(0, 0);
    return;
  }
  if (!shown.length) {
    el.innerHTML = `<div style="text-align:center;padding:48px;color:#6b7280;font-size:14px">🔍 Sin coincidencias para «${escapeHtml(raw)}»<br><span style="font-size:12px">Prueba con otra palabra o borra el buscador</span></div>`;
    updateRevisionCount(0, revisionEntries.length);
    return;
  }
  el.innerHTML = shown.map(revisionEntryCard).join('');
  updateRevisionCount(shown.length, revisionEntries.length);
}

/** Tarjeta de un asiento pendiente. */
function revisionEntryCard(e) {
  const date = new Date(e.date).toLocaleDateString('es-PA');
  let lineasHtml = '';
  if (e.lines && e.lines.length) {
    lineasHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Cuenta</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Débito</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Crédito</th></tr></thead><tbody>';
    for (const l of e.lines) {
      lineasHtml += `<tr>
        <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0">${escapeHtml(l.account?.code||'')} — ${escapeHtml(l.account?.name||'')}</td>
        <td style="text-align:right;padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#2e7d32;font-weight:600">${l.debit ? '$'+l.debit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
        <td style="text-align:right;padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#c62828;font-weight:600">${l.credit ? '$'+l.credit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}) : '—'}</td>
      </tr>`;
    }
    lineasHtml += '</tbody></table>';
  }
  return `<div id="rev-entry-${e.id}" style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:10px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px">${escapeHtml(e.description||'Sin descripción')}${e.provider ? ` — <span style="font-size:11px;color:#6b7280;font-weight:400">${escapeHtml(e.provider)}</span>` : ''}</div>
        <div style="font-size:12px;color:#6b7280;margin-top:4px">📅 ${date} · 👤 ${escapeHtml(e.createdBy?.name||'—')} · ${e.lines?.length||0} líneas</div>
        ${lineasHtml}
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
        ${getUser()?.role === 'admin' || getUser()?.role === 'superadmin' ? `<button onclick="showEditEntryModal('${e.id}')" style="padding:6px 14px;font-size:12px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✏️ Editar</button>
        <button onclick="reviewCopy('${e.id}')" style="padding:6px 14px;font-size:12px;background:#475569;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">📋 Copiar</button>` : ''}
        <button onclick="reviewApprove('${e.id}')" style="padding:6px 14px;font-size:12px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✅ Aprobar</button>
        <button onclick="reviewReject('${e.id}')" style="padding:6px 14px;font-size:12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">❌ Rechazar</button>
      </div>
    </div>
  </div>`;
}

/** Subtítulo con el número de asientos (feedback de cuántos quedan). */
function updateRevisionCount(shown, total) {
  const sub = document.getElementById('revision-subtitle');
  if (!sub) return;
  if (!total) { sub.textContent = 'Asientos pendientes de revisión por el contador'; return; }
  sub.textContent = shown === total
    ? `${total} asiento(s) pendiente(s) de revisión por el contador`
    : `${shown} de ${total} asiento(s) coinciden con el filtro`;
}

/**
 * Quita la tarjeta del asiento ya revisado SIN recargar la lista: los de
 * abajo suben y el scroll se mantiene donde estaba. Si era la última, deja
 * el mensaje de "no hay pendientes". (El botón 🔄 Actualizar trae nuevas.)
 */
function removeRevisionEntry(id) {
  // Sale también del cache: si no, al escribir en el buscador reaparecería.
  revisionEntries = revisionEntries.filter(e => e.id !== id);
  const card = document.getElementById(`rev-entry-${id}`);
  if (!card) { renderRevisionList(); return; }
  card.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
  card.style.opacity = '0';
  card.style.transform = 'translateX(16px)';
  setTimeout(() => {
    card.remove();
    const el = document.getElementById('revision-inline-list');
    const restantes = el.querySelectorAll('[id^="rev-entry-"]').length;
    // Sin tarjetas en pantalla se repinta el estado vacío: sin pendientes, o
    // sin coincidencias si el filtro dejó fuera a los que quedan.
    if (restantes === 0) renderRevisionList();
    else updateRevisionCount(restantes, revisionEntries.length);
  }, 250);
}

async function reviewApprove(id) {
  // Modo 1-click activo → se aprueba sin diálogo (la tarjeta desaparece como
  // feedback). Sin el modo, se pide la confirmación de siempre.
  const oneClick = document.getElementById('revision-oneclick');
  if (!(oneClick && oneClick.checked)) {
    const ok = await showConfirm('¿Apruebas este asiento?\n\n✅ El asiento quedará CONFIRMADO y afectará los saldos contables.');
    if (!ok) return;
  }
  try {
    const res = await authFetch(`${API_URL}/journal/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'aprobar' }) });
    if (res.ok) {
      removeRevisionEntry(id);
    } else {
      const e = await res.json().catch(() => ({}));
      await showAlert(e.error || 'No se pudo aprobar el asiento');
    }
  } catch (e) { await showAlert('Error de conexión'); }
}

/** Copia el asiento: abre el modal de Asiento Manual con la fecha de hoy, la
 *  misma descripción y las cuentas del original en cero. No se crea nada hasta
 *  guardar en el modal; si se cancela, no queda rastro. */
async function reviewCopy(id) {
  try {
    const res = await authFetch(`${API_URL}/journal/${id}`);
    if (!res.ok) { await showAlert('No se pudo cargar el asiento'); return; }
    showCreateEntryModal(await res.json(), undefined, 'copy');
  } catch (e) { await showAlert('Error de conexión'); }
}

async function reviewReject(id) {
  // Mostrar modal para pedir motivo del rechazo
  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:420px">
    <div class="app-dialog-icon">❌</div>
    <div class="app-dialog-msg">¿Rechazar este asiento?</div>
    <div style="margin:8px 0">
      <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:4px">Motivo del rechazo <span style="color:#dc2626">*</span> <small>(mín. 10 caracteres)</small></label>
      <input id="reject-notes-input" placeholder="Ej: Monto incorrecto, cuenta equivocada..." style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px;box-sizing:border-box">
      <small id="reject-notes-error" style="color:#dc2626;display:none;font-size:11px">El motivo debe tener al menos 10 caracteres.</small>
    </div>
    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="reject-cancel">Cancelar</button>
      <button class="app-dialog-btn danger" id="reject-confirm">Rechazar</button>
    </div></div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#reject-cancel').onclick = close;
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelector('#reject-confirm').onclick = async () => {
    const notes = document.getElementById('reject-notes-input').value.trim();
    if (notes.length < 10) {
      document.getElementById('reject-notes-error').style.display = 'block';
      return;
    }
    overlay.remove();
    try {
      const res = await authFetch(`${API_URL}/journal/${id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rechazar', notes }),
      });
      if (res.ok) {
        removeRevisionEntry(id);
      } else {
        const e = await res.json().catch(() => ({}));
        await showAlert(e.error || 'No se pudo rechazar el asiento');
      }
    } catch (e) { await showAlert('Error de conexión'); }
  };
}

