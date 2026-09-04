// informes.js (12/14) — panel informes con tabs y export
/* ── Panel: Informes (inline) ── */
function loadPanelInformes() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-informes-content').classList.remove('hidden');
  // Activar tab Diario por defecto
  clickInformeTab('diario');
}

// Tabs de informes
document.querySelectorAll('#panel-tabs-informes button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-informes');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    clickInformeTab(btn.dataset.informe);
  });
});

let _currentInformeTab = 'diario';

function clickInformeTab(informe) {
  const btns = document.querySelectorAll('#panel-tabs-informes button');
  btns.forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
  const active = document.querySelector(`#panel-tabs-informes button[data-informe="${informe}"]`);
  if (active) { active.classList.add('active'); active.style.color = '#1a1a2e'; active.style.borderBottomColor = '#1565c0'; }
  _currentInformeTab = informe;
  // Mostrar filtro de fecha solo para reportes que lo soportan
  const exportTypes = { diario: 'diario', balance: 'balance-comprobacion', resultados: 'estado-resultados', dashboard: null, auxiliares: null, revision: null, proveedores: 'proveedores' };
  const showFilter = (informe === 'diario' || informe === 'balance' || informe === 'resultados' || informe === 'proveedores' || informe === 'dashboard');
  document.getElementById('informes-date-filter').classList.toggle('hidden', !showFilter);
  // Mostrar filtro de status solo en Diario
  const statusEl = document.getElementById('informes-filter-status');
  if (statusEl) statusEl.style.display = informe === 'diario' ? '' : 'none';
  setInformesExportBar(exportTypes[informe] || null);
  showInformesLoading();
  const loaders = { diario: loadReportDiario, balance: loadReportBalance, resultados: loadReportResultados, dashboard: loadReportDashboard, proveedores: loadReportProveedores };
  if (loaders[informe]) loaders[informe]();
}

function showInformesLoading() {
  document.getElementById('informes-inline-result').innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando reporte...</div>';
}

let _informesCharts = [];

