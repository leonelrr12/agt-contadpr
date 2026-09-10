// carga-inicial.js — Carga Inicial (balance de apertura) del Panel de
// Administración. Se movió aquí desde el panel Importar porque es un proceso
// de un solo uso por empresa. Usa los endpoints existentes del import
// (/api/import/preview con flag cargaInicial y /api/import/carga-inicial/execute)
// y su propia shell de UI (ids carga-inicial-*).
// Depende de: core.js (authFetch/showAlert/showConfirm).

let cargaInicialFile = null;
let cargaInicialPreview = null;

/* ── Account picker (cuentas contables) ── */
let cargaInicialAccounts = [];
let cargaInicialPickerCallback = null;

async function loadAllAccountsCargaInicial() {
  if (cargaInicialAccounts.length > 0) return cargaInicialAccounts;
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    if (res.ok) { cargaInicialAccounts = await res.json(); }
    return cargaInicialAccounts;
  } catch (e) { return []; }
}

function showAccountPickerCargaInicial(rowIndex, currentAccountId, event) {
  closeAccountPickerCargaInicial();
  const accounts = cargaInicialAccounts;
  if (accounts.length === 0) return;

  const picker = document.createElement('div');
  picker.id = 'carga-inicial-picker-dd';
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
        if (cargaInicialPickerCallback) {
          cargaInicialPickerCallback({ id: item.dataset.id, name: item.dataset.name, code: item.dataset.code, type: item.dataset.type });
        }
        closeAccountPickerCargaInicial();
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

  setTimeout(() => { document.addEventListener('click', closeAccountPickerCargaInicialOnClick); }, 0);
}

function closeAccountPickerCargaInicialOnClick(e) {
  const p = document.getElementById('carga-inicial-picker-dd');
  if (p && !p.contains(e.target) && !e.target.closest('.account-picker-btn')) {
    closeAccountPickerCargaInicial();
  }
}

function closeAccountPickerCargaInicial() {
  const p = document.getElementById('carga-inicial-picker-dd');
  if (p) p.remove();
  document.removeEventListener('click', closeAccountPickerCargaInicialOnClick);
}

/* ── Panel: Carga Inicial (Administración) ── */

/** Al abrir la pestaña: fecha por defecto, dropzone y aviso de "ya existe". */
async function loadPanelCargaInicial() {
  const dateInput = document.getElementById('carga-inicial-date');
  if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  loadAllAccountsCargaInicial();

  const zone = document.getElementById('carga-inicial-zone');
  const fileInput = document.getElementById('carga-inicial-file');
  zone.onclick = () => fileInput.click();
  zone.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  zone.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) handleCargaInicialFile(f);
  };
  fileInput.onchange = e => {
    const f = e.target.files[0];
    if (f) handleCargaInicialFile(f);
  };

  // Aviso: la carga inicial es de un solo uso — comprobar si ya existe una
  const warn = document.getElementById('carga-inicial-existe-warn');
  if (warn) {
    warn.classList.add('hidden');
    try {
      const res = await authFetch(`${API_URL}/import/carga-inicial/existe`);
      if (res.ok) {
        const d = await res.json();
        if (d.exists && d.entry) {
          const fecha = new Date(d.entry.date).toLocaleDateString('es-PA');
          warn.innerHTML = `⚠️ <strong>Ya existe una carga inicial</strong> (asiento ${d.entry.status} del ${fecha}). Verifica antes de crear otra: dos cargas iniciales duplicarían los saldos de apertura.`;
          warn.classList.remove('hidden');
        }
      }
    } catch { /* sin aviso si falla la consulta */ }
  }
}

