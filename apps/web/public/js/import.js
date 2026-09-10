// import.js (9/14) — importación masiva inline y conciliación
/* ── Panel: Importar (inline) ── */
let importInlineFile = null;
let importInlinePreview = null;

/* ── Tipo de importación: transacciones / pagos a facturas / planilla / honorarios ── */
function importMode() {
  const el = document.querySelector('input[name="import-inline-mode"]:checked');
  return el ? el.value : 'transacciones';
}

const IMPORT_MODE_HINTS = {
  transacciones: 'Sube el CSV/Excel con tus transacciones históricas. La IA clasificará cada concepto. En Gastos/Compras, la columna "Estado" (Contado/Crédito) define el pago: "Crédito" carga a Proveedores y exige Nº de factura; Contado/sin estado sale del banco indicado en la columna "Banco/Cuenta" (opcional) o del banco por defecto de Configuración.',
  cobros: 'Pagos/abonos a facturas: columnas Cliente, Fecha de Pago, Cuenta (banco), Factura # y TOTAL. Las filas SIN "Fecha de Pago" y "Cuenta" son facturas aún no pagadas: quedan ⏳ pendientes y se omiten. Puedes re-subir el mismo archivo: los pagos ya aplicados no se duplican (se omiten).',
  planilla: 'Planilla (nómina): columnas QUINCENA, NOMBRE, CEDULA, SUELDO, HORAS EXTRAS, DECIMO, SS, SE, ISR y TOPAL A PAGAR, con "Banco" opcional al final (si no, el banco por defecto de Configuración). Elige el Tipo (Sueldo o Décimo III: son procesos aparte) y configura las cuentas en Administración → Cargas. Un asiento BORRADOR por empleado; re-subir el mismo archivo no duplica.',
  honorarios: 'Honorarios Profesionales: columnas FECHA, RUC/CÉDULA, NOMBRE, DESCRIPCIÓN/CONCEPTO y MONTO (lo que sale del banco), con "Banco" opcional al final (si no, el banco por defecto de Configuración). Configura la cuenta del gasto en Administración → Cargas. Un asiento BORRADOR por pago; re-subir el mismo archivo no duplica.',
};

function applyImportModeUI() {
  const mode = importMode();
  const chipIds = { transacciones: 'import-mode-label-tx', carga: 'import-mode-label-carga', cobros: 'import-mode-label-cobros', planilla: 'import-mode-label-planilla', honorarios: 'import-mode-label-honorarios' };
  Object.entries(chipIds).forEach(([m, id]) => {
    const label = document.getElementById(id);
    if (!label) return;
    const active = m === mode;
    label.style.background = active ? '#fff' : 'transparent';
    label.style.boxShadow = active ? '0 1px 2px rgba(0,0,0,0.08)' : 'none';
    label.style.fontWeight = active ? '600' : '400';
  });
  const hint = document.getElementById('import-inline-mode-hint');
  if (hint) hint.textContent = IMPORT_MODE_HINTS[mode] || IMPORT_MODE_HINTS.transacciones;
  // La fecha global solo aplica a transacciones y carga inicial: los cobros
  // usan la columna "Fecha de Pago" del propio archivo.
  const isCobros = mode === 'cobros';
  const dateLabel = document.getElementById('import-inline-date-label');
  const dateInput = document.getElementById('import-inline-date');
  if (dateLabel) dateLabel.style.display = isCobros ? 'none' : 'inline';
  if (dateInput) dateInput.style.display = isCobros ? 'none' : 'inline-block';
  // El selector de tipo (Sueldo / Décimo III) solo existe en modo Planilla;
  // la fecha global se mantiene como respaldo si el archivo no trae QUINCENA.
  const tipoWrap = document.getElementById('import-inline-planilla-tipo-wrap');
  if (tipoWrap) tipoWrap.style.display = (mode === 'planilla') ? 'inline-flex' : 'none';
}

