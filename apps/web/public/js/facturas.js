// facturas.js (15/15) — módulo Facturas PDF (add-on contratado por separado)

const fmtFac = n => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function loadPanelFacturas() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-facturas-content').classList.remove('hidden');

  if (!window.userAddons?.includes('facturas-pdf')) {
    document.getElementById('facturas-lista-content').innerHTML = `
      <div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:32px;text-align:center;color:#92400e">
        <div style="font-size:32px">🧾</div>
        <div style="font-size:15px;font-weight:700;margin-top:8px">Módulo Facturas PDF no contratado</div>
        <div style="font-size:13px;margin-top:4px">Este módulo se contrata por separado. Contáctanos por WhatsApp para activarlo.</div>
      </div>`;
    return;
  }
  clickFacturasTab('lista');
}

document.querySelectorAll('#facturas-tabs button').forEach(btn => {
  btn.addEventListener('click', () => clickFacturasTab(btn.dataset.ftab));
});

function clickFacturasTab(tab) {
  document.querySelectorAll('#facturas-tabs button').forEach(b => {
    b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent';
  });
  const active = document.querySelector(`#facturas-tabs button[data-ftab="${tab}"]`);
  if (active) { active.classList.add('active'); active.style.color = '#1a1a2e'; active.style.borderBottomColor = '#1565c0'; }
  document.getElementById('facturas-lista-content').classList.toggle('hidden', tab !== 'lista');
  document.getElementById('facturas-config-content').classList.toggle('hidden', tab !== 'config');
  if (tab === 'lista') loadFacturasList();
  else loadFacturasConfig();
}

