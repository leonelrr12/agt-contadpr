/* Caché de cuentas para los selectores de asiento. Es propia de este archivo a
 * propósito: la global `cuentasCache` la llena admin.js con el catálogo SIN
 * filtrar (hay que ver las bloqueadas para poder desbloquearlas), así que
 * reutilizarla dejaba cuentas bloqueadas en estos combos. */
let entryCuentasCache = null;

/** Cuentas que admiten asientos (sin bloqueadas), con las cuentas ya usadas por
 *  `extraEntries` reinyectadas para no cambiarlas en silencio al guardar.
 *  Se pide en CADA apertura del modal: entre una y otra el usuario pudo bloquear
 *  una cuenta en Administración y no debe seguir ofreciéndose. Si la petición
 *  falla se usa la última lista buena (mejor que un combo vacío). */
async function getEntryAccounts(extraEntries = []) {
  try {
    const r = await authFetch(`${API_URL}/accounts?excludeBlocked=true`);
    const json = await r.json();
    if (Array.isArray(json)) entryCuentasCache = json;
  } catch (e) { /* se usa la última lista buena */ }
  const lista = [...(entryCuentasCache || [])];
  for (const e of extraEntries) {
    for (const l of (e?.lines || [])) {
      if (l.account && !lista.some(a => a.id === l.accountId)) lista.push(l.account);
    }
  }
  return lista.filter(a => a.isActive).sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

// entry-modals.js (11/14) — modales de edición/corrección de asientos
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
    // 0 = 0 cuadra pero no es un asiento: sin montos no se guarda (el backend
    // también lo rechaza). Es el caso de la copia abierta sin llenar.
    const enCero = Math.round((totalDebit + totalCredit) * 100) === 0;
    const ok = balanced && !enCero;
    balanceEl.textContent = enCero
      ? 'Asigna montos a las líneas: un asiento no puede quedar en cero'
      : `Débito: $${totalDebit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} · Crédito: $${totalCredit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} · Diferencia: $${diff.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    // El cero no es un error sino el punto de partida (una copia abre así):
    // ámbar. El rojo queda para lo que de verdad no cuadra.
    balanceEl.style.background = enCero ? '#fffbeb' : ok ? '#ecfdf5' : '#fef2f2';
    balanceEl.style.color = enCero ? '#92400e' : ok ? '#059669' : '#dc2626';
    saveBtn.disabled = !ok;
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

  // Cuentas que admiten asientos; las del propio asiento se reinyectan aunque
  // se hayan bloqueado después (el backend rechazará el guardado y lo dirá, pero
  // no se cambia la cuenta en silencio).
  const activeAccounts = await getEntryAccounts([entry]);

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
    showCreateEntryModal(originalEntry, entryId, 'correction');

  } catch (e) { await showAlert('Error de conexión'); }
}

async function showCreateEntryModal(originalEntry, originalEntryId, mode) {
  // originalEntry/originalEntryId + mode='correction': flujo de CORRECCIÓN
  // (reversión del original + nuevo BORRADOR). mode='copy': COPIA del asiento
  // —misma descripción y cuentas, montos en cero—. Sin argumentos: ASIENTO
  // MANUAL (formulario en blanco → POST /api/journal).
  const isCorrection = mode === 'correction';
  const isCopy = mode === 'copy';
  // Cuentas que admiten asientos antes de renderizar. En la corrección y en la
  // copia, las del asiento original se reinyectan aunque se hayan bloqueado después.
  const activeAccounts = await getEntryAccounts([originalEntry]);

  const today = todayLocalStr();
  const desc = isCorrection
    ? `CORRECCIÓN: ${originalEntry.description || 'Sin descripción'}`
    : isCopy ? originalEntry.description || '' : '';
  const modalTitle = isCorrection ? '✏️ Corregir Asiento' : '📝 Asiento Manual';
  const modalSubtitle = isCorrection
    ? 'El asiento original fue anulado. Crea la versión corregida como BORRADOR.'
    : isCopy
      ? 'Copia del asiento: mismas cuentas y descripción, con la fecha de hoy y los montos en cero.'
      : 'Crea un asiento contable manual. Quedará en BORRADOR para revisión y aprobación.';
  const saveLabel = isCorrection ? 'Guardar como BORRADOR' : 'Guardar asiento';
  const savingLabel = isCorrection ? 'Creando reversión...' : 'Guardando...';
  // La corrección conserva los montos del original; la copia los deja en cero.
  const initialLines = !isCorrection && !isCopy ? [] : (originalEntry.lines || []).map(l => ({
    accountId: l.accountId,
    debit: isCopy ? 0 : l.debit || 0,
    credit: isCopy ? 0 : l.credit || 0,
  }));

  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.id = 'create-entry-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:750px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:4px">${modalTitle}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:16px">${modalSubtitle}</div>

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
      <button class="app-dialog-btn primary" id="create-entry-save" disabled>${saveLabel}</button>
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
    initialLines,
  });

  // Bloquear la pantalla mientras el modal esté abierto: solo se cierra
  // con Guardar o Cancelar (no por click fuera del modal ni scroll de fondo),
  // para no perder lo que el usuario esté escribiendo.
  document.body.style.overflow = 'hidden';
  const closeModal = () => {
    document.body.style.overflow = '';
    overlay.remove();
  };
  overlay.querySelector('#create-entry-cancel').onclick = closeModal;

  saveBtn.onclick = async () => {
    const date = overlay.querySelector('#create-entry-date').value;
    const description = overlay.querySelector('#create-entry-desc').value.trim();
    if (!date || !description) { await showAlert('Fecha y descripción son requeridas'); return; }

    const invalid = window.createEntryLines.some(l => !l.accountId);
    if (invalid) { await showAlert('Todas las líneas deben tener una cuenta asignada'); return; }

    saveBtn.disabled = true;
    saveBtn.textContent = savingLabel;

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
            date: todayLocalStr(),
            description: `REVERSIÓN [ref:${originalEntryId.slice(0,12)}]: ${originalEntry.description || 'Asiento original'}`,
            lines: revLines,
          }),
        });
        if (!revRes.ok) {
          const err = await revRes.json();
          await showAlert(`❌ ${err.error || 'Error al crear reversión'}`);
          saveBtn.disabled = false;
          saveBtn.textContent = saveLabel;
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

      saveBtn.textContent = isCorrection ? 'Creando corrección...' : savingLabel;

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
        closeModal();
        if (isCorrection) {
          await showAlert('✅ Asiento corregido creado como BORRADOR. Ve a Revisión para aprobarlo.');
          // Recargar reporte diario actual
          if (typeof loadReportDiario === 'function') loadReportDiario();
        } else {
          await showAlert('✅ Asiento manual creado en BORRADOR. Apruebalo aquí en Revisión.');
          // Refrescar la lista de pendientes para que aparezca el nuevo asiento
          if (typeof loadRevisionList === 'function') loadRevisionList();
        }
      } else {
        const err = await res.json();
        await showAlert(`❌ ${err.error || 'Error al crear el asiento'}`);
        saveBtn.disabled = false;
        saveBtn.textContent = saveLabel;
      }
    } catch (e) {
      await showAlert('Error de conexión');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Guardar como BORRADOR';
    }
  };
}

/* ── Visor: Asiento original (drawer lateral) ──
 * Abre el asiento COMPLETO que generó un movimiento del auxiliar de cuenta, sin
 * salir de la tabla: el panel entra desde la derecha, la fila de origen queda
 * resaltada y se puede saltar de un movimiento a otro sin cerrar nada.
 * `accountId` (opcional) es la cuenta que se estaba consultando: su línea se
 * destaca para ver de un golpe con qué contrapartida se armó el asiento. */
let _entryDrawerKeyHandler = null;

function closeEntryDrawer() {
  const overlay = document.getElementById('entry-drawer-overlay');
  if (overlay) overlay.remove();
  if (_entryDrawerKeyHandler) {
    document.removeEventListener('keydown', _entryDrawerKeyHandler);
    _entryDrawerKeyHandler = null;
  }
  document.querySelectorAll('.aux-row-active').forEach(tr => tr.classList.remove('aux-row-active'));
}

async function showEntryDrawer(entryId, accountId) {
  // Un solo drawer: abrir otro movimiento reemplaza el contenido (sin apilar).
  const previo = document.getElementById('entry-drawer-overlay');
  if (previo) previo.remove();

  const overlay = document.createElement('div');
  overlay.className = 'entry-drawer-overlay';
  overlay.id = 'entry-drawer-overlay';
  overlay.innerHTML = `<aside class="entry-drawer" role="dialog" aria-label="Asiento original">
    <div class="entry-drawer-head">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
        <div style="font-weight:700;font-size:15px">📄 Asiento original</div>
        <button id="entry-drawer-close" title="Cerrar (Esc)" style="border:none;background:#f1f5f9;color:#374151;border-radius:6px;width:28px;height:28px;font-size:14px;cursor:pointer;flex-shrink:0">✕</button>
      </div>
      <div id="entry-drawer-sub" style="font-size:12px;color:#6b7280;margin-top:2px">Cargando...</div>
    </div>
    <div class="entry-drawer-body" id="entry-drawer-body">
      <div style="padding:24px;text-align:center;color:#6b7280;font-size:13px">Cargando asiento...</div>
    </div>
  </aside>`;
  document.body.appendChild(overlay);

  // Cierre: ✕, click en el fondo o Esc. El drawer NO bloquea el scroll de la
  // tabla de atrás: es un visor, no un formulario con datos sin guardar.
  overlay.addEventListener('click', e => { if (e.target === overlay) closeEntryDrawer(); });
  overlay.querySelector('#entry-drawer-close').onclick = closeEntryDrawer;
  _entryDrawerKeyHandler = e => { if (e.key === 'Escape') closeEntryDrawer(); };
  document.addEventListener('keydown', _entryDrawerKeyHandler);

  const body = overlay.querySelector('#entry-drawer-body');
  const sub = overlay.querySelector('#entry-drawer-sub');

  let entry;
  try {
    const res = await authFetch(`${API_URL}/journal/${entryId}`);
    if (!res || !res.ok) { body.innerHTML = '<div style="padding:24px;color:#991b1b;font-size:13px">No se pudo cargar el asiento</div>'; sub.textContent = 'Error'; return; }
    entry = await res.json();
  } catch (e) {
    body.innerHTML = '<div style="padding:24px;color:#991b1b;font-size:13px">Error de conexión</div>';
    sub.textContent = 'Error';
    return;
  }
  // El drawer pudo cerrarse mientras cargaba
  if (!document.getElementById('entry-drawer-overlay')) return;

  const fmt = n => `$${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const money = n => (Number(n) ? fmt(n) : '—');
  const fecha = entry.date ? new Date(entry.date).toLocaleDateString('es-PA') : '—';
  const o = entry.origin;
  const lineas = entry.lines || [];
  const totalDeb = lineas.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCred = lineas.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const cuadra = Math.abs(totalDeb - totalCred) < 0.01 && totalDeb > 0;

  sub.innerHTML = `📅 ${fecha} · ${statusTag(entry.status, entry.reviewNotes)}`;

  // Línea de la cuenta consultada: fondo azul claro + borde izquierdo
  const filas = lineas.map(l => {
    const esLaCuenta = accountId && l.accountId === accountId;
    const fondo = esLaCuenta ? 'background:#eff6ff;box-shadow:inset 3px 0 0 #1565c0' : '';
    return `<tr style="${fondo}">
      <td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12.5px">
        <span style="color:#6b7280">${escapeHtml(l.account?.code || '')}</span> ${escapeHtml(l.account?.name || '')}
        ${esLaCuenta ? '<span style="font-size:10px;color:#1565c0;font-weight:700;margin-left:4px">◀ ESTA CUENTA</span>' : ''}
      </td>
      <td style="text-align:right;padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12.5px;color:#2e7d32;font-weight:600;white-space:nowrap">${money(l.debit)}</td>
      <td style="text-align:right;padding:8px 12px;border-bottom:1px solid #f0f0f0;font-size:12.5px;color:#c62828;font-weight:600;white-space:nowrap">${money(l.credit)}</td>
    </tr>`;
  }).join('');

  // Concepto con que se clasificó el movimiento: la descripción del asiento
  // trae el detalle original (lo que decía el archivo), así que el concepto
  // clasificado se muestra aquí, debajo del origen.
  const concepto = entry.transactions?.[0]?.concept || null;

  const auditoria = [
    entry.createdBy?.name ? `👤 Creado por ${escapeHtml(entry.createdBy.name)}${entry.createdAt ? ` · ${new Date(entry.createdAt).toLocaleDateString('es-PA')}` : ''}` : null,
    entry.reviewedBy?.name ? `🔍 Revisado por ${escapeHtml(entry.reviewedBy.name)}${entry.reviewedAt ? ` · ${new Date(entry.reviewedAt).toLocaleDateString('es-PA')}` : ''}` : null,
    entry.reviewNotes ? `📝 Notas de revisión: ${escapeHtml(entry.reviewNotes)}` : null,
  ].filter(Boolean);

  body.innerHTML = `
    <div style="font-weight:700;font-size:15px;line-height:1.35">${escapeHtml(entry.description || 'Sin descripción')}</div>
    ${o ? `<div style="margin-top:8px">
      <span style="display:inline-flex;align-items:center;gap:5px;background:#eef2ff;color:#3730a3;border:1px solid #c7d2fe;border-radius:999px;padding:3px 10px;font-size:11.5px;font-weight:600">${o.icon || '🏷'} ${escapeHtml(o.label || 'Origen')}</span>
      ${o.detail ? `<div style="font-size:11.5px;color:#6b7280;margin-top:4px">${escapeHtml(o.detail)}</div>` : ''}
      ${concepto ? `<div style="font-size:11.5px;color:#6b7280;margin-top:4px">Concepto: <strong style="color:#374151">${escapeHtml(concepto)}</strong></div>` : ''}
      ${o.link && o.link.type === 'invoice' && typeof downloadFacturaPdf === 'function'
        ? `<button onclick="downloadFacturaPdf('${o.link.id}')" style="margin-top:6px;padding:5px 12px;font-size:11.5px;background:#fff;color:#1565c0;border:1px solid #1565c0;border-radius:6px;cursor:pointer">📄 Ver PDF de la factura</button>`
        : ''}
    </div>` : ''}

    <table style="width:100%;border-collapse:collapse;margin-top:14px">
      <thead><tr>
        <th style="text-align:left;padding:6px 12px;border-bottom:2px solid #e5e7eb;font-size:10.5px;color:#6b7280;text-transform:uppercase">Cuenta</th>
        <th style="text-align:right;padding:6px 12px;border-bottom:2px solid #e5e7eb;font-size:10.5px;color:#6b7280;text-transform:uppercase">Débito</th>
        <th style="text-align:right;padding:6px 12px;border-bottom:2px solid #e5e7eb;font-size:10.5px;color:#6b7280;text-transform:uppercase">Crédito</th>
      </tr></thead>
      <tbody>${filas || '<tr><td colspan="3" style="padding:12px;color:#6b7280;font-size:12.5px">El asiento no tiene líneas</td></tr>'}</tbody>
      <tfoot><tr style="border-top:2px solid #1a1a2e;font-weight:700">
        <td style="padding:8px 12px;font-size:12px">Totales ${cuadra
          ? '<span style="color:#059669;font-weight:600">✓ cuadra</span>'
          : '<span style="color:#b45309;font-weight:600">⚠ descuadre</span>'}</td>
        <td style="text-align:right;padding:8px 12px;font-size:12.5px;color:#2e7d32;white-space:nowrap">${fmt(totalDeb)}</td>
        <td style="text-align:right;padding:8px 12px;font-size:12.5px;color:#c62828;white-space:nowrap">${fmt(totalCred)}</td>
      </tr></tfoot>
    </table>

    ${auditoria.length ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid #f0f0f0;font-size:11.5px;color:#6b7280;line-height:1.8">${auditoria.join('<br>')}</div>` : ''}
    <div style="margin-top:12px;font-size:10.5px;color:#9ca3af">Asiento ${escapeHtml(entry.id.slice(0, 10))}…</div>
  `;

  // Resaltar la fila del auxiliar que abrió este drawer
  document.querySelectorAll('.aux-row-active').forEach(tr => tr.classList.remove('aux-row-active'));
  const fila = document.querySelector(`[data-entry-id="${entryId}"]`);
  if (fila) fila.classList.add('aux-row-active');
}

