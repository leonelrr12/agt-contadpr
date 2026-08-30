// salud.js (14/14) — panel de salud financiera con IA (ratios, proyección y narrativa)

let _saludCharts = [];

function loadPanelSalud(refresh = false) {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-salud-content').classList.remove('hidden');
  loadSaludData(refresh);
}

async function loadSaludData(refresh = false) {
  const el = document.getElementById('salud-inline-list');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Analizando tu salud financiera...</div>';
  _saludCharts.forEach(c => c.destroy());
  _saludCharts = [];
  try {
    const res = await authFetch(`${API_URL}/salud${refresh ? '?refresh=1' : ''}`);
    if (!res.ok) { el.innerHTML = saludErrorState(); return; }
    const d = await res.json();
    if (d.sinDatos) {
      el.innerHTML = '<div style="text-align:center;padding:48px 24px;color:#6b7280">Aún no hay movimientos contables recientes para analizar. Registra tus primeros asientos y vuelve a este panel.</div>';
      return;
    }
    el.innerHTML = saludScore(d) + saludKpis(d) + saludAlertas(d) + saludIA(d) + saludChartBox() + saludProyeccion(d) + saludNota(d);
    renderSaludChart(d);
  } catch (e) {
    el.innerHTML = saludErrorState();
  }
}

const fmtSalud = n => n === 0 ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = v => v == null ? '—' : v + '%';
const veces = v => v == null ? '—' : v + '×';
const dias = v => v == null ? '—' : v + ' días';

function saludKpis(d) {
  const r = d.ratios || {};
  const card = (label, value, cls = '') =>
    `<div class="dash-card ${cls}"><span>${label}</span><strong>${value}</strong></div>`;
  return `<div class="dash-summary" style="margin-bottom:16px">
    ${card('Liquidez Corriente', veces(r.liquidez), r.liquidez == null ? '' : (r.liquidez >= 1.5 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Prueba Ácida', veces(r.pruebaAcida), r.pruebaAcida == null ? '' : (r.pruebaAcida >= 1 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Capital de Trabajo', fmtSalud(r.capitalTrabajo), r.capitalTrabajo == null ? '' : (r.capitalTrabajo >= 0 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Endeudamiento', pct(r.endeudamiento), r.endeudamiento == null ? '' : (r.endeudamiento <= 50 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Deuda/Patrimonio', veces(r.deudaPatrimonio), r.deudaPatrimonio == null ? '' : (r.deudaPatrimonio <= 1 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Margen Neto (año)', pct(r.margenNeto), r.margenNeto == null ? '' : (r.margenNeto >= 5 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Margen Bruto', pct(r.margenBruto), r.margenBruto == null ? '' : (r.margenBruto >= 30 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('ROE (año)', pct(r.roe), r.roe == null ? '' : (r.roe >= 5 ? 'dash-card-pos' : 'dash-card-neg'))}
    ${card('Días de Cobro', dias(r.dso))}
    ${card('Días de Pago', dias(r.dpo))}
    ${card('Caja Actual', fmtSalud(d.caja?.saldoActual))}
  </div>`;
}

/** Score consolidado: semáforo por categoría + nivel global. */
function saludScore(d) {
  const s = d.score;
  if (!s) return '';
  const colorNivel = { EXCELENTE: '#059669', BUENO: '#16a34a', REGULAR: '#f59e0b', CRITICO: '#dc2626' };
  const scoreColor = (v) => v >= 75 ? '#059669' : v >= 50 ? '#f59e0b' : '#dc2626';
  const bar = (label, v, icon) => `
    <div style="flex:1;min-width:130px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:11px;color:#6b7280">${icon} ${label}</span>
        <span style="font-size:12px;font-weight:700;color:${scoreColor(v)}">${v}</span>
      </div>
      <div style="background:#e5e7eb;border-radius:4px;height:7px;overflow:hidden">
        <div style="background:${scoreColor(v)};height:100%;width:${v}%;border-radius:4px"></div>
      </div>
    </div>`;
  return `
    <div style="background:#fff;border:1px solid #e5e7eb;border-left:4px solid ${colorNivel[s.nivel]};border-radius:10px;padding:16px;margin-bottom:16px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px">
        <div style="font-weight:700;font-size:15px;color:#1a1a2e">🎯 Score de Salud Financiera</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:11px;color:#6b7280">Global</span>
          <span style="font-size:22px;font-weight:800;color:${colorNivel[s.nivel]}">${s.global}</span>
          <span style="font-size:12px;font-weight:700;color:#fff;background:${colorNivel[s.nivel]};padding:4px 10px;border-radius:12px">${s.nivel}</span>
        </div>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap">
        ${bar('Liquidez', s.liquidez, '💧')}
        ${bar('Rentabilidad', s.rentabilidad, '📈')}
        ${bar('Endeudamiento', s.endeudamiento, '🏦')}
        ${bar('Eficiencia', s.eficiencia, '⚡')}
        ${bar('Flujo', s.flujo, '💵')}
      </div>
      <div style="font-size:11px;color:#9ca3af;margin-top:10px">Escala 0-100 por categoría · 80+ Excelente · 60-79 Bueno · 40-59 Regular · &lt;40 Crítico</div>
    </div>`;
}

