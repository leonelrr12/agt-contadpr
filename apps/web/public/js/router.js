// router.js (5/14) — navegación sidebar y tabs de admin
/* ── Sidebar navigation ── */
document.querySelectorAll('#sidebar-nav .nav-link[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('#sidebar-nav .nav-link[data-view]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    // Helpers
    function hideAllPanels() {
      ['panel-recurring-content','panel-import-content',
       'panel-conciliacion-content','panel-taxcalendar-content','panel-salud-content','panel-whatsapp-content',
       'panel-auxiliares-content','panel-revision-content',
       'panel-informes-content','panel-admin-content','panel-facturas-content'].forEach(id => {
        const el = document.getElementById(id); if (el) el.classList.add('hidden');
      });
      const rp = document.getElementById('reports-panel');
      document.body.style.overflow = '';
    }

    if (view === 'chat') {
      hideAllPanels();
      document.getElementById('chat-header').classList.remove('hidden');
      document.getElementById('chat-messages').classList.remove('hidden');
      document.getElementById('input-area').classList.remove('hidden');
      return;
    }

    // Ocultar chat para cualquier panel que no sea chat
    document.getElementById('chat-header').classList.add('hidden');
    document.getElementById('chat-messages').classList.add('hidden');
    document.getElementById('input-area').classList.add('hidden');

    if (view === 'panel-recurring') { hideAllPanels(); loadPanelRecurring(); return; }
    if (view === 'panel-import') { hideAllPanels(); loadPanelImport(); return; }
    if (view === 'panel-conciliacion') { hideAllPanels(); loadPanelConciliacion(); return; }
    if (view === 'panel-taxcalendar') { hideAllPanels(); loadPanelTaxCalendar(); return; }
    if (view === 'panel-salud') { hideAllPanels(); loadPanelSalud(); return; }
    if (view === 'panel-auxiliares') { hideAllPanels(); loadPanelAuxiliares(); return; }
    if (view === 'panel-revision') { hideAllPanels(); loadPanelRevision(); return; }
    if (view === 'panel-informes') { hideAllPanels(); loadPanelInformes(); return; }
    if (view === 'panel-facturas') { hideAllPanels(); loadPanelFacturas(); return; }
    if (view === 'panel-whatsapp') { hideAllPanels(); loadPanelWhatsApp(); return; }

    // Admin panel — inline con tabs
    if (view === 'panel-admin') {
      hideAllPanels();
      document.getElementById('panel-admin-content').classList.remove('hidden');
      document.getElementById('cuentas-admin-content').classList.remove('hidden');
      document.getElementById('cuentas-admin-actions').classList.remove('hidden');
      clickAdminTab('cuentas-admin');
      return;
    }
  });
});

function clickAdminTab(panel) {
  document.querySelectorAll('#panel-tabs-admin button').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`#panel-tabs-admin button[data-panel="${panel}"]`);
  if (btn) btn.click();
}

// Admin panel tabs
document.querySelectorAll('#panel-tabs-admin button').forEach(btn => {
  btn.addEventListener('click', () => {
    const parentTabs = btn.closest('#panel-tabs-admin');
    parentTabs.querySelectorAll('button').forEach(b => { b.classList.remove('active'); b.style.color = '#6b7280'; b.style.borderBottomColor = 'transparent'; });
    btn.classList.add('active');
    btn.style.color = '#1a1a2e';
    btn.style.borderBottomColor = '#1565c0';
    // Mostrar/ocultar secciones
    const contentIds = {
      'cuentas-admin': ['cuentas-admin-content', 'cuentas-admin-actions', 'cuentas-admin-form'],
      'conceptos-admin': ['conceptos-admin-content', 'conceptos-admin-actions', 'conceptos-admin-form'],
      'config': ['config-content'],
      'cierres-admin': ['cierres-admin-content'],
    };
    // Ocultar todo
    document.querySelectorAll('#cuentas-admin-content, #cuentas-admin-actions, #cuentas-admin-form, #conceptos-admin-content, #conceptos-admin-actions, #conceptos-admin-form, #config-content, #cierres-admin-content').forEach(el => el.classList.add('hidden'));
    // Mostrar lo relevante
    const ids = contentIds[btn.dataset.panel] || [];
    ids.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); });
    // Cargar datos
    if (btn.dataset.panel === 'cuentas-admin') loadPanelCuentasAdmin();
    if (btn.dataset.panel === 'conceptos-admin') loadPanelConceptosAdmin();
    if (btn.dataset.panel === 'config') loadPanelConfig();
    if (btn.dataset.panel === 'cierres-admin') loadPanelCierresAdmin();
  });
});

