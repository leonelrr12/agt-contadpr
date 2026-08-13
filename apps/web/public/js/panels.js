/* ── Diario state ── */
let diarioPage = 1;
const DIARIO_PAGE_SIZE = 20;

function filterPanelDiario() {
  diarioPage = 1;
  loadPanelDiario();
}

async function loadPanelDiario() {
  const el = document.getElementById('diario-content');
  const pagEl = document.getElementById('diario-pagination');
  const from = document.getElementById('filter-diario-from').value;
  const to = document.getElementById('filter-diario-to').value;
  const status = document.getElementById('filter-diario-status').value;
  const provider = document.getElementById('filter-diario-provider').value;
  let url = `${API_URL}/journal?page=${diarioPage}&pageSize=${DIARIO_PAGE_SIZE}`;
  if (status) url += `&status=${status}`;
  if (from) url += `&startDate=${from}`;
  if (to) url += `&endDate=${to}`;
  if (provider) url += `&provider=${encodeURIComponent(provider)}`;
  try {
    const res = await authFetch(url);
    const data = await res.json();
    if (!data.entries || !data.entries.length) {
      el.innerHTML = '<div class="empty">No hay asientos registrados</div>';
      pagEl.innerHTML = '';
      return;
    }
    let html = '<table><thead><tr><th>Fecha</th><th>Descripción</th><th>Cuenta</th><th>Débito</th><th>Crédito</th><th>Estado</th></tr></thead><tbody>';
    for (const e of data.entries) {
      const date = new Date(e.date).toLocaleDateString('es-PA');
      let statusTag = '';
      if (e.status === 'BORRADOR') statusTag = '<span class="tag tag-draft">BORRADOR</span>';
      else if (e.status === 'CONFIRMADO') statusTag = '<span class="tag tag-conf">CONFIRMADO</span>';
      else if (e.status === 'RECHAZADO') statusTag = `<span class="tag tag-rejected" title="${e.reviewNotes || ''}">RECHAZADO</span>`;
      else if (e.status === 'ANULADO') statusTag = '<span class="tag tag-void">ANULADO</span>';
      const providerHtml = e.provider ? ` — <span style="font-size:11px;color:#6b7280">${e.provider}</span>` : '';
      const firstLine = e.lines[0];
      if (firstLine) {
        const canUndo = e.status === 'CONFIRMADO' && !e.description.startsWith('ANULACIÓN:');
        const undoBtn = canUndo ? `<button onclick="anularPanel('${e.id}')" class="btn-undo" title="Anular asiento">↩</button>` : '';
        html += `<tr><td>${date}</td><td>${e.description}${providerHtml}${e.reviewNotes ? `<br><small style="color:#c62828">${e.reviewNotes}</small>` : ''}</td><td>${firstLine.account?.name || ''}</td><td class="debit">${firstLine.debit ? '$' + firstLine.debit.toFixed(2) : ''}</td><td class="credit">${firstLine.credit ? '$' + firstLine.credit.toFixed(2) : ''}</td><td>${statusTag} ${undoBtn}</td></tr>`;
      }
      for (let i = 1; i < e.lines.length; i++) {
        const line = e.lines[i];
        html += `<tr><td></td><td></td><td>${line.account?.name || ''}</td><td class="debit">${line.debit ? '$' + line.debit.toFixed(2) : ''}</td><td class="credit">${line.credit ? '$' + line.credit.toFixed(2) : ''}</td><td></td><td></td></tr>`;
      }
    }
    el.innerHTML = html + '</tbody></table>';

    pagEl.innerHTML = '';
    if (data.totalPages > 1) {
      const prev = document.createElement('button');
      prev.textContent = '← Anterior';
      prev.disabled = diarioPage <= 1;
      prev.onclick = () => { if (diarioPage > 1) { diarioPage--; loadPanelDiario(); } };
      pagEl.appendChild(prev);
      const span = document.createElement('span');
      span.textContent = `Pág. ${data.page} de ${data.totalPages} (${data.total} asientos)`;
      pagEl.appendChild(span);
      const next = document.createElement('button');
      next.textContent = 'Siguiente →';
      next.disabled = diarioPage >= data.totalPages;
      next.onclick = () => { if (diarioPage < data.totalPages) { diarioPage++; loadPanelDiario(); } };
      pagEl.appendChild(next);
    }
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; pagEl.innerHTML = ''; }
}

