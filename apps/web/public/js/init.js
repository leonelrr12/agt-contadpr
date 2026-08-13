// init.js (8/14) — export, logout y bootstrap DOMContentLoaded
/* ── Exportar reportes ── */
async function exportReport(reportType, format = 'xlsx') {
  const from = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-from`);
  const to = document.getElementById(`filter-${reportType === 'diario' ? 'diario' : reportType === 'balance-comprobacion' ? 'balance' : 'resultados'}-to`);
  const statusEl = document.getElementById('filter-diario-status');

  let url = `${API_URL}/reports/export/${reportType}?format=${format}`;
  if (from && from.value) url += `&startDate=${from.value}`;
  if (to && to.value) url += `&endDate=${to.value}`;
  if (statusEl && reportType === 'diario' && statusEl.value) url += `&status=${statusEl.value}`;

  try {
    const res = await authFetch(url);
    if (!res.ok) {
      const err = await res.json();
      await showAlert('Error al exportar: ' + (err.error || 'Error desconocido'));
      return;
    }
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="?(.+?)"?$/);
    a.download = filenameMatch ? filenameMatch[1] : `${reportType}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
  } catch (e) {
    await showAlert('Error de conexión al exportar');
  }
}

async function logout() {
  if (!await showConfirm('¿Cerrar sesión? Se perderá cualquier transacción no guardada.')) return;
  localStorage.removeItem('agt_token');
  localStorage.removeItem('agt_user');
  window.location.href = '/login.html';
}

document.addEventListener('DOMContentLoaded', () => {
  // Mostrar info del usuario
  const user = getUser();
  if (user) {
    document.getElementById('sidebar-user-name').textContent = user.name;
    document.getElementById('sidebar-user-company').textContent = user.company?.name || '';

    // Mostrar admin solo a admins y contadores
    if (user.role === 'admin' || user.role === 'contador') {
      document.getElementById('nav-admin-link').style.display = 'block';
    }
    // SaaS Admin solo para admin
    if (user.role === 'admin') {
      document.getElementById('nav-saas-link').style.display = 'block';
    }
  }

  // Cargar info de suscripción
  loadSubscriptionInfo();

  addMessage('¡Buenos días! Soy tu agente contable. ¿Qué deseas registrar hoy?', 'assistant');
  addMessage('Puedes escribir algo como:\n• "Compré combustible por $40 con tarjeta"\n• "Vendí $250 en efectivo"\n• "Pagué la electricidad"\n• "Compra de mercancía por $100 con ITBMS a Distribuidora XYZ, crédito"\n• "Vendí $200 en efectivo con ITBMS"\n• "Pago de ITBMS por $150"', 'assistant');

  // Cargar cuentas para el selector del Auxiliar
  loadAuxiliarAccounts();

  // ── Inicializar date picker persistente ──
  const datePicker = document.getElementById('capture-date-picker');
  if (datePicker) {
    datePicker.value = captureDate;
    datePicker.addEventListener('change', () => {
      captureDate = datePicker.value;
      dateBannerShown = false; // re-mostrar banner si el usuario cambia la fecha
      // Actualizar también la fecha en el banner si está visible
      const bannerDate = document.getElementById('capture-date-banner-date');
      if (bannerDate) bannerDate.textContent = formatDateForDisplay(captureDate);
    });
  }
});