async function loadFacturasList() {
  const el = document.getElementById('facturas-lista-content');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/facturas?page=1&pageSize=50`);
    const d = await res.json();
    const items = d.items || [];
    if (!items.length) {
      el.innerHTML = '<div style="text-align:center;padding:48px;color:#6b7280">No hay facturas emitidas. Crea la primera con "➕ Nueva Factura".</div>';
      return;
    }
    const statusChip = (s) => {
      const c = { PENDIENTE: ['#f59e0b', '#fffbeb'], VENCIDA: ['#dc2626', '#fef2f2'], PAGADA: ['#059669', '#f0fdf4'], RECHAZADA: ['#6b7280', '#f3f4f6'] }[s] || ['#6b7280', '#f3f4f6'];
      return `<span style="font-size:11px;background:${c[1]};color:${c[0]};padding:2px 8px;border-radius:10px;font-weight:600">${s}</span>`;
    };
    const rows = items.map(f => `<tr>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0"><strong>${escapeHtml(f.number || '—')}</strong></td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${escapeHtml(f.client?.name || '—')}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${new Date(f.date).toLocaleDateString('es-PA')}</td>
      <td style="text-align:right;padding:8px 10px;border-bottom:1px solid #f0f0f0;font-weight:600">${fmtFac(f.total)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">${statusChip(f.status)}</td>
      <td style="padding:8px 10px;border-bottom:1px solid #f0f0f0">
        <button onclick="downloadFacturaPdf('${f.id}')" style="padding:4px 10px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:5px;cursor:pointer">📄 PDF</button>
        ${f.status !== 'PAGADA' && f.status !== 'RECHAZADA' ? `<button onclick="payFactura('${f.id}')" style="margin-left:4px;padding:4px 10px;font-size:11px;background:#059669;color:#fff;border:none;border-radius:5px;cursor:pointer">💵 Cobrar</button>` : ''}
      </td>
    </tr>`).join('');
    el.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Nº Factura</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Cliente</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Fecha</th>
        <th style="text-align:right;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Total</th>
        <th style="text-align:left;padding:8px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280">Estado</th>
        <th style="width:32px"></th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#dc2626">Error al cargar</div>'; }
}

async function downloadFacturaPdf(id) {
  try {
    const token = getToken();
    const res = await fetch(`${API_URL}/facturas/${id}/pdf?token=${encodeURIComponent(token)}`);
    if (!res.ok) { alert('❌ Error al generar el PDF'); return; }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="([^"]+)"/);
    const nombre = m ? m[1] : 'Factura.pdf';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = nombre;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { alert('❌ Error de conexión'); }
}

// ── Nueva factura ──
let facturaItems = [{ descripcion: '', cantidad: 1, precio: '' }];

function openFacturaModal() {
  facturaItems = [{ descripcion: '', cantidad: 1, precio: '' }];
  const overlay = document.createElement('div'); overlay.className = 'app-dialog-overlay';
  overlay.id = 'factura-modal-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:720px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:16px">➕ Nueva Factura</div>
    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
      <div style="flex:2;min-width:200px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Cliente</label>
        <input id="fac-cliente" placeholder="Nombre del cliente (o CONSUMIDOR FINAL)" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
      </div>
      <div style="flex:1;min-width:140px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">RUC (opcional)</label>
        <input id="fac-ruc" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
      </div>
      <div style="flex:1;min-width:120px">
        <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Método de pago</label>
        <select id="fac-pago" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff">
          <option value="EFECTIVO">💵 Efectivo</option>
          <option value="CREDITO">📋 Crédito</option>
        </select>
      </div>
    </div>
    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Items</div>
    <div id="fac-items"></div>
    <button onclick="addFacturaItemRow()" style="margin-top:8px;padding:6px 12px;font-size:11px;background:#f0f0f0;border:1px dashed #9ca3af;border-radius:6px;cursor:pointer;color:#374151">+ Agregar item</button>
    <div id="fac-totales" style="margin-top:12px;padding:10px 12px;background:#f9fafb;border-radius:8px;font-size:13px;text-align:right;color:#1a1a2e"></div>
    <div class="app-dialog-buttons" style="margin-top:14px">
      <button class="app-dialog-btn secondary" onclick="closeFacturaModal()">Cancelar</button>
      <button class="app-dialog-btn primary" onclick="saveFactura()">💾 Emitir Factura</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  renderFacturaItems();
}

function closeFacturaModal() {
  const ov = document.getElementById('factura-modal-overlay');
  if (ov) ov.remove();
}

function addFacturaItemRow() {
  facturaItems.push({ descripcion: '', cantidad: 1, precio: '' });
  renderFacturaItems();
}

function renderFacturaItems() {
  const el = document.getElementById('fac-items');
  if (!el) return;
  el.innerHTML = facturaItems.map((it, i) => `
    <div style="display:flex;gap:8px;margin-bottom:6px">
      <input value="${escapeHtml(it.descripcion)}" oninput="facItem(${i},'descripcion',this.value)" placeholder="Descripción" style="flex:3;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px">
      <input type="number" min="1" value="${it.cantidad}" oninput="facItem(${i},'cantidad',parseFloat(this.value)||1)" placeholder="Cant." style="flex:0 0 60px;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;text-align:right">
      <input type="number" step="0.01" min="0" value="${it.precio}" oninput="facItem(${i},'precio',parseFloat(this.value)||0)" placeholder="Precio" style="flex:0 0 90px;padding:7px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;text-align:right">
      <button onclick="facRemoveItem(${i})" style="background:none;border:none;cursor:pointer;font-size:14px">🗑️</button>
    </div>`).join('');
  updateFacturaTotales();
}

function facItem(i, field, value) {
  facturaItems[i][field] = value;
  updateFacturaTotales();
}

function facRemoveItem(i) {
  facturaItems.splice(i, 1);
  renderFacturaItems();
}

function updateFacturaTotales() {
  const el = document.getElementById('fac-totales');
  if (!el) return;
  const subtotal = facturaItems.reduce((s, it) => s + (it.cantidad || 1) * (it.precio || 0), 0);
  const itbms = subtotal * 0.07;
  el.innerHTML = `Subtotal: <strong>${fmtFac(subtotal)}</strong> · ITBMS (7%): <strong>${fmtFac(itbms)}</strong> · <span style="font-size:15px">Total: <strong>${fmtFac(subtotal + itbms)}</strong></span>`;
}

async function saveFactura() {
  const cliente = document.getElementById('fac-cliente').value.trim();
  if (!cliente) { alert('❌ Indica el cliente (o CONSUMIDOR FINAL)'); return; }
  const items = facturaItems.filter(it => it.descripcion.trim());
  if (!items.length) { alert('❌ Agrega al menos un item con descripción'); return; }
  const pago = document.getElementById('fac-pago').value;
  try {
    const res = await authFetch(`${API_URL}/facturas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientName: cliente,
        clientTaxId: document.getElementById('fac-ruc').value.trim() || undefined,
        items,
        paymentMethod: pago,
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('❌ ' + (e.error || 'Error al emitir la factura'));
      return;
    }
    const d = await res.json();
    closeFacturaModal();
    loadFacturasList();
    if (confirm(`✅ Factura ${d.number} emitida por ${fmtFac(d.total)}. ¿Descargar el PDF?`)) downloadFacturaPdf(d.id);
  } catch (e) { alert('❌ Error de conexión'); }
}

