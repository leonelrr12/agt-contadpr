// honorarios.js — Carga masiva de Honorarios Profesionales en el panel Importar.
// Proceso independiente: sin IA, un asiento BORRADOR por pago (Honorarios
// Profesionales al Debe vs Banco — cuentas en Administración → Honorarios).
// Reutiliza la zona de arrastre y la tabla (#import-inline-*) del panel.
// Depende de: import.js (importInlinePreview, resetImportInline), core.js.

function honorariosFmt(n) {
  return n ? `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

/** Sube el archivo de honorarios al preview (validación completa, sin escribir). */
async function handleHonorariosFile(file) {
  document.getElementById('import-inline-file-name').textContent = `📎 ${file.name}`;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-loading-text').textContent = 'Analizando honorarios...';

  const importDate = document.getElementById('import-inline-date').value;
  const formData = new FormData();
  formData.append('file', file);
  if (importDate) formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/honorarios/preview`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    if (!res.ok) {
      const e = await res.json();
      await showAlert(e.error || 'Error al procesar los honorarios');
      resetImportInline();
      return;
    }
    importInlinePreview = await res.json();
    document.getElementById('import-inline-zone').classList.add('hidden');
    renderHonorariosPreview();
  } catch (e) {
    document.getElementById('import-inline-loading').classList.add('hidden');
    await showAlert('Error de conexión');
    resetImportInline();
  }
}

/**
 * Preview de honorarios: filas ok/omitida/error (patrón de planilla), tarjetas
 * de totales, contadores y avisos (cuentas sin configurar, errores fuera de
 * la muestra de 20).
 */
function renderHonorariosPreview() {
  const hp = importInlinePreview && importInlinePreview.honorariosPreview;
  if (!hp) return;

  const prevWarn = document.getElementById('import-inline-warn');
  if (prevWarn) prevWarn.remove();
  const prevCards = document.getElementById('import-inline-honorarios-cards');
  if (prevCards) prevCards.remove();

  document.getElementById('import-inline-summary').classList.remove('hidden');
  document.getElementById('import-inline-preview').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.remove('hidden');

  const btnExecute = document.getElementById('import-inline-execute');
  btnExecute.textContent = `⚖️ Cargar honorarios (${hp.ok})`;
  btnExecute.style.background = '#0e7490';
  btnExecute.disabled = hp.ok === 0;
  btnExecute.title = hp.ok === 0
    ? 'No hay filas listas para cargar: revisa los errores del archivo y las cuentas de Configuración → Honorarios'
    : '';

  document.getElementById('import-inline-total').textContent = hp.total;
  document.getElementById('import-inline-ok').textContent = hp.ok;
  document.getElementById('import-inline-err').textContent = hp.errors.length;

  if (hp.errors.some(e => /Configura la cuenta/i.test(e.error || ''))) {
    const warn = document.createElement('div');
    warn.id = 'import-inline-warn';
    warn.style.cssText = 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
    warn.innerHTML = '⚠️ Hay cuentas de honorarios sin configurar. Defínelas en <strong>Administración → ⚖️ Honorarios</strong> y vuelve a cargar el archivo.';
    document.getElementById('import-inline-summary').after(warn);
  } else if ((importInlinePreview.repairCount || 0) > 0) {
    // CSV con coma como separador Y coma decimal: se repararon las filas, pero
    // conviene avisar (nombres con comas pueden haberse desalineado).
    const warn = document.createElement('div');
    warn.id = 'import-inline-warn';
    warn.style.cssText = 'background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
    warn.innerHTML = `⚠️ ${importInlinePreview.repairCount} fila(s) tenían montos con coma decimal (formato "400,00") y se interpretaron automáticamente. <strong>Revisa que las columnas coincidan</strong>: si algún nombre lleva comas, exporta el CSV con punto y coma (;) como separador.`;
    document.getElementById('import-inline-summary').after(warn);
  } else {
    const beyond = hp.errors.filter(x => x.row > 20);
    if (beyond.length > 0) {
      const warn = document.createElement('div');
      warn.id = 'import-inline-warn';
      warn.style.cssText = 'background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;font-size:12px;margin-bottom:12px';
      warn.innerHTML = `⚠️ <strong>${beyond.length} fila(s) con error fuera de la vista</strong> (#${beyond.map(x => x.row).join(', #')}). Se omitirán al cargar.`;
      document.getElementById('import-inline-summary').after(warn);
    }
  }

  // Tarjetas extra: total a pagar y omitidas
  const rowsOk = hp.rows.filter(r => r.status === 'ok');
  const totalPagar = rowsOk.reduce((s, r) => s + (r.monto || 0), 0);
  const profesionales = new Set(rowsOk.map(r => `${r.taxId}|${(r.nombre || '').toLowerCase()}`)).size;
  const cards = document.createElement('div');
  cards.id = 'import-inline-honorarios-cards';
  cards.style.cssText = 'display:flex;gap:14px;margin-bottom:16px';
  let cardHtml =
    `<div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#0e7490">${honorariosFmt(totalPagar)}</div><div style="font-size:11px;color:#6b7280">Total a pagar (muestra)</div></div>
     <div class="summary-card" style="flex:1;background:#fff;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700">${profesionales}</div><div style="font-size:11px;color:#6b7280">Profesionales (muestra)</div></div>`;
  if (hp.omitted > 0) {
    cardHtml += `<div class="summary-card" style="flex:1;background:#f8fafc;border-radius:8px;padding:12px;text-align:center;box-shadow:0 1px 2px rgba(0,0,0,0.06)"><div style="font-size:20px;font-weight:700;color:#6b7280">↩️ ${hp.omitted}</div><div style="font-size:11px;color:#6b7280">Ya cargados (se omiten)</div></div>`;
  }
  cards.innerHTML = cardHtml;
  document.getElementById('import-inline-summary').parentNode.insertBefore(
    cards, document.getElementById('import-inline-summary').nextSibling,
  );

  const thead = document.getElementById('import-inline-thead');
  thead.innerHTML = '<tr><th>#</th><th>Fecha</th><th>Profesional</th><th>RUC/Cédula</th><th>Concepto</th><th>Monto</th><th>Estado</th></tr>';

  let html = '';
  for (const r of hp.rows) {
    let bg = '';
    let estadoHtml = '';
    if (r.status === 'ok') {
      estadoHtml = '✅ Lista';
    } else if (r.status === 'omitida') {
      bg = 'style="background:#f8fafc"';
      estadoHtml = `<span style="color:#64748b;font-size:11px">↩️ ${escapeHtml(r.error || 'Ya cargado')}</span>`;
    } else {
      bg = 'style="background:#fef2f2"';
      estadoHtml = `<span style="color:#b91c1c;font-size:11px">❌ ${escapeHtml(r.error || 'Error')}</span>`;
    }
    html += `<tr${bg}>
      <td>${r.row}</td><td>${r.fechaFinal || '—'}</td><td>${escapeHtml(r.nombre || '')}</td>
      <td>${escapeHtml(r.taxId || '')}</td><td>${escapeHtml(r.concepto || '')}</td>
      <td>${honorariosFmt(r.monto)}</td>
      <td>${estadoHtml}</td></tr>`;
  }
  document.getElementById('import-inline-tbody').innerHTML = html;
}

