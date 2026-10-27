// terceros.js — panel «Terceros»: maestro de clientes y proveedores.
//
// Un solo listado con la clasificación (Cliente/Proveedor) y búsqueda en
// pantalla por nombre, RUC, DV, teléfono, email o dirección. Los datos salen de
// los endpoints existentes (/clients y /suppliers), que ya devuelven el perfil
// fiscal descifrado; filtrar acá evita reconsultar la API en cada tecla.

let _terceros = [];
let _tercerosCargando = false;
let _tercerosResumen = null;

/** Mismos roles que pueden crear/editar clientes y proveedores en la API. */
function puedeEditarTerceros() {
  return ['admin', 'contador', 'superadmin'].includes(getUser()?.role);
}

function r2T(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function moneyTercero(n) {
  return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fechaTercero(d) {
  if (!d) return '—';
  const f = new Date(d);
  return Number.isNaN(f.getTime()) ? '—' : f.toLocaleDateString('es-PA');
}

/** Saldo de un documento: refleja la misma regla que el backend (saldos.ts). */
function saldoDocTercero(tipo, doc) {
  if (!doc || doc.status === 'PAGADA' || doc.status === 'RECHAZADA') return 0;
  if (tipo === 'Cliente') {
    // Una factura de contado no es CxC aunque su status siga PENDIENTE.
    if (doc.paymentMethod === 'EFECTIVO') return 0;
    return Math.max(0, r2T((Number(doc.total) || 0) - (Number(doc.paidAmount) || 0)));
  }
  return Math.max(0, r2T(doc.total));
}

function docsTercero(tipo, d) {
  return (tipo === 'Cliente' ? d?.invoices : d?.bills) || [];
}

/** Aging local para el badge y las tarjetas del panel. El modal usa el backend. */
function agingTerceroLocal(tipo, d) {
  const out = { corriente: 0, d30: 0, d60: 0, d90: 0, d120: 0, over120: 0, vencido: 0 };
  const hoy = Date.now();
  for (const doc of docsTercero(tipo, d)) {
    if (doc.status === 'RECHAZADA') continue;
    const saldo = saldoDocTercero(tipo, doc);
    if (saldo <= 0.01) continue;
    const vence = doc.dueDate ? new Date(doc.dueDate) : null;
    if (!vence || Number.isNaN(vence.getTime())) {
      out.corriente += saldo;
      continue;
    }
    const dias = Math.floor((hoy - vence.getTime()) / 86400000);
    if (dias <= 0) out.corriente += saldo;
    else if (dias <= 30) out.d30 += saldo;
    else if (dias <= 60) out.d60 += saldo;
    else if (dias <= 90) out.d90 += saldo;
    else if (dias <= 120) out.d120 += saldo;
    else out.over120 += saldo;
  }
  out.vencido = r2T(out.d30 + out.d60 + out.d90 + out.d120 + out.over120);
  for (const k of ['corriente', 'd30', 'd60', 'd90', 'd120', 'over120']) out[k] = r2T(out[k]);
  return out;
}

function ecoTercero(t) {
  const d = t.data || {};
  const saldo = t.tipo === 'Cliente' ? (Number(d.totalDue) || 0) : (Number(d.totalOwed) || 0);
  const aging = agingTerceroLocal(t.tipo, d);
  return { saldo: r2T(saldo), vencido: aging.vencido, aging };
}

function calcularResumenTerceros(lista) {
  const out = { cxc: 0, cxp: 0, vencCobrar: 0, vencPagar: 0, clientesSaldo: 0, proveedoresSaldo: 0 };
  for (const t of lista || []) {
    const eco = t._eco || ecoTercero(t);
    if (t.tipo === 'Cliente') {
      out.cxc += eco.saldo;
      out.vencCobrar += eco.vencido;
      if (eco.saldo > 0.01) out.clientesSaldo++;
    } else {
      out.cxp += eco.saldo;
      out.vencPagar += eco.vencido;
      if (eco.saldo > 0.01) out.proveedoresSaldo++;
    }
  }
  for (const k of ['cxc', 'cxp', 'vencCobrar', 'vencPagar']) out[k] = r2T(out[k]);
  return out;
}

function tarjetaResumenTercero(label, value, sub, color) {
  return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:12px;text-align:center">
    <div style="font-size:11px;color:#6b7280">${label}</div>
    <div style="font-size:18px;font-weight:700;color:${color};margin-top:3px">${value}</div>
    <div style="font-size:10px;color:#9ca3af;margin-top:2px">${sub}</div>
  </div>`;
}

function loadPanelTerceros() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-terceros-content').classList.remove('hidden');
  const btn = document.getElementById('terceros-nuevo-btn');
  if (btn) btn.style.display = puedeEditarTerceros() ? '' : 'none';
  loadTerceros();
}

async function loadTerceros() {
  const list = document.getElementById('terceros-list');
  if (!list) return;
  if (_tercerosCargando) return;
  _tercerosCargando = true;
  list.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando terceros...</div>';
  try {
    const [rc, rs] = await Promise.all([authFetch(`${API_URL}/clients`), authFetch(`${API_URL}/suppliers`)]);
    if (!rc.ok || !rs.ok) {
      list.innerHTML = '<div class="empty">Error al cargar terceros</div>';
      return;
    }
    const [clients, suppliers] = await Promise.all([rc.json(), rs.json()]);
    _terceros = [
      ...(Array.isArray(clients) ? clients : []).map((c) => ({ tipo: 'Cliente', data: c })),
      ...(Array.isArray(suppliers) ? suppliers : []).map((s) => ({ tipo: 'Proveedor', data: s })),
    ];
    // Se calcula una vez al cargar: el buscador repinta en cada tecla y no debe
    // recorrer todas las facturas/bills de todos los terceros cada vez.
    _terceros.forEach((t) => { t._eco = ecoTercero(t); });
    _tercerosResumen = calcularResumenTerceros(_terceros);
    renderTerceros();
  } catch (e) {
    list.innerHTML = '<div class="empty">Error de conexión</div>';
  } finally {
    _tercerosCargando = false;
  }
}

/** Todo lo que el buscador puede mirar, sin distinguir mayúsculas ni tildes.
 *  Incluye el RUC/teléfono en dígitos para que "34224075526" encuentre
 *  "342-240-75526-50" y "50760000000" encuentre "+507 6000-0000". */
function terceroHaystack(t) {
  const d = t.data || {};
  const digitos = (v) => String(v ?? '').replace(/\D/g, '');
  const rucCompleto = d.dv ? `${d.taxId || ''}-${d.dv}` : (d.taxId || '');
  return normalizeSearch([
    t.tipo,
    d.name,
    d.tradeName,
    d.contactName,
    d.taxId,
    d.dv,
    rucCompleto,
    digitos(d.taxId),
    digitos(d.phone),
    d.phone,
    d.email,
    d.address,
    d.location,
    d.taxIdType,
  ].join(' '));
}

function renderTerceros() {
  const list = document.getElementById('terceros-list');
  const resumen = document.getElementById('terceros-resumen');
  if (!list || !resumen) return;

  const raw = document.getElementById('terceros-search')?.value?.trim() || '';
  const terms = normalizeSearch(raw).split(/\s+/).filter(Boolean);
  const shown = terms.length
    ? _terceros.filter((t) => {
        const hay = terceroHaystack(t);
        return terms.every((term) => hay.includes(term));
      })
    : _terceros;

  const clientes = _terceros.filter((t) => t.tipo === 'Cliente').length;
  const proveedores = _terceros.filter((t) => t.tipo === 'Proveedor').length;
  const eco = _tercerosResumen || calcularResumenTerceros(_terceros);

  resumen.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 8px">
      ${tarjetaResumenTercero('💵 CxC pendiente', moneyTercero(eco.cxc), `${eco.clientesSaldo} cliente(s) con saldo`, '#1d4ed8')}
      ${tarjetaResumenTercero('💵 CxP pendiente', moneyTercero(eco.cxp), `${eco.proveedoresSaldo} proveedor(es) con saldo`, '#b45309')}
      ${tarjetaResumenTercero('⚠️ Vencido por cobrar', moneyTercero(eco.vencCobrar), 'facturas vencidas', eco.vencCobrar > 0 ? '#dc2626' : '#059669')}
      ${tarjetaResumenTercero('⚠️ Vencido por pagar', moneyTercero(eco.vencPagar), 'facturas vencidas', eco.vencPagar > 0 ? '#dc2626' : '#059669')}
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:8px">${_terceros.length} tercero(s): ${clientes} cliente(s) y ${proveedores} proveedor(es)`
    + (terms.length ? ` · mostrando ${shown.length}` : '') + '</div>';

  if (!_terceros.length) {
    list.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Todavía no hay clientes ni proveedores registrados.<br><span style="font-size:12px">Se crean al emitir facturas o al registrar una compra/gasto.</span></div>';
    return;
  }
  if (!shown.length) {
    list.innerHTML = `<div style="text-align:center;padding:32px;color:#6b7280">🔍 Sin coincidencias para «${escapeHtml(raw)}»</div>`;
    return;
  }

  const badge = (tipo) => tipo === 'Cliente'
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:600">👤 Cliente</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:600">🏭 Proveedor</span>';

  const puede = puedeEditarTerceros();
  const rows = shown.map((t) => {
    const d = t.data || {};
    const nombre = escapeHtml(d.name || '—');
    const comercial = d.tradeName && d.tradeName !== d.name
      ? `<div style="font-size:11px;color:#6b7280">${escapeHtml(d.tradeName)}</div>`
      : '';
    const ecoT = t._eco || ecoTercero(t);
    const saldoColor = ecoT.vencido > 0.01 ? '#dc2626' : (t.tipo === 'Cliente' ? '#1d4ed8' : '#b45309');
    const saldoBadge = ecoT.saldo > 0.01
      ? `<div style="font-size:11px;margin-top:2px;color:${saldoColor}">💵 ${t.tipo === 'Cliente' ? 'Debe' : 'Por pagar'} ${moneyTercero(ecoT.saldo)}`
        + (ecoT.vencido > 0.01 ? ` · vencido ${moneyTercero(ecoT.vencido)}` : '') + '</div>'
      : '<div style="font-size:11px;margin-top:2px;color:#059669">✅ Al día</div>';
    const celdas = [
      badge(t.tipo),
      `<div style="font-weight:600">${nombre}</div>${comercial}${saldoBadge}`,
      escapeHtml(d.taxId || '—'),
      escapeHtml(d.dv || '—'),
      escapeHtml(d.phone || '—'),
      escapeHtml(d.email || '—'),
      escapeHtml(d.address || '—'),
    ];
    const acciones = [
      `<button onclick="verEstadoTercero('${t.tipo}', '${d.id}')" title="Estado de cuenta: saldo, antigüedad y movimientos" style="padding:3px 8px;font-size:11px;background:#059669;color:#fff;border:none;border-radius:4px;cursor:pointer">💵</button>`,
    ];
    if (puede) {
      acciones.push(
        `<button onclick="abrirTerceroModal('${t.tipo}', '${d.id}')" title="Editar ${t.tipo.toLowerCase()}" style="padding:3px 8px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">✏️</button>`,
        `<button onclick="eliminarTercero('${t.tipo}', '${d.id}')" title="Eliminar ${t.tipo.toLowerCase()}" style="padding:3px 8px;font-size:11px;background:#dc2626;color:#fff;border:none;border-radius:4px;cursor:pointer">🗑️</button>`,
      );
    }
    celdas.push(acciones.join(' '));
    return celdas;
  });

  list.innerHTML = buildInformesTable(
    ['Clasificación', 'Nombre', 'RUC', 'DV', 'Teléfono', 'Email', 'Dirección', 'Acciones'],
    rows,
  );
}

/* ── Estado de cuenta (💵): saldo, antigüedad, tendencia y movimientos ── */

async function verEstadoTercero(tipo, id) {
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.id = 'tercero-estado-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:920px;max-height:90vh;overflow-y:auto">
    <div style="padding:28px;text-align:center;color:#6b7280;font-size:13px">Cargando estado de cuenta...</div>
  </div>`;
  document.body.appendChild(overlay);
  const cerrar = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cerrar(); });

  try {
    const endpoint = tipo === 'Cliente' ? 'clients' : 'suppliers';
    const res = await authFetch(`${API_URL}/${endpoint}/${encodeURIComponent(id)}/resumen`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { overlay.remove(); await showAlert(`❌ ${data.error || 'No se pudo cargar el estado de cuenta'}`); return; }
    overlay.querySelector('.app-dialog').innerHTML = renderEstadoTerceroHtml(data);
    overlay.querySelector('#tercero-estado-close').onclick = cerrar;
  } catch (e) {
    overlay.remove();
    await showAlert('Error de conexión');
  }
}

function chipEstadoTercero(estado) {
  const colores = {
    PAGADA: ['#ecfdf5', '#059669'],
    PENDIENTE: ['#fffbeb', '#b45309'],
    VENCIDA: ['#fef2f2', '#dc2626'],
  };
  const [bg, color] = colores[estado] || ['#f3f4f6', '#6b7280'];
  return `<span style="display:inline-block;padding:2px 7px;border-radius:10px;background:${bg};color:${color};font-size:10px;font-weight:700">${escapeHtml(estado || '—')}</span>`;
}

function renderEstadoTerceroHtml(d) {
  const r = d.resumen || {};
  const ag = d.aging || {};
  const tipoBadge = d.tipo === 'Cliente'
    ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#dbeafe;color:#1d4ed8;font-size:11px;font-weight:700">👤 Cliente</span>'
    : '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700">🏭 Proveedor</span>';
  const ruc = [d.taxId, d.dv].filter(Boolean).join('-');
  const contacto = [d.phone, d.email, d.address].filter(Boolean).join(' · ');
  const extra = d.tipo === 'Cliente'
    ? (d.esAgenteRetenedor
        ? ` · Agente retenedor ${Math.round((Number(d.porcentajeRetencionItbms) || 0.5) * 100)}%`
        : '')
    : (d.paymentTerms ? ` · Plazo ${escapeHtml(String(d.paymentTerms))} días` : '');

  const kpis = d.tipo === 'Cliente'
    ? [['Facturado', r.total, '#1d4ed8'], ['Cobrado', r.pagado, '#059669'], ['Pendiente', r.pendiente, '#b45309'], ['Vencido', r.vencido, r.vencido > 0 ? '#dc2626' : '#059669']]
    : [['Comprado', r.total, '#1d4ed8'], ['Pagado', r.pagado, '#059669'], ['Pendiente', r.pendiente, '#b45309'], ['Vencido', r.vencido, r.vencido > 0 ? '#dc2626' : '#059669']];

  const kpiHtml = kpis.map(([label, valor, color]) =>
    `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 12px">
      <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em">${label}</div>
      <div style="font-size:18px;font-weight:700;color:${color};margin-top:2px">${moneyTercero(valor)}</div>
    </div>`).join('');

  const documentos = d.documentos || {};
  const secundarios = [
    ['Documentos', `${r.documentos || 0}`, `${documentos.facturas || 0} factura(s) + ${documentos.contado || 0} contado`],
    ['Ticket promedio', moneyTercero(r.ticketPromedio), 'por movimiento'],
    ['Último movimiento', fechaTercero(r.ultimoMovimiento), ''],
    ['Próximo vencimiento', fechaTercero(r.proximoVencimiento),
      r.proximoVencimiento && new Date(r.proximoVencimiento).getTime() < Date.now() ? 'vencido' : ''],
    ['Días de pago', r.promedioDiasPago == null ? '—' : `${r.promedioDiasPago} días`, 'promedio'],
  ];
  if (d.tipo === 'Cliente') {
    const ret = d.retenido || {};
    secundarios.push(['Retenido ITBMS', moneyTercero(ret.total), `Pend. ${moneyTercero(ret.pendiente)} · Recib. ${moneyTercero(ret.recibido)} · Aplic. ${moneyTercero(ret.aplicado)}`]);
  }
  const secundariosHtml = secundarios.map(([label, valor, sub]) =>
    `<div style="min-width:130px">
      <div style="font-size:10px;color:#6b7280">${label}</div>
      <div style="font-size:12px;font-weight:600;color:#1a1a2e">${escapeHtml(String(valor || '—'))}</div>
      ${sub ? `<div style="font-size:9px;color:#9ca3af">${escapeHtml(sub)}</div>` : ''}
    </div>`).join('');

  const agingItems = [
    ['Corriente', ag.corriente, '#059669'],
    ['1-30', ag.d30, '#f59e0b'],
    ['31-60', ag.d60, '#f97316'],
    ['61-90', ag.d90, '#dc2626'],
    ['91-120', ag.d120, '#b91c1c'],
    ['+120', ag.over120, '#7f1d1d'],
  ];
  const agingHtml = agingItems.map(([label, valor, color]) =>
    `<div style="flex:1;min-width:70px;text-align:center;background:#fff;border:1px solid #e5e7eb;border-radius:6px;padding:6px 4px">
      <div style="font-size:9px;color:#6b7280">${label}</div>
      <div style="font-size:11px;font-weight:700;color:${valor > 0.01 ? color : '#9ca3af'}">${moneyTercero(valor)}</div>
    </div>`).join('');

  const tendencia = Array.isArray(d.tendencia) ? d.tendencia : [];
  const maxTendencia = Math.max(0, ...tendencia.map((x) => Number(x.total) || 0));
  const tendenciaHtml = tendencia.length && maxTendencia > 0
    ? `<div style="display:flex;align-items:flex-end;gap:4px;height:105px;padding:8px 8px 4px;border:1px solid #e5e7eb;border-radius:8px;background:#fafafa">
        ${tendencia.map((x) => {
          const alto = maxTendencia > 0 ? Math.max(2, Math.round(((Number(x.total) || 0) / maxTendencia) * 76)) : 2;
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:2px" title="${escapeHtml(x.label)}: ${moneyTercero(x.total)}">
            <div style="width:100%;height:${alto}px;background:#93c5fd;border-radius:2px 2px 0 0"></div>
            <span style="font-size:8px;color:#6b7280">${escapeHtml(x.label)}</span>
          </div>`;
        }).join('')}
      </div>`
    : '<div style="font-size:12px;color:#6b7280">Sin movimientos en los últimos 12 meses.</div>';

  const recientes = Array.isArray(d.recientes) ? d.recientes : [];
  const filas = recientes.length
    ? recientes.map((m) => `<tr>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;white-space:nowrap">${fechaTercero(m.fecha)}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;white-space:nowrap">${escapeHtml(m.documento || '—')}${m.contado ? ' <span style="font-size:9px;color:#6b7280">(contado)</span>' : ''}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(m.detalle || '')}">${escapeHtml(m.detalle || '—')}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap">${moneyTercero(m.total)}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;font-weight:600;color:${Number(m.saldo) > 0.01 ? '#b45309' : '#6b7280'}">${moneyTercero(m.saldo)}</td>
        <td style="padding:5px 6px;border-bottom:1px solid #f1f5f9;text-align:center;white-space:nowrap">${chipEstadoTercero(m.estado)}</td>
      </tr>`).join('')
    : '<tr><td colspan="6" style="padding:18px;text-align:center;color:#6b7280;font-size:12px">Sin movimientos registrados.</td></tr>';

  return `<div style="font-weight:700;font-size:16px;margin-bottom:4px">💵 Estado de cuenta</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
      ${tipoBadge}
      <span style="font-size:16px;font-weight:700;color:#1a1a2e">${escapeHtml(d.name || '—')}</span>
      ${d.tradeName && d.tradeName !== d.name ? `<span style="font-size:12px;color:#6b7280">(${escapeHtml(d.tradeName)})</span>` : ''}
    </div>
    <div style="font-size:11px;color:#6b7280;margin-bottom:14px">
      ${ruc ? `RUC/Cédula ${escapeHtml(ruc)}` : 'Sin RUC/Cédula'}${contacto ? ` · ${escapeHtml(contacto)}` : ''}${extra}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:10px">${kpiHtml}</div>
    <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 10px;background:#f9fafb;border-radius:8px;margin-bottom:14px">${secundariosHtml}</div>

    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Antigüedad de saldos</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px">${agingHtml}</div>

    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Últimos 12 meses</div>
    <div style="margin-bottom:14px">${tendenciaHtml}</div>

    <div style="font-size:12px;font-weight:600;color:#374151;margin-bottom:6px">Movimientos recientes</div>
    <div style="overflow-x:auto;border:1px solid #e5e7eb;border-radius:8px">
      <table style="width:100%;border-collapse:collapse;font-size:11.5px">
        <thead><tr style="background:#f8fafc;color:#6b7280">
          <th style="text-align:left;padding:6px 6px;font-weight:600">Fecha</th>
          <th style="text-align:left;padding:6px 6px;font-weight:600">Documento</th>
          <th style="text-align:left;padding:6px 6px;font-weight:600">Detalle</th>
          <th style="text-align:right;padding:6px 6px;font-weight:600">Total</th>
          <th style="text-align:right;padding:6px 6px;font-weight:600">Saldo</th>
          <th style="text-align:center;padding:6px 6px;font-weight:600">Estado</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>
    </div>
    <div style="font-size:10px;color:#9ca3af;margin:8px 0 12px">Incluye facturas/bills y movimientos al contado vinculados. El pendiente es CxC (cliente) o CxP (proveedor).</div>

    <div class="app-dialog-buttons">
      <button class="app-dialog-btn primary" id="tercero-estado-close">Cerrar</button>
    </div>`;
}

/** Formulario único de alta/edición. El tipo solo se elige al crear. */
function abrirTerceroModal(tipo, id) {
  if (!puedeEditarTerceros()) return;
  const esEdicion = !!id;
  const item = esEdicion ? _terceros.find((t) => t.tipo === tipo && t.data.id === id) : null;
  if (esEdicion && !item) { showAlert('No se encontró el tercero'); return; }
  const d = item?.data || {};
  const tipoInicial = esEdicion ? tipo : (tipo === 'Proveedor' ? 'Proveedor' : 'Cliente');
  const val = (k) => escapeHtml(d[k] || '');
  const campo = 'width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px';
  const label = 'font-size:11px;color:#6b7280;display:block;margin-bottom:3px';
  const tiposId = ['', 'RUC', 'CEDULA', 'NT', 'PASAPORTE'].map((v) =>
    `<option value="${v}"${(d.taxIdType || '') === v ? ' selected' : ''}>${v === '' ? '— Sin clasificar —' : v === 'CEDULA' ? 'Cédula' : v === 'NT' ? 'Número Tributario (NT)' : v === 'PASAPORTE' ? 'Pasaporte' : 'RUC'}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.id = 'tercero-modal-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:720px;max-height:90vh;overflow-y:auto">
    <div style="font-weight:700;font-size:16px;margin-bottom:4px">${esEdicion ? '✏️ Editar' : '➕ Nuevo'} tercero</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:14px">El RUC, DV y la dirección se usan para facturar electrónicamente y para el Anexo DGI.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px">
      <div>
        <label style="${label}">Tipo *</label>
        ${esEdicion
          ? `<div style="padding:8px;border:1px solid #e5e7eb;border-radius:6px;background:#f9fafb;font-size:13px">${tipoInicial === 'Cliente' ? '👤 Cliente' : '🏭 Proveedor'}</div>`
          : `<select id="tercero-tipo" style="${campo}"><option value="Cliente"${tipoInicial === 'Cliente' ? ' selected' : ''}>👤 Cliente</option><option value="Proveedor"${tipoInicial === 'Proveedor' ? ' selected' : ''}>🏭 Proveedor</option></select>`}
      </div>
      <div>
        <label style="${label}">Nombre / Razón social *</label>
        <input id="tercero-name" maxlength="200" value="${val('name')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Nombre comercial</label>
        <input id="tercero-tradeName" maxlength="200" value="${val('tradeName')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">RUC / Cédula (sin DV)</label>
        <input id="tercero-taxId" maxlength="30" value="${val('taxId')}" placeholder="8-733-2267" style="${campo}">
      </div>
      <div>
        <label style="${label}">DV (dígito verificador)</label>
        <input id="tercero-dv" maxlength="2" value="${val('dv')}" placeholder="88" style="${campo}">
      </div>
      <div>
        <label style="${label}">Tipo de identificación</label>
        <select id="tercero-taxIdType" style="${campo}">${tiposId}</select>
      </div>
      <div>
        <label style="${label}">Teléfono</label>
        <input id="tercero-phone" maxlength="40" value="${val('phone')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Email</label>
        <input id="tercero-email" type="email" maxlength="120" value="${val('email')}" style="${campo}">
      </div>
      <div style="grid-column:1/-1">
        <label style="${label}">Dirección</label>
        <input id="tercero-address" maxlength="300" value="${val('address')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Ubicación DGI (PP-DD-CC)</label>
        <input id="tercero-location" maxlength="8" value="${val('location')}" placeholder="8-8-8" style="${campo}">
      </div>
      <div>
        <label style="${label}">Persona de contacto</label>
        <input id="tercero-contactName" maxlength="120" value="${val('contactName')}" style="${campo}">
      </div>
      <div>
        <label style="${label}">Plazo de pago (días, proveedores)</label>
        <input id="tercero-paymentTerms" maxlength="20" value="${val('paymentTerms') || '30'}" style="${campo}">
      </div>
      <div style="grid-column:1/-1">
        <label style="${label}">Notas</label>
        <textarea id="tercero-notes" rows="2" maxlength="500" style="${campo}">${escapeHtml(d.notes || '')}</textarea>
      </div>
    </div>
    <div class="app-dialog-buttons">
      <button class="app-dialog-btn secondary" id="tercero-cancel">Cancelar</button>
      <button class="app-dialog-btn primary" id="tercero-save">💾 Guardar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#tercero-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#tercero-save').onclick = () => guardarTercero(overlay, tipoInicial, id);
  setTimeout(() => document.getElementById('tercero-name')?.focus(), 0);
}

async function guardarTercero(overlay, tipoInicial, id) {
  const v = (field) => document.getElementById(field)?.value.trim() || '';
  const tipo = id ? tipoInicial : (document.getElementById('tercero-tipo')?.value || 'Cliente');
  const nombre = v('tercero-name');
  if (!nombre) { await showAlert('El nombre es obligatorio'); return; }
  const dv = v('tercero-dv');
  if (dv && !/^\d{1,2}$/.test(dv)) { await showAlert('El DV debe ser de 1 o 2 dígitos.'); return; }
  const location = v('tercero-location');
  if (location && !/^\d{1,2}-\d{1,2}-\d{1,2}$/.test(location)) {
    await showAlert('La ubicación debe tener el formato PP-DD-CC (ej. 8-8-8).');
    return;
  }
  const email = v('tercero-email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { await showAlert('El email no es válido.'); return; }

  const body = {
    name: nombre,
    taxId: v('tercero-taxId') || null,
    dv: dv || null,
    taxIdType: v('tercero-taxIdType') || null,
    phone: v('tercero-phone') || null,
    email: email || null,
    address: v('tercero-address') || null,
    location: location || null,
    tradeName: v('tercero-tradeName') || null,
    contactName: v('tercero-contactName') || null,
    notes: v('tercero-notes') || null,
  };
  if (tipo === 'Proveedor') body.paymentTerms = v('tercero-paymentTerms') || '30';

  const save = overlay.querySelector('#tercero-save');
  save.disabled = true;
  save.textContent = 'Guardando...';
  try {
    const url = `${API_URL}/${tipo === 'Cliente' ? 'clients' : 'suppliers'}${id ? '/' + encodeURIComponent(id) : ''}`;
    const res = await authFetch(url, {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      await showAlert(`❌ ${data.error || 'No se pudo guardar el tercero'}`);
      save.disabled = false;
      save.textContent = '💾 Guardar';
      return;
    }
    overlay.remove();
    await showAlert(`✅ ${tipo} ${id ? 'actualizado' : 'creado'}.`);
    loadTerceros();
  } catch (e) {
    await showAlert('Error de conexión');
    save.disabled = false;
    save.textContent = '💾 Guardar';
  }
}

async function eliminarTercero(tipo, id) {
  if (!puedeEditarTerceros()) return;
  const item = _terceros.find((t) => t.tipo === tipo && t.data.id === id);
  const nombre = item?.data?.name || 'este tercero';
  const ok = await showConfirm(`¿Eliminar ${tipo.toLowerCase()} "${nombre}"?\n\nSolo se puede si no tiene facturas, retenciones o cuentas de trabajador asociadas.`);
  if (!ok) return;
  try {
    const url = `${API_URL}/${tipo === 'Cliente' ? 'clients' : 'suppliers'}/${encodeURIComponent(id)}`;
    const res = await authFetch(url, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { await showAlert(`❌ ${data.error || 'No se pudo eliminar'}`); return; }
    await showAlert('✅ Tercero eliminado.');
    loadTerceros();
  } catch (e) { await showAlert('Error de conexión'); }
}
