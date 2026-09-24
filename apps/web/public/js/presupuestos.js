// presupuestos.js — pestaña 💰 Presupuesto: captura mensual por cuenta hoja y
// comparativa contra el real. Vive dentro del panel Informes (informes.js la
// carga desde los mapas `loaders`).
//
// El presupuesto se guarda SIEMPRE positivo, en la dirección natural de la
// cuenta: un gasto se escribe como 1.500 (no −1.500) y un ingreso como 1.500.
// El backend hace la misma normalización sobre el real.

let _pptoYear = null;
let _pptoAnioFiscal = null;
let _pptoSubTab = 'captura'; // 'captura' | 'comparativa'
let _pptoCuentas = [];
let _pptoCeldas = {}; // { [accountId]: [12 números] }
let _pptoDirty = new Set(); // "accountId|mes(1..12)" pendientes de guardar
let _pptoSoloResultado = true; // grilla: solo cuentas de resultado
let _pptoMes = 'acum'; // 'acum' | '1'..'12'
let _pptoTipos = 'resultado';

const PPTO_MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const PPTO_TIPOS_RESULTADO = ['INGRESO', 'GASTO', 'COSTO'];
const PPTO_SEMAFORO = {
  verde: { bg: '#ecfdf5', fg: '#059669', texto: 'En línea' },
  ambar: { bg: '#fffbeb', fg: '#92400e', texto: 'Desviación' },
  rojo: { bg: '#fef2f2', fg: '#dc2626', texto: 'Alerta' },
  neutro: { bg: '#f3f4f6', fg: '#6b7280', texto: 'Sin novedad' },
  futuro: { bg: '#f8fafc', fg: '#9ca3af', texto: 'Sin transcurrir' },
};