function loadPanelImport() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-import-content').classList.remove('hidden');
  // Inicializar fecha por defecto
  const dateInput = document.getElementById('import-inline-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
  // Cambiar el tipo de importación: re-procesar archivo si ya hay uno
  document.querySelectorAll('input[name="import-inline-mode"]').forEach(r => {
    r.onchange = () => {
      applyImportModeUI();
      if (importInlineFile) handleImportInlineFile(importInlineFile);
    };
  });
  applyImportModeUI();
  // Drag & drop + file input
  const zone = document.getElementById('import-inline-zone');
  const fileInput = document.getElementById('import-inline-file');
  zone.onclick = () => fileInput.click();
  zone.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  zone.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) handleImportInlineFile(f);
  };
  fileInput.onchange = e => {
    const f = e.target.files[0];
    if (f) handleImportInlineFile(f);
  };
}

async function handleImportInlineFile(file) {
  // Modo Planilla: flujo propio (js/planilla.js) — sin IA ni clasificación
  if (importMode() === 'planilla') { importInlineFile = file; return handlePlanillaFile(file); }
  // Modo Honorarios: flujo propio (js/honorarios.js) — sin IA ni clasificación
  if (importMode() === 'honorarios') { importInlineFile = file; return handleHonorariosFile(file); }
  importInlineFile = file;
  const mode = importMode();
  const isCobros = mode === 'cobros';
  document.getElementById('import-inline-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-loading-text').textContent = isCobros
    ? 'Analizando pagos a facturas...' : 'Analizando archivo...';

  const formData = new FormData();
  formData.append('file', file);
  if (isCobros) {
    formData.append('cobros', 'true');
  } else {
    // Misma fecha global que usa /execute-all: la preview valida la fecha igual que la ejecución
    const d = document.getElementById('import-inline-date').value;
    if (d) formData.append('importDate', d);
  }
  try {
    const res = await authFetch(`${API_URL}/import/preview`, { method: 'POST', body: formData });
    if (!res.ok) { const e = await res.json(); await showAlert(e.error || 'Error'); resetImportInline(); return; }
    importInlinePreview = await res.json();
    document.getElementById('import-inline-loading').classList.add('hidden');
    document.getElementById('import-inline-zone').classList.add('hidden');
    // ¿Archivo de pagos a facturas cargado en modo "Transacciones"?
    // El modo normal no mapea "Fecha de Pago" ni la cuenta/banco (usa la
    // fecha genérica y clasifica por concepto): cambiar SOLO al modo cobros
    // y reprocesar. El chip se mueve solo — si el usuario quería el modo
    // normal, un clic lo devuelve y se re-analiza el archivo.
    if (!isCobros && importInlinePreview.detectedCobrosFile) {
      const radio = document.querySelector('input[name="import-inline-mode"][value="cobros"]');
      if (radio) { radio.checked = true; applyImportModeUI(); }
      return handleImportInlineFile(file); // reprocesar en modo cobros
    }
    // ¿Archivo de HONORARIOS cargado en modo "Transacciones"? (conceptos que
    // dicen "honorarios"): en el modo normal la IA lo registra como gasto con
    // proveedor y se mezclaría con el Informe Por Proveedores. Cambiar SOLO al
    // chip ⚖️ Honorarios y reprocesar (un clic lo devuelve si no aplica).
    if (!isCobros && importInlinePreview.detectedHonorariosFile) {
      const radio = document.querySelector('input[name="import-inline-mode"][value="honorarios"]');
      if (radio) { radio.checked = true; applyImportModeUI(); }
      return handleImportInlineFile(file); // reprocesar en modo honorarios
    }
    renderImportInlinePreview();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

/** Etiqueta legible del método de pago derivado del Estado (columna "Pago"). */
function importPagoLabel(pm) {
  if (pm === 'CREDITO') return ['Crédito', '#b45309'];
  if (pm === 'EFECTIVO') return ['Efectivo', '#065f46'];
  if (pm === 'TRANSFERENCIA') return ['Transferencia', '#0369a1'];
  if (pm === 'CHEQUE') return ['Cheque', '#0369a1'];
  if (pm === 'TARJETA_CREDITO') return ['Tarjeta crédito', '#7c3aed'];
  if (pm === 'TARJETA_DEBITO') return ['Tarjeta débito', '#7c3aed'];
  return null;
}

function renderImportInlinePreview() {
  if (!importInlinePreview) return;
  // Preview de Planilla (nómina): render propio en js/planilla.js
  if (importInlinePreview.planilla === true) return renderPlanillaPreview();
  // Preview de Honorarios: render propio en js/honorarios.js
  if (importInlinePreview.honorarios === true) return renderHonorariosPreview();
  const isCobros = importInlinePreview.cobros === true;
  // Limpiar aviso de filas fuera de la muestra de un render previo
  const prevWarn = document.getElementById('import-inline-warn');
  if (prevWarn) prevWarn.remove();
  // Limpiar tarjetas extra de cobros de un render previo
  const prevCobrosCards = document.getElementById('import-inline-cobros-cards');
  if (prevCobrosCards) prevCobrosCards.remove();
  // Limpiar tarjetas de planilla de un render previo
  const prevPlanillaCards = document.getElementById('import-inline-planilla-cards');
  if (prevPlanillaCards) prevPlanillaCards.remove();
  // Limpiar tarjetas de honorarios de un render previo
  const prevHonorariosCards = document.getElementById('import-inline-honorarios-cards');
  if (prevHonorariosCards) prevHonorariosCards.remove();
  // Limpiar aviso de banco no reconocido (planilla/honorarios)
  const prevBankWarn = document.getElementById('import-inline-bank-warn');
  if (prevBankWarn) prevBankWarn.remove();

  document.getElementById('import-inline-summary').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.remove('hidden');

  const btnExecute = document.getElementById('import-inline-execute');
  if (isCobros) {
    btnExecute.textContent = '💰 Aplicar pagos';
    btnExecute.style.background = '#b45309';
    // Permite ejecutar igual que el import normal: las filas con error se
    // omiten y se reportan en el resumen final.
    btnExecute.disabled = false;
    btnExecute.title = '';
  } else {
    btnExecute.textContent = '✅ Importar transacciones';
    btnExecute.style.background = '#059669';
    btnExecute.disabled = false;
    btnExecute.title = '';
  }

  if (isCobros && importInlinePreview.cobrosPreview) {
    renderImportCobrosPreview();
  } else {
    const { totalRows, previewRows, invalidRows = [] } = importInlinePreview;
    // El server valida TODAS las filas del archivo (invalidRows), no solo las
    // 20 visibles: los contadores reflejan el archivo completo.
    document.getElementById('import-inline-total').textContent = totalRows;
    document.getElementById('import-inline-ok').textContent = Math.max(0, totalRows - invalidRows.length);
    document.getElementById('import-inline-err').textContent = invalidRows.length;

    // Aviso si hay incompletas más allá de la muestra de 20
    const beyond = invalidRows.filter(x => x.row > 20);
    if (beyond.length > 0) {
      const warn = document.createElement('div');
      warn.id = 'import-inline-warn';
      warn.style.cssText = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
      warn.innerHTML = `⚠️ <strong>${beyond.length} fila(s) incompleta(s) fuera de la vista</strong> (#${beyond.map(x => x.row).join(', #')}): faltan datos obligatorios. Corrígelas en el archivo y vuelve a cargarlo.`;
      document.getElementById('import-inline-summary').after(warn);
    }

    const thead = document.getElementById('import-inline-thead');
    thead.innerHTML = '<tr><th>#</th><th>Fecha</th><th>Descripción</th><th>Monto</th><th>Pago</th><th>Ref</th><th>RUC</th><th>Concepto</th><th>Cuenta</th><th>Conf</th><th></th></tr>';
    let html = '';
    previewRows.forEach((r, i) => {
      const conf = r.classification;
      const faltantes = r.missing || [];
      const rowCls = faltantes.length ? ' style="background:#fef2f2"' : '';
      // Monto mostrado = neto + ITBMS (lo que realmente se paga)
      let montoHtml = '—';
      if (r.amount) {
        const total = r.amount + (r.itbms || 0);
        montoHtml = `$${total.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}${r.itbms ? ` <span style="color:#9ca3af;font-size:10px">(neto $${r.amount.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} + ITBMS $${r.itbms.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})})</span>` : ''}`;
      }
      // Pago derivado del Estado (Contado/Crédito) o del método detectado
      const pagoLbl = importPagoLabel(r.paymentMethod);
      let pagoHtml = '—';
      if (pagoLbl) {
        pagoHtml = `<span style="color:${pagoLbl[1]};font-size:11px;font-weight:600">${pagoLbl[0]}</span>`;
      } else if (r.type === 'GASTO' || r.type === 'COMPRA') {
        pagoHtml = '<span style="color:#059669;font-size:11px;font-weight:600" title="Al contado: sale del banco indicado en la columna Banco/Cuenta o del banco por defecto">Contado (banco)</span>';
      }
      html += `<tr${rowCls}>
        <td>${i+1}</td><td>${r.date||'—'}</td><td>${escapeHtml(r.description||'')}</td>
        <td>${montoHtml}</td>
        <td>${pagoHtml}</td>
        <td>${escapeHtml(r.reference||'')}</td><td>${escapeHtml(r.ruc||'')}</td>
        <td>${escapeHtml(r.concept||'')}</td>
        <td>${conf?escapeHtml(conf.concept):'—'}</td>
        <td>${conf?Math.round(conf.confidence*100)+'%':'—'}</td>
        <td>${faltantes.length ? `<span style="color:#dc2626;font-size:11px">Falta: ${faltantes.join(', ')}</span>` : ''}</td></tr>`;
    });
    document.getElementById('import-inline-tbody').innerHTML = html;
  }
}

