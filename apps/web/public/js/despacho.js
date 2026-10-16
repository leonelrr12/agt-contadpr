// despacho.js — «Mis empresas»: qué está pendiente en cada empresa del usuario.
//
// Una tarjeta por empresa con lo que pide atención hoy —borradores por revisar,
// el buzón con problemas, por cobrar vencido, obligaciones fiscales y la cuota—
// y un botón para entrar. El cambio de empresa reusa `cambiarEmpresa()` de
// init.js: mismo camino que el desplegable del sidebar.

async function loadPanelDespacho() {
  const el = document.getElementById('panel-despacho-content');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:40px;color:#6b7280">Cargando el tablero…</div>';
  try {
    const res = await authFetch(`${API_URL}/despacho/pendientes`);
    if (!res.ok) throw new Error();
    const { empresas, actual } = await res.json();
    el.innerHTML = despachoHTML(empresas || [], actual);
    despachoComparativo(el);
  } catch {
    el.innerHTML = '<div class="empty" style="padding:32px;text-align:center">No se pudo cargar el tablero</div>';
  }
}

/**
 * El comparativo: ventas, costos+gastos y resultado de cada empresa, del mes y
 * del año. Se pide aparte porque son cuentas más pesadas y la pantalla de
 * pendientes no tiene por qué esperarlas.
 */
async function despachoComparativo(el) {
  const cont = document.createElement('div');
  cont.id = 'despacho-comparativo';
  cont.innerHTML = '<div class="admin-form-card"><h4>📊 Comparativo</h4><div style="color:#6b7280;font-size:13px">Calculando…</div></div>';
  el.appendChild(cont);
  try {
    const res = await authFetch(`${API_URL}/despacho/comparativo`);
    if (!res.ok) throw new Error();
    const { empresas, actual, mes } = await res.json();
    cont.innerHTML = comparativoHTML(empresas || [], actual, mes);
  } catch {
    cont.innerHTML = '<div class="admin-form-card"><h4>📊 Comparativo</h4><div style="color:#6b7280;font-size:13px">No se pudo calcular.</div></div>';
  }
}

function comparativoHTML(empresas, actualId, mesPedido) {
  if (!empresas.length) return '';
  const periodo = empresas[0]?.mes?.periodo || mesPedido || '';
  const [anio, mm] = String(periodo).split('-');
  const nombreMes = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][Number(mm) - 1] || periodo;

  const fila = (e) => {
    const num = (n, conSigno) => {
      const v = Number(n || 0);
      const color = !conSigno ? '#1a1a2e' : v < 0 ? '#b91c1c' : '#059669';
      return `<td class="num" style="color:${color};font-weight:${conSigno ? 600 : 400}">${despachoMoney(v)}</td>`;
    };
    return `<tr${e.id === actualId ? ' style="background:#f8fafc"' : ''}>
      <td style="white-space:nowrap">${despachoEsc(e.name)}${e.id === actualId ? ' <span style="font-size:10px;color:#1565c0">(activa)</span>' : ''}</td>
      ${num(e.mes.ingresos)}${num(e.mes.gastos)}${num(e.mes.resultado, true)}
      ${num(e.anio.ingresos)}${num(e.anio.gastos)}${num(e.anio.resultado, true)}
    </tr>`;
  };

  const anios = [...new Set(empresas.map((e) => e.anio.desde))];
  const etiquetaAnio = anios.length === 1 ? `Año ${anios[0]}` : 'Año en curso';

  return `<div class="admin-form-card" style="margin-top:4px">
    <h4>📊 Comparativo</h4>
    <p style="font-size:12px;color:#6b7280;margin:0 0 10px 0">
      Ventas, costos y gastos, y resultado — de <strong>${despachoEsc(nombreMes)} ${despachoEsc(anio)}</strong> y del
      <strong>${despachoEsc(etiquetaAnio)}</strong> de cada empresa. Son los mismos números que muestra el
      Estado de Resultados de cada una; acá no se suman entre empresas.
    </p>
    <div style="overflow-x:auto">
      <table class="grilla"><thead>
        <tr>
          <th rowspan="2" style="text-align:left;vertical-align:bottom">Empresa</th>
          <th colspan="3" style="text-align:center;border-bottom:1px solid #e5e7eb">${despachoEsc(nombreMes)} ${despachoEsc(anio)}</th>
          <th colspan="3" style="text-align:center;border-bottom:1px solid #e5e7eb">${despachoEsc(etiquetaAnio)}</th>
        </tr>
        <tr>
          <th class="num">Ventas</th><th class="num">Costos y gastos</th><th class="num">Resultado</th>
          <th class="num">Ventas</th><th class="num">Costos y gastos</th><th class="num">Resultado</th>
        </tr>
      </thead><tbody>${empresas.map(fila).join('')}</tbody></table>
    </div>
    ${anios.length > 1 ? '<div style="font-size:11px;color:#92400e;margin-top:8px">⚠️ Las empresas tienen años fiscales distintos: la columna «Año en curso» de cada una es su propio período.</div>' : ''}
  </div>`;
}

const despachoEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const despachoMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Un dato del tablero: número grande, etiqueta chica y color si pide atención. */
function despachoDato(valor, etiqueta, alerta) {
  const color = alerta && valor ? '#b91c1c' : '#1a1a2e';
  const fondo = alerta && valor ? '#fef2f2' : '#f9fafb';
  return `<div style="flex:1;min-width:110px;background:${fondo};border-radius:8px;padding:8px 10px">
    <div style="font-size:19px;font-weight:700;color:${color};line-height:1.1">${valor}</div>
    <div style="font-size:11px;color:#6b7280;margin-top:2px">${etiqueta}</div>
  </div>`;
}

function despachoHTML(empresas, actualId) {
  if (!empresas.length) {
    return '<div class="empty" style="padding:32px;text-align:center">No tenés acceso a ninguna empresa.</div>';
  }

  const tarjetas = empresas.map((e) => {
    const esActual = e.id === actualId;
    const pctCuota = e.cuota.limite ? Math.round((e.cuota.usado / e.cuota.limite) * 100) : 0;
    const buzonMal = e.buzon.problemas > 0 || !!e.buzon.detalle;
    const nadaPendiente =
      !e.borradores && !buzonMal && !e.porCobrar.vencidas && !e.obligaciones.vencidas && !e.obligaciones.porVencer && pctCuota < 90;

    return `<div style="background:#fff;border:1px solid ${esActual ? '#1565c0' : '#e5e7eb'};border-radius:12px;padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="font-weight:700;font-size:15px">${despachoEsc(e.name)}${esActual ? ' <span style="font-size:11px;background:#eff6ff;color:#1565c0;padding:2px 8px;border-radius:10px">estás acá</span>' : ''}</div>
          <div style="font-size:11px;color:#6b7280">tu rol: ${despachoEsc(e.role)}${e.cuota.plan ? ` · plan ${despachoEsc(e.cuota.plan)}` : ''}</div>
        </div>
        ${esActual ? '' : `<button class="btn-primary" style="padding:7px 16px;border:none;border-radius:8px;background:#1565c0;color:#fff;font-weight:600;cursor:pointer;font-size:13px" onclick="cambiarEmpresa('${e.id}')">Entrar →</button>`}
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
        ${despachoDato(e.borradores, e.borradores === 1 ? 'borrador por revisar' : 'borradores por revisar', e.borradores > 0)}
        ${despachoDato(e.porCobrar.vencidas ? `${e.porCobrar.vencidas} · ${despachoMoney(e.porCobrar.monto)}` : '—', 'por cobrar vencido', e.porCobrar.vencidas > 0)}
        ${despachoDato(e.obligaciones.vencidas ? String(e.obligaciones.vencidas) : (e.obligaciones.porVencer || '—'), e.obligaciones.vencidas ? 'obligaciones vencidas' : 'obligaciones esta semana', e.obligaciones.vencidas > 0)}
        ${despachoDato(e.cuota.limite ? `${pctCuota}%` : '—', `cuota usada (${e.cuota.usado}/${e.cuota.limite})`, pctCuota >= 90)}
      </div>

      ${buzonMal
        ? `<div style="margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;font-size:12px;color:#92400e">
             📧 <strong>Facturas por correo:</strong> ${e.buzon.problemas ? `${e.buzon.problemas} correo(s) con problemas` : ''}${e.buzon.detalle ? ` — ${despachoEsc(e.buzon.detalle)}` : ''}
             <div style="color:#6b7280;margin-top:2px">Se arregla en Administración → Configuración → «Facturas por correo».</div>
           </div>`
        : ''}
      ${nadaPendiente
        ? '<div style="margin-top:10px;font-size:12px;color:#059669;font-weight:600">✅ Sin pendientes</div>'
        : ''}
    </div>`;
  });

  // Solo admin y superadmin dan de alta empresas (mismo criterio que la API):
  // abrir libros nuevos es una responsabilidad, y quien la crea queda de dueño.
  const puedeCrear = ['admin', 'superadmin'].includes(getUser()?.role);

  // El cupo de empresas es de la CUENTA, así que se muestra al lado del botón que
  // lo consume —y no al superadmin, que da de alta clientes con cuenta propia y por
  // eso no tiene tope—. Cuenta las empresas de la cuenta, que pueden ser más que las
  // que este usuario ve acá (las que no lleva no salen en las tarjetas).
  const tope = window.userSubscription?.topes?.empresas;
  const contadorEmpresas = (puedeCrear && getUser()?.role !== 'superadmin' && tope?.max)
    ? `<span style="font-size:12px;color:#6b7280;margin-right:10px">${tope.usados} de ${tope.max} empresas</span>`
    : '';

  return `<div class="admin-form-card">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <h4 style="margin:0 0 4px 0">🏢 Mis empresas</h4>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0">
          Lo que pide atención en cada empresa. «Entrar» cambia la empresa activa y recarga la pantalla:
          no hace falta cerrar sesión.
        </p>
      </div>
      <div style="display:flex;align-items:center;white-space:nowrap">${contadorEmpresas}${puedeCrear ? `<button class="btn-secondary" style="padding:7px 14px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-weight:600;font-size:13px;white-space:nowrap" onclick="openCrearEmpresa(${JSON.stringify(empresas.map((e) => ({ id: e.id, name: e.name }))).replace(/"/g, '&quot;')})">+ Crear empresa</button>` : ''}</div>
    </div>
    ${tarjetas.join('')}
  </div>`;
}

/**
 * Alta de una empresa desde acá. Nace con el plan de cuentas y los conceptos de la
 * plantilla y **dentro de la cuenta de quien la crea** (no estrena plan: el plan y
 * la cuota son de la cuenta, y la empresa nueva consume de esa misma cuota). Quien
 * la crea queda como su administrador: al terminar, entra directo a ella.
 */
function openCrearEmpresa(misEmpresas = []) {
  // De dónde copiar el catálogo: la plantilla del sistema o una empresa propia
  // (un despacho usa SU catálogo para que todos sus clientes nazcan iguales).
  const opciones = [
    '<option value="">Plantilla del sistema (recomendada para empezar)</option>',
    ...misEmpresas.map((e) => `<option value="${despachoEsc(e.id)}">${despachoEsc(e.name)}</option>`),
  ].join('');

  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:440px">
    <div style="font-weight:700;font-size:16px;margin-bottom:6px">🏢 Nueva empresa</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:12px">Nace con el plan de cuentas y los conceptos de la plantilla, y entra en tu plan (no estrena uno propio: consume de tu misma cuota). Vas a quedar como su administrador.</div>
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Nombre</label>
    <input id="ce-nombre" placeholder="Distribuidora La Central, S.A." style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">RUC (opcional — se puede completar después)</label>
    <input id="ce-ruc" placeholder="1555-1234-5678" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">
    <label style="font-size:11px;color:#6b7280;display:block;margin:8px 0 2px">Copiar el plan de cuentas y los conceptos de</label>
    <select id="ce-plantilla" style="width:100%;padding:8px;border:1px solid #d1d5db;border-radius:6px;font-size:13px">${opciones}</select>
    <div style="font-size:11px;color:#6b7280;margin-top:4px">Elegí una empresa tuya si querés que este cliente nazca con tu mismo catálogo.</div>
    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
      <button class="app-dialog-btn" onclick="this.closest('.app-dialog-overlay').remove()">Cancelar</button>
      <button class="app-dialog-btn primary" onclick="guardarEmpresaNueva(this)">🏢 Crear y entrar</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
}

async function guardarEmpresaNueva(btn) {
  const nombre = document.getElementById('ce-nombre')?.value.trim();
  const taxId = document.getElementById('ce-ruc')?.value.trim() || null;
  const plantillaCompanyId = document.getElementById('ce-plantilla')?.value || null;
  if (!nombre) { await showAlert('Poné el nombre de la empresa'); return; }
  btn.disabled = true;
  btn.textContent = 'Creando…';
  try {
    const res = await authFetch(`${API_URL}/companies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nombre, taxId, plantillaCompanyId }),
    });
    const data = await res.json();
    if (!res.ok) {
      await showAlert(data.error || 'No se pudo crear la empresa');
      btn.disabled = false;
      btn.textContent = '🏢 Crear y entrar';
      return;
    }
    // Se entra a la empresa nueva con la sesión que devuelve el alta.
    localStorage.setItem('agt_token', data.token);
    localStorage.setItem('agt_user', JSON.stringify(data.user));
    window.location.reload();
  } catch {
    await showAlert('Error de conexión');
    btn.disabled = false;
    btn.textContent = '🏢 Crear y entrar';
  }
}
