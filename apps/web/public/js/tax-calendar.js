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

    // ── Cierre de año fiscal ──
    const year = new Date().getFullYear();
    html += `
      <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid #1565c0;border-radius:10px;padding:16px;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span style="font-size:26px">🗓</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:700;font-size:14px;color:#1a1a2e">Cierre de año fiscal</div>
            <div id="year-close-status" style="font-size:12px;color:#6b7280;margin-top:2px">Consultando...</div>
          </div>
          <select id="year-close-select" onchange="loadYearCloseStatus()" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff">${[year, year-1, year-2].map(y => `<option value="${y}">${y}</option>`).join('')}</select>
          <button onclick="closeFiscalYear()" id="year-close-btn" style="padding:8px 14px;font-size:12px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">🔒 Cerrar año</button>
        </div>
        <div id="year-close-result" style="margin-top:8px"></div>
      </div>`;

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
    loadYearCloseStatus();
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

// ── Cierre de año fiscal ──
async function loadYearCloseStatus() {
  const year = document.getElementById('year-close-select')?.value;
  const el = document.getElementById('year-close-status');
  if (!year || !el) return;
  try {
    const res = await authFetch(`${API_URL}/year-close/${year}`);
    if (!res.ok) { el.innerHTML = '<span style="color:#dc2626">Error al consultar</span>'; return; }
    const d = await res.json();
    const pend = d.resumen.pendientesRevision > 0
      ? `<span style="color:#f59e0b;font-weight:600">⚠️ ${d.resumen.pendientesRevision} asiento(s) pendientes de revisión no se incluirán</span>`
      : '';
    el.innerHTML = d.cerrado
      ? `<span style="color:#059669;font-weight:600">✅ Cerrado</span> · Utilidad del ejercicio: <strong>$${d.resumen.utilidadNeta.toFixed(2)}</strong>`
      : `<span style="color:#f59e0b;font-weight:600">Abierto</span> · Utilidad proyectada (solo aprobados): <strong>$${d.resumen.utilidadNeta.toFixed(2)}</strong>${pend ? '<br>' + pend : ''}`;
    const btn = document.getElementById('year-close-btn');
    if (btn) btn.style.display = d.cerrado ? 'none' : '';
  } catch { el.innerHTML = '<span style="color:#dc2626">Error al consultar</span>'; }
}

async function closeFiscalYear() {
  const year = document.getElementById('year-close-select')?.value;
  const resumen = document.getElementById('year-close-result');
  if (!year || !resumen) return;
  // Advertir si hay asientos pendientes de revisión en el año
  let aviso = '';
  try {
    const st = await (await authFetch(`${API_URL}/year-close/${year}`)).json();
    if (!st.cerrado && st.resumen.pendientesRevision > 0) {
      aviso = `\n\n⚠️ Hay ${st.resumen.pendientesRevision} asiento(s) en BORRADOR en ${year} que NO se incluirán en el cierre. Aprueba o rechaza antes de cerrar si deben contar.`;
    }
  } catch {}
  if (!confirm(`¿Cerrar el año fiscal ${year}? Se creará un asiento de cierre CONFIRMADO con la utilidad del ejercicio (solo asientos aprobados). No se podrá volver a cerrar hasta anularlo.${aviso}`)) return;
  resumen.innerHTML = 'Cerrando...';
  try {
    const res = await authFetch(`${API_URL}/year-close/${year}`, { method: 'POST' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      resumen.innerHTML = `<span style="color:#dc2626">${escapeHtml(e.error || 'Error al cerrar el año')}</span>`;
      return;
    }
    const d = await res.json();
    const esGanancia = d.resumen.tipo === 'GANANCIA';
    const color = esGanancia ? '#059669' : '#dc2626';
    resumen.innerHTML = `<span style="color:${color};font-weight:600">${esGanancia ? 'GANANCIA' : 'PÉRDIDA'}: $${d.resumen.utilidadNeta.toFixed(2)}</span> · Asiento <code>${d.entry.id.slice(0, 8)}</code> creado (${d.entry.lines.length} líneas).`;
    loadYearCloseStatus();
  } catch { resumen.innerHTML = '<span style="color:#dc2626">Error de conexión</span>'; }
}