/* ── Preview de "Pagos a facturas" (cobros) ──
 * Estados por fila: ok (a aplicar) · pending (⏳ sin Fecha de Pago/Cuenta =
 * factura aún no pagada, se omite) · omitted (↩️ ya aplicada en BD, se omite,
 * re-subida idempotente) · error (se omite y se reporta).
 */
function renderImportCobrosPreview() {
  const cp = importInlinePreview.cobrosPreview;
  const { rows, errors, pending = 0, omitted = 0, appliedTotal, markedPaid } = cp;
  const totalRows = importInlinePreview.totalRows;
  const okCount = cp.success || 0; // filas a aplicar (status ok)

  document.getElementById('import-inline-total').textContent = totalRows;
  document.getElementById('import-inline-ok').textContent = okCount;
  document.getElementById('import-inline-err').textContent = errors.length;

  // Tarjetas extra: total abonado, saldadas, pendientes y ya aplicadas
  const summaryEl = document.getElementById('import-inline-summary');
  const cards = document.createElement('div');
  cards.id = 'import-inline-cobros-cards';
  cards.style.cssText = 'display:flex;gap:14px;margin-bottom:16px';
  let cardHtml =
    `<div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#b45309">$${appliedTotal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div style="font-size:11px;color:#6b7280">Total a abonar</div></div>
     <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#059669">${markedPaid}</div><div style="font-size:11px;color:#6b7280">Facturas que quedan pagadas</div></div>`;
  if (pending > 0) {
    cardHtml += `<div class="summary-card" style="flex:1;background:#f8fafc;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#64748b">⏳ ${pending}</div><div style="font-size:11px;color:#6b7280">Facturas sin pago (pendientes)</div></div>`;
  }
  if (omitted > 0) {
    cardHtml += `<div class="summary-card" style="flex:1;background:#f8fafc;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#6b7280">↩️ ${omitted}</div><div style="font-size:11px;color:#6b7280">Ya aplicadas (se omiten)</div></div>`;
  }
  cards.innerHTML = cardHtml;
  summaryEl.parentNode.insertBefore(cards, summaryEl.nextSibling);

  // Aviso de errores más allá de la muestra de 20 (igual que el import normal)
  const beyond = errors.filter(x => x.row > 20);
  if (beyond.length > 0) {
    const warn = document.createElement('div');
    warn.id = 'import-inline-warn';
    warn.style.cssText = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
    warn.innerHTML = `⚠️ <strong>${beyond.length} fila(s) con error fuera de la vista</strong> (#${beyond.map(x => x.row).join(', #')}). Se omitirán al aplicar.`;
    document.getElementById('import-inline-summary').after(warn);
  }

  const thead = document.getElementById('import-inline-thead');
  thead.innerHTML = '<tr><th>#</th><th>Nº Factura</th><th>Cliente</th><th>Fecha pago</th><th>Abono</th><th>Cuenta</th><th>Saldo anterior</th><th>Saldo posterior</th><th>Estado</th></tr>';

  const fmt = n => (n != null ? `$${Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}` : '—');
  let html = '';
  rows.forEach(r => {
    const numCell = r.number
      ? `${escapeHtml(r.number)}${r.viaDigits ? ' <span title="Coincidió por dígitos (p.ej. 1003 = A-001003)" style="color:#d97706;cursor:help">≈</span>' : ''}`
      : (r.fileNumber ? `<span style="color:#9ca3af">${escapeHtml(r.fileNumber)}</span>` : '—');
    const clientCell = r.clientMatched || r.clientFile || '—';

    let bg = '';
    let estadoHtml = '';
    let dateHtml = r.date || '—';
    let amountHtml = r.amount != null ? `<span style="color:#9ca3af">${fmt(r.amount)}</span>` : '—';
    let accountHtml = '—';
    let saldoHtml = '—';

    if (r.status === 'ok') {
      amountHtml = `<strong>${fmt(r.amount)}</strong>`;
      if (r.accountCode) {
        accountHtml = `<span style="color:#065f46">${escapeHtml(r.accountName||'')}</span> <span style="color:#9ca3af;font-size:10px">(${escapeHtml(r.accountCode)})</span>`;
      }
      estadoHtml = r.paid ? '✅ <strong>PAGADA</strong>' : '✅ Abono';
      if (r.retencionItbms > 0) {
        estadoHtml += ` <span style="font-size:10px;color:#1565c0;background:#eff6ff;padding:1px 6px;border-radius:8px">🔖 ret. ${fmt(r.retencionItbms)}${r.retencionAuto ? ' (auto)' : ''}</span>`;
      }
      saldoHtml = `${fmt(r.saldoBefore)} → ${fmt(r.saldoAfter)}`;
    } else if (r.status === 'pending') {
      bg = 'style="background:#f8fafc"';
      estadoHtml = '<span style="color:#64748b;font-size:11px">⏳ Sin pago — pendiente</span>';
    } else if (r.status === 'omitted') {
      bg = 'style="background:#f8fafc"';
      accountHtml = r.accountName ? `<span style="color:#9ca3af">${escapeHtml(r.accountName)}</span>` : '—';
      estadoHtml = `<span style="color:#64748b;font-size:11px">↩️ ${escapeHtml(r.error || 'Ya aplicada')}</span>`;
    } else {
      bg = 'style="background:#fef2f2"';
      if (r.accountName) accountHtml = `<span style="color:#9ca3af">${escapeHtml(r.accountName)}</span>`;
      estadoHtml = `<span style="color:#b91c1c;font-size:11px">❌ ${escapeHtml(r.error || '')}</span>`;
    }

    html += `<tr${bg}>
      <td>${r.row}</td><td>${numCell}</td><td>${escapeHtml(clientCell)}</td>
      <td>${dateHtml}</td><td>${amountHtml}</td><td>${accountHtml}</td>
      <td colspan="2" style="color:#9ca3af">${saldoHtml}</td>
      <td>${estadoHtml}</td></tr>`;
  });
  document.getElementById('import-inline-tbody').innerHTML = html;
}

