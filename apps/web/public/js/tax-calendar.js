// tax-calendar.js (13/14) — calendario fiscal panameño
/* ── Panel: Calendario Fiscal (inline) ── */
function loadPanelTaxCalendar() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-taxcalendar-content').classList.remove('hidden');
  loadTaxCalendarInline();
}

async function loadTaxCalendarInline() {
  const el = document.getElementById('taxcalendar-inline-list');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/tax-calendar`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; return; }
    const data = await res.json();
    const overdue = data.overdue || [];
    const upcoming = data.upcoming || [];

    if (!overdue.length && !upcoming.length) {
      el.innerHTML = '<div style="text-align:center;padding:48px;color:#059669;font-size:15px">✅ No hay obligaciones fiscales pendientes</div>';
      return;
    }

    const tipoIcono = { ITBMS: '🧾', ISR: '💰', CSS: '🏥', AVISO: '📋', TASA_UNICA: '📊' };
    const tipoLabel = { ITBMS: 'Declaración ITBMS', ISR: 'Impuesto sobre la Renta', CSS: 'Seguro Social', AVISO: 'Aviso de Operación', TASA_UNICA: 'Tasa Única' };

    function renderCard(o, isOverdue) {
      const due = new Date(o.dueDate);
      const dias = Math.ceil((due - Date.now()) / 86400000);
      const icon = tipoIcono[o.type] || '📌';
      const label = tipoLabel[o.type] || o.type;
      const statusColor = isOverdue ? '#dc2626' : dias <= 7 ? '#f59e0b' : '#059669';
      const statusBg = isOverdue ? '#fef2f2' : dias <= 7 ? '#fffbeb' : '#f0fdf4';
      const badge = isOverdue ? '🔴 Vencida' : dias <= 7 ? '🟡 Próxima' : '🟢 Al día';
      const diasText = isOverdue ? `${Math.abs(dias)} días de retraso` : dias === 0 ? 'Vence hoy' : `${dias} días restantes`;

      return `<div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${statusColor};border-radius:10px;padding:16px;margin-bottom:10px;display:flex;align-items:center;gap:14px">
        <div style="font-size:32px">${icon}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:#1a1a2e">${escapeHtml(label)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px">${escapeHtml(o.label)}</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap">
            <span style="font-size:12px;color:${statusColor};font-weight:600">📅 ${due.toLocaleDateString('es-PA',{month:'short',day:'numeric',year:'numeric'})}</span>
            <span style="font-size:11px;background:${statusBg};color:${statusColor};padding:2px 8px;border-radius:10px;font-weight:600">${badge} · ${diasText}</span>
            ${o.estimatedAmount ? `<span style="font-size:13px;font-weight:700;color:#1a1a2e">$${o.estimatedAmount.toFixed(2)}</span>` : ''}
          </div>
        </div>
        ${o.status !== 'COMPLETED' ? `<button class="btn-sm" onclick="markTaxObligationComplete('${o.id}')" style="padding:4px 10px;font-size:11px;background:#059669;color:#fff;border:none;border-radius:6px;cursor:pointer;white-space:nowrap">✅ Marcar</button>` : '<span style="font-size:11px;color:#059669;font-weight:600">✅ Completado</span>'}
      </div>`;
    }

    let html = '';
    if (data.saldoITBMS != null) {
      html += `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:12px">
        <div style="font-size:24px">🧾</div>
        <div style="flex:1">
          <div style="font-size:12px;color:#0369a1;font-weight:600">Saldo acumulado de ITBMS por pagar</div>
          <div style="font-size:18px;font-weight:700;color:${data.saldoITBMS > 0 ? '#b45309' : '#059669'}">$${data.saldoITBMS.toFixed(2)}</div>
        </div>
        ${data.saldoITBMS > 0 ? '<div style="font-size:11px;color:#6b7280;text-align:right">Ventas − compras − pagos parciales a DGI<br>sobre la cuenta 2.1.05</div>' : '<span style="font-size:12px;color:#059669;font-weight:600">✅ Al día</span>'}
      </div>`;
    }
    if (overdue.length) {
      html += `<div style="margin-bottom:20px"><h3 style="font-size:15px;color:#dc2626;margin:0 0 10px 0">🔴 Vencidas (${overdue.length})</h3>`;
      html += overdue.map(o => renderCard(o, true)).join('');
      html += '</div>';
    }
    if (upcoming.length) {
      html += `<div><h3 style="font-size:15px;color:#1a1a2e;margin:0 0 10px 0">📅 Próximas (${upcoming.length})</h3>`;
      html += upcoming.map(o => renderCard(o, false)).join('');
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

async function markTaxObligationComplete(id) {
  try {
    const res = await authFetch(`${API_URL}/tax-calendar/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'COMPLETED' }),
    });
    if (res.ok) { loadTaxCalendarInline(); }
  } catch (e) { /* ignore */ }
}