/** Sube el archivo al preview de carga inicial (no escribe nada). */
async function handleCargaInicialFile(file) {
  cargaInicialFile = file;
  document.getElementById('carga-inicial-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('carga-inicial-loading').classList.remove('hidden');
  document.getElementById('carga-inicial-loading-text').textContent = 'Analizando archivo de carga inicial...';

  const importDate = document.getElementById('carga-inicial-date').value;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('cargaInicial', 'true');
  if (importDate) formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/import/preview`, { method: 'POST', body: formData });
    document.getElementById('carga-inicial-loading').classList.add('hidden');
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); resetCargaInicial(); return; }
    cargaInicialPreview = await res.json();
    document.getElementById('carga-inicial-zone').classList.add('hidden');
    renderCargaInicialPreview();
  } catch (e) {
    document.getElementById('carga-inicial-loading').classList.add('hidden');
    await showAlert('Error de conexión');
    resetCargaInicial();
  }
}

/** Preview: filas con cuenta asignable, totales de balance y contadores. */
function renderCargaInicialPreview() {
  if (!cargaInicialPreview || !cargaInicialPreview.cargaInicialPreview) return;
  const cip = cargaInicialPreview.cargaInicialPreview;
  const { rows, totalDebit, totalCredit, balanced, accountsNotFound } = cip;
  const totalRows = cargaInicialPreview.totalRows;

  document.getElementById('carga-inicial-summary').classList.remove('hidden');
  document.getElementById('carga-inicial-preview').classList.remove('hidden');
  document.getElementById('carga-inicial-actions').classList.remove('hidden');

  // rows trae TODAS las cuentas del archivo (no solo una muestra)
  document.getElementById('carga-inicial-total').textContent = totalRows;
  document.getElementById('carga-inicial-ok').textContent = rows.filter(r => r.status === 'ok').length;
  document.getElementById('carga-inicial-err').textContent = accountsNotFound;

  const btnExecute = document.getElementById('carga-inicial-execute');
  btnExecute.disabled = accountsNotFound > 0 || !balanced;
  btnExecute.title = accountsNotFound > 0
    ? 'Corrige las cuentas no encontradas antes de ejecutar'
    : !balanced
      ? 'El balance no cuadra. Revisa los montos.'
      : '';

  // Tarjetas de balance (débitos/créditos/diferencia)
  const summaryEl = document.getElementById('carga-inicial-summary');
  let balanceRow = document.getElementById('carga-inicial-balance-row');
  if (!balanceRow) {
    balanceRow = document.createElement('div');
    balanceRow.id = 'carga-inicial-balance-row';
    balanceRow.style.cssText = 'display:flex;gap:14px;margin-bottom:12px';
    summaryEl.parentNode.insertBefore(balanceRow, summaryEl.nextSibling);
  }
  balanceRow.innerHTML =
    `<div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:10px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:18px;font-weight:700">$${totalDebit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style="font-size:11px;color:#6b7280">Total Débitos</div></div>
     <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:10px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:18px;font-weight:700">$${totalCredit.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style="font-size:11px;color:#6b7280">Total Créditos</div></div>
     <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:10px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:18px;font-weight:700;color:${balanced?'#059669':'#dc2626'}">${balanced?'✅ Balanceado':'⚠️ Desbalanceado'}</div><div style="font-size:11px;color:#6b7280">Diferencia: $${Math.abs(totalDebit-totalCredit).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div></div>`;

  const thead = document.getElementById('carga-inicial-thead');
  thead.innerHTML = '<tr><th>#</th><th>Tipo</th><th>Cuenta</th><th>Monto</th><th>Lado</th><th>Cuenta Contable</th><th>Estado</th></tr>';
  let html = '';
  rows.forEach((r, i) => {
    const isErr = r.status !== 'ok';
    const accountLabel = r.matchedAccount ? `${r.matchedAccount.code} - ${r.matchedAccount.name}` : '';
    html += `<tr>
      <td>${i+1}</td><td>${escapeHtml(r.accountType)}</td><td>${escapeHtml(r.accountName)}</td>
      <td>$${r.amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</td><td>${r.side}</td>
      <td>
        <button class="account-picker-btn"
          style="font-size:11px;text-align:left;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:4px 8px;border-radius:4px;cursor:pointer;background:${isErr?'#fee2e2':'#f0fdf4'};border:1px solid ${isErr?'#fecaca':'#bbf7d0'};color:${isErr?'#991b1b':'#065f46'}"
          data-row="${i}" data-account-id="${r.matchedAccount?r.matchedAccount.id:''}">
          ${r.matchedAccount ? escapeHtml(accountLabel) : '🔍 Seleccionar...'}
        </button>
      </td>
      <td>${r.status==='ok'?'✅':'<span style="color:#dc2626">❌</span>'}</td></tr>`;
  });
  document.getElementById('carga-inicial-tbody').innerHTML = html;

  document.getElementById('carga-inicial-tbody').querySelectorAll('.account-picker-btn').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const rowIndex = parseInt(this.dataset.row);
      const currentId = this.dataset.accountId || null;
      cargaInicialPickerCallback = (selected) => {
        const row = cargaInicialPreview.cargaInicialPreview.rows[rowIndex];
        row.matchedAccount = { id: selected.id, name: selected.name, code: selected.code, type: selected.type };
        row.status = 'ok';
        const rrows = cargaInicialPreview.cargaInicialPreview.rows;
        cargaInicialPreview.cargaInicialPreview.accountsNotFound = rrows.filter(r => r.status !== 'ok').length;
        cargaInicialPreview.cargaInicialPreview.totalDebit = rrows.filter(r => r.side === 'Debe').reduce((s, r) => s + r.amount, 0);
        cargaInicialPreview.cargaInicialPreview.totalCredit = rrows.filter(r => r.side === 'Haber').reduce((s, r) => s + r.amount, 0);
        cargaInicialPreview.cargaInicialPreview.balanced = Math.abs(
          cargaInicialPreview.cargaInicialPreview.totalDebit - cargaInicialPreview.cargaInicialPreview.totalCredit
        ) < 0.01;
        renderCargaInicialPreview();
      };
      showAccountPickerCargaInicial(rowIndex, currentId, e);
    });
  });
}

