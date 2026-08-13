// entry-modals.js (11/13) — modales de edición/corrección de asientos
/* ── Maquinaria compartida de líneas editables (edit/create de asientos) ── */
// Expone en window: <ns>Lines, <ns>UpdateLine, <ns>RemoveLine, <ns>AddLine, <ns>UpdateBalance
// para los onchange/onclick inline del modal. Retorna helpers para el flujo de guardado.
function setupEntryLines({ tbody, balanceEl, saveBtn, activeAccounts, namespace, initialLines }) {
  const lines = initialLines.slice();
  if (lines.length < 2) lines.push({ accountId: '', debit: 0, credit: 0 });

  function renderLines() {
    tbody.innerHTML = lines.map((l, i) => `<tr>
      <td style="padding:4px 4px">
        <select onchange="${namespace}UpdateLine(${i},'accountId',this.value)" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;box-sizing:border-box">
          <option value="">— Seleccionar cuenta —</option>
          ${activeAccounts.map(a => `<option value="${a.id}" ${a.id === l.accountId ? 'selected' : ''}>${escapeHtml(a.code)} — ${escapeHtml(a.name)}</option>`).join('')}
        </select>
      </td>
      <td style="padding:4px 4px"><input type="number" step="0.01" min="0" value="${l.debit || ''}" onchange="${namespace}UpdateLine(${i},'debit',parseFloat(this.value)||0)" onfocus="if(this.value==='0')this.value=''" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;text-align:right;box-sizing:border-box"></td>
      <td style="padding:4px 4px"><input type="number" step="0.01" min="0" value="${l.credit || ''}" onchange="${namespace}UpdateLine(${i},'credit',parseFloat(this.value)||0)" onfocus="if(this.value==='0')this.value=''" style="width:100%;padding:6px;border:1px solid #d1d5db;border-radius:4px;font-size:11px;text-align:right;box-sizing:border-box"></td>
      <td style="padding:4px 2px;text-align:center">${lines.length > 2 ? `<button onclick="${namespace}RemoveLine(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px" title="Eliminar línea">🗑️</button>` : ''}</td>
    </tr>`).join('');
    updateBalance();
  }

  function updateBalance() {
    const totalDebit = lines.reduce((s, l) => s + (l.debit || 0), 0);
    const totalCredit = lines.reduce((s, l) => s + (l.credit || 0), 0);
    const diff = Math.abs(totalDebit - totalCredit);
    const balanced = Math.round(diff * 100) === 0;
    balanceEl.textContent = `Débito: $${totalDebit.toFixed(2)} · Crédito: $${totalCredit.toFixed(2)} · Diferencia: $${diff.toFixed(2)}`;
    balanceEl.style.background = balanced ? '#ecfdf5' : '#fef2f2';
    balanceEl.style.color = balanced ? '#059669' : '#dc2626';
    saveBtn.disabled = !balanced;
  }

  window[namespace + 'Lines'] = lines;
  window[namespace + 'UpdateBalance'] = updateBalance;
  window[namespace + 'RenderLines'] = renderLines;
  window[namespace + 'UpdateLine'] = function(i, field, value) {
    window[namespace + 'Lines'][i][field] = value;
    updateBalance();
  };
  window[namespace + 'RemoveLine'] = function(i) {
    if (window[namespace + 'Lines'].length <= 2) return;
    window[namespace + 'Lines'].splice(i, 1);
    renderLines();
  };
  window[namespace + 'AddLine'] = function() {
    window[namespace + 'Lines'].push({ accountId: '', debit: 0, credit: 0 });
    renderLines();
  };

  renderLines();
  return { lines, renderLines, updateBalance };
}