async function loadReportDiario() {
  const el = document.getElementById('informes-inline-result');
  try {
    const params = getInformesDateParams(); params.set('limit','30');
    const res = await authFetch(`${API_URL}/journal?${params}`);
    const d = await res.json();
    if (!d.entries || !d.entries.length) { el.innerHTML = '<div class="empty">No hay asientos registrados</div>'; return; }
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    let totDeb = 0, totCred = 0;
    let html = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Fecha</th><th>Descripción</th><th>Cuenta</th><th>Débito</th><th>Crédito</th><th>Estado</th></tr></thead><tbody>';
    for (const e of d.entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      const desc = escapeHtml(e.description||'');
      const statusHtml = statusTag(e.status);
      // Bloquear corrección si ya fue revertido/corregido antes
      const alreadyCorrected = (e.description||'').includes('[ref:') || d.entries.some(x => (x.description||'').includes(`[ref:${e.id.slice(0,12)}]`));
      const canCorrect = e.status === 'CONFIRMADO' && !(e.description||'').startsWith('ANULACIÓN:') && !(e.description||'').startsWith('REVERSIÓN') && !alreadyCorrected;
      const actionsHtml = canCorrect
        ? `<button onclick="corregirEntry('${e.id}')" style="margin-left:4px;padding:2px 8px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer" title="Anular original y crear corrección">✏️ Corregir</button>`
        : '';
      for (let i = 0; i < e.lines.length; i++) {
        const l = e.lines[i];
        totDeb += (l.debit||0);
        totCred += (l.credit||0);
        html += `<tr>
          <td>${i===0 ? date : ''}</td>
          <td>${i===0 ? desc : ''}</td>
          <td>${escapeHtml(l.account?.code||'')} — ${escapeHtml(l.account?.name||'')}</td>
          <td style="color:#2e7d32;font-weight:600">${l.debit ? fmt(l.debit) : '—'}</td>
          <td style="color:#c62828;font-weight:600">${l.credit ? fmt(l.credit) : '—'}</td>
          <td>${i===0 ? statusHtml + actionsHtml : ''}</td>
        </tr>`;
      }
    }
    html += '</tbody><tfoot><tr style="border-top:2px solid #1a1a2e;font-weight:700">';
    html += '<td></td><td></td><td style="padding-left:24px">Total</td>';
    html += `<td style="color:#2e7d32">${fmt(totDeb)}</td>`;
    html += `<td style="color:#c62828">${fmt(totCred)}</td>`;
    html += '<td></td></tr></tfoot></table></div>';
    el.innerHTML = informesPeriodoInfo(d) + html;
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
async function loadReportBalance() {
  const el = document.getElementById('informes-inline-result');
  try {
    const params = getInformesDateParams();
    const res = await authFetch(`${API_URL}/reports/balance-comprobacion?${params}`);
    const d = await res.json();
    const cuentas = d.cuentas || d || [];
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    let totDeb = 0, totCred = 0;
    const rows = cuentas.map(a => {
      totDeb += (a.totalDebit||0);
      totCred += (a.totalCredit||0);
      return [
        escapeHtml(a.account?.code), escapeHtml(a.account?.name),
        `<span style="color:#2e7d32">${fmt(a.totalDebit||0)}</span>`,
        `<span style="color:#c62828">${fmt(a.totalCredit||0)}</span>`,
        `<strong style="color:${a.balanceType==='DEUDOR'?'#2e7d32':'#c62828'}">${a.balanceType==='DEUDOR'?'+':'−'}${fmt(Math.abs(a.balance||0)).replace('$','')}</strong>`
      ];
    });
    const footer = ['', '<span style="padding-left:24px">Total</span>', `<span style="color:#2e7d32;font-weight:700">${fmt(totDeb)}</span>`, `<span style="color:#c62828;font-weight:700">${fmt(totCred)}</span>`, ''];
    const periodoInfo = d.periodo
      ? `<div style="font-size:12px;color:#6b7280;margin-bottom:10px">📅 Período de movimientos: ${new Date(d.periodo.start).toLocaleDateString('es-PA')} — ${new Date(d.periodo.end).toLocaleDateString('es-PA')} · Año fiscal ${d.periodo.anioFiscal} · <strong>Saldo acumulado</strong> al corte</div>`
      : '';
    el.innerHTML = periodoInfo + buildInformesTable(['Código','Cuenta','Débito (período)','Crédito (período)','Saldo (acumulado)'], rows, footer);
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
async function loadReportResultados() {
  const el = document.getElementById('informes-inline-result');
  try {
    const params = getInformesDateParams();
    const res = await authFetch(`${API_URL}/reports/estado-resultados?${params}`);
    const d = await res.json();
    const items = (obj) => Object.entries(obj||{}).map(([k,v]) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(k)}</td><td style="text-align:right;padding:6px 10px;border-bottom:1px solid #e5e7eb;font-weight:600">$${Number(v).toLocaleString()}</td></tr>`).join('');
    el.innerHTML = informesPeriodoInfo(d) + `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
        <div>
          <h3 style="font-size:14px;color:#2e7d32;margin:0 0 8px 0">📈 Ingresos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
            ${items(d.ingresos?.detalle||{})}
            <tfoot><tr style="border-top:2px solid #1a1a2e;background:#f0fdf4"><td style="padding:8px 10px"><strong>Total Ingresos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#2e7d32">$${d.ingresos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot>
          </table>
        </div>
        <div>
          <h3 style="font-size:14px;color:#c62828;margin:0 0 8px 0">📉 Gastos</h3>
          <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
            ${items(d.gastos?.detalle||{})}
            <tfoot><tr style="border-top:2px solid #1a1a2e;background:#fef2f2"><td style="padding:8px 10px"><strong>Total Gastos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#c62828">$${d.gastos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot>
          </table>
        </div>
      </div>
      ${d.costos?.total ? `<div style="margin-top:8px"><h3 style="font-size:14px;color:#e65100;margin:0 0 8px 0">🏭 Costos</h3><table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,0.06)">${items(d.costos?.detalle||{})}<tfoot><tr style="border-top:2px solid #1a1a2e"><td style="padding:8px 10px"><strong>Total Costos</strong></td><td style="text-align:right;padding:8px 10px"><strong style="color:#e65100">$${d.costos?.total?.toLocaleString()||'0'}</strong></td></tr></tfoot></table></div>` : ''}
      <div style="margin-top:16px;padding:14px;background:#f0f9ff;border-radius:8px;text-align:center;font-size:16px;font-weight:700;color:#1a1a2e">
        💰 Ganancia Bruta: <span style="color:${(d.gananciaBruta||0)>=0?'#2e7d32':'#c62828'}">$${(d.gananciaBruta||0).toLocaleString()}</span>
        &nbsp;|&nbsp;
        📊 Utilidad Neta: <span style="color:${(d.utilidadNeta||0)>=0?'#2e7d32':'#c62828'}">$${(d.utilidadNeta||0).toLocaleString()}</span>
      </div>`;
  } catch(e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}
// Carga Chart.js desde CDN si aún no está disponible (primer uso o sin panel dashboard previo)
async function ensureChartJs() {
  if (typeof Chart !== 'undefined') return true;
  try {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
    return true;
  } catch { return false; }
}

async function loadReportDashboard() {
  const el = document.getElementById('informes-inline-result');
  _informesCharts.forEach(c => c.destroy());
  _informesCharts = [];
  if (typeof Chart === 'undefined') {
    el.innerHTML = '<div class="empty">Cargando librería de gráficos...</div>';
    const ok = await ensureChartJs();
    if (!ok) { el.innerHTML = '<div class="empty">Error al cargar gráficos. Recarga la página.</div>'; return; }
  }
  try {
    const res = await authFetch(`${API_URL}/reports/dashboard`);
    if (!res || !res.ok) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const d = await res.json();

    let html = `
    <div class="dash-summary">
      <div class="dash-card dash-card-ing"><span>Ingresos</span><strong>$${d.resumen.totalIngresos.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
      <div class="dash-card dash-card-gas"><span>Gastos</span><strong>$${d.resumen.totalGastos.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
      <div class="dash-card dash-card-cost"><span>Costos</span><strong>$${d.resumen.totalCostos.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
      <div class="dash-card ${d.resumen.utilidadNeta >= 0 ? 'dash-card-pos' : 'dash-card-neg'}"><span>Utilidad Neta</span><strong>$${d.resumen.utilidadNeta.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></div>
    </div>
    <div class="dash-grid">
      <div class="dash-chart-card"><h4>Ingresos vs Gastos por Mes</h4><canvas id="chart-monthly"></canvas></div>
      <div class="dash-chart-card"><h4>Gastos por Categoría</h4><canvas id="chart-gastos"></canvas></div>
    </div>`;

    if (d.topIngresos.length) {
      html += `<div class="dash-grid"><div class="dash-chart-card"><h4>Ingresos por Categoría</h4><canvas id="chart-ingresos"></canvas></div><div></div></div>`;
    }

    el.innerHTML = informesPeriodoInfo(d) + html;

    const months = d.monthly.map(m => {
      const [y, mo] = m.month.split('-');
      const dt = new Date(parseInt(y), parseInt(mo) - 1);
      return dt.toLocaleDateString('es-PA', { month: 'short', year: 'numeric' });
    });

    const ctx1 = document.getElementById('chart-monthly');
    if (ctx1) {
      _informesCharts.push(new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: months,
          datasets: [
            { label: 'Ingresos', data: d.monthly.map(m => m.ingresos), backgroundColor: '#2e7d32', borderRadius: 4 },
            { label: 'Gastos', data: d.monthly.map(m => m.gastos), backgroundColor: '#c62828', borderRadius: 4 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } } },
          scales: { y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.06)' } }, x: { grid: { display: false } } },
        },
      }));
    }

    const ctx2 = document.getElementById('chart-gastos');
    if (ctx2 && d.topGastos.length) {
      const colors = ['#c62828', '#e53935', '#ef5350', '#e57373', '#ef9a9a', '#ffcdd2', '#b71c1c', '#d32f2f'];
      _informesCharts.push(new Chart(ctx2, {
        type: 'doughnut',
        data: {
          labels: d.topGastos.map(g => g.nombre),
          datasets: [{ data: d.topGastos.map(g => g.total), backgroundColor: colors.slice(0, d.topGastos.length) }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } } },
        },
      }));
    }

    const ctx3 = document.getElementById('chart-ingresos');
    if (ctx3 && d.topIngresos.length) {
      const colors = ['#2e7d32', '#388e3c', '#43a047', '#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#c8e6c9'];
      _informesCharts.push(new Chart(ctx3, {
        type: 'doughnut',
        data: {
          labels: d.topIngresos.map(g => g.nombre),
          datasets: [{ data: d.topIngresos.map(g => g.total), backgroundColor: colors.slice(0, d.topIngresos.length) }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, padding: 10, font: { size: 11 } } } },
        },
      }));
    }
  } catch (e) { el.innerHTML = '<div class="empty">Error de conexión</div>'; }
}
function loadReportAuxiliares() {
  const el = document.getElementById('informes-inline-result');
  el.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <button class="btn-primary active" onclick="switchAuxTab('cuenta',this)" style="padding:8px 16px;font-size:13px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">📒 Cuenta</button>
      <button class="btn-secondary" onclick="switchAuxTab('cxc',this)" style="padding:8px 16px;font-size:13px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;cursor:pointer">👥 CxC</button>
      <button class="btn-secondary" onclick="switchAuxTab('cxp',this)" style="padding:8px 16px;font-size:13px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;cursor:pointer">🏭 CxP</button>
    </div>
    <div id="aux-sub-content"></div>`;
  switchAuxTab('cuenta');
}

function switchAuxTab(tab, btn) {
  if (btn) {
    document.querySelectorAll('#informes-inline-result button').forEach(b => { b.style.background = '#e5e7eb'; b.style.color = '#374151'; });
    btn.style.background = '#1565c0'; btn.style.color = '#fff';
  }
  const sub = document.getElementById('aux-sub-content');
  sub.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Cargando...</div>';
  if (tab === 'cuenta') loadAuxCuenta(sub);
  else if (tab === 'cxc') loadAuxCxC(sub);
  else if (tab === 'cxp') loadAuxCxP(sub);
}

async function loadAuxCuenta(el) {
  el.innerHTML = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center"><select id="informes-aux-select" onchange="loadAuxiliarData()" style="padding:8px;border:1px solid #d1d5db;border-radius:6px;min-width:280px"><option value="">Selecciona una cuenta...</option></select><input type="date" id="aux-from" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px"><input type="date" id="aux-to" style="padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px"><button onclick="loadAuxiliarData()" style="padding:8px 14px;border:1px solid #1565c0;border-radius:6px;background:#1565c0;color:#fff;cursor:pointer;font-size:12px">🔍 Buscar</button></div><div id="informes-aux-data"><div style="text-align:center;padding:32px;color:#6b7280">Selecciona una cuenta</div></div>';
  try { const res = await authFetch(`${API_URL}/accounts`); const accounts = await res.json(); const sel = document.getElementById('informes-aux-select'); const sorted = detailAccounts(accounts); if (sel) sorted.forEach(a => { sel.innerHTML += `<option value="${a.id}">${a.code} — ${a.name}</option>`; }); } catch(e) {}
}
async function loadAuxiliarData() {
  const id = document.getElementById('informes-aux-select')?.value;
  if (!id) return;
  const from = document.getElementById('aux-from')?.value || '';
  const to = document.getElementById('aux-to')?.value || '';
  const params = new URLSearchParams();
  if (from) params.set('startDate', from);
  if (to) params.set('endDate', to);
  const el = document.getElementById('informes-aux-data');
  el.innerHTML = 'Cargando...';
  try {
    const res = await authFetch(`${API_URL}/journal/mayor/${id}?${params}`);
    const d = await res.json();
    if (!d.detail || !d.detail.length) { el.innerHTML = '<div style="text-align:center;padding:24px;color:#6b7280">Sin movimientos</div>'; return; }
    const fmt = n => n===0?'—':'$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    el.innerHTML = `<div style="margin-bottom:8px;font-weight:600">${d.account.code} — ${d.account.name}</div>` +
      buildInformesTable(['Fecha','Detalle','Débito','Crédito','Saldo'],
        d.detail.map(e => [new Date(e.date).toLocaleDateString('es-PA'), escapeHtml(e.description||''), `<span style="color:#2e7d32">${fmt(e.debit||0)}</span>`, `<span style="color:#c62828">${fmt(e.credit||0)}</span>`, `<strong>${fmt(e.balance||0)}</strong>`]));
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}
async function loadAuxCxC(el) {
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/clients`), authFetch(`${API_URL}/clients/report/summary`)]);
    if (!rc || !rs) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const clients = await rc.json(), sum = await rs.json();
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">'+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Clientes</div><div style="font-size:20px;font-weight:700">${sum.totalClients}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Por Cobrar</div><div style="font-size:20px;font-weight:700;color:#f59e0b">$${sum.totalDue.toLocaleString()}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Vencidas</div><div style="font-size:20px;font-weight:700;color:#ef4444">${sum.overdueInvoices}</div></div>`+
    '</div>';
    html += clients.filter(c => c.totalDue > 0).length
      ? buildInformesTable(['Cliente','RUC','Pendiente','Facturas',''], clients.filter(c => c.totalDue > 0).map(c => [escapeHtml(c.name), escapeHtml(c.taxId||'—'), `<span style="color:#c62828;font-weight:600">$${c.totalDue.toLocaleString()}</span>`, c.invoiceCount||'—', `<button onclick="toggleFacturas('${c.id}','invoices')" style="padding:4px 10px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📋 Ver</button><div id="detalle-${c.id}" class="hidden" style="margin-top:8px"></div>`]))
      : '<div style="text-align:center;padding:24px;color:#6b7280">Sin clientes con saldo pendiente</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}
async function loadAuxCxP(el) {
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/suppliers`), authFetch(`${API_URL}/suppliers/report/summary`)]);
    if (!rc || !rs) { el.innerHTML = '<div class="empty">Error</div>'; return; }
    const supps = await rc.json(), sum = await rs.json();
    let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">'+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Proveedores</div><div style="font-size:20px;font-weight:700">${sum.totalSuppliers}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Por Pagar</div><div style="font-size:20px;font-weight:700;color:#f59e0b">$${sum.totalOwed.toLocaleString()}</div></div>`+
      `<div style="background:#fff;border-radius:8px;padding:14px"><div style="font-size:11px;color:#6b7280">Vencidas</div><div style="font-size:20px;font-weight:700;color:#ef4444">${sum.overdueBills}</div></div>`+
    '</div>';
    html += supps.filter(s => s.totalOwed > 0).length
      ? buildInformesTable(['Proveedor','RUC','Pendiente','Facturas',''], supps.filter(s => s.totalOwed > 0).map(s => [escapeHtml(s.name), escapeHtml(s.taxId||'—'), `<span style="color:#c62828;font-weight:600">$${s.totalOwed.toLocaleString()}</span>`, s.billCount||'—', `<button onclick="toggleFacturas('${s.id}','bills')" style="padding:4px 10px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📋 Ver</button><div id="detalle-${s.id}" class="hidden" style="margin-top:8px"></div>`]))
      : '<div style="text-align:center;padding:24px;color:#6b7280">Sin proveedores con saldo pendiente</div>';
    el.innerHTML = html;
  } catch(e) { el.innerHTML = '<div class="empty">Error</div>'; }
}

async function toggleFacturas(entityId, type) {
  const det = document.getElementById('detalle-' + entityId);
  if (!det.classList.contains('hidden')) { det.classList.add('hidden'); return; }
  det.classList.remove('hidden');
  det.innerHTML = '<div style="text-align:center;padding:12px;color:#6b7280">Cargando...</div>';
  const url = type === 'invoices' ? `${API_URL}/clients/${entityId}/invoices` : `${API_URL}/suppliers/${entityId}/bills`;
  try {
    const res = await authFetch(url);
    const items = await res.json();
    if (!items || !items.length) { det.innerHTML = '<div style="text-align:center;padding:12px;color:#6b7280">Sin facturas</div>'; return; }
    const fmt = n => '$'+n.toLocaleString('en-US',{minimumFractionDigits:2});
    const rows = items.map(f => {
      const statusLabel = { PENDIENTE: '⏳ Pendiente', VENCIDA: '🔴 Vencida', PAGADA: '✅ Pagada', RECHAZADA: '❌ Rechazada' };
      const statusColor = { PENDIENTE: '#f59e0b', VENCIDA: '#dc2626', PAGADA: '#059669', RECHAZADA: '#dc2626' };
      // Saldo real: 0 en pagadas/rechazadas; con parciales queda el restante
      const saldo = f.saldo != null ? f.saldo
        : (f.status === 'PAGADA' || f.status === 'RECHAZADA') ? 0
          : Math.max(0, (f.total || f.amount || 0) - (f.paidAmount || 0));
      return [
        f.number || '—',
        new Date(f.date).toLocaleDateString('es-PA'),
        new Date(f.dueDate).toLocaleDateString('es-PA'),
        fmt(f.total || f.amount || 0),
        `<span style="color:${saldo > 0 ? '#c62828' : '#059669'};font-weight:600">${fmt(saldo)}</span>`,
        `<span style="color:${statusColor[f.status]||'#6b7280'};font-weight:600;font-size:11px">${statusLabel[f.status]||f.status}</span>`
      ];
    });
    det.innerHTML = '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:12px;margin-top:4px">'+
      buildInformesTable(['N° Factura','Fecha','Vence','Monto','Saldo','Estado'], rows)+'</div>';
  } catch(e) { det.innerHTML = '<div style="color:#dc2626;padding:8px">Error al cargar</div>'; }
}

/* ── Export helpers ── */
function getInformesDateParams() {
  const from = document.getElementById('informes-filter-from')?.value || '';
  const to = document.getElementById('informes-filter-to')?.value || '';
  const status = document.getElementById('informes-filter-status')?.value || '';
  const params = new URLSearchParams();
  if (from) params.set('startDate', from);
  if (to) params.set('endDate', to);
  if (status) params.set('status', status);
  return params;
}
function loadCurrentInformeTab() {
  const loaders = { diario: loadReportDiario, balance: loadReportBalance, resultados: loadReportResultados, dashboard: loadReportDashboard, proveedores: loadReportProveedores };
  if (loaders[_currentInformeTab]) loaders[_currentInformeTab]();
}

function setInformesExportBar(type) {
  const el = document.getElementById('informes-export-btns');
  if (!el) return;
  if (!type) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <button onclick="exportInforme('${type}','xlsx')" style="padding:5px 12px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📥 Excel</button>
    <button onclick="exportInforme('${type}','csv')" style="padding:5px 12px;font-size:11px;background:#333;color:#fff;border:none;border-radius:4px;cursor:pointer">CSV</button>`;
}
function exportInforme(type, format) {
  const token = getToken();
  window.open(`${API_URL}/reports/export/${type}?format=${format}&token=${encodeURIComponent(token)}`, '_blank');
}

function buildInformesTable(headers, rows, footer) {
  let h = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>';
  for (const th of headers) h += `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase">${th}</th>`;
  h += '</tr></thead><tbody>';
  for (const row of rows) {
    h += '<tr>';
    for (const td of row) h += `<td style="padding:8px 10px;border-bottom:1px solid #e5e7eb">${td}</td>`;
    h += '</tr>';
  }
  h += '</tbody>';
  if (footer) {
    h += `<tfoot><tr style="border-top:2px solid #1a1a2e;font-weight:700">`;
    for (const td of footer) h += `<td style="padding:8px 10px">${td||''}</td>`;
    h += '</tr></tfoot>';
  }
  h += '</table></div>';
  return h;
}

/** Línea de información del período efectivo que muestra el reporte. */
function informesPeriodoInfo(d) {
  if (!d || !d.periodo) return '';
  const s = d.periodo.start ? new Date(d.periodo.start).toLocaleDateString('es-PA') : '';
  const e = d.periodo.end ? new Date(d.periodo.end).toLocaleDateString('es-PA') : '';
  const af = d.periodo.anioFiscal ? ` · Año fiscal ${d.periodo.anioFiscal}` : '';
  return `<div style="font-size:12px;color:#6b7280;margin-bottom:10px">📅 Período mostrado: ${s} — ${e}${af}</div>`;
}

// ── Reporte por proveedor (facturas DGI — declaración de rentas) ──
async function loadReportProveedores() {
  const el = document.getElementById('informes-inline-result');
  const params = getInformesDateParams();
  try {
    const res = await authFetch(`${API_URL}/reports/proveedores?${params.toString()}`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar el reporte</div>'; return; }
    const d = await res.json();

    if (!d.proveedores.length) {
      el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">No hay facturas con proveedor en el período seleccionado</div>';
      return;
    }

    const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
    const cards = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px">
        ${[
          ['🧾 Proveedores', d.totalProveedores],
          ['📄 Facturas', d.facturas],
          ['💰 Subtotal', money(d.subtotal)],
          ['📊 ITBMS', money(d.itbms)],
          ['✅ Total', money(d.total)],
        ].map(([label, value]) => `
          <div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center">
            <div style="font-size:11px;color:#6b7280">${label}</div>
            <div style="font-size:17px;font-weight:700;color:#1a1a2e;margin-top:4px">${value}</div>
          </div>`).join('')}
      </div>`;

    const rows = d.proveedores.map((p, i) => [
      p.provider,
      p.ruc || '—',
      p.facturas,
      money(p.subtotal),
      money(p.itbms),
      money(p.total),
      `<button onclick="toggleProveedorDetalle(${i})" style="padding:4px 10px;font-size:11px;background:#f0f0f0;border:1px solid #d1d5db;border-radius:5px;cursor:pointer">📋 Detalle</button>`,
    ]);
    const footer = ['', '', d.facturas, money(d.subtotal), money(d.itbms), money(d.total), ''];

    let html = informesPeriodoInfo(d) + cards + buildInformesTable(['Proveedor', 'RUC', 'Facturas', 'Subtotal', 'ITBMS', 'Total', ''], rows, footer);

    // Detalle por proveedor (toggle)
    d.proveedores.forEach((p, i) => {
      const detRows = p.detalle.map(f => [
        f.invoiceNumber || '—',
        new Date(f.date).toLocaleDateString('es-PA'),
        money(f.amount),
        money(f.itbms),
        money(f.total),
      ]);
      const detFooter = ['Total', '', money(p.subtotal), money(p.itbms), money(p.total)];
      html += `<div id="prov-detalle-${i}" class="hidden" style="margin:8px 0 16px 8px;border-left:3px solid #1565c0;padding-left:12px">${buildInformesTable(['N° Factura', 'Fecha', 'Monto', 'ITBMS', 'Total'], detRows, detFooter)}</div>`;
    });

    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar el reporte</div>';
  }
}

function toggleProveedorDetalle(i) {
  const el = document.getElementById(`prov-detalle-${i}`);
  if (el) el.classList.toggle('hidden');
}