function pptoR2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pptoMoney(n) {
  if (!n) return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pptoPuedeEditar() {
  return ['admin', 'contador', 'superadmin'].includes(getUser()?.role);
}

/* ── Entrada del panel ── */
async function loadReportPresupuestos() {
  const el = document.getElementById('informes-inline-result');
  _informesCharts.forEach(c => c.destroy());
  _informesCharts = [];
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando presupuesto...</div>';
  try {
    const res = await authFetch(`${API_URL}/budgets${_pptoYear ? '?year=' + _pptoYear : ''}`);
    if (!res.ok) throw new Error('Error al cargar');
    const d = await res.json();
    _pptoAnioFiscal = d.anioFiscal;
    _pptoYear = d.year;
    _pptoCuentas = d.cuentas;
    _pptoCeldas = {};
    for (const c of _pptoCuentas) _pptoCeldas[c.id] = new Array(12).fill(0);
    for (const m of d.montos) {
      if (_pptoCeldas[m.accountId]) _pptoCeldas[m.accountId][m.month - 1] = Number(m.amount) || 0;
    }
    _pptoDirty = new Set();
  } catch (e) {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar el presupuesto.</div>';
    return;
  }
  await pptoRender();
}

function pptoSwitchSub(tab) {
  _pptoSubTab = tab;
  _informesCharts.forEach(c => c.destroy());
  _informesCharts = [];
  pptoRender();
}

async function pptoCambiarAnio(valor) {
  _pptoYear = Number(valor);
  await loadReportPresupuestos();
}

async function pptoRender() {
  const el = document.getElementById('informes-inline-result');
  if (!el) return;
  const años = [];
  for (let a = _pptoAnioFiscal - 2; a <= _pptoAnioFiscal + 1; a++) años.push(a);
  if (!años.includes(_pptoYear)) años.push(_pptoYear);
  años.sort();

  const editable = pptoPuedeEditar();
  const subtab = (id, texto) => {
    const activo = _pptoSubTab === id;
    return `<button onclick="pptoSwitchSub('${id}')" style="padding:6px 14px;border:1px solid ${activo ? '#1565c0' : '#d1d5db'};border-radius:6px;background:${activo ? '#1565c0' : '#fff'};color:${activo ? '#fff' : '#374151'};cursor:pointer;font-size:12px;font-weight:600">${texto}</button>`;
  };

  el.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
      ${subtab('captura', '✏️ Captura')}
      ${subtab('comparativa', '📊 Real vs Presupuesto')}
      <span style="flex:1"></span>
      <label style="font-size:12px;color:#6b7280">Año
        <select id="ppto-year" onchange="pptoCambiarAnio(this.value)" style="margin-left:6px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff">
          ${años.map(a => `<option value="${a}"${a === _pptoYear ? ' selected' : ''}>${a}${a === _pptoAnioFiscal ? ' (fiscal)' : ''}</option>`).join('')}
        </select>
      </label>
    </div>
    <div id="ppto-cuerpo"></div>`;

  if (_pptoSubTab === 'captura') await pptoRenderCaptura();
  else await pptoRenderComparativa();
  setInformesExportBar(_pptoSubTab === 'captura' ? 'presupuesto' : 'presupuesto-comparativa');
}

/* ── Captura ── */
async function pptoRenderCaptura() {
  const cuerpo = document.getElementById('ppto-cuerpo');
  const editable = pptoPuedeEditar();
  const cuentas = _pptoCuentas.filter(c => !_pptoSoloResultado || PPTO_TIPOS_RESULTADO.includes(c.type));

  if (!cuentas.length) {
    cuerpo.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">No hay cuentas hoja para presupuestar. Revisa el plan de cuentas.</div>';
    return;
  }

  const categorias = [];
  for (const c of cuentas) if (!categorias.includes(c.categoriaKey)) categorias.push(c.categoriaKey);

  const celdaInput = (c, i) => {
    const val = _pptoCeldas[c.id][i];
    return `<td style="padding:2px;border-bottom:1px solid #f1f5f9"><input type="number" step="0.01" min="0" value="${val || ''}" ${editable ? '' : 'disabled'}
      data-acc="${c.id}" data-m="${i + 1}" onchange="pptoSetCell(this)" onfocus="this.select()"
      style="width:88px;padding:4px 6px;border:1px solid #e5e7eb;border-radius:4px;font-size:12px;text-align:right;background:${editable ? '#fff' : '#f9fafb'}"></td>`;
  };

  let html = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
    <button onclick="pptoGuardar()" id="ppto-save" ${editable ? 'disabled' : 'hidden'} style="padding:7px 16px;border:none;border-radius:6px;background:#2e7d32;color:#fff;cursor:pointer;font-size:12px;font-weight:600">💾 Guardar presupuesto</button>
    ${editable ? `
      <button onclick="pptoPlantilla('promedio',3)" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">Promediar 3 meses</button>
      <button onclick="pptoPlantilla('promedio',6)" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">Promediar 6 meses</button>
      <button onclick="pptoPlantilla('anterior')" style="padding:6px 12px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:12px">Copiar ${_pptoYear - 1}</button>
      <button onclick="pptoPlantilla('limpiar')" style="padding:6px 12px;border:1px solid #fca5a5;border-radius:6px;background:#fff;color:#b91c1c;cursor:pointer;font-size:12px">Limpiar</button>` : ''}
    <span style="flex:1"></span>
    <label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:5px">
      <input type="checkbox" ${_pptoSoloResultado ? 'checked' : ''} onchange="pptoToggleTipos(this.checked)"> Solo cuentas de resultado
    </label>
  </div>
  <div id="ppto-aviso" style="font-size:12px;color:#6b7280;margin-bottom:8px">${editable ? 'Los montos se escriben en positivo: un gasto de 1.500 se captura como 1.500.' : 'Solo admin y contador pueden editar el presupuesto.'}</div>
  <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
    <thead><tr style="text-align:right">
      <th style="position:sticky;left:0;background:#fff;text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase;min-width:220px">Cuenta</th>
      ${PPTO_MESES.map(m => `<th style="padding:6px 4px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">${m}</th>`).join('')}
      <th style="padding:6px 8px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Total</th>
    </tr></thead><tbody>`;

  for (const cat of categorias) {
    const propias = cuentas.filter(c => c.categoriaKey === cat);
    const nombre = propias[0].categoriaName;
    html += `<tr style="background:#f8fafc">
      <td style="position:sticky;left:0;background:#f8fafc;padding:6px 8px;font-weight:700;color:#1a1a2e;border-bottom:1px solid #e5e7eb">${escapeHtml(nombre)}</td>
      ${PPTO_MESES.map((_, i) => `<td id="ppto-cat-${escapeHtml(cat)}-${i}" style="padding:6px 4px;text-align:right;color:#374151;border-bottom:1px solid #e5e7eb"></td>`).join('')}
      <td id="ppto-cattot-${escapeHtml(cat)}" style="padding:6px 8px;text-align:right;font-weight:700;border-bottom:1px solid #e5e7eb"></td>
    </tr>`;
    for (const c of propias) {
      html += `<tr>
        <td style="position:sticky;left:0;background:#fff;padding:4px 8px;border-bottom:1px solid #f1f5f9">
          <span style="color:#9ca3af">${escapeHtml(c.code)}</span> ${escapeHtml(c.name)}
        </td>
        ${PPTO_MESES.map((_, i) => celdaInput(c, i)).join('')}
        <td id="ppto-rowtot-${c.id}" style="padding:6px 8px;text-align:right;font-weight:600;border-bottom:1px solid #f1f5f9"></td>
      </tr>`;
    }
  }

  html += `</tbody><tfoot><tr style="border-top:2px solid #1a1a2e;font-weight:700">
      <td style="position:sticky;left:0;background:#fff;padding:8px">Total del mes</td>
      ${PPTO_MESES.map((_, i) => `<td id="ppto-col-${i}" style="padding:8px 4px;text-align:right"></td>`).join('')}
      <td id="ppto-total" style="padding:8px;text-align:right;color:#1565c0"></td>
    </tr></tfoot></table></div>`;

  cuerpo.innerHTML = html;
  pptoRefreshTotals();
}

function pptoToggleTipos(solo) {
  _pptoSoloResultado = solo;
  pptoRenderCaptura();
}

function pptoSetCell(input) {
  const acc = input.dataset.acc;
  const mes = Number(input.dataset.m);
  const valor = Math.max(0, pptoR2(parseFloat(input.value) || 0));
  input.value = valor || '';
  _pptoCeldas[acc][mes - 1] = valor;
  _pptoDirty.add(`${acc}|${mes}`);
  pptoRefreshTotals();
}

/** Recalcula TODOS los totales desde el estado (nunca acumula: el drift de floats se nota). */
function pptoRefreshTotals() {
  const save = document.getElementById('ppto-save');
  if (save) save.disabled = _pptoDirty.size === 0;

  const visible = _pptoCuentas.filter(c => !_pptoSoloResultado || PPTO_TIPOS_RESULTADO.includes(c.type));
  const porColumna = new Array(12).fill(0);
  for (const c of visible) {
    let total = 0;
    for (let i = 0; i < 12; i++) {
      const v = _pptoCeldas[c.id]?.[i] || 0;
      total += v;
      porColumna[i] += v;
    }
    const celda = document.getElementById(`ppto-rowtot-${c.id}`);
    if (celda) celda.textContent = total ? pptoMoney(pptoR2(total)) : '—';
  }

  const categorias = [...new Set(visible.map(c => c.categoriaKey))];
  for (const cat of categorias) {
    const propias = visible.filter(c => c.categoriaKey === cat);
    let totalCat = 0;
    for (let i = 0; i < 12; i++) {
      const suma = pptoR2(propias.reduce((s, c) => s + (_pptoCeldas[c.id]?.[i] || 0), 0));
      totalCat += suma;
      const celda = document.getElementById(`ppto-cat-${cat}-${i}`);
      if (celda) celda.textContent = suma ? pptoMoney(suma) : '—';
    }
    const celdaTot = document.getElementById(`ppto-cattot-${cat}`);
    if (celdaTot) celdaTot.textContent = totalCat ? pptoMoney(pptoR2(totalCat)) : '—';
  }

  let granTotal = 0;
  for (let i = 0; i < 12; i++) {
    const celda = document.getElementById(`ppto-col-${i}`);
    const valor = pptoR2(porColumna[i]);
    granTotal += valor;
    if (celda) celda.textContent = valor ? pptoMoney(valor) : '—';
  }
  const total = document.getElementById('ppto-total');
  if (total) total.textContent = granTotal ? pptoMoney(pptoR2(granTotal)) : '—';
}

async function pptoGuardar() {
  if (!_pptoDirty.size) return;
  const items = [..._pptoDirty].map(k => {
    const [acc, mes] = k.split('|');
    return { accountId: acc, month: Number(mes), amount: _pptoCeldas[acc][Number(mes) - 1] || 0 };
  });
  const btn = document.getElementById('ppto-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    const res = await authFetch(`${API_URL}/budgets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year: _pptoYear, items }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo guardar');
    _pptoDirty = new Set();
    await loadReportPresupuestos(); // el servidor es la única fuente de verdad
    showAlert(`✅ Presupuesto guardado (${items.length} ${items.length === 1 ? 'celda' : 'celdas'})`);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = '💾 Guardar presupuesto'; }
    showAlert('❌ ' + (e.message || 'Error al guardar el presupuesto'));
  }
}