/* ── Modal: Editar Asiento (solo admin) ── */
async function showEditEntryModal(entryId) {
  // Cargar entry completo
  let entry;
  try {
    const res = await authFetch(`${API_URL}/journal/${entryId}`);
    if (!res.ok) { await showAlert('Error al cargar el asiento'); return; }
    entry = await res.json();
  } catch (e) { await showAlert('Error de conexión'); return; }

  if (entry.status !== 'BORRADOR') { await showAlert('Solo se pueden editar asientos en BORRADOR'); return; }

  // Asegurar cuentas cargadas
  if (!cuentasCache || !cuentasCache.length) {
    try {
      const r = await authFetch(`${API_URL}/accounts`);
      cuentasCache = await r.json();
    } catch (e) { /* usar cache vacío */ }
  }
  const activeAccounts = (cuentasCache || []).filter(a => a.isActive).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const dateStr = entry.date ? new Date(entry.date).toISOString().split('T')[0] : '';

  // Construir HTML del modal
  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.id = 'edit-entry-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:750px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:16px">✏️ Editar Asiento</div>

    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Fecha</label>
        <input id="edit-entry-date" type="date" value="${dateStr}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box">
      </div>
      <div style="flex:2;min-width:250px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Descripción</label>
        <input id="edit-entry-desc" type="text" value="${escapeHtml(entry.description||'')}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box">
      </div>
    </div>

    <div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Líneas del asiento</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px" id="edit-entry-lines-table">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280">Cuenta</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280;width:120px">Débito</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280;width:120px">Crédito</th>
          <th style="width:32px"></th>
        </tr></thead>
        <tbody id="edit-entry-lines-tbody"></tbody>
      </table>
      <button onclick="editEntryAddLine()" style="margin-top:8px;padding:6px 12px;font-size:11px;background:#f0f0f0;border:1px dashed #9ca3af;border-radius:6px;cursor:pointer;color:#374151">+ Agregar línea</button>
    </div>

    <div id="edit-entry-balance" style="padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;margin-bottom:12px;text-align:right"></div>

    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="edit-entry-cancel">Cancelar</button>
      <button class="app-dialog-btn primary" id="edit-entry-save" disabled>Guardar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Referencias
  const tbody = overlay.querySelector('#edit-entry-lines-tbody');
  const balanceEl = overlay.querySelector('#edit-entry-balance');
  const saveBtn = overlay.querySelector('#edit-entry-save');
  const cancelBtn = overlay.querySelector('#edit-entry-cancel');

  // Datos vivos (se mutan) — maquinaria compartida con el modal de corrección
  setupEntryLines({
    tbody,
    balanceEl,
    saveBtn,
    activeAccounts,
    namespace: 'editEntry',
    initialLines: (entry.lines || []).map(l => ({
      accountId: l.accountId,
      debit: l.debit || 0,
      credit: l.credit || 0,
    })),
  });

  // Eventos
  cancelBtn.onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  saveBtn.onclick = async () => {
    const date = overlay.querySelector('#edit-entry-date').value;
    const description = overlay.querySelector('#edit-entry-desc').value.trim();
    if (!date || !description) { await showAlert('Fecha y descripción son requeridas'); return; }

    // Validar que cada línea tenga cuenta
    const invalid = window.editEntryLines.some(l => !l.accountId);
    if (invalid) { await showAlert('Todas las líneas deben tener una cuenta asignada'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Guardando...';

    try {
      const res = await authFetch(`${API_URL}/journal/${entryId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          description,
          lines: window.editEntryLines.map(l => ({
            accountId: l.accountId,
            debit: l.debit || 0,
            credit: l.credit || 0,
          })),
        }),
      });
      if (res.ok) {
        overlay.remove();
        loadRevisionList();
        await showAlert('✅ Asiento actualizado');
      } else {
        const err = await res.json();
        await showAlert(`❌ ${err.error || 'Error al guardar'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Guardar';
      }
    } catch (e) {
      await showAlert('Error de conexión');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar';
    }
  };
}

/* ── Corregir Asiento Confirmado (anular + nuevo BORRADOR) ── */
async function corregirEntry(entryId) {
  const ok = await showConfirm(
    '⚠️ Se abrirá el formulario con los datos del asiento original para que los corrijas.\n\n' +
    '📌 Al guardar, se creará una REVERSIÓN del original (CONFIRMADO).\n' +
    '📌 El asiento original se mantiene CONFIRMADO (no se modifica).\n' +
    '📌 El nuevo asiento corregido quedará en BORRADOR para revisión.\n\n' +
    'Si cancelas el formulario, no se hará ningún cambio.\n\n' +
    '¿Deseas continuar?'
  );
  if (!ok) return;

  try {
    // Obtener datos del original para pre-llenar el modal
    const getRes = await authFetch(`${API_URL}/journal/${entryId}`);
    if (!getRes.ok) { await showAlert('Error al cargar datos del asiento'); return; }
    const originalEntry = await getRes.json();

    // Abrir modal — el anulado + creación ocurren al guardar
    showCreateEntryModal(originalEntry, entryId);

  } catch (e) { await showAlert('Error de conexión'); }
}

async function showCreateEntryModal(originalEntry, originalEntryId) {
  // Asegurar cuentas cargadas antes de renderizar
  if (!cuentasCache || !cuentasCache.length) {
    try {
      const r = await authFetch(`${API_URL}/accounts`);
      cuentasCache = await r.json();
    } catch (e) { /* seguir con cache vacío */ }
  }
  const activeAccounts = (cuentasCache || []).filter(a => a.isActive).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));

  const today = new Date().toISOString().split('T')[0];
  const desc = `CORRECCIÓN: ${originalEntry.description || 'Sin descripción'}`;

  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.id = 'create-entry-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:750px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:4px">✏️ Corregir Asiento</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:16px">El asiento original fue anulado. Crea la versión corregida como BORRADOR.</div>

    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Fecha</label>
        <input id="create-entry-date" type="date" value="${today}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box">
      </div>
      <div style="flex:2;min-width:250px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Descripción</label>
        <input id="create-entry-desc" type="text" value="${escapeHtml(desc)}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box">
      </div>
    </div>

    <div style="margin-bottom:12px">
      <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Líneas del asiento</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px" id="create-entry-lines-table">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280">Cuenta</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280;width:120px">Débito</th>
          <th style="text-align:right;padding:4px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280;width:120px">Crédito</th>
          <th style="width:32px"></th>
        </tr></thead>
        <tbody id="create-entry-lines-tbody"></tbody>
      </table>
      <button onclick="createEntryAddLine()" style="margin-top:8px;padding:6px 12px;font-size:11px;background:#f0f0f0;border:1px dashed #9ca3af;border-radius:6px;cursor:pointer;color:#374151">+ Agregar línea</button>
    </div>

    <div id="create-entry-balance" style="padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;margin-bottom:12px;text-align:right"></div>

    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="create-entry-cancel">Cancelar</button>
      <button class="app-dialog-btn primary" id="create-entry-save" disabled>Guardar como BORRADOR</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  const tbody = overlay.querySelector('#create-entry-lines-tbody');
  const balanceEl = overlay.querySelector('#create-entry-balance');
  const saveBtn = overlay.querySelector('#create-entry-save');

  // Datos vivos — maquinaria compartida con el modal de edición
  setupEntryLines({
    tbody,
    balanceEl,
    saveBtn,
    activeAccounts,
    namespace: 'createEntry',
    initialLines: (originalEntry.lines || []).map(l => ({
      accountId: l.accountId,
      debit: l.debit || 0,
      credit: l.credit || 0,
    })),
  });

  overlay.querySelector('#create-entry-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  saveBtn.onclick = async () => {
    const date = overlay.querySelector('#create-entry-date').value;
    const description = overlay.querySelector('#create-entry-desc').value.trim();
    if (!date || !description) { await showAlert('Fecha y descripción son requeridas'); return; }

    const invalid = window.createEntryLines.some(l => !l.accountId);
    if (invalid) { await showAlert('Todas las líneas deben tener una cuenta asignada'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Creando reversión...';

    try {
      // 1. Crear reversión del original (CONFIRMADO) — usa líneas ORIGINALES invertidas
      if (originalEntryId) {
        const originalLines = originalEntry.lines || [];
        const revLines = originalLines.map(l => ({
          accountId: l.accountId,
          debit: l.credit || 0,
          credit: l.debit || 0,
        }));
        const revRes = await authFetch(`${API_URL}/journal`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: new Date().toISOString().split('T')[0],
            description: `REVERSIÓN [ref:${originalEntryId.slice(0,12)}]: ${originalEntry.description || 'Asiento original'}`,
            lines: revLines,
          }),
        });
        if (!revRes.ok) {
          const err = await revRes.json();
          await showAlert(`❌ ${err.error || 'Error al crear reversión'}`);
          saveBtn.disabled = false;
          saveBtn.textContent = 'Guardar como BORRADOR';
          return;
        }
        // Aprobar la reversión automáticamente
        const revData = await revRes.json();
        await authFetch(`${API_URL}/journal/${revData.id}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'aprobar' }),
        });
      }

      saveBtn.textContent = 'Creando corrección...';

      // 2. Crear el nuevo asiento corregido (BORRADOR) con referencia al original
      const refTag = originalEntryId ? ` [ref:${originalEntryId.slice(0,12)}]` : '';
      const res = await authFetch(`${API_URL}/journal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          description: description + refTag,
          lines: window.createEntryLines.map(l => ({
            accountId: l.accountId,
            debit: l.debit || 0,
            credit: l.credit || 0,
          })),
        }),
      });
      if (res.ok) {
        overlay.remove();
        await showAlert('✅ Asiento corregido creado como BORRADOR. Ve a Revisión para aprobarlo.');
        // Recargar reporte diario actual
        if (typeof loadReportDiario === 'function') loadReportDiario();
      } else {
        const err = await res.json();
        await showAlert(`❌ ${err.error || 'Error al crear el asiento'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = 'Guardar como BORRADOR';
      }
    } catch (e) {
      await showAlert('Error de conexión');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar como BORRADOR';
    }
  };
}