async function payFactura(id) {
  if (!confirm('¿Marcar esta factura como cobrada? Se creará el asiento de cobro (BORRADOR).')) return;
  try {
    const res = await authFetch(`${API_URL}/facturas/${id}/pay`, { method: 'PATCH' });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('❌ ' + (e.error || 'Error al cobrar'));
      return;
    }
    loadFacturasList();
  } catch (e) { alert('❌ Error de conexión'); }
}

// ── Configuración (serie, resolución DGI, logo) ──
async function loadFacturasConfig() {
  const el = document.getElementById('facturas-config-content');
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando...</div>';
  try {
    const res = await authFetch(`${API_URL}/facturas/config`);
    const d = await res.json();
    el.innerHTML = `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:20px;max-width:560px">
        <h3 style="margin:0 0 4px 0;color:#1a1a2e">⚙️ Configuración de Facturación</h3>
        <p style="font-size:12px;color:#6b7280;margin:0 0 16px 0">Numeración autorizada por la DGI y logo de tu empresa para las facturas PDF</p>
        <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap">
          <div style="flex:1;min-width:120px">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Serie</label>
            <input id="cfg-serie" value="${escapeHtml(d.facturaSerie || '')}" placeholder="A" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box">
          </div>
          <div style="flex:2;min-width:180px">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Nº Resolución DGI</label>
            <input id="cfg-resolucion" value="${escapeHtml(d.facturaResolucion || '')}" placeholder="123-2026" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;box-sizing:border-box">
          </div>
          <div style="flex:1;min-width:140px">
            <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Fecha de la resolución</label>
            <input type="date" id="cfg-resolucion-fecha" value="${d.facturaResolucionFecha ? new Date(d.facturaResolucionFecha).toISOString().slice(0, 10) : ''}" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff">
          </div>
        </div>
        <div style="margin-bottom:12px">
          <label style="font-size:11px;color:#6b7280;display:block;margin-bottom:2px">Logo (PNG/JPG, se redimensiona a ≤800px)</label>
          <input type="file" id="cfg-logo" accept="image/*" style="font-size:12px">
          <div style="font-size:11px;color:#6b7280;margin-top:4px">${d.hasLogo ? '✅ Logo actual cargado' : 'Sin logo'}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button onclick="saveFacturasConfig()" style="padding:8px 18px;font-size:13px;background:#1565c0;color:#fff;border:none;border-radius:6px;cursor:pointer">💾 Guardar Configuración</button>
          ${d.hasLogo ? `<button onclick="removeFacturaLogo()" style="padding:8px 14px;font-size:12px;background:#fef2f2;color:#dc2626;border:1px solid #fecaca;border-radius:6px;cursor:pointer">Quitar logo</button>` : ''}
        </div>
      </div>`;
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#dc2626">Error al cargar</div>'; }
}

async function saveFacturasConfig() {
  const form = new FormData();
  form.append('serie', document.getElementById('cfg-serie').value.trim());
  form.append('resolucion', document.getElementById('cfg-resolucion').value.trim());
  const fecha = document.getElementById('cfg-resolucion-fecha').value;
  if (fecha) form.append('resolucionFecha', fecha);
  const logo = document.getElementById('cfg-logo').files?.[0];
  if (logo) form.append('logo', logo);
  try {
    const res = await authFetch(`${API_URL}/facturas/config`, { method: 'POST', body: form });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      alert('❌ ' + (e.error || 'Error al guardar'));
      return;
    }
    alert('✅ Configuración guardada');
    loadFacturasConfig();
  } catch (e) { alert('❌ Error de conexión'); }
}

async function removeFacturaLogo() {
  const form = new FormData();
  form.append('removeLogo', 'true');
  try {
    await authFetch(`${API_URL}/facturas/config`, { method: 'POST', body: form });
    loadFacturasConfig();
  } catch (e) { alert('❌ Error'); }
}