/** Plantillas de carga: rellenan la grilla y la marcan como pendiente (no guardan solas). */
async function pptoPlantilla(tipo, n) {
  const visible = _pptoCuentas.filter(c => !_pptoSoloResultado || PPTO_TIPOS_RESULTADO.includes(c.type));
  const marcar = () => {
    for (const c of visible) for (let i = 0; i < 12; i++) _pptoDirty.add(`${c.id}|${i + 1}`);
  };

  if (tipo === 'limpiar') {
    if (!(await showConfirm('¿Borrar todo el presupuesto de la pantalla? Tendrás que guardar para que se aplique.'))) return;
    for (const c of visible) _pptoCeldas[c.id] = new Array(12).fill(0);
    marcar();
  } else if (tipo === 'anterior') {
    try {
      const res = await authFetch(`${API_URL}/budgets?year=${_pptoYear - 1}`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      if (!d.montos.length) { showAlert(`El año ${_pptoYear - 1} no tiene presupuesto guardado.`); return; }
      if (!(await showConfirm(`¿Copiar el presupuesto de ${_pptoYear - 1} a ${_pptoYear}? Revisa antes de guardar.`))) return;
      for (const c of visible) _pptoCeldas[c.id] = new Array(12).fill(0);
      for (const m of d.montos) if (_pptoCeldas[m.accountId]) _pptoCeldas[m.accountId][m.month - 1] = Number(m.amount) || 0;
      marcar();
    } catch {
      showAlert('❌ No se pudo leer el presupuesto del año anterior');
      return;
    }
  } else {
    // Promedio de los últimos N meses CON movimiento (el real del propio año)
    try {
      const res = await authFetch(`${API_URL}/budgets/comparison?year=${_pptoAnioFiscal}&tipos=todas`);
      if (!res.ok) throw new Error();
      const d = await res.json();
      const transcurridos = Math.min(n, d.mesActual || 0);
      if (!transcurridos) { showAlert('Todavía no hay meses transcurridos para promediar.'); return; }
      if (!(await showConfirm(`¿Rellenar con el promedio de los últimos ${transcurridos} meses de ${d.year}? Revisa antes de guardar.`))) return;
      const porCuenta = new Map(d.matriz.map(m => [m.accountId, m.real]));
      for (const c of visible) {
        const real = porCuenta.get(c.id);
        if (!real) continue;
        const promedio = pptoR2(real.slice(0, transcurridos).reduce((s, v) => s + v, 0) / transcurridos);
        _pptoCeldas[c.id] = new Array(12).fill(promedio);
      }
      marcar();
    } catch {
      showAlert('❌ No se pudo calcular el promedio');
      return;
    }
  }
  await pptoRenderCaptura();
}

/* ── Comparativa ── */
async function pptoRenderComparativa() {
  const cuerpo = document.getElementById('ppto-cuerpo');
  const q = new URLSearchParams({ year: String(_pptoYear), tipos: _pptoTipos });
  if (_pptoMes !== 'acum') q.set('mes', _pptoMes);
  let d;
  try {
    const res = await authFetch(`${API_URL}/budgets/comparison?${q.toString()}`);
    if (!res.ok) throw new Error();
    d = await res.json();
  } catch {
    cuerpo.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar la comparativa.</div>';
    return;
  }

  const etiquetaPeriodo = _pptoMes === 'acum' ? `Enero–${PPTO_MESES[11]} ${d.year}` : `Enero–${PPTO_MESES[Number(_pptoMes) - 1]} ${d.year}`;
  const controles = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
    <select id="ppto-mes" onchange="pptoSetMes(this.value)" style="padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff">
      <option value="acum"${_pptoMes === 'acum' ? ' selected' : ''}>Acumulado del año</option>
      ${PPTO_MESES.map((m, i) => `<option value="${i + 1}"${_pptoMes === String(i + 1) ? ' selected' : ''}>Enero–${m}</option>`).join('')}
    </select>
    <label style="font-size:12px;color:#6b7280;display:flex;align-items:center;gap:5px">
      <input type="checkbox" ${_pptoTipos === 'todas' ? 'checked' : ''} onchange="pptoToggleComparativaTipos(this.checked)"> Incluir cuentas de balance
    </label>
    <span style="flex:1"></span>
    <span style="font-size:12px;color:#6b7280">${etiquetaPeriodo}</span>
  </div>`;

  if (!d.filas.length) {
    cuerpo.innerHTML = controles + '<div style="text-align:center;padding:32px;color:#6b7280">Sin presupuesto ni movimientos en el período.<br><span style="font-size:12px">Captura el presupuesto en la pestaña ✏️ Captura.</span></div>';
    return;
  }

  cuerpo.innerHTML = controles + pptoCards(d) + pptoTablaComparativa(d) + pptoChartsHtml(d);
  await pptoChartMensual(d.mensual);
  await pptoChartCategorias(d.categorias);
}

function pptoSetMes(valor) {
  _pptoMes = valor;
  _informesCharts.forEach(c => c.destroy());
  _informesCharts = [];
  pptoRenderComparativa();
}
function pptoToggleComparativaTipos(todas) {
  _pptoTipos = todas ? 'todas' : 'resultado';
  _informesCharts.forEach(c => c.destroy());
  _informesCharts = [];
  pptoRenderComparativa();
}

function pptoCard(titulo, bloque) {
  if (!bloque) return '';
  const s = PPTO_SEMAFORO[bloque.semaforo] || PPTO_SEMAFORO.neutro;
  return `<div class="dash-card" style="border-left:4px solid ${s.fg}">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase">${titulo}</div>
    <div style="font-size:20px;font-weight:700;color:#1a1a2e">${pptoMoney(bloque.real)}</div>
    <div style="font-size:11px;color:#6b7280">Presupuesto ${pptoMoney(bloque.budget)}</div>
    <div style="font-size:11px;margin-top:4px;color:${s.fg}">
      ${bloque.variacionPct === null ? s.texto : `${bloque.variacionPct > 0 ? '+' : ''}${bloque.variacionPct}% · ${s.texto}`}
    </div>
  </div>`;
}

function pptoCards(d) {
  const t = d.totales;
  if (d.tipos === 'todas') {
    return `<div class="dash-grid" style="margin-bottom:16px">${pptoCard('Total', t.general)}</div>`;
  }
  return `<div class="dash-grid" style="margin-bottom:16px">
    ${pptoCard('Ingresos', t.ingresos)}
    ${pptoCard('Costos', t.costos)}
    ${pptoCard('Gastos', t.gastos)}
    ${pptoCard('Utilidad neta', t.utilidadNeta)}
  </div>`;
}

function pptoDesviacion(f) {
  const s = PPTO_SEMAFORO[f.semaforo] || PPTO_SEMAFORO.neutro;
  const flecha = f.direccion === 'favorable' ? '▼' : f.direccion === 'desfavorable' ? '▲' : '=';
  const texto = f.variacionPct === null ? s.texto : `${flecha} ${f.variacionPct > 0 ? '+' : ''}${f.variacionPct}%`;
  return `<span title="${s.texto}" style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;background:${s.bg};color:${s.fg}">${texto}</span>`;
}

function pptoFila(f, esCategoria) {
  const nombre = esCategoria
    ? `<strong>${escapeHtml(f.categoriaName)}</strong>`
    : `<span style="color:#9ca3af">${escapeHtml(f.code)}</span> ${escapeHtml(f.name)}`;
  // El color va por FAVORABILIDAD, no por el signo: ingresar más es bueno (verde)
  // y gastar más es malo (rojo), aunque las dos variaciones sean positivas.
  const colorVar = f.direccion === 'favorable' ? '#059669' : f.direccion === 'desfavorable' ? '#dc2626' : '#6b7280';
  return {
    cells: [
      nombre,
      pptoMoney(f.budget),
      pptoMoney(f.real),
      f.variacion ? `<span style="color:${colorVar}">${pptoMoney(f.variacion)}</span>` : '—',
      pptoDesviacion(f),
    ],
    rowAttrs: esCategoria ? 'style="background:#f8fafc"' : '',
  };
}

function pptoTablaComparativa(d) {
  const filas = [];
  for (const cat of d.categorias) {
    filas.push(pptoFila(cat, true));
    for (const f of d.filas.filter(x => x.categoriaKey === cat.categoriaKey)) filas.push(pptoFila(f, false));
  }
  const t = d.tipos === 'resultado' ? d.totales.utilidadNeta : d.totales.general;
  const s = PPTO_SEMAFORO[t.semaforo] || PPTO_SEMAFORO.neutro;
  const footer = [
    d.tipos === 'resultado' ? 'UTILIDAD NETA' : 'TOTAL',
    pptoMoney(t.budget),
    pptoMoney(t.real),
    pptoMoney(t.variacion),
    `<span style="color:${s.fg}">${s.texto}</span>`,
  ];
  return buildInformesTable(['Cuenta', 'Presupuesto', 'Real', 'Variación', 'Desviación'], filas, footer);
}

function pptoChartsHtml() {
  return `<div class="dash-grid" style="margin-top:16px">
    <div class="dash-chart-card"><h4 style="margin:0 0 8px 0;font-size:13px;color:#1a1a2e">Presupuesto vs real por mes</h4>
      <canvas id="ppto-chart-mensual"></canvas></div>
    <div class="dash-chart-card"><h4 style="margin:0 0 8px 0;font-size:13px;color:#1a1a2e">Por categoría (período)</h4>
      <canvas id="ppto-chart-categorias"></canvas></div>
  </div>`;
}

async function pptoChartMensual(mensual) {
  if (typeof Chart === 'undefined') await ensureChartJs();
  const canvas = document.getElementById('ppto-chart-mensual');
  if (!canvas) return;
  _informesCharts.push(new Chart(canvas, {
    type: 'bar',
    data: {
      labels: PPTO_MESES,
      datasets: [
        { label: 'Presupuesto', data: mensual.map(m => m.budget), backgroundColor: '#93c5fd' },
        { label: 'Real', data: mensual.map(m => m.real), backgroundColor: '#1565c0' },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: { y: { ticks: { font: { size: 10 } } }, x: { ticks: { font: { size: 10 } } } },
    },
  }));
}

async function pptoChartCategorias(categorias) {
  if (typeof Chart === 'undefined') await ensureChartJs();
  const canvas = document.getElementById('ppto-chart-categorias');
  if (!canvas) return;
  const conDatos = categorias.filter(c => c.budget || c.real).slice(0, 10);
  _informesCharts.push(new Chart(canvas, {
    type: 'bar',
    data: {
      labels: conDatos.map(c => c.categoriaName),
      datasets: [
        { label: 'Presupuesto', data: conDatos.map(c => c.budget), backgroundColor: '#93c5fd' },
        { label: 'Real', data: conDatos.map(c => c.real), backgroundColor: '#1565c0' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
      scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } },
    },
  }));
}
