// panels-sidebar.js (9/14) — auxiliar, recurrentes y vinculación WhatsApp
// ── Auxiliar de Cuenta ──
let _auxiliarAccounts = [];

async function loadAuxiliarAccounts() {
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    if (!res || !res.ok) return;
    const accounts = await res.json();
    _auxiliarAccounts = detailAccounts(accounts);

    const sel = document.getElementById('auxiliar-account');
    if (!sel) return;
    sel.innerHTML = '<option value="">Selecciona una cuenta...</option>' +
      _auxiliarAccounts.map(a => `<option value="${a.id}">${a.code} — ${a.name}</option>`).join('');
  } catch (e) {
    console.error('Error cargando cuentas:', e);
  }
}

async function loadAuxiliar() {
  const accountId = document.getElementById('auxiliar-account').value;
  const from = document.getElementById('auxiliar-from').value;
  const to = document.getElementById('auxiliar-to').value;

  if (!accountId) {
    await showAlert('Selecciona una cuenta contable');
    return;
  }

  const el = document.getElementById('auxiliar-content');
  el.innerHTML = '<div class="empty">Cargando...</div>';

  try {
    const params = new URLSearchParams();
    if (from) params.set('startDate', from);
    if (to) params.set('endDate', to);
    const qs = params.toString();

    const res = await authFetch(`${API_URL}/journal/mayor/${accountId}${qs ? `?${qs}` : ''}`);
    if (!res || !res.ok) { el.innerHTML = '<div class="empty">Error al cargar</div>'; return; }

    const data = await res.json();
    if (!data.detail || !data.detail.length) {
      el.innerHTML = '<div class="empty">Sin movimientos en este período</div>';
      return;
    }

    const account = data.account;
    const fmt = (n) => n === 0 ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    el.innerHTML = `
      <div style="margin-bottom:12px">
        <strong style="font-size:16px">${account.code} — ${account.name}</strong>
        <span style="color:#6b7280;font-size:13px;margin-left:8px">(${account.type})</span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="border-bottom:2px solid #e2e4e8">
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-size:11px">FECHA</th>
              <th style="text-align:left;padding:8px 12px;color:#6b7280;font-size:11px">DETALLE</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">DÉBITO</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">CRÉDITO</th>
              <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">SALDO</th>
            </tr>
          </thead>
          <tbody>
            ${data.detail.map(d => `
              <tr style="border-bottom:1px solid #f0f0f0">
                <td style="padding:8px 12px;white-space:nowrap">${new Date(d.date).toLocaleDateString('es-PA')}</td>
                <td style="padding:8px 12px;max-width:300px;overflow:hidden;text-overflow:ellipsis" title="${escapeHtml(d.description)}">${escapeHtml(d.description?.substring(0, 80) || '')}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap">${fmt(d.debit)}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap">${fmt(d.credit)}</td>
                <td style="text-align:right;padding:8px 12px;white-space:nowrap;font-weight:600;color:${d.balance >= 0 ? '#065f46' : '#991b1b'}">${fmt(d.balance)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr style="border-top:2px solid #1a1a2e;font-weight:700">
              <td colspan="2" style="padding:8px 12px">TOTALES</td>
              <td style="text-align:right;padding:8px 12px">${fmt(data.totals.totalDebit)}</td>
              <td style="text-align:right;padding:8px 12px">${fmt(data.totals.totalCredit)}</td>
              <td style="text-align:right;padding:8px 12px;color:${data.totals.finalBalance >= 0 ? '#065f46' : '#991b1b'}">${fmt(data.totals.finalBalance)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  } catch (e) {
    el.innerHTML = '<div class="empty">Error de conexión</div>';
  }
}

async function exportAuxiliar() {
  const accountId = document.getElementById('auxiliar-account').value;
  const from = document.getElementById('auxiliar-from').value;
  const to = document.getElementById('auxiliar-to').value;

  if (!accountId) { await showAlert('Selecciona una cuenta'); return; }

  try {
    const params = new URLSearchParams();
    if (from) params.set('startDate', from);
    if (to) params.set('endDate', to);
    const qs = params.toString();

    const res = await authFetch(`${API_URL}/journal/mayor/${accountId}${qs ? `?${qs}` : ''}`);
    if (!res || !res.ok) { await showAlert('Error al exportar'); return; }

    const data = await res.json();
    if (!data.detail || !data.detail.length) { await showAlert('Sin datos para exportar'); return; }

    // Generar CSV
    const account = data.account;
    let csv = `"${account.code} — ${account.name} (${account.type})"\n`;
    csv += 'Fecha,Detalle,Débito,Crédito,Saldo\n';
    for (const d of data.detail) {
      csv += `"${new Date(d.date).toLocaleDateString('es-PA')}","${(d.description || '').replace(/"/g, '""')}",${d.debit},${d.credit},${d.balance}\n`;
    }
    csv += `"TOTALES",,${data.totals.totalDebit},${data.totals.totalCredit},${data.totals.finalBalance}\n`;

    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auxiliar_${account.code.replace(/\./g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    await showAlert('Error al exportar');
  }
}

// escHtml consolidado en escapeHtml (capture-qr.js) — único helper de escape

// ── Recurring Transactions Panel ──
let editingRecurringId = null;

async function loadPanelRecurring() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  hideRecurringForm();
  document.getElementById('panel-recurring-content').classList.remove('hidden');

  try {
    const res = await authFetch(`${API_URL}/recurring`);
    if (!res.ok) throw new Error('Error al cargar');
    const data = await res.json();
    const templates = data.templates || [];
    window._recurringTemplates = templates;

    // Pending review
    const pendingDiv = document.getElementById('recurring-pending');
    const pendingCount = document.getElementById('recurring-pending-count');
    if (data.pendingReview > 0) {
      pendingDiv.style.display = 'block';
      pendingCount.textContent = data.pendingReview;
    } else {
      pendingDiv.style.display = 'none';
    }

    let html = '';
    if (templates.length === 0) {
      html = '<div class="empty" style="padding:32px;text-align:center;color:#6b7280">No hay transacciones recurrentes. Crea una para automatizar tus registros.</div>';
    } else {
      html = '<div style="display:flex;flex-direction:column;gap:12px">';
      for (const t of templates) {
        const freqLabel = { DAILY: 'Diario', WEEKLY: 'Semanal', MONTHLY: 'Mensual', YEARLY: 'Anual' }[t.frequency] || t.frequency;
        const nextRun = new Date(t.nextRunAt).toLocaleDateString('es-PA');
        const activeBadge = t.isActive
          ? '<span class="badge badge-ok">Activo</span>'
          : '<span class="badge badge-err">Pausado</span>';
        const lastRun = t.lastRunAt ? new Date(t.lastRunAt).toLocaleDateString('es-PA') : '—';
        html += `<div data-recurring-id="${t.id}" style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
            <div>
              <strong style="font-size:15px">${escapeHtml(t.description)}</strong>
              <div style="font-size:13px;color:#6b7280;margin-top:2px">${escapeHtml(t.concept || '')} • ${freqLabel} • $${t.amount.toFixed(2)}</div>
            </div>
            ${activeBadge}
          </div>
          <div style="display:flex;gap:16px;font-size:12px;color:#6b7280;margin-bottom:12px">
            <span>📅 Próximo: ${nextRun}</span>
            <span>📌 Último: ${lastRun}</span>
            <span>${t.requireConfirmation ? '🔍 Requiere confirmación' : '✅ Auto-confirmado'}</span>
          </div>
          <div style="display:flex;gap:6px">
            <button class="btn-secondary btn-sm" onclick="editRecurring('${t.id}')">✏️ Editar</button>
            <button class="btn-secondary btn-sm" onclick="toggleRecurring('${t.id}', ${!t.isActive})">${t.isActive ? '⏸ Pausar' : '▶️ Reanudar'}</button>
            <button class="btn-primary btn-sm" onclick="runRecurring('${t.id}')" style="background:#1565c0">▶️ Ejecutar ahora</button>
            <button class="btn-danger btn-sm" onclick="deleteRecurring('${t.id}')">🗑 Eliminar</button>
          </div>
        </div>`;
      }
      html += '</div>';
    }
    document.getElementById('recurring-list').innerHTML = html;
  } catch (e) {
    document.getElementById('recurring-list').innerHTML = '<div class="empty">Error al cargar</div>';
  }
}

function recurringFormHTML(title, values = {}) {
  return `<div class="recurring-inline-form" style="background:#f8fafc;border:1px solid #bfdbfe;border-radius:10px;padding:18px;margin-top:12px">
    <h4 style="margin:0 0 12px 0;font-size:15px;color:#1a1a2e">${title}</h4>
    <div class="form-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div style="grid-column:1/-1"><label style="font-size:12px;color:#6b7280">Descripción</label><input id="rec-desc" value="${escapeHtml(values.description||'')}" placeholder="Ej: Alquiler oficina" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px"></div>
      <div><label style="font-size:12px;color:#6b7280">Monto</label><input id="rec-amount" type="number" step="0.01" value="${values.amount||''}" placeholder="0.00" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px"></div>
      <div><label style="font-size:12px;color:#6b7280">Concepto</label><input id="rec-concept" value="${escapeHtml(values.concept||'')}" placeholder="Opcional" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px"></div>
      <div><label style="font-size:12px;color:#6b7280">Tipo</label><select id="rec-type" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px">
        <option value="GASTO" ${values.type==='GASTO'?'selected':''}>Gasto</option><option value="INGRESO" ${values.type==='INGRESO'?'selected':''}>Ingreso</option><option value="COMPRA" ${values.type==='COMPRA'?'selected':''}>Compra</option><option value="VENTA" ${values.type==='VENTA'?'selected':''}>Venta</option></select></div>
      <div><label style="font-size:12px;color:#6b7280">Método de pago</label><select id="rec-payment" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px">
        <option value="" ${!values.paymentMethod?'selected':''}>—</option><option value="EFECTIVO" ${values.paymentMethod==='EFECTIVO'?'selected':''}>Efectivo</option><option value="TRANSFERENCIA" ${values.paymentMethod==='TRANSFERENCIA'?'selected':''}>Transferencia</option><option value="TARJETA_CREDITO" ${values.paymentMethod==='TARJETA_CREDITO'?'selected':''}>T. Crédito</option><option value="TARJETA_DEBITO" ${values.paymentMethod==='TARJETA_DEBITO'?'selected':''}>T. Débito</option></select></div>
      <div><label style="font-size:12px;color:#6b7280">Frecuencia</label><select id="rec-freq" onchange="toggleRecDayFields()" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px">
        <option value="DAILY" ${values.frequency==='DAILY'?'selected':''}>Diario</option><option value="WEEKLY" ${values.frequency==='WEEKLY'?'selected':''}>Semanal</option><option value="MONTHLY" ${values.frequency==='MONTHLY'?'selected':''}>Mensual</option><option value="YEARLY" ${values.frequency==='YEARLY'?'selected':''}>Anual</option></select></div>
      <div id="rec-day-group"><label style="font-size:12px;color:#6b7280">Día del mes</label><input id="rec-day" type="number" min="1" max="31" value="${values.dayOfMonth||1}" style="width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:6px"></div>
      <div style="grid-column:1/-1"><label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="rec-confirm" ${values.requireConfirmation!==false?'checked':''}> Requiere confirmación antes de ejecutar</label></div>
    </div>
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="btn-primary" id="rec-save-btn" onclick="saveRecurring()" style="padding:8px 20px;font-size:13px">${values.id ? 'Actualizar' : 'Guardar'}</button>
      <button class="btn-secondary" onclick="hideRecurringForm()" style="padding:8px 20px;font-size:13px">Cancelar</button>
    </div>
  </div>`;
}

function showCreateRecurring() {
  hideRecurringForm();
  editingRecurringId = null;
  const list = document.getElementById('recurring-list');
  const form = recurringFormHTML('➕ Nueva Transacción Recurrente');
  list.insertAdjacentHTML('afterbegin', form);
  toggleRecDayFields();
}

function hideRecurringForm() {
  document.querySelectorAll('.recurring-inline-form').forEach(el => el.remove());
  editingRecurringId = null;
}

function editRecurring(id) {
  const t = (window._recurringTemplates || []).find(t => t.id === id);
  if (!t) return;

  hideRecurringForm();
  editingRecurringId = id;
  const card = document.querySelector(`[data-recurring-id="${id}"]`);
  if (card) {
    const form = recurringFormHTML('✏️ Editar Transacción Recurrente', t);
    card.insertAdjacentHTML('afterend', form);
    toggleRecDayFields();
  }
}

async function saveRecurring() {
  const body = {
    description: document.getElementById('rec-desc').value.trim(),
    amount: parseFloat(document.getElementById('rec-amount').value) || 0,
    concept: document.getElementById('rec-concept').value.trim() || undefined,
    type: document.getElementById('rec-type').value,
    paymentMethod: document.getElementById('rec-payment').value || null,
    frequency: document.getElementById('rec-freq').value,
    dayOfMonth: parseInt(document.getElementById('rec-day').value) || 1,
    requireConfirmation: document.getElementById('rec-confirm').checked,
  };

  if (!body.description || body.amount <= 0) {
    await showAlert('Descripción y monto son requeridos');
    return;
  }

  try {
    const url = editingRecurringId
      ? `${API_URL}/recurring/${editingRecurringId}`
      : `${API_URL}/recurring`;
    const method = editingRecurringId ? 'PUT' : 'POST';

    const res = await authFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }

    hideRecurringForm();
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al guardar');
  }
}

async function runRecurring(id) {
  const ok = await showConfirm('¿Ejecutar esta transacción recurrente ahora? Se creará un asiento contable.');
  if (!ok) return;
  try {
    const res = await authFetch(`${API_URL}/recurring/${id}/run`, { method: 'POST' });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); return; }
    const data = await res.json();
    if (data.executed) {
      await showAlert('✅ Asiento generado correctamente. Revisa el Diario.');
    } else {
      await showAlert('❌ ' + (data.error || 'No se pudo ejecutar'));
    }
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al ejecutar');
  }
}

