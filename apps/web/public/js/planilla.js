// planilla.js — Carga masiva de Planilla (nómina) dentro del panel Importar.
// Proceso independiente de las demás cargas: sin IA, un asiento BORRADOR por
// empleado (cuentas en Administración → Configuración → Planilla). Reutiliza
// la zona de arrastre y la tabla (#import-inline-*) del panel Importar.
// Depende de: import.js (importInlinePreview, resetImportInline), core.js.

/** Tipo de planilla elegido (Sueldo o Décimo III: son procesos aparte). */
function planillaTipoSeleccionado() {
  const sel = document.getElementById('import-inline-planilla-tipo');
  return sel ? (sel.value || 'SUELDO') : 'SUELDO';
}

function planillaTipoLabel() {
  const sel = document.getElementById('import-inline-planilla-tipo');
  return sel && sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : 'Planilla';
}

function planillaFmt(n) {
  return n ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

/** Sube el archivo de planilla al preview (validación completa, sin escribir). */
async function handlePlanillaFile(file) {
  document.getElementById('import-inline-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-loading-text').textContent = 'Analizando planilla...';

  const tipo = planillaTipoSeleccionado();
  const importDate = document.getElementById('import-inline-date').value;
  const formData = new FormData();
  formData.append('file', file);
  formData.append('tipo', tipo);
  if (importDate) formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/planilla/preview`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    if (!res.ok) {
      const e = await res.json();
      await showAlert(e.error || 'Error al procesar la planilla');
      resetImportInline();
      return;
    }
    importInlinePreview = await res.json();
    document.getElementById('import-inline-zone').classList.add('hidden');
    renderPlanillaPreview();
  } catch (e) {
    document.getElementById('import-inline-loading').classList.add('hidden');
    await showAlert('Error de conexión');
    resetImportInline();
  }
}

/**
 * Preview de la planilla: filas ok/omitida/error (patrón de cobros), tarjetas
 * de totales, contadores y avisos (cuentas sin configurar, errores fuera de
 * la muestra de 20).
 */
function renderPlanillaPreview() {
  const pp = importInlinePreview && importInlinePreview.planillaPreview;
  if (!pp) return;

  // Limpiar avisos/tarjetas de un render previo
  const prevWarn = document.getElementById('import-inline-warn');
  if (prevWarn) prevWarn.remove();
  const prevBankWarn = document.getElementById('import-inline-bank-warn');
  if (prevBankWarn) prevBankWarn.remove();
  const prevCards = document.getElementById('import-inline-planilla-cards');
  if (prevCards) prevCards.remove();

  document.getElementById('import-inline-summary').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.remove('hidden');

  const btnExecute = document.getElementById('import-inline-execute');
  btnExecute.textContent = `👷 Cargar planilla (${pp.ok})`;
  btnExecute.style.background = '#7c3aed';
  btnExecute.disabled = pp.ok === 0;
  btnExecute.title = pp.ok === 0
    ? 'No hay filas listas para cargar: revisa los errores del archivo y las cuentas de Configuración → Planilla'
    : '';

  // Contadores del archivo completo
  document.getElementById('import-inline-total').textContent = pp.total;
  document.getElementById('import-inline-ok').textContent = pp.ok;
  document.getElementById('import-inline-err').textContent = pp.errors.length;

  // Aviso de cuentas sin configurar (error típico del primer uso)
  if (pp.errors.some(e => /Configura la cuenta/i.test(e.error || ''))) {
    const warn = document.createElement('div');
    warn.id = 'import-inline-warn';
    warn.style.cssText = 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
    warn.innerHTML = '⚠️ Hay cuentas de planilla sin configurar. Defínelas en <strong>Administración → 👷 Planilla</strong> y vuelve a cargar el archivo.';
    document.getElementById('import-inline-summary').after(warn);
  } else {
    // Aviso de errores más allá de la muestra de 20 (patrón del import normal)
    const beyond = pp.errors.filter(x => x.row > 20);
    if (beyond.length > 0) {
      const warn = document.createElement('div');
      warn.id = 'import-inline-warn';
      warn.style.cssText = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
      warn.innerHTML = `⚠️ <strong>${beyond.length} fila(s) con error fuera de la vista</strong> (#${beyond.map(x => x.row).join(', #')}). Se omitirán al cargar.`;
      document.getElementById('import-inline-summary').after(warn);
    }
  }

  // Aviso si alguna fila no trae un banco reconocido (se usará el default)
  const bankAvisos = pp.rows.filter(r => r.bankAviso);
  if (bankAvisos.length > 0) {
    const warn = document.createElement('div');
    warn.id = 'import-inline-bank-warn';
    warn.style.cssText = 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
    warn.innerHTML = `🏦 ${bankAvisos.length} fila(s) con banco no reconocido en el archivo: se usará la cuenta por defecto (columna <strong>Banco</strong>). Ej.: ${escapeHtml(bankAvisos[0].bankAviso)}`;
    document.getElementById('import-inline-summary').after(warn);
  }

  // Tarjetas extra: neto a pagar, retenciones y omitidas
  const rowsOk = pp.rows.filter(r => r.status === 'ok');
  const totalNeto = rowsOk.reduce((s, r) => s + (r.neto || 0), 0);
  const totalRet = rowsOk.reduce((s, r) => s + (r.ss || 0) + (r.se || 0) + (r.isr || 0), 0);
  const cards = document.createElement('div');
  cards.id = 'import-inline-planilla-cards';
  cards.style.cssText = 'display:flex;gap:14px;margin-bottom:16px';
  let cardHtml =
    `<div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#7c3aed">${planillaFmt(totalNeto)}</div><div style="font-size:11px;color:#6b7280">Neto a pagar (muestra)</div></div>
     <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#b45309">${planillaFmt(totalRet)}</div><div style="font-size:11px;color:#6b7280">SS + SE + ISR (muestra)</div></div>`;
  if (pp.omitted > 0) {
    cardHtml += `<div class="summary-card" style="flex:1;background:#f8fafc;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#6b7280">↩️ ${pp.omitted}</div><div style="font-size:11px;color:#6b7280">Ya cargadas (se omiten)</div></div>`;
  }
  cards.innerHTML = cardHtml;
  document.getElementById('import-inline-summary').parentNode.insertBefore(
    cards, document.getElementById('import-inline-summary').nextSibling,
  );

  const thead = document.getElementById('import-inline-thead');
  thead.innerHTML = '<tr><th>#</th><th>Quincena</th><th>Nombre</th><th>Cédula</th><th>Sueldo</th><th>Extras</th><th>Décimo</th><th>SS</th><th>SE</th><th>ISR</th><th>Neto</th><th>Banco</th><th>Estado</th></tr>';

  let html = '';
  for (const r of pp.rows) {
    let bg = '';
    let estadoHtml = '';
    if (r.status === 'ok') {
      estadoHtml = '✅ Lista';
    } else if (r.status === 'omitida') {
      bg = 'style="background:#f8fafc"';
      estadoHtml = `<span style="color:#64748b;font-size:11px">↩️ ${escapeHtml(r.error || 'Ya cargada')}</span>`;
    } else {
      bg = 'style="background:#fef2f2"';
      estadoHtml = `<span style="color:#b91c1c;font-size:11px">❌ ${escapeHtml(r.error || 'Error')}</span>`;
    }
    // Cuenta de banco que se usará (columna Banco del archivo o el default)
    let bancoHtml = '—';
    if (r.bankAccount) {
      bancoHtml = `<span title="${escapeHtml(r.bankSource === 'archivo' ? 'Banco del archivo' : r.bankAviso || 'Banco por defecto')}">${escapeHtml(r.bankAccount.code)} — ${escapeHtml(r.bankAccount.name)}</span>`;
      if (r.bankAviso) bancoHtml += ' <span style="color:#b45309;cursor:help" title="' + escapeHtml(r.bankAviso) + '">⚠️</span>';
    }
    html += `<tr${bg}>
      <td>${r.row}</td><td>${r.quincenaFinal || '—'}</td><td>${escapeHtml(r.employee || '')}</td>
      <td>${escapeHtml(r.cedula || '')}</td>
      <td>${planillaFmt(r.salario)}</td><td>${planillaFmt(r.horasExtras)}</td><td>${planillaFmt(r.decimo)}</td>
      <td>${planillaFmt(r.ss)}</td><td>${planillaFmt(r.se)}</td><td>${planillaFmt(r.isr)}</td><td>${planillaFmt(r.neto)}</td>
      <td style="font-size:11px">${bancoHtml}</td>
      <td>${estadoHtml}</td></tr>`;
  }
  document.getElementById('import-inline-tbody').innerHTML = html;
}