function saludAlertas(d) {
  if (!d.alertas || !d.alertas.length) return '';
  const colors = { critical: '#dc2626', warning: '#f59e0b', info: '#3b82f6' };
  const icons = { critical: '🔴', warning: '🟠', info: '🔵' };
  const items = d.alertas.map(a => `
    <div style="background:#fff;border-left:4px solid ${colors[a.severidad]};border-radius:8px;padding:10px 14px;box-shadow:0 1px 2px rgba(0,0,0,0.06)">
      ${icons[a.severidad]} ${escapeHtml(a.mensaje)}
    </div>`).join('');
  return `<h3 style="font-size:14px;color:#1a1a2e;margin:20px 0 8px 0">⚠️ Alertas (${d.alertas.length})</h3>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">${items}</div>`;
}

function saludIA(d) {
  if (!d.narrativa) {
    return `<div style="background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;padding:16px;margin-bottom:16px;color:#6b7280;font-size:13px">
      🤖 Análisis IA no disponible — el modelo no respondió. Los ratios y alertas por reglas siguen activos.
      <button onclick="loadPanelSalud(true)" class="btn-secondary" style="margin-left:8px;padding:6px 12px;font-size:12px">Reintentar con IA</button>
    </div>`;
  }
  const bullets = (arr) => arr.map(x => `<li style="margin:4px 0">${escapeHtml(x)}</li>`).join('');
  return `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin-bottom:16px">
    <div style="font-weight:700;color:#0369a1;margin-bottom:8px">🤖 Análisis con IA</div>
    <p style="margin:0 0 12px 0;font-size:14px;color:#1a1a2e;line-height:1.5">${escapeHtml(d.narrativa.resumen)}</p>
    ${d.narrativa.alertas.length ? `<div style="font-size:13px;color:#92400e;margin-bottom:8px"><strong>Alertas IA:</strong><ul style="margin:4px 0 0 0;padding-left:20px">${bullets(d.narrativa.alertas)}</ul></div>` : ''}
    ${d.narrativa.recomendaciones.length ? `<div style="font-size:13px;color:#065f46"><strong>Recomendaciones:</strong><ul style="margin:4px 0 0 0;padding-left:20px">${bullets(d.narrativa.recomendaciones)}</ul></div>` : ''}
  </div>`;
}

function saludChartBox() {
  return `<div class="dash-grid"><div class="dash-chart-card"><h4>Ingresos vs Gastos (6 meses)</h4><canvas id="chart-salud-flujo"></canvas></div></div>`;
}

async function renderSaludChart(d) {
  if (typeof Chart === 'undefined') {
    const ok = await ensureChartJs();
    if (!ok) return;
  }
  const ctx = document.getElementById('chart-salud-flujo');
  if (!ctx || !d.monthly || !d.monthly.length) return;
  const labels = d.monthly.map(m => {
    const [y, mo] = m.month.split('-');
    return new Date(parseInt(y), parseInt(mo) - 1).toLocaleDateString('es-PA', { month: 'short', year: 'numeric' });
  });
  _saludCharts.push(new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
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

function saludProyeccion(d) {
  if (!d.proyeccion || !d.proyeccion.length) return '';
  const rows = d.proyeccion.map(p => `
    <tr style="border-bottom:1px solid #f0f0f0;${p.saldoFinal < 0 ? 'background:#fef2f2' : ''}">
      <td style="padding:8px 12px;text-transform:capitalize">${escapeHtml(p.label)}</td>
      <td style="padding:8px 12px;text-align:right;color:#2e7d32">${fmtSalud(p.entradas)}</td>
      <td style="padding:8px 12px;text-align:right;color:#c62828">${fmtSalud(p.salidas)}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;color:${p.saldoFinal >= 0 ? '#065f46' : '#991b1b'}">${fmtSalud(p.saldoFinal)}</td>
    </tr>`).join('');
  return `<h3 style="font-size:14px;color:#1a1a2e;margin:20px 0 8px 0">🔮 Proyección de Caja (3 meses)</h3>
    <div style="overflow-x:auto;margin-bottom:8px">
      <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:8px">
        <thead><tr style="border-bottom:2px solid #e5e7eb">
          <th style="text-align:left;padding:8px 12px;color:#6b7280;font-size:11px">Mes</th>
          <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">Entradas</th>
          <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">Salidas</th>
          <th style="text-align:right;padding:8px 12px;color:#6b7280;font-size:11px">Saldo final</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:#6b7280">Entradas y salidas estimadas: transacciones recurrentes activas + obligaciones fiscales próximas.</div>`;
}

function saludNota(d) {
  const t = d.generadoA ? new Date(d.generadoA).toLocaleTimeString('es-PA', { hour: '2-digit', minute: '2-digit' }) : '';
  return t ? `<div style="font-size:11px;color:#9ca3af;margin-top:12px">Actualizado a las ${t}</div>` : '';
}

function saludErrorState() {
  return `<div style="text-align:center;padding:48px 24px;color:#6b7280">
    Error al cargar la salud financiera.
    <div style="margin-top:12px"><button class="btn-primary" onclick="loadPanelSalud(true)">🔄 Reintentar</button></div>
  </div>`;
}
