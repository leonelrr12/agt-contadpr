// import.js (9/14) — importación masiva inline y conciliación
/* ── Panel: Importar (inline) ── */
let importInlineFile = null;
let importInlinePreview = null;

/* ── Account Picker para Carga Inicial (inline) ── */
let allAccountsInline = [];
let accountPickerCallbackInline = null;

async function loadAllAccountsInline() {
  if (allAccountsInline.length > 0) return allAccountsInline;
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    if (res.ok) { allAccountsInline = await res.json(); }
    return allAccountsInline;
  } catch (e) { return []; }
}

function showAccountPickerInline(rowIndex, currentAccountId, event) {
  closeAccountPickerInline();
  const accounts = allAccountsInline;
  if (accounts.length === 0) return;

  const picker = document.createElement('div');
  picker.id = 'account-picker-inline-dd';
  picker.style.cssText = 'position:fixed;background:#fff;border:1px solid #d0d5dd;border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,0.15);z-index:99999;width:300px;max-height:300px;display:flex;flex-direction:column';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Buscar cuenta...';
  searchInput.style.cssText = 'width:100%;padding:10px 12px;border:none;border-bottom:1px solid #e5e7eb;font-size:13px;outline:none;border-radius:8px 8px 0 0';
  picker.appendChild(searchInput);

  const list = document.createElement('div');
  list.style.cssText = 'overflow-y:auto;flex:1';
  picker.appendChild(list);

  function renderList(filter) {
    const q = (filter || '').toLowerCase().trim();
    let filtered = accounts;
    if (q) {
      filtered = accounts.filter(a =>
        a.name.toLowerCase().includes(q) || a.code.includes(q) ||
        (a.type && a.type.toLowerCase().includes(q))
      );
    }
    filtered = filtered.slice(0, 50);
    if (filtered.length === 0) {
      list.innerHTML = '<div style="padding:12px;color:#9ca3af;font-size:13px;text-align:center">No se encontraron cuentas</div>';
      return;
    }
    let html = ''; let lastType = '';
    filtered.forEach(a => {
      if (a.type && a.type !== lastType) {
        lastType = a.type;
        html += `<div style="padding:4px 12px;font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;background:#f9fafb">${escapeHtml(lastType)}</div>`;
      }
      const sel = a.id === currentAccountId;
      html += `<div data-id="${a.id}" data-name="${escapeHtml(a.name)}" data-code="${escapeHtml(a.code)}" data-type="${escapeHtml(a.type||'')}"
        style="padding:6px 12px;cursor:pointer;font-size:13px;${sel?'background:#e0e7ff;font-weight:600':''}">
        <span style="color:#6b7280;font-size:11px;margin-right:6px">${escapeHtml(a.code)}</span>${escapeHtml(a.name)}
      </div>`;
    });
    list.innerHTML = html;
    list.querySelectorAll('div[data-id]').forEach(item => {
      item.addEventListener('click', () => {
        if (accountPickerCallbackInline) {
          accountPickerCallbackInline({ id: item.dataset.id, name: item.dataset.name, code: item.dataset.code, type: item.dataset.type });
        }
        closeAccountPickerInline();
      });
      item.addEventListener('mouseover', function() { this.style.background = '#f0f7ff'; });
      item.addEventListener('mouseout', function() { this.style.background = sel ? '#e0e7ff' : 'transparent'; });
    });
  }

  renderList('');
  searchInput.addEventListener('input', () => renderList(searchInput.value));
  searchInput.focus();

  const rect = event.target.getBoundingClientRect();
  picker.style.top = Math.min(rect.bottom + 4, window.innerHeight - 320) + 'px';
  picker.style.left = Math.min(rect.left, window.innerWidth - 320) + 'px';
  document.body.appendChild(picker);

  setTimeout(() => { document.addEventListener('click', closeAccountPickerInlineOnClick); }, 0);
}

function closeAccountPickerInlineOnClick(e) {
  const p = document.getElementById('account-picker-inline-dd');
  if (p && !p.contains(e.target) && !e.target.closest('.account-picker-btn')) {
    closeAccountPickerInline();
  }
}