/** Ejecuta la carga: confirmación → POST /execute-all → resumen final. */
async function executePlanillaInline() {
  const pp = importInlinePreview && importInlinePreview.planillaPreview;
  if (!pp) return;
  if (pp.ok === 0) {
    await showAlert('No hay filas listas para cargar. Revisa los errores y las cuentas de Configuración → Planilla.');
    return;
  }

  let msg = `¿Cargar la planilla (${planillaTipoLabel()}) de ${pp.ok} empleado(s)?\n\nSe creará un asiento BORRADOR por empleado (Sueldo/Extras/Décimo al Debe; SS, SE, ISR y Neto al Haber).`;
  if (pp.omitted > 0) {
    msg += `\n\n↩️ ${pp.omitted} fila(s) ya cargada(s) se omitirán — re-subir el archivo no duplica.`;
  }
  if (pp.errors.length > 0) {
    msg += `\n\n⚠️ ${pp.errors.length} fila(s) con error se omitirán:\n` +
      pp.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
      (pp.errors.length > 6 ? `\n… y ${pp.errors.length - 6} más.` : '');
  }
  const ok = await showConfirm(msg);
  if (!ok) return;

  const btnExecute = document.getElementById('import-inline-execute');
  btnExecute.disabled = true;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading-text').textContent = `Cargando planilla (${pp.ok} empleados)...`;

  const formData = new FormData();
  formData.append('file', importInlineFile);
  formData.append('tipo', planillaTipoSeleccionado());
  const importDate = document.getElementById('import-inline-date').value;
  if (importDate) formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/planilla/execute-all`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      let msg2 = `✅ Planilla cargada: ${result.success} de ${result.total} asiento(s) BORRADOR.`;
      if ((result.omitted || 0) > 0) {
        msg2 += `\n↩️ ${result.omitted} fila(s) ya cargada(s) se omitieron (no se duplicaron).`;
      }
      if (result.errors && result.errors.length) {
        msg2 += `\n\n❌ ${result.errors.length} fila(s) rechazadas:\n` +
          result.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
          (result.errors.length > 6 ? `\n… y ${result.errors.length - 6} más.` : '');
      }
      msg2 += '\n\nLos asientos quedan como BORRADOR para su revisión y confirmación.';
      await showAlert(msg2);
    } else {
      await showAlert(`❌ ${result.error || 'Error'}`);
    }
    resetImportInline();
  } catch (e) {
    document.getElementById('import-inline-loading').classList.add('hidden');
    await showAlert('Error de conexión');
    resetImportInline();
  }
}
