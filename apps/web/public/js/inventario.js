// inventario.js — módulo de Inventario, página standalone (no vive en el SPA).
//
// Usa shared.js (no core.js): es el juego de helpers de las páginas sueltas y lee
// las MISMAS claves de localStorage que el SPA, así que comparte la sesión.
//
// Criterio de la pantalla: el kardex es la fuente de verdad de las cantidades y el
// libro diario la de los montos. Cuando los dos no coinciden, se muestra la
// diferencia en vez de esconderla.

const API_URL = '/api';

let _invTab = 'existencias';
let _invProductos = [];
let _invLineas = [];   // líneas del formulario de entrada
let _invSalidas = [];  // líneas del formulario de salida

/** Escapa todo texto que venga del usuario (nombres de producto, proveedores, notas). */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
const hoy = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local

const puedeEditar = () => ['admin', 'contador', 'superadmin', 'inventario'].includes(getUser()?.role);

async function pedir(url, opts = {}) {
  const res = await authFetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ── Navegación ──────────────────────────────────────────────────────────────

document.getElementById('inv-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.inv-tab');
  if (!btn) return;
  _invTab = btn.dataset.tab;
  document.querySelectorAll('.inv-tab').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

function render() {
  const el = document.getElementById('inv-contenido');
  const vistas = {
    existencias: vistaExistencias,
    entradas: vistaEntradas,
    salidas: vistaSalidas,
    kardex: vistaKardex,
    valoracion: vistaValoracion,
    carga: vistaCarga,
  };
  el.innerHTML = '<div class="loading">Cargando…</div>';
  (vistas[_invTab] || vistaExistencias)()
    .then((html) => { el.innerHTML = html; })
    .catch((err) => { el.innerHTML = `<div class="aviso">No se pudo cargar: ${esc(err.message)}</div>`; });
}

/** Recarga el catálogo y vuelve a pintar. El servidor es la única fuente de verdad. */
async function recargar() {
  const data = await pedir(`${API_URL}/inventario/productos?pageSize=200`);
  _invProductos = data.items || [];
  _invTotales = data.totales || {};
  return data;
}

let _invTotales = {};

// ── Existencias ─────────────────────────────────────────────────────────────

async function vistaExistencias() {
  const data = await recargar();
  const filas = _invProductos.map((p) => `
    <tr>
      <td>${esc(p.sku) || '—'}</td>
      <td>${esc(p.nombre)}</td>
      <td class="num">${num(p.stockActual)} ${esc(p.unidad)}</td>
      <td class="num">${money(p.costoPromedio)}</td>
      <td class="num">${p.precioVenta == null ? '—' : money(p.precioVenta)}</td>
      <td class="num">${margen(p)}</td>
      <td class="num">${money(p.stockValor)}</td>
      <td class="num">${num(p.stockMinimo)}</td>
      <td>${badgeEstado(p.estado)}</td>
    </tr>`).join('');

  const t = _invTotales;
  return `
    <div class="summary-cards">
      <div class="summary-card"><div class="num">${money(t.valor)}</div><div class="label">Valor del inventario</div></div>
      <div class="summary-card ${t.bajoMinimo ? 'warn' : ''}"><div class="num">${t.bajoMinimo || 0}</div><div class="label">Bajo el mínimo</div></div>
      <div class="summary-card ${t.negativos ? 'err' : ''}"><div class="num">${t.negativos || 0}</div><div class="label">En negativo</div></div>
      <div class="summary-card"><div class="num">${data.total}</div><div class="label">Productos</div></div>
    </div>
    ${_invProductos.length ? `
    <div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Código</th><th>Producto</th><th class="num">Existencia</th><th class="num">Costo prom.</th><th class="num">P. Venta</th><th class="num">Margen</th><th class="num">Valor</th><th class="num">Mínimo</th><th>Estado</th></tr></thead>
      <tbody>${filas}</tbody>
    </table></div>` : '<div class="card">Todavía no hay productos. Cargá el primero desde <code>POST /api/inventario/productos</code> o el formulario de alta.</div>'}
    ${puedeEditar() ? formularioProducto() : ''}`;
}

/**
 * Margen sobre el precio de venta: (precio − costo) / precio. Se calcula sobre el
 * precio y no sobre el costo porque es como se lee un margen comercial. Si el
 * producto no tiene precio cargado no se inventa nada: se muestra un guion.
 */
function margen(p) {
  if (p.precioVenta == null || p.precioVenta <= 0) return '—';
  const m = ((p.precioVenta - p.costoPromedio) / p.precioVenta) * 100;
  const color = m < 0 ? '#dc2626' : m < 15 ? '#d97706' : '#059669';
  return `<span style="color:${color}">${m.toFixed(1)}%</span>`;
}

function badgeEstado(estado) {
  const mapa = {
    OK: ['badge-ok', 'En orden'],
    BAJO: ['badge-warn', 'Bajo mínimo'],
    NEGATIVO: ['badge-err', 'Negativo'],
    SIN_COSTO: ['badge-warn', 'Sin costo'],
  };
  const [cls, txt] = mapa[estado] || ['badge-neutral', estado];
  return `<span class="badge ${cls}">${esc(txt)}</span>`;
}

function formularioProducto() {
  return `
  <div class="card">
    <h3>➕ Nuevo producto</h3>
    <div class="form-grid">
      <div><label>Nombre *</label><input id="np-nombre" placeholder="Ej: Cemento gris 50kg"></div>
      <div><label>Código (opcional)</label><input id="np-sku" placeholder="SKU interno"></div>
      <div><label>Unidad</label><input id="np-unidad" value="UND" maxlength="10"></div>
      <div><label>Precio de venta (sin ITBMS)</label><input id="np-precio" type="number" step="0.01" min="0" placeholder="Opcional"></div>
      <div><label>Stock mínimo (alerta)</label><input id="np-minimo" type="number" step="0.001" min="0" value="0"></div>
    </div>
    <div style="margin-top:12px"><button class="btn btn-primary" onclick="crearProducto()">Crear producto</button></div>
    <div class="nota">La existencia se carga con una <strong>entrada de mercancía</strong>, no acá: así queda el movimiento que la respalda.</div>
  </div>`;
}

async function crearProducto() {
  const nombre = document.getElementById('np-nombre').value.trim();
  if (!nombre) return showAlert('El nombre es obligatorio');
  try {
    await pedir(`${API_URL}/inventario/productos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre,
        sku: document.getElementById('np-sku').value.trim() || undefined,
        unidad: document.getElementById('np-unidad').value.trim() || 'UND',
        precioVenta: document.getElementById('np-precio').value === '' ? null : Number(document.getElementById('np-precio').value),
        stockMinimo: Number(document.getElementById('np-minimo').value) || 0,
      }),
    });
    await showAlert(`Producto "${nombre}" creado.`);
    render();
  } catch (e) {
    await showAlert(e.message);
  }
}

// ── Entrada de mercancía ────────────────────────────────────────────────────

async function vistaEntradas() {
  await recargar();
  const opciones = _invProductos.map((p) => `<option value="${esc(p.id)}">${esc(p.nombre)} (${num(p.stockActual)} ${esc(p.unidad)})</option>`).join('');

  return `
  <div class="card">
    <h3>⬇️ Entrada de mercancía</h3>
    <p class="nota" style="margin-top:0">Registra la compra y su asiento: <code>Debe Inventario</code> por el costo, y el pago contra banco, caja o proveedores. Es la <strong>única</strong> vía que debita la cuenta de inventario.</p>
    ${_invProductos.length ? '' : '<div class="aviso">Primero creá un producto en la pestaña Existencias.</div>'}

    <div id="inv-lineas">${lineasHtml()}</div>
    <button class="btn btn-secondary btn-sm" onclick="agregarLinea()">+ Agregar producto</button>

    <div class="form-grid" style="margin-top:16px">
      <div><label>Fecha</label><input id="en-fecha" type="date" value="${hoy()}"></div>
      <div><label>Forma de pago</label><select id="en-pago">
        <option value="TRANSFERENCIA">Transferencia</option>
        <option value="EFECTIVO">Efectivo</option>
        <option value="CHEQUE">Cheque</option>
        <option value="TARJETA_DEBITO">Tarjeta de débito</option>
        <option value="TARJETA_CREDITO">Tarjeta de crédito</option>
        <option value="CREDITO">Crédito (queda a deber)</option>
      </select></div>
      <div><label>Proveedor (obligatorio si es a crédito)</label><input id="en-proveedor" placeholder="Nombre del proveedor"></div>
      <div><label>N° de factura del proveedor</label><input id="en-referencia" placeholder="Opcional"></div>
      <div><label>ITBMS de la compra</label><input id="en-itbms" type="number" step="0.01" min="0" value="0"></div>
      <div><label>&nbsp;</label><button class="btn btn-secondary" style="width:100%" onclick="previsualizar()">Ver el asiento</button></div>
    </div>
    <div id="en-preview"></div>
    <div style="margin-top:12px"><button class="btn btn-primary" onclick="guardarEntrada()">Registrar entrada</button></div>
    <div class="nota">El asiento nace en <strong>borrador</strong>: lo revisa el contador antes de que afecte los informes. El ITBMS va aparte como crédito fiscal solo si la empresa lo declara; si no, sumalo al costo unitario.</div>
  </div>`;
}

function lineasHtml() {
  if (!_invLineas.length) _invLineas = [{ productId: '', cantidad: 1, costoUnitario: 0 }];
  const opciones = (sel) => _invProductos.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('');
  return _invLineas.map((l, i) => `
    <div class="linea-row">
      <div><label>Producto</label><select onchange="_invLineas[${i}].productId=this.value;previsualizar()">${opciones(l.productId)}</select></div>
      <div><label>Cantidad</label><input type="number" step="0.001" min="0" value="${l.cantidad}" oninput="_invLineas[${i}].cantidad=Number(this.value);previsualizar()"></div>
      <div><label>Costo unitario</label><input type="number" step="0.01" min="0" value="${l.costoUnitario}" oninput="_invLineas[${i}].costoUnitario=Number(this.value);previsualizar()"></div>
      <div>${_invLineas.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="quitarLinea(${i})">✕</button>` : ''}</div>
    </div>`).join('');
}

function agregarLinea() {
  _invLineas.push({ productId: '', cantidad: 1, costoUnitario: 0 });
  document.getElementById('inv-lineas').innerHTML = lineasHtml();
}

function quitarLinea(i) {
  _invLineas.splice(i, 1);
  document.getElementById('inv-lineas').innerHTML = lineasHtml();
  previsualizar();
}

/**
 * Muestra el asiento ANTES de guardar. Es solo una vista previa con lo que se
 * alcanza a saber en el navegador: las cuentas reales y la regularización de un
 * faltante las resuelve el servidor, y el resultado final puede diferir.
 */
function previsualizar() {
  const el = document.getElementById('en-preview');
  if (!el) return;
  const itbms = Number(document.getElementById('en-itbms')?.value) || 0;
  const validas = _invLineas.filter((l) => l.productId && l.cantidad > 0);
  if (!validas.length) { el.innerHTML = ''; return; }

  const neto = validas.reduce((s, l) => s + l.cantidad * l.costoUnitario, 0);
  const filas = validas.map((l) => {
    const p = _invProductos.find((x) => x.id === l.productId);
    return `<div class="fila"><span>Inventario — ${esc(p?.nombre || '')} × ${num(l.cantidad)}</span><span>${money(l.cantidad * l.costoUnitario)}</span></div>`;
  }).join('');

  el.innerHTML = `<div class="preview">
    <div class="fila"><strong>Debe</strong><span></span></div>
    ${filas}
    ${itbms > 0 ? `<div class="fila"><span>ITBMS por Pagar (crédito fiscal)</span><span>${money(itbms)}</span></div>` : ''}
    <div class="fila"><strong>Haber</strong><span></span></div>
    <div class="fila"><span>Según la forma de pago</span><span>${money(neto + itbms)}</span></div>
    <div class="fila total"><span>Total</span><span>${money(neto + itbms)}</span></div>
  </div>`;
}

async function guardarEntrada() {
  const lineas = _invLineas.filter((l) => l.productId && l.cantidad > 0);
  if (!lineas.length) return showAlert('Elegí al menos un producto con cantidad');

  const cuerpo = {
    lineas,
    fecha: document.getElementById('en-fecha').value || hoy(),
    paymentMethod: document.getElementById('en-pago').value,
    itbmsAmount: Number(document.getElementById('en-itbms').value) || 0,
    referencia: document.getElementById('en-referencia').value.trim() || undefined,
    // Clave por envío: si se hace doble clic, el segundo intento no duplica el stock.
    dedupeKey: `entrada:${Date.now()}`,
  };

  const proveedor = document.getElementById('en-proveedor').value.trim();
  if (cuerpo.paymentMethod === 'CREDITO' && !proveedor) {
    return showAlert('Una compra a crédito necesita el nombre del proveedor.');
  }
  if (proveedor) {
    // El proveedor se crea si no existe: la compra a crédito lo necesita para el
    // auxiliar de CxP, y obligar a darlo de alta antes rompe el flujo.
    try {
      const sup = await pedir(`${API_URL}/suppliers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: proveedor }),
      });
      cuerpo.supplierId = sup.id || sup.supplier?.id;
    } catch (e) {
      return showAlert(`No se pudo usar el proveedor "${proveedor}": ${e.message}`);
    }
  }

  try {
    const r = await pedir(`${API_URL}/inventario/entradas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    const avisos = (r.avisos || []).length ? `\n\n${r.avisos.join('\n')}` : '';
    await showAlert(`Entrada registrada. Asiento ${r.asiento.id.slice(-6)} en borrador.${avisos}`);
    _invLineas = [];
    render();
  } catch (e) {
    await showAlert(e.message);
  }
}

// ── Salidas y ajustes ───────────────────────────────────────────────────────

async function vistaSalidas() {
  await recargar();
  if (!_invSalidas.length) _invSalidas = [{ productId: '', cantidad: 1 }];
  const opciones = (sel) => _invProductos.map((p) =>
    `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)} (${num(p.stockActual)})</option>`).join('');

  return `
  <div class="card">
    <h3>⬆️ Salida de inventario</h3>
    <p class="nota" style="margin-top:0">Para mermas, consumo interno o correcciones. <strong>La venta no se registra acá</strong>: se factura y la factura descuenta el stock sola. El asiento sale contra la cuenta de costo.</p>
    <div id="inv-salidas">${_invSalidas.map((l, i) => `
      <div class="linea-row">
        <div><label>Producto</label><select onchange="_invSalidas[${i}].productId=this.value">${opciones(l.productId)}</select></div>
        <div><label>Cantidad</label><input type="number" step="0.001" min="0" value="${l.cantidad}" oninput="_invSalidas[${i}].cantidad=Number(this.value)"></div>
        <div></div>
        <div>${_invSalidas.length > 1 ? `<button class="btn btn-secondary btn-sm" onclick="_invSalidas.splice(${i},1);render()">✕</button>` : ''}</div>
      </div>`).join('')}</div>
    <button class="btn btn-secondary btn-sm" onclick="_invSalidas.push({productId:'',cantidad:1});render()">+ Agregar producto</button>

    <div class="form-grid" style="margin-top:16px">
      <div><label>Fecha</label><input id="sa-fecha" type="date" value="${hoy()}"></div>
      <div><label>Motivo</label><input id="sa-motivo" placeholder="Ej: merma, consumo interno"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-top:12px">
      <input type="checkbox" id="sa-forzar"> Permitir dejar el stock en negativo (venta ya ocurrida sin mercancía cargada)
    </label>
    <div style="margin-top:12px"><button class="btn btn-primary" onclick="guardarSalida()">Registrar salida</button></div>
  </div>`;
}

async function guardarSalida() {
  const lineas = _invSalidas.filter((l) => l.productId && l.cantidad > 0);
  if (!lineas.length) return showAlert('Elegí al menos un producto con cantidad');
  try {
    const r = await pedir(`${API_URL}/inventario/salidas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        lineas,
        fecha: document.getElementById('sa-fecha').value || hoy(),
        motivo: document.getElementById('sa-motivo').value.trim() || undefined,
        forzar: document.getElementById('sa-forzar').checked,
        dedupeKey: `salida:${Date.now()}`,
      }),
    });
    const avisos = (r.avisos || []).length ? `\n\n${r.avisos.join('\n')}` : '';
    await showAlert(`Salida registrada. Asiento ${r.asiento.id.slice(-6)} en borrador.${avisos}`);
    _invSalidas = [];
    render();
  } catch (e) {
    await showAlert(e.message);
  }
}

// ── Kardex ──────────────────────────────────────────────────────────────────

async function vistaKardex() {
  const data = await recargar();
  if (!_invProductos.length) return '<div class="card">Todavía no hay productos.</div>';

  const sel = _invKardexProducto && _invProductos.some((p) => p.id === _invKardexProducto)
    ? _invKardexProducto : _invProductos[0].id;
  const k = await pedir(`${API_URL}/inventario/productos/${sel}/kardex`);
  _invKardexProducto = sel;

  const filas = k.movimientos.map((m) => `
    <tr>
      <td>${new Date(m.fecha).toLocaleDateString('es-PA')}</td>
      <td>${etiquetaTipo(m)}</td>
      <td>${esc(m.referencia || m.notas || '—')}</td>
      <td class="num">${m.cantidad > 0 && esEntrada(m) ? num(m.cantidad) : ''}</td>
      <td class="num">${m.cantidad > 0 && !esEntrada(m) ? num(m.cantidad) : ''}</td>
      <td class="num">${money(m.costoUnitario)}</td>
      <td class="num">${num(m.saldoCantidad)}</td>
      <td class="num">${money(m.saldoValor)}</td>
    </tr>`).join('');

  return `
    <div class="card">
      <label style="font-size:12px;color:#6b7280">Producto</label>
      <select onchange="_invKardexProducto=this.value;render()" style="padding:8px;border:1px solid #d0d5dd;border-radius:6px;min-width:280px">
        ${_invProductos.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('')}
      </select>
    </div>
    <div class="summary-cards">
      <div class="summary-card"><div class="num">${num(k.producto.stockActual)}</div><div class="label">Existencia</div></div>
      <div class="summary-card"><div class="num">${money(k.producto.costoPromedio)}</div><div class="label">Costo promedio</div></div>
      <div class="summary-card"><div class="num">${money(k.producto.stockValor)}</div><div class="label">Valor del kardex</div></div>
      <div class="summary-card ${k.mayor.cuadra ? 'ok' : 'err'}"><div class="num">${money(k.mayor.diferencia)}</div><div class="label">Diferencia vs mayor</div></div>
    </div>
    <div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Fecha</th><th>Movimiento</th><th>Referencia</th><th class="num">Entrada</th><th class="num">Salida</th><th class="num">Costo unit.</th><th class="num">Saldo cant.</th><th class="num">Saldo valor</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:24px">Sin movimientos todavía</td></tr>'}</tbody>
    </table></div>
    <div class="nota">El kardex va en <strong>orden de registro</strong>, no de fecha del documento: una factura retroactiva no reescribe los promedios que ya pasaron. ${k.mayor.cuadra ? 'El valor del kardex coincide con el saldo del mayor en la cuenta de inventario.' : `El mayor dice ${money(k.mayor.saldo)} — la diferencia se muestra para que no pase inadvertida.`}</div>`;
}

let _invKardexProducto = null;

const esEntrada = (m) => m.tipo === 'ENTRADA' || m.tipo === 'AJUSTE_POSITIVO';

function etiquetaTipo(m) {
  if (m.origen === 'REGULARIZACION') return '<span class="badge badge-warn">Regularización</span>';
  const mapa = { ENTRADA: ['badge-ok', 'Entrada'], SALIDA: ['badge-neutral', 'Salida'], AJUSTE_POSITIVO: ['badge-ok', 'Ajuste +'], AJUSTE_NEGATIVO: ['badge-neutral', 'Ajuste −'] };
  const [cls, txt] = mapa[m.tipo] || ['badge-neutral', m.tipo];
  return `<span class="badge ${cls}">${esc(txt)}</span>`;
}

// ── Valoración ──────────────────────────────────────────────────────────────

async function vistaValoracion() {
  const v = await pedir(`${API_URL}/inventario/valoracion`);
  const filas = v.filas.filter((f) => f.cantidad !== 0 || f.valor !== 0).map((f) => `
    <tr>
      <td>${esc(f.sku) || '—'}</td>
      <td>${esc(f.nombre)}</td>
      <td class="num">${num(f.cantidad)} ${esc(f.unidad)}</td>
      <td class="num">${money(f.costoPromedio)}</td>
      <td class="num">${money(f.valor)}</td>
    </tr>`).join('');

  return `
    <div class="summary-cards">
      <div class="summary-card"><div class="num">${money(v.total)}</div><div class="label">Valor del inventario</div></div>
      <div class="summary-card"><div class="num">${money(v.mayor.saldo)}</div><div class="label">Saldo en el mayor</div></div>
      <div class="summary-card ${v.mayor.cuadra ? 'ok' : 'err'}"><div class="num">${money(v.mayor.diferencia)}</div><div class="label">Diferencia</div></div>
    </div>
    <div style="overflow-x:auto"><table class="data-table">
      <thead><tr><th>Código</th><th>Producto</th><th class="num">Existencia</th><th class="num">Costo prom.</th><th class="num">Valor</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="5" style="text-align:center;color:#6b7280;padding:24px">Sin existencias</td></tr>'}</tbody>
    </table></div>
    <div class="nota">${v.mayor.cuadra
      ? 'El kardex y el mayor coinciden al centavo.'
      : 'Hay una diferencia entre lo que vale el kardex y lo que dice el mayor. Suele venir de movimientos cuyo asiento quedó rechazado, o de asientos hechos a mano contra la cuenta de inventario.'}</div>`;
}

// ── Carga inicial ───────────────────────────────────────────────────────────

let _invCargaPreview = null;

async function vistaCarga() {
  const cuentas = await pedir(`${API_URL}/accounts`).then((d) => (Array.isArray(d) ? d : d.accounts || [])).catch(() => []);
  const opcionesCuenta = cuentas
    .filter((c) => ['PATRIMONIO', 'PASIVO', 'ACTIVO'].includes(c.type))
    .map((c) => `<option value="${esc(c.id)}">${esc(c.code)} — ${esc(c.name)}</option>`).join('');

  return `
  <div class="card">
    <h3>📥 Carga inicial de inventario</h3>
    <p class="nota" style="margin-top:0">
      Subí el catálogo de <strong>mercancía de reventa</strong> con sus existencias. La materia prima y los
      insumos no van acá: son gasto y no llevan kardex.
      <br>Columnas: <code>SKU</code> (opcional), <code>Nombre</code>, <code>Existencia</code>,
      <code>Costo</code>, <code>Precio de Venta</code> (opcional). El precio va <strong>sin ITBMS</strong>.
    </p>

    <div class="form-grid">
      <div style="grid-column:1/-1">
        <label>Archivo CSV o Excel</label>
        <input type="file" id="ci-archivo" accept=".csv,.xlsx">
      </div>
      <div><label>Fecha de la carga</label><input id="ci-fecha" type="date" value="${hoy()}"></div>
      <div>
        <label>¿Este inventario ya está en la contabilidad?</label>
        <select id="ci-ya" onchange="document.getElementById('ci-contrapartida-bloque').style.display = this.value === '1' ? 'none' : 'block'">
          <option value="0">No — hay que asentarlo</option>
          <option value="1">Sí — solo cargar el kardex</option>
        </select>
      </div>
      <div id="ci-contrapartida-bloque" style="grid-column:1/-1">
        <label>Cuenta de contrapartida del asiento de apertura</label>
        <select id="ci-contrapartida">${opcionesCuenta || '<option value="">(no se pudieron cargar las cuentas)</option>'}</select>
      </div>
    </div>

    <div style="margin-top:12px"><button class="btn btn-secondary" onclick="previsualizarCarga()">Ver qué va a entrar</button></div>
    <div class="nota">
      Si el inventario <strong>ya está en el mayor</strong> —porque cargaste el balance de apertura— dejá "Sí":
      la carga crea solo los movimientos del kardex, para que el kardex alcance al mayor en vez de duplicarlo.
    </div>
  </div>
  <div id="ci-resultado"></div>`;
}

async function previsualizarCarga() {
  const input = document.getElementById('ci-archivo');
  const el = document.getElementById('ci-resultado');
  if (!input.files?.length) return showAlert('Elegí un archivo primero');

  el.innerHTML = '<div class="loading">Leyendo el archivo…</div>';
  const fd = new FormData();
  fd.append('file', input.files[0]);
  try {
    const res = await authFetch(`${API_URL}/inventario/carga-inicial/preview`, { method: 'POST', body: fd });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'No se pudo leer el archivo');
    _invCargaPreview = d;
    el.innerHTML = htmlPreviewCarga(d);
  } catch (e) {
    el.innerHTML = `<div class="aviso">${esc(e.message)}</div>`;
  }
}

function htmlPreviewCarga(d) {
  const s = d.resumen;
  const filas = d.filas.map((f) => `
    <tr style="${f.errores.length ? 'background:#fef2f2' : ''}">
      <td>${esc(f.sku) || '—'}</td>
      <td>${esc(f.nombre) || '<em>sin nombre</em>'}</td>
      <td class="num">${num(f.cantidad)}</td>
      <td class="num">${money(f.costoUnitario)}</td>
      <td class="num">${f.precioVenta == null ? '—' : money(f.precioVenta)}</td>
      <td class="num">${money(f.cantidad * f.costoUnitario)}</td>
      <td>${f.errores.length
        ? `<span class="badge badge-err" title="${esc(f.errores.join(' · '))}">${esc(f.errores[0])}</span>`
        : f.existente ? '<span class="badge badge-warn">Ya existe</span>' : '<span class="badge badge-ok">Nuevo</span>'}</td>
    </tr>`).join('');

  const puedeCargar = s.validas > 0;
  return `
  <div class="summary-cards">
    <div class="summary-card"><div class="num">${s.validas}</div><div class="label">Filas válidas</div></div>
    <div class="summary-card ${s.conError ? 'err' : ''}"><div class="num">${s.conError}</div><div class="label">Con errores</div></div>
    <div class="summary-card ${s.existentes ? 'warn' : ''}"><div class="num">${s.existentes}</div><div class="label">Ya existen</div></div>
    <div class="summary-card"><div class="num">${money(s.valorTotal)}</div><div class="label">Valor de la carga</div></div>
  </div>
  ${d.duplicadas?.length ? `<div class="aviso">El archivo repite ${d.duplicadas.length} producto(s); sus existencias se sumaron en una sola fila: ${esc(d.duplicadas.slice(0, 5).join(', '))}${d.duplicadas.length > 5 ? '…' : ''}</div>` : ''}
  ${s.conError ? '<div class="aviso">Las filas en rojo tienen errores y <strong>no se van a cargar</strong>. Corregí el archivo y volvé a subirlo, o cargá solo las válidas.</div>' : ''}
  <div style="overflow-x:auto;max-height:400px;overflow-y:auto"><table class="data-table">
    <thead><tr><th>SKU</th><th>Producto</th><th class="num">Existencia</th><th class="num">Costo</th><th class="num">P. Venta</th><th class="num">Valor</th><th>Estado</th></tr></thead>
    <tbody>${filas}</tbody>
  </table></div>
  <div style="margin-top:12px">
    <button class="btn btn-primary" onclick="ejecutarCarga()" ${puedeCargar ? '' : 'disabled'}>Cargar ${s.validas} producto(s)</button>
  </div>
  <div class="nota">Los productos que ya existen suman la existencia a la que tenían. Todo queda con su movimiento de kardex fechado el día que elegiste.</div>`;
}

async function ejecutarCarga() {
  if (!_invCargaPreview) return showAlert('Primero previsualizá el archivo');
  const yaEnContabilidad = document.getElementById('ci-ya').value === '1';
  const contrapartida = document.getElementById('ci-contrapartida')?.value;

  if (!yaEnContabilidad && !contrapartida) {
    return showAlert('Elegí la cuenta de contrapartida del asiento de apertura.');
  }
  const validas = _invCargaPreview.filas.filter((f) => !f.errores.length);

  try {
    const r = await pedir(`${API_URL}/inventario/carga-inicial/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filas: validas.map((f) => ({
          sku: f.sku, nombre: f.nombre, cantidad: f.cantidad,
          costoUnitario: f.costoUnitario, precioVenta: f.precioVenta,
        })),
        fecha: document.getElementById('ci-fecha').value || hoy(),
        yaEnContabilidad,
        cuentaContrapartidaId: yaEnContabilidad ? undefined : contrapartida,
        dedupeKey: `carga-inicial:${Date.now()}`,
      }),
    });
    await showAlert(
      `Cargados ${r.creados} producto(s) nuevo(s) y actualizados ${r.actualizados}.\n` +
      `Valor de la carga: ${money(r.valorTotal)}.` +
      (r.asiento ? `\nAsiento de apertura ${r.asiento.id.slice(-6)} en borrador.` : '\nSin asiento: el kardex alcanzó al mayor.') +
      (r.avisos?.length ? `\n\n${r.avisos.join('\n')}` : ''),
    );
    _invCargaPreview = null;
    _invTab = 'existencias';
    document.querySelectorAll('.inv-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'existencias'));
    render();
  } catch (e) {
    await showAlert(e.message);
  }
}

// ── Arranque ────────────────────────────────────────────────────────────────

render();