function closeAccountPickerInline() {
  const p = document.getElementById('account-picker-inline-dd');
  if (p) p.remove();
  document.removeEventListener('click', closeAccountPickerInlineOnClick);
}

function loadPanelImport() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-import-content').classList.remove('hidden');
  // Inicializar fecha por defecto
  const dateInput = document.getElementById('import-inline-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  // Cargar catálogo de cuentas para el picker de carga inicial
  loadAllAccountsInline();
  // Checkbox carga inicial: re-procesar archivo al cambiar
  document.getElementById('import-inline-carga').onchange = () => {
    if (importInlineFile) handleImportInlineFile(importInlineFile);
  };
  // Drag & drop + file input
  const zone = document.getElementById('import-inline-zone');
  const fileInput = document.getElementById('import-inline-file');
  zone.onclick = () => fileInput.click();
  zone.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  zone.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) handleImportInlineFile(f);
  };
  fileInput.onchange = e => {
    const f = e.target.files[0];
    if (f) handleImportInlineFile(f);
  };
}

async function handleImportInlineFile(file) {
  importInlineFile = file;
  const isCarga = document.getElementById('import-inline-carga').checked;
  document.getElementById('import-inline-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-loading-text').textContent = isCarga ? 'Analizando archivo de carga inicial...' : 'Analizando archivo...';

  const formData = new FormData();
  formData.append('file', file);
  if (isCarga) {
    formData.append('cargaInicial', 'true');
  } else {
    // Misma fecha global que usa /execute-all: la preview valida la fecha igual que la ejecución
    const d = document.getElementById('import-inline-date').value;
    if (d) formData.append('importDate', d);
  }
  try {
    const res = await authFetch(`${API_URL}/import/preview`, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); resetImportInline(); return; }
    importInlinePreview = await res.json();
    document.getElementById('import-inline-loading').classList.add('hidden');
    document.getElementById('import-inline-zone').classList.add('hidden');
    renderImportInlinePreview();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

function renderImportInlinePreview() {
  if (!importInlinePreview) return;
  const isCarga = importInlinePreview.cargaInicial === true;
  // Limpiar aviso de filas fuera de la muestra de un render previo
  const prevWarn = document.getElementById('import-inline-warn');
  if (prevWarn) prevWarn.remove();

  document.getElementById('import-inline-summary').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.remove('hidden');

  const btnExecute = document.getElementById('import-inline-execute');
  if (isCarga) {
    btnExecute.textContent = '📋 Cargar Balance Inicial';
    btnExecute.style.background = '#7c3aed';
    // Deshabilitar si hay cuentas no encontradas o no balanceado
    if (importInlinePreview.cargaInicialPreview) {
      const hasErrors = (importInlinePreview.cargaInicialPreview.accountsNotFound || 0) > 0;
      const notBalanced = !importInlinePreview.cargaInicialPreview.balanced;
      btnExecute.disabled = hasErrors || notBalanced;
      btnExecute.title = hasErrors
        ? 'Corrige las cuentas no encontradas antes de ejecutar'
        : notBalanced
          ? 'El balance no cuadra. Revisa los montos.'
          : '';
    }
  } else {
    btnExecute.textContent = '✅ Importar transacciones';
    btnExecute.style.background = '#059669';
    btnExecute.disabled = false;
    btnExecute.title = '';
  }

  if (isCarga && importInlinePreview.cargaInicialPreview) {
    const cip = importInlinePreview.cargaInicialPreview;
    const { rows, totalDebit, totalCredit, balanced, accountsNotFound } = cip;
    const totalRows = importInlinePreview.totalRows;

    document.getElementById('import-inline-total').textContent = totalRows;
    document.getElementById('import-inline-ok').textContent = rows.length - accountsNotFound + (totalRows > 20 ? '+' : '');
    document.getElementById('import-inline-err').textContent = accountsNotFound;

    // Mostrar balance extra
    const summaryEl = document.getElementById('import-inline-summary');
    let balanceRow = document.getElementById('import-inline-balance-row');
    if (!balanceRow) {
      balanceRow = document.createElement('div');
      balanceRow.id = 'import-inline-balance-row';
      balanceRow.style.cssText = 'display:flex;gap:14px;margin-bottom:16px';
      summaryEl.parentNode.insertBefore(balanceRow, summaryEl.nextSibling);
    }
    balanceRow.innerHTML =
      `<div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700">$${totalDebit.toFixed(2)}</div><div style="font-size:11px;color:#6b7280">Total Débitos</div></div>
       <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700">$${totalCredit.toFixed(2)}</div><div style="font-size:11px;color:#6b7280">Total Créditos</div></div>
       <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:${balanced?'#059669':'#dc2626'}">${balanced?'✅ Balanceado':'⚠️ Desbalanceado'}</div><div style="font-size:11px;color:#6b7280">Diferencia: $${Math.abs(totalDebit-totalCredit).toFixed(2)}</div></div>`;

    const thead = document.getElementById('import-inline-thead');
    thead.innerHTML = '<tr><th>#</th><th>Tipo</th><th>Cuenta</th><th>Monto</th><th>Lado</th><th>Cuenta Contable</th><th>Estado</th></tr>';
    let html = '';
    rows.forEach((r, i) => {
      const isErr = r.status !== 'ok';
      const accountLabel = r.matchedAccount ? `${r.matchedAccount.code} - ${r.matchedAccount.name}` : '';
      html += `<tr>
        <td>${i+1}</td><td>${escapeHtml(r.accountType)}</td><td>${escapeHtml(r.accountName)}</td>
        <td>$${r.amount.toFixed(2)}</td><td>${r.side}</td>
        <td>
          <button class="account-picker-btn"
            style="font-size:11px;text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border-radius:4px;cursor:pointer;background:${isErr?'#fee2e2':'#f0fdf4'};border:1px solid ${isErr?'#fecaca':'#bbf7d0'};color:${isErr?'#991b1b':'#065f46'}"
            data-row="${i}" data-account-id="${r.matchedAccount?r.matchedAccount.id:''}">
            ${r.matchedAccount ? escapeHtml(accountLabel) : '🔍 Seleccionar...'}
          </button>
        </td>
        <td>${r.status==='ok'?'✅':'<span style="color:#dc2626">❌</span>'}</td></tr>`;
    });
    document.getElementById('import-inline-tbody').innerHTML = html;

    // Asignar eventos click a los botones de selección
    document.getElementById('import-inline-tbody').querySelectorAll('.account-picker-btn').forEach(btn => {
      btn.addEventListener('click', function(e) {
        const rowIndex = parseInt(this.dataset.row);
        const currentId = this.dataset.accountId || null;
        accountPickerCallbackInline = (selected) => {
          const row = importInlinePreview.cargaInicialPreview.rows[rowIndex];
          row.matchedAccount = { id: selected.id, name: selected.name, code: selected.code, type: selected.type };
          row.status = 'ok';
          const rrows = importInlinePreview.cargaInicialPreview.rows;
          importInlinePreview.cargaInicialPreview.accountsNotFound = rrows.filter(r => r.status !== 'ok').length;
          importInlinePreview.cargaInicialPreview.totalDebit = rrows.filter(r => r.side === 'Debe').reduce((s, r) => s + r.amount, 0);
          importInlinePreview.cargaInicialPreview.totalCredit = rrows.filter(r => r.side === 'Haber').reduce((s, r) => s + r.amount, 0);
          importInlinePreview.cargaInicialPreview.balanced = Math.abs(
            importInlinePreview.cargaInicialPreview.totalDebit - importInlinePreview.cargaInicialPreview.totalCredit
          ) < 0.01;
          // Re-render
          document.getElementById('import-inline-tbody').querySelectorAll('.account-picker-btn').forEach(b => {
            b.removeEventListener('click', () => {}); // limpia handlers viejos
          });
          renderImportInlinePreview();
        };
        showAccountPickerInline(rowIndex, currentId, e);
      });
    });
  } else {
    // Remover balance row si existe
    const balanceRow = document.getElementById('import-inline-balance-row');
    if (balanceRow) balanceRow.remove();

    const { totalRows, previewRows, invalidRows = [] } = importInlinePreview;
    // El server valida TODAS las filas del archivo (invalidRows), no solo las
    // 20 visibles: los contadores reflejan el archivo completo.
    document.getElementById('import-inline-total').textContent = totalRows;
    document.getElementById('import-inline-ok').textContent = Math.max(0, totalRows - invalidRows.length);
    document.getElementById('import-inline-err').textContent = invalidRows.length;

    // Aviso si hay incompletas más allá de la muestra de 20
    const beyond = invalidRows.filter(x => x.row > 20);
    if (beyond.length > 0) {
      const warn = document.createElement('div');
      warn.id = 'import-inline-warn';
      warn.style.cssText = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
      warn.innerHTML = `⚠️ <strong>${beyond.length} fila(s) incompleta(s) fuera de la vista</strong> (#${beyond.map(x => x.row).join(', #')}): faltan datos obligatorios. Corrígelas en el archivo y vuelve a cargarlo.`;
      document.getElementById('import-inline-summary').after(warn);
    }

    const thead = document.getElementById('import-inline-thead');
    thead.innerHTML = '<tr><th>#</th><th>Fecha</th><th>Descripción</th><th>Monto</th><th>Ref</th><th>RUC</th><th>Concepto</th><th>Cuenta</th><th>Conf</th><th></th></tr>';
    let html = '';
    previewRows.forEach((r, i) => {
      const conf = r.classification;
      const faltantes = r.missing || [];
      const rowCls = faltantes.length ? ' style="background:#fef2f2"' : '';
      // Monto mostrado = neto + ITBMS (lo que realmente se paga)
      let montoHtml = '—';
      if (r.amount) {
        const total = r.amount + (r.itbms || 0);
        montoHtml = `$${total.toFixed(2)}${r.itbms ? ` <span style="color:#9ca3af;font-size:10px">(neto $${r.amount.toFixed(2)} + ITBMS $${r.itbms.toFixed(2)})</span>` : ''}`;
      }
      html += `<tr${rowCls}>
        <td>${i+1}</td><td>${r.date||'—'}</td><td>${escapeHtml(r.description||'')}</td>
        <td>${montoHtml}</td>
        <td>${escapeHtml(r.reference||'')}</td><td>${escapeHtml(r.ruc||'')}</td>
        <td>${escapeHtml(r.concept||'')}</td>
        <td>${conf?escapeHtml(conf.concept):'—'}</td>
        <td>${conf?Math.round(conf.confidence*100)+'%':'—'}</td>
        <td>${faltantes.length ? `<span style="color:#dc2626;font-size:11px">Falta: ${faltantes.join(', ')}</span>` : ''}</td></tr>`;
    });
    document.getElementById('import-inline-tbody').innerHTML = html;
  }
}

async function executeImportInline() {
  if (!importInlineFile) return;
  const isCarga = importInlinePreview.cargaInicial === true;
  const total = importInlinePreview.totalRows;
  const importDate = document.getElementById('import-inline-date').value;
  const dateLabel = new Date(importDate+'T12:00:00').toLocaleDateString('es-PA',{year:'numeric',month:'long',day:'numeric'});

  if (isCarga) {
    const cip = importInlinePreview.cargaInicialPreview;
    if (cip.accountsNotFound > 0) {
      await showAlert(`⚠️ Hay ${cip.accountsNotFound} cuenta(s) sin asignar. Usa el selector (🔍) en cada fila.`);
      return;
    }
    if (!cip.balanced) {
      await showAlert(`⚠️ El balance no cuadra. Diferencia: $${Math.abs(cip.totalDebit - cip.totalCredit).toFixed(2)}`);
      return;
    }

    const ok = await showConfirm(`¿Crear carga inicial con ${total} cuentas?\n\n📅 Fecha del balance: ${dateLabel}\n\nSe creará un solo asiento de apertura como BORRADOR.`);
    if (!ok) return;

    document.getElementById('import-inline-loading').classList.remove('hidden');
    document.getElementById('import-inline-actions').classList.add('hidden');
    document.getElementById('import-inline-loading-text').textContent = `Creando carga inicial con ${total} cuentas...`;

    // Enviar filas resueltas como JSON
    const rows = cip.rows.map(r => ({
      accountId: r.matchedAccount.id,
      accountName: r.accountName,
      accountType: r.accountType,
      amount: r.amount,
      side: r.side,
    }));

    try {
      const res = await authFetch(`${API_URL}/import/carga-inicial/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, importDate }),
      });
      document.getElementById('import-inline-loading').classList.add('hidden');
      const result = await res.json();
      if (res.ok) {
        const d = result.totalDebit || 0;
        const c = result.totalCredit || 0;
        await showAlert(`✅ Carga Inicial completada\n\n${result.description || ''}\nDébitos: $${d.toFixed(2)}\nCréditos: $${c.toFixed(2)}`);
      } else {
        await showAlert(`❌ ${result.error || 'Error'}`);
      }
      resetImportInline();
    } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
    return;
  }

  // ── Flujo normal ──
  const ok = await showConfirm(`¿Importar ${total} transacciones?\n\n📅 Fecha: ${dateLabel}\n\n⚠️ Verifica la fecha. Los asientos se crearán como BORRADOR.`);
  if (!ok) return;

  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading-text').textContent = `Importando ${total} transacciones...`;

  const formData = new FormData();
  formData.append('file', importInlineFile);
  formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/import/execute-all`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      let msg = `✅ Importación completada: ${result.success} de ${result.total} exitosas.`;
      if (result.errors && result.errors.length) {
        msg += `\n\n❌ ${result.errors.length} fila(s) rechazadas:\n` +
          result.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
          (result.errors.length > 6 ? `\n… y ${result.errors.length - 6} más.` : '');
      }
      await showAlert(msg);
    } else {
      await showAlert(`❌ ${result.error || 'Error'}`);
    }
    resetImportInline();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

function resetImportInline() {
  importInlineFile = null;
  importInlinePreview = null;
  document.getElementById('import-inline-file').value = '';
  document.getElementById('import-inline-file-name').textContent = '';
  document.getElementById('import-inline-zone').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.add('hidden');
  document.getElementById('import-inline-summary').classList.add('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading').classList.add('hidden');
  // Limpiar balance row si existe
  const balanceRow = document.getElementById('import-inline-balance-row');
  if (balanceRow) balanceRow.remove();
  // Resetear botón
  const btn = document.getElementById('import-inline-execute');
  btn.textContent = '✅ Importar transacciones';
  btn.style.background = '#059669';
}

/* ── Panel: Conciliación (inline) ── */
function loadPanelConciliacion() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-conciliacion-content').classList.remove('hidden');
  loadConciliacionList();
}

async function loadConciliacionList() {
  const el = document.getElementById('conciliacion-inline-list');
  try {
    const res = await authFetch(`${API_URL}/reconcile`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; return; }
    const statements = await res.json();
    if (!statements.length) {
      el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">No hay extractos bancarios. Sube uno para comenzar.</div>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Archivo</th><th>Fecha subida</th><th>Estado</th><th>Filas</th><th></th></tr></thead><tbody>';
    for (const s of statements) {
      html += `<tr>
        <td><strong>${escapeHtml(s.fileName||'Extracto')}</strong></td>
        <td>${new Date(s.uploadDate).toLocaleDateString('es-PA')}</td>
        <td>${s.status}</td>
        <td>${s._count?.rows||'—'}</td>
        <td><button class="btn-sm" onclick="window.open('/conciliacion.html','_blank')">🔍 Abrir</button></td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

function showConciliacionUpload() {
  const el = document.getElementById('conciliacion-inline-upload');
  el.classList.remove('hidden');
  const fileInput = document.getElementById('conciliacion-inline-file');
  el.onclick = () => fileInput.click();
  el.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) uploadConciliacionFile(f);
  };
  fileInput.onchange = e => { const f = e.target.files[0]; if (f) uploadConciliacionFile(f); };
}

async function uploadConciliacionFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await authFetch(`${API_URL}/reconcile/upload`, { method: 'POST', body: formData });
    if (res.ok) { await showAlert('✅ Extracto subido. Redirigiendo a conciliación...'); window.open('/conciliacion.html','_blank'); }
    else { const e = await res.json(); await showAlert(e.error || 'Error al subir'); }
  } catch (e) { await showAlert('Error de conexión'); }
  document.getElementById('conciliacion-inline-upload').classList.add('hidden');
  loadConciliacionList();
}