/** Ejecuta la carga inicial (un solo asiento BORRADOR de apertura). */
async function executeCargaInicial() {
  const cip = cargaInicialPreview && cargaInicialPreview.cargaInicialPreview;
  if (!cip) return;
  if (cip.accountsNotFound > 0) {
    await showAlert(`⚠️ Hay ${cip.accountsNotFound} cuenta(s) sin asignar. Usa el selector (🔍) en cada fila.`);
    return;
  }
  if (!cip.balanced) {
    await showAlert(`⚠️ El balance no cuadra. Diferencia: $${Math.abs(cip.totalDebit - cip.totalCredit).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`);
    return;
  }

  const importDate = document.getElementById('carga-inicial-date').value;
  const dateLabel = importDate
    ? new Date(importDate + 'T12:00:00').toLocaleDateString('es-PA', { year: 'numeric', month: 'long', day: 'numeric' })
    : '(sin fecha)';
  const total = cargaInicialPreview.totalRows;

  const ok = await showConfirm(`¿Crear carga inicial con ${total} cuentas?\n\n📅 Fecha del balance: ${dateLabel}\n\nSe creará un solo asiento de apertura como BORRADOR.`);
  if (!ok) return;

  document.getElementById('carga-inicial-loading').classList.remove('hidden');
  document.getElementById('carga-inicial-actions').classList.add('hidden');
  document.getElementById('carga-inicial-loading-text').textContent = `Creando carga inicial con ${total} cuentas...`;

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
    document.getElementById('carga-inicial-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      const d = result.totalDebit || 0;
      const c = result.totalCredit || 0;
      await showAlert(`✅ Carga Inicial completada\n\n${result.description || ''}\nDébitos: $${d.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}\nCréditos: $${c.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`);
    } else {
      await showAlert(`❌ ${result.error || 'Error'}`);
    }
    resetCargaInicial();
    loadPanelCargaInicial(); // refrescar el aviso de "ya existe"
  } catch (e) {
    document.getElementById('carga-inicial-loading').classList.add('hidden');
    await showAlert('Error de conexión');
    resetCargaInicial();
  }
}

/** Limpia el estado del panel (mantiene la pestaña abierta). */
function resetCargaInicial() {
  cargaInicialFile = null;
  cargaInicialPreview = null;
  const fileInput = document.getElementById('carga-inicial-file');
  if (fileInput) fileInput.value = '';
  document.getElementById('carga-inicial-file-name').textContent = '';
  document.getElementById('carga-inicial-zone').classList.remove('hidden');
  document.getElementById('carga-inicial-preview').classList.add('hidden');
  document.getElementById('carga-inicial-summary').classList.add('hidden');
  document.getElementById('carga-inicial-actions').classList.add('hidden');
  document.getElementById('carga-inicial-loading').classList.add('hidden');
  const balanceRow = document.getElementById('carga-inicial-balance-row');
  if (balanceRow) balanceRow.remove();
  const btn = document.getElementById('carga-inicial-execute');
  if (btn) { btn.disabled = false; btn.title = ''; }
}