/** Ejecuta la carga: confirmación → POST /execute-all → resumen final. */
async function executeHonorariosInline() {
  const hp = importInlinePreview && importInlinePreview.honorariosPreview;
  if (!hp) return;
  if (hp.ok === 0) {
    await showAlert('No hay filas listas para cargar. Revisa los errores y las cuentas de Configuración → Honorarios.');
    return;
  }

  let msg = `¿Cargar ${hp.ok} pago(s) de honorarios?\n\nSe creará un asiento BORRADOR por pago: Honorarios Profesionales al Debe vs Banco al Haber.`;
  if (hp.omitted > 0) {
    msg += `\n\n↩️ ${hp.omitted} fila(s) ya cargada(s) se omitirán — re-subir el archivo no duplica.`;
  }
  if (hp.errors.length > 0) {
    msg += `\n\n⚠️ ${hp.errors.length} fila(s) con error se omitirán:\n` +
      hp.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
      (hp.errors.length > 6 ? `\n… y ${hp.errors.length - 6} más.` : '');
  }
  const ok = await showConfirm(msg);
  if (!ok) return;

  const btnExecute = document.getElementById('import-inline-execute');
  btnExecute.disabled = true;
  document.getElementById('import-inline-loading').classList.remove('hidden');
  document.getElementById('import-inline-actions').classList.add('hidden');
  document.getElementById('import-inline-loading-text').textContent = `Cargando honorarios (${hp.ok} pagos)...`;

  const formData = new FormData();
  formData.append('file', importInlineFile);
  const importDate = document.getElementById('import-inline-date').value;
  if (importDate) formData.append('importDate', importDate);

  try {
    const res = await authFetch(`${API_URL}/honorarios/execute-all`, { method: 'POST', body: formData });
    document.getElementById('import-inline-loading').classList.add('hidden');
    const result = await res.json();
    if (res.ok) {
      let msg2 = `✅ Honorarios cargados: ${result.success} de ${result.total} asiento(s) BORRADOR.`;
      if ((result.omitted || 0) > 0) {
        msg2 += `\n↩️ ${result.omitted} fila(s) ya cargada(s) se omitieron (no se duplicaron).`;
      }
      if (result.errors && result.errors.length) {
        msg2 += `\n\n❌ ${result.errors.length} fila(s) rechazadas:\n` +
          result.errors.slice(0, 6).map(e => `• Fila ${e.row}: ${e.error}`).join('\n') +
          (result.errors.length > 6 ? `\n… y ${result.errors.length - 6} más.` : '');
      }
      msg2 += '\n\nLos asientos quedan como BORRADOR para su revisión. El informe por RUC/Cédula está en Informes → ⚖️ Honorarios.';
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
