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
}

/* ── Panel: Revisión (sidebar) ── */
function loadPanelRevision() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-revision-content').classList.remove('hidden');
  loadRevisionList();
}

async function loadRevisionList() {
  const el = document.getElementById('revision-inline-list');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/journal/pendientes`);
    const d = await res.json();
    if (!d || !d.length) {
      el.innerHTML = '<div style="text-align:center;padding:48px;color:#059669;font-size:15px">✅ No hay asientos pendientes de revisión</div>';
      return;
    }
    let html = '';
    for (const e of d) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      let lineasHtml = '';
      if (e.lines && e.lines.length) {
        lineasHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><thead><tr><th style="text-align:left;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Cuenta</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Débito</th><th style="text-align:right;padding:4px 8px;border-bottom:1px solid #e5e7eb;color:#6b7280">Crédito</th></tr></thead><tbody>';
        for (const l of e.lines) {
          lineasHtml += `<tr>
            <td style="padding:4px 8px;border-bottom:1px solid #f0f0f0">${escapeHtml(l.account?.code||'')} — ${escapeHtml(l.account?.name||'')}</td>
            <td style="text-align:right;padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#2e7d32;font-weight:600">${l.debit ? '$'+l.debit.toFixed(2) : '—'}</td>
            <td style="text-align:right;padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#c62828;font-weight:600">${l.credit ? '$'+l.credit.toFixed(2) : '—'}</td>
          </tr>`;
        }
        lineasHtml += '</tbody></table>';
      }
      html += `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:10px">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px">${escapeHtml(e.description||'Sin descripción')}${e.provider ? ` — <span style="font-size:11px;color:#6b7280;font-weight:400">${escapeHtml(e.provider)}</span>` : ''}</div>
            <div style="font-size:12px;color:#6b7280;margin-top:4px">📅 ${date} · 👤 ${escapeHtml(e.createdBy?.name||'—')} · ${e.lines?.length||0} líneas</div>
            ${lineasHtml}
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0">
            ${getUser()?.role === 'admin' ? `<button onclick="showEditEntryModal('${e.id}')" style="padding:6px 14px;font-size:12px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✏️ Editar</button>` : ''}
            <button onclick="reviewApprove('${e.id}')" style="padding:6px 14px;font-size:12px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✅ Aprobar</button>
            <button onclick="reviewReject('${e.id}')" style="padding:6px 14px;font-size:12px;background:#dc2626;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">❌ Rechazar</button>
          </div>
        </div>
      </div>`;
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

async function reviewApprove(id) {
  const ok = await showConfirm('¿Apruebas este asiento?\n\n✅ El asiento quedará CONFIRMADO y afectará los saldos contables.');
  if (!ok) return;
  try {
    const res = await authFetch(`${API_URL}/journal/${id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'aprobar' }) });
    if (res.ok) loadRevisionList();
  } catch (e) { /* silencioso */ }
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
      if (res.ok) { loadRevisionList(); }
    } catch (e) { await showAlert('Error'); }
  };
}