function clearDiarioFilters() {
  document.getElementById('filter-diario-from').value = '';
  document.getElementById('filter-diario-to').value = '';
  document.getElementById('filter-diario-status').value = 'CONFIRMADO';
  document.getElementById('filter-diario-provider').value = '';
  diarioPage = 1;
  loadPanelDiario();
}

async function anularPanel(id) {
  await anularEntry(id, null);
  loadPanelDiario();
  loadPanelBalance();
  loadPanelResultados();
}

async function loadPanelBalance() {
  const el = document.getElementById('balance-content');
  const from = document.getElementById('filter-balance-from').value;
  const to = document.getElementById('filter-balance-to').value;
  let url = `${API_URL}/reports/balance-comprobacion`;
  if (from) url += `?startDate=${from}`;
  if (to) url += `${from ? '&' : '?'}endDate=${to}`;
  try {
    const res = await authFetch(url);
    const data = await res.json();
    if (!data.length) { el.innerHTML = '<div class="empty">No hay movimientos</div>'; return; }
    let html = '<table><thead><tr><th>Cuenta</th><th>Débitos</th><th>Créditos</th><th>Saldo</th></tr></thead><tbody>';
    for (const b of data) {
      const saldo = b.balanceType === 'DEUDOR' ? `<span class="debit">$${b.balance.toFixed(2)}</span>` : `<span class="credit">$${b.balance.toFixed(2)}</span>`;
      html += `<tr><td>${b.account.name}</td><td class="debit">${b.totalDebit ? '$' + b.totalDebit.toFixed(2) : ''}</td><td class="credit">${b.totalCredit ? '$' + b.totalCredit.toFixed(2) : ''}</td><td>${saldo}</td></tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}

function clearBalanceFilters() {
  document.getElementById('filter-balance-from').value = '';
  document.getElementById('filter-balance-to').value = '';
  loadPanelBalance();
}

async function loadPanelResultados() {
  const el = document.getElementById('resultados-content');
  const from = document.getElementById('filter-resultados-from').value;
  const to = document.getElementById('filter-resultados-to').value;
  let url = `${API_URL}/reports/estado-resultados`;
  if (from) url += `?startDate=${from}`;
  if (to) url += `${from ? '&' : '?'}endDate=${to}`;
  try {
    const res = await authFetch(url);
    const d = await res.json();

    let html = '<div class="summary-grid">' +
      `<div class="card"><h3>Ingresos</h3><div class="value pos">$${d.ingresos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Costos</h3><div class="value neg">$${d.costos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Ganancia Bruta</h3><div class="value ${d.gananciaBruta >= 0 ? 'pos' : 'neg'}">$${d.gananciaBruta.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Gastos</h3><div class="value neg">$${d.gastos.total.toFixed(2)}</div></div>` +
      `<div class="card"><h3>Utilidad Neta</h3><div class="value ${d.utilidadNeta >= 0 ? 'pos' : 'neg'}">$${d.utilidadNeta.toFixed(2)}</div></div>` +
    '</div>';

    function items(title, obj) {
      const keys = Object.keys(obj);
      if (!keys.length) return '';
      let h = `<div class="card" style="margin-top:10px"><h3>${title}</h3>`;
      for (const [k, v] of Object.entries(obj)) {
        h += `<div class="line-item"><span>${k}</span><span class="amt">$${Math.abs(v).toFixed(2)}</span></div>`;
      }
      return h + '</div>';
    }

    html += items('Detalle de Ingresos', d.ingresos.detalle);
    html += items('Detalle de Costos', d.costos.detalle);
    html += items('Detalle de Gastos', d.gastos.detalle);
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar</div>'; }
}

function clearResultadosFilters() {
  document.getElementById('filter-resultados-from').value = '';
  document.getElementById('filter-resultados-to').value = '';
  loadPanelResultados();
}

/* ── Dashboard ── */
let dashboardCharts = [];

function destroyDashboardCharts() {
  dashboardCharts.forEach(c => c.destroy());
  dashboardCharts = [];
}

async function loadPanelDashboard() {
  const el = document.getElementById('dashboard-content');
  destroyDashboardCharts();
  if (typeof Chart === 'undefined') {
    el.innerHTML = '<div class="empty">Cargando librería de gráficos...</div>';
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js';
        s.onload = resolve; s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch { el.innerHTML = '<div class="empty">Error al cargar gráficos. Recarga la página.</div>'; return; }
  }
  try {
    const res = await authFetch(`${API_URL}/reports/dashboard`);
    const d = await res.json();

    let html = `
    <div class="dash-summary">
      <div class="dash-card dash-card-ing"><span>Ingresos</span><strong>$${d.resumen.totalIngresos.toFixed(2)}</strong></div>
      <div class="dash-card dash-card-gas"><span>Gastos</span><strong>$${d.resumen.totalGastos.toFixed(2)}</strong></div>
      <div class="dash-card dash-card-cost"><span>Costos</span><strong>$${d.resumen.totalCostos.toFixed(2)}</strong></div>
      <div class="dash-card ${d.resumen.utilidadNeta >= 0 ? 'dash-card-pos' : 'dash-card-neg'}"><span>Utilidad Neta</span><strong>$${d.resumen.utilidadNeta.toFixed(2)}</strong></div>
    </div>
    <div class="dash-grid">
      <div class="dash-chart-card"><h4>Ingresos vs Gastos por Mes</h4><canvas id="chart-monthly"></canvas></div>
      <div class="dash-chart-card"><h4>Gastos por Categoría</h4><canvas id="chart-gastos"></canvas></div>
    </div>`;

    if (d.topIngresos.length) {
      html += `<div class="dash-grid"><div class="dash-chart-card"><h4>Ingresos por Categoría</h4><canvas id="chart-ingresos"></canvas></div><div></div></div>`;
    }

    el.innerHTML = html;

    const months = d.monthly.map(m => {
      const [y, mo] = m.month.split('-');
      const dt = new Date(parseInt(y), parseInt(mo) - 1);
      return dt.toLocaleDateString('es-PA', { month: 'short', year: 'numeric' });
    });

    const ctx1 = document.getElementById('chart-monthly');
    if (ctx1) {
      dashboardCharts.push(new Chart(ctx1, {
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
      dashboardCharts.push(new Chart(ctx2, {
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
      dashboardCharts.push(new Chart(ctx3, {
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
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar dashboard</div>'; }
}

/* ── Catálogo de Cuentas ── */
async function loadPanelCuentas() {
  const el = document.getElementById('cuentas-content');
  try {
    const res = await authFetch(`${API_URL}/accounts`);
    const cuentas = await res.json();
    if (!cuentas.length) { el.innerHTML = '<div class="empty">No hay cuentas registradas</div>'; return; }

    const tipos = ['ACTIVO', 'PASIVO', 'PATRIMONIO', 'INGRESO', 'COSTO', 'GASTO'];
    const colores = { ACTIVO: '#1565c0', PASIVO: '#e65100', PATRIMONIO: '#6a1b9a', INGRESO: '#2e7d32', COSTO: '#c62828', GASTO: '#d84315' };
    const labels = { ACTIVO: 'Activos', PASIVO: 'Pasivos', PATRIMONIO: 'Patrimonio', INGRESO: 'Ingresos', COSTO: 'Costos', GASTO: 'Gastos' };

    let html = '';
    for (const tipo of tipos) {
      const filtradas = cuentas.filter(c => c.type === tipo && !c.parentId);
      if (!filtradas.length) continue;
      html += `<div class="cuenta-grupo"><div class="cuenta-tipo" style="background:${colores[tipo]}">${labels[tipo]}</div>`;
      for (const root of filtradas) {
        html += buildCuentaTree(root, cuentas);
      }
      html += '</div>';
    }
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar cuentas</div>'; }
}

function buildCuentaTree(account, all, depth = 0) {
  const children = all.filter(c => c.parentId === account.id);
  let html = `<div class="cuenta-row" style="padding-left:${depth * 20 + 8}px">
    <span class="cuenta-code">${account.code}</span>
    <span class="cuenta-name">${account.name}</span>
  </div>`;
  for (const child of children) {
    html += buildCuentaTree(child, all, depth + 1);
  }
  return html;
}

/* ── Conceptos Contables ── */
async function loadPanelConceptos() {
  const el = document.getElementById('conceptos-content');
  try {
    const res = await authFetch(`${API_URL}/concepts`);
    const concepts = await res.json();
    if (!concepts.length) { el.innerHTML = '<div class="empty">No hay conceptos registrados</div>'; return; }

    let html = '<table><thead><tr><th>Concepto</th><th>Cuenta Contable</th><th>Código</th><th>Confianza</th></tr></thead><tbody>';
    for (const c of concepts) {
      const pct = Math.round(c.confidence * 100);
      html += `<tr>
        <td><strong>${c.name}</strong></td>
        <td>${c.account?.name || '—'}</td>
        <td class="cuenta-code">${c.account?.code || '—'}</td>
        <td><span class="tag tag-conf">${pct}%</span></td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div class="empty">Error al cargar conceptos</div>'; }
}