async function executeImportInline() {
  if (!importInlineFile) return;
  // Carga de Planilla (nómina): ejecución propia en js/planilla.js
  if (importInlinePreview && importInlinePreview.planilla === true) return executePlanillaInline();
  // Carga de Honorarios: ejecución propia en js/honorarios.js
  if (importInlinePreview && importInlinePreview.honorarios === true) return executeHonorariosInline();
  const isCobros = importInlinePreview.cobros === true;
  const total = importInlinePreview.totalRows;
  const importDate = document.getElementById('import-inline-date').value;
  const dateLabel = new Date(importDate+'T12:00:00').toLocaleDateString('es-PA',{year:'numeric',month:'long',day:'numeric'});

  // ── Flujo cobros / pagos a facturas ──
  if (isCobros) {
    const cp = importInlinePreview.cobrosPreview || {};
    const okCount = cp.success || 0;
    let msg = `¿Aplicar ${okCount} pago(s) a facturas?`;
    if ((cp.pending || 0) > 0) {
      msg += `\n\n⏳ ${cp.pending} factura(s) sin "Fecha de Pago"/"Cuenta" quedan pendientes (aún no pagadas) y no se tocan.`;
    }
    if ((cp.omitted || 0) > 0) {
      msg += `\n\n↩️ ${cp.omitted} abono(s) ya aplicado(s) se omitirán — re-subir el archivo no duplica pagos.`;
    }
    if ((cp.clientesAutoMarcados || 0) > 0) {
      msg += `\n\n🔖 ${cp.clientesAutoMarcados} cliente(s) sin perfil se marcarán automáticamente como agente de retención (evidencia del cobro). Puedes ajustarlo luego en su ficha.`;
    }
    msg += `\n\nCada pago crea un asiento BORRADOR (débito banco/caja, crédito Clientes) y descuenta del saldo de la factura. Los abonos parciales quedan registrados.`;
    if (cp.errors && cp.errors.length > 0) {
      msg += `\n\n⚠️ ${cp.errors.length} fila(s) con error se omitirán:\n` +
        cp.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
        (cp.errors.length > 6 ? `\n… y ${cp.errors.length - 6} más.` : '');
    }
    const ok = await showConfirm(msg);
    if (!ok) return;

    document.getElementById('import-inline-loading').classList.remove('hidden');
    document.getElementById('import-inline-actions').classList.add('hidden');
    document.getElementById('import-inline-loading-text').textContent = `Aplicando ${okCount} pagos...`;

    const formData = new FormData();
    formData.append('file', importInlineFile);
    try {
      const res = await authFetch(`${API_URL}/import/cobros/execute-all`, { method: 'POST', body: formData });
      document.getElementById('import-inline-loading').classList.add('hidden');
      const result = await res.json();
      if (res.ok) {
        let msg2 = `✅ Pagos aplicados: ${result.success} de ${result.total} candidatos.\n\n💰 ${result.markedPaid || 0} factura(s) quedaron pagadas en su totalidad.`;
        if ((result.pending || 0) > 0) {
          msg2 += `\n\n⏳ ${result.pending} factura(s) quedaron pendientes (sin "Fecha de Pago"/"Cuenta").`;
        }
        if ((result.omitted || 0) > 0) {
          msg2 += `\n↩️ ${result.omitted} fila(s) ya aplicada(s) se omitieron (no se duplicaron).`;
        if ((result.clientesAutoMarcados || 0) > 0) {
          msg2 += `\n🔖 ${result.clientesAutoMarcados} cliente(s) marcados como agente de retención (revisa su ficha si no aplica).`;
        }
        }
        if (result.errors && result.errors.length) {
          msg2 += `\n\n❌ ${result.errors.length} fila(s) rechazadas:\n` +
            result.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
            (result.errors.length > 6 ? `\n… y ${result.errors.length - 6} más.` : '');
        }
        await showAlert(msg2);
      } else {
        await showAlert(`❌ ${result.error || 'Error'}`);
      }
      resetImportInline();
    } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
    return;
  }

  // ── Flujo normal ──
  const ok = await showConfirm(`¿Importar ${total} transacciones?\n\n📅 Fecha: ${dateLabel}\n\n⚠️ Verifica la fecha. Los asientos se crearán como BORRADOR.`);
  if (!ok) return;

  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading-text').textContent = `Importando ${total} transacciones...`;

  const formData = new FormData();
  formData.append('file', importInlineFile);
  formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/import/execute-all`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      let msg = `✅ Importación completada: ${result.success} de ${result.total} exitosas.`;
      if (result.errors && result.errors.length) {
        msg += `\n\n❌ ${result.errors.length} fila(s) rechazadas:\n` +
          result.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
          (result.errors.length > 6 ? `\n… y ${result.errors.length - 6} más.` : '');
      }
      await showAlert(msg);
    } else {
      await showAlert(`❌ ${result.error || 'Error'}`);
    }
    resetImportInline();
  } catch (e) { await showAlert('Error de conexión'); resetImportInline(); }
}

function resetImportInline() {
  importInlineFile = null;
  importInlinePreview = null;
  document.getElementById('import-inline-file').value = '';
  document.getElementById('import-inline-file-name').textContent = '';
  document.getElementById('import-inline-zone').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.add('hidden');
  document.getElementById('import-inline-summary').classList.add('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading').classList.add('hidden');
  // Limpiar tarjetas extra de cobros si existen
  const cobrosCards = document.getElementById('import-inline-cobros-cards');
  if (cobrosCards) cobrosCards.remove();
  // Limpiar tarjetas de planilla si existen
  const planillaCards = document.getElementById('import-inline-planilla-cards');
  if (planillaCards) planillaCards.remove();
  // Limpiar tarjetas de honorarios si existen
  const honorariosCards = document.getElementById('import-inline-honorarios-cards');
  if (honorariosCards) honorariosCards.remove();
  // Limpiar aviso de banco no reconocido si existe
  const bankWarn = document.getElementById('import-inline-bank-warn');
  if (bankWarn) bankWarn.remove();
  // Resetear botón y modo de importación
  const btn = document.getElementById('import-inline-execute');
  btn.textContent = '✅ Importar transacciones';
  btn.style.background = '#059669';
  btn.disabled = false;
  const txRadio = document.querySelector('input[name="import-inline-mode"][value="transacciones"]');
  if (txRadio) { txRadio.checked = true; applyImportModeUI(); }
}

/* ── Panel: Conciliación (inline) ── */
function loadPanelConciliacion() {
  document.getElementById('chat-messages').classList.add('hidden');
  document.getElementById('input-area').classList.add('hidden');
  document.getElementById('panel-conciliacion-content').classList.remove('hidden');
  loadConciliacionList();
}

async function loadConciliacionList() {
  const el = document.getElementById('conciliacion-inline-list');
  try {
    const res = await authFetch(`${API_URL}/reconcile`);
    if (!res.ok) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; return; }
    const statements = await res.json();
    if (!statements.length) {
      el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">No hay extractos bancarios. Sube uno para comenzar.</div>';
      return;
    }
    let html = '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Archivo</th><th>Fecha subida</th><th>Estado</th><th>Filas</th><th></th></tr></thead><tbody>';
    for (const s of statements) {
      html += `<tr>
        <td><strong>${escapeHtml(s.fileName||'Extracto')}</strong></td>
        <td>${new Date(s.uploadDate).toLocaleDateString('es-PA')}</td>
        <td>${s.status}</td>
        <td>${s._count?.rows||'—'}</td>
        <td><button class="btn-sm" onclick="window.open('/conciliacion.html','_blank')">🔍 Abrir</button></td>
      </tr>`;
    }
    el.innerHTML = html + '</tbody></table>';
  } catch (e) { el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar</div>'; }
}

function showConciliacionUpload() {
  const el = document.getElementById('conciliacion-inline-upload');
  el.classList.remove('hidden');
  const fileInput = document.getElementById('conciliacion-inline-file');
  el.onclick = () => fileInput.click();
  el.ondragover = e => { e.preventDefault(); e.stopPropagation(); };
  el.ondrop = e => {
    e.preventDefault(); e.stopPropagation();
    const f = e.dataTransfer.files[0];
    if (f) uploadConciliacionFile(f);
  };
  fileInput.onchange = e => { const f = e.target.files[0]; if (f) uploadConciliacionFile(f); };
}

async function uploadConciliacionFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await authFetch(`${API_URL}/reconcile/upload`, { method: 'POST', body: formData });
    if (res.ok) { await showAlert('✅ Extracto subido. Redirigiendo a conciliación...'); window.open('/conciliacion.html','_blank'); }
    else { const e = await res.json(); await showAlert(e.error || 'Error al subir'); }
  } catch (e) { await showAlert('Error de conexión'); }
  document.getElementById('conciliacion-inline-upload').classList.add('hidden');
  loadConciliacionList();
}