async function toggleRecurring(id, isActive) {
  try {
    await authFetch(`${API_URL}/recurring/${id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive }),
    });
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al cambiar estado');
  }
}

async function deleteRecurring(id) {
  const ok = await showConfirm('¿Eliminar esta transacción recurrente?');
  if (!ok) return;
  try {
    await authFetch(`${API_URL}/recurring/${id}`, { method: 'DELETE' });
    await loadPanelRecurring();
  } catch (e) {
    await showAlert('Error al eliminar');
  }
}

function toggleRecDayFields() {
  const freq = document.getElementById('rec-freq').value;
  const container = document.getElementById('rec-day-container');
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    container.style.display = 'block';
    document.querySelector('#rec-day-container label').textContent = 'Día del mes';
    document.getElementById('rec-day').min = 1;
    document.getElementById('rec-day').max = 31;
  } else if (freq === 'WEEKLY') {
    container.style.display = 'block';
    document.querySelector('#rec-day-container label').textContent = 'Día de semana (0=Dom)';
    document.getElementById('rec-day').min = 0;
    document.getElementById('rec-day').max = 6;
  } else {
    container.style.display = 'none';
  }
}

// ── WhatsApp Panel ──
async function loadPanelWhatsApp() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-recurring-content').classList.add('hidden');
  hideRecurringForm();
  document.getElementById('panel-whatsapp-content').classList.remove('hidden');

  // Mostrar el número del bot de WhatsApp (endpoint público)
  const botNumber = document.getElementById('wa-bot-number');
  try {
    const res = await fetch(`${API_URL}/config/wa-phone`);
    if (res.ok) {
      const data = await res.json();
      if (data.phone) botNumber.textContent = data.phone;
    }
  } catch {}

  await loadWhatsAppLinks();
}

async function loadWhatsAppLinks() {
  try {
    const res = await authFetch(`${API_URL}/whatsapp/links`);
    if (!res.ok) throw new Error('Error');
    const links = await res.json();

    const el = document.getElementById('wa-links-list');
    if (!links.length) {
      el.innerHTML = '<div style="color:#6b7280;text-align:center;padding:16px;background:#f9fafb;border-radius:8px">No hay números vinculados aún. Vincula tu WhatsApp para empezar.</div>';
      return;
    }

    let html = '<div style="display:flex;flex-direction:column;gap:8px">';
    for (const l of links) {
      const verified = l.verifiedAt ? '✅' : '⏳';
      const date = l.verifiedAt ? new Date(l.verifiedAt).toLocaleDateString('es-PA') : 'Pendiente';
      html += `<div style="display:flex;justify-content:space-between;align-items:center;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px">
        <div>
          <strong>${verified} ${l.phoneNumber}</strong>
          <span style="font-size:11px;color:#6b7280;margin-left:8px">${l.label || ''}</span>
          <div style="font-size:11px;color:#6b7280">Vinculado: ${date}</div>
        </div>
        <button class="btn-danger btn-sm" onclick="unlinkWhatsApp('${l.id}')">🗑 Desvincular</button>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  } catch (e) {
    document.getElementById('wa-links-list').innerHTML = '<div style="color:#dc2626">Error al cargar</div>';
  }
}

async function verifyWhatsAppCode() {
  const phone = document.getElementById('wa-phone').value.trim();
  const code = document.getElementById('wa-code').value.trim();

  if (!phone || !code) {
    await showAlert('Ingresa tu número de WhatsApp y el código de 6 dígitos.');
    return;
  }

  try {
    const res = await authFetch(`${API_URL}/whatsapp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, code }),
    });

    const data = await res.json();
    if (!res.ok) { await showAlert(data.error || 'Error al verificar'); return; }

    await showAlert(data.message);
    document.getElementById('wa-code').value = '';
    document.getElementById('wa-phone').value = '';
    await loadWhatsAppLinks();
  } catch (e) {
    await showAlert('Error de conexión');
  }
}

async function unlinkWhatsApp(id) {
  const ok = await showConfirm('¿Desvincular este número de WhatsApp?');
  if (!ok) return;
  try {
    await authFetch(`${API_URL}/whatsapp/links/${id}`, { method: 'DELETE' });
    await loadWhatsAppLinks();
  } catch (e) {
    await showAlert('Error al desvincular');
  }
}

