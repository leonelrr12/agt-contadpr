/**
 * Pantalla del módulo de Planilla (PLANILLA.md).
 *
 * Mini-SPA por pestañas, igual que `inventario.js`. Dos reglas que atraviesan todo
 * el archivo:
 *
 *  · **El servidor calcula.** El grid de la corrida NO recalcula montos en el
 *    navegador: manda los ajustes que el contador toca (días, horas extras, notas) y
 *    vuelve a pedir el cálculo. Duplicar el motor acá sería garantizar que algún día
 *    la pantalla y el asiento digan cosas distintas.
 *
 *  · **Todo texto que venga de afuera se escapa.** Los nombres de empleado salen de
 *    archivos que sube el usuario.
 */
(function () {
  'use strict';

  const API = '/api/planilla';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
  const num = (n) => (Number(n) || 0).toLocaleString('es-PA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (n) => (Number(n) * 100).toFixed(2).replace(/\.?0+$/, '') + '%';

  function isoDe(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const hoy = () => isoDe(new Date());

  async function pedir(ruta, opciones = {}) {
    const res = await authFetch(API + ruta, {
      ...opciones,
      headers: opciones.body instanceof FormData
        ? opciones.headers
        : { 'Content-Type': 'application/json', ...(opciones.headers || {}) },
    });
    const texto = await res.text();
    let datos;
    try { datos = texto ? JSON.parse(texto) : {}; } catch { datos = { error: texto }; }
    if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
    return datos;
  }

  const estado = { vista: 'corrida', empleados: [], parametros: null, corrida: null, ajustes: {} };
  let temporizador = null;

  // ─── Navegación ────────────────────────────────────────────────────────────

  const VISTAS = {
    corrida: vistaCorrida,
    empleados: vistaEmpleados,
    acumulados: vistaAcumulados,
    historial: vistaHistorial,
    css: vistaCSS,
    cuadre: vistaCuadre,
    parametros: vistaParametros,
  };

  function avisos(lista, clase = '') {
    if (!lista || lista.length === 0) return '';
    return lista.map((a) => `<div class="aviso ${clase}">${esc(a)}</div>`).join('');
  }

  async function render() {
    const cont = $('pl-contenido');
    cont.innerHTML = '<div class="loading">Cargando…</div>';
    document.querySelectorAll('#pl-tabs .pl-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === estado.vista);
    });
    try {
      cont.innerHTML = await VISTAS[estado.vista]();
    } catch (e) {
      cont.innerHTML = `<div class="aviso err">${esc(e.message)}</div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    // En qué empresa estoy parado: el encabezado lo dice antes de pedir datos.
    pintarEmpresaEnTitulo('pl-empresa');
    const tab = new URLSearchParams(location.search).get('tab');
    if (tab && VISTAS[tab]) estado.vista = tab;
    document.querySelectorAll('#pl-tabs .pl-tab').forEach((b) => {
      b.addEventListener('click', () => { estado.vista = b.dataset.tab; render(); });
    });
    render();
  });

  // ─── Corrida ───────────────────────────────────────────────────────────────

  const TIPOS = {
    SUELDO: { label: 'Sueldo', periodicidad: 'QUINCENAL' },
    DECIMO: { label: 'Décimo III', periodicidad: 'ANUAL' },
    VACACIONES: { label: 'Vacaciones', periodicidad: 'EVENTUAL' },
  };

  /**
   * Las periodicidades de una corrida de SUELDO y cómo se llaman. La semanal se
   * contabiliza en UN asiento para toda la nómina: 52 corridas al año por el asiento
   * de cada empleado convertirían la cola de revisión en el cuello de botella.
   */
  const PERIODICIDADES = [
    ['SEMANAL', 'Semanal'],
    ['QUINCENAL', 'Quincenal'],
    ['MENSUAL', 'Mensual'],
  ];

  /** El tipo de pago de la ficha del empleado. */
  const TIPOS_PAGO = [['SEMANAL', 'Semanal'], ['QUINCENAL', 'Quincenal'], ['MENSUAL', 'Mensual']];

  const etiquetaTipoPago = (v) => (TIPOS_PAGO.find(([k]) => k === v) || [, v || '—'])[1];

  function formaCorrida() {
    if (!estado.forma) {
      const d = new Date();
      estado.forma = {
        tipo: 'SUELDO',
        periodicidad: 'QUINCENAL',
        fechaDesde: isoDe(new Date(d.getFullYear(), d.getMonth(), 1)),
        fechaPago: isoDe(new Date(d.getFullYear(), d.getMonth(), 15)),
      };
    }
    return estado.forma;
  }

  async function vistaCorrida() {
    const f = formaCorrida();
    const esPrestacion = f.tipo !== 'SUELDO';
    const p = estado.corrida;

    const cards = p ? `
      <div class="summary-cards">
        <div class="summary-card"><div class="num">${num(p.totales.bruto)}</div><div class="label">Bruto del período</div></div>
        <div class="summary-card"><div class="num">${num(p.totales.deducciones)}</div><div class="label">Deducciones</div></div>
        <div class="summary-card ok"><div class="num">${num(p.totales.neto)}</div><div class="label">Neto a pagar</div></div>
        <div class="summary-card warn"><div class="num">${num(p.totales.patronal)}</div><div class="label">Aporte del patrono</div></div>
      </div>` : '';

    const filas = p ? p.items.map((i) => filaCorrida(i, f.tipo)).join('') : '';

    const tabla = p && p.items.length ? `
      <table class="data-table">
        <thead><tr>
          <th>Empleado</th><th class="num">Días</th><th class="num">Horas extras</th>
          <th class="num">${esPrestacion ? 'Monto a pagar' : 'Otros ingresos'}</th>
          <th class="num" title="Ausencia o tardanza: baja el sueldo y la base de cotización">Menos sueldo</th>
          <th class="num">Otras deducc.</th>
          <th class="num">Sueldo</th><th class="num">SS</th><th class="num">SE</th>
          <th class="num">ISR</th><th class="num">Neto</th>
        </tr></thead>
        <tbody>${filas}</tbody>
      </table>` : (p ? '<div class="aviso">No hay empleados con monto a pagar en este período.</div>' : '');

    return `
      <div class="card">
        <h3>Nueva corrida</h3>
        <div class="form-grid">
          <div><label>Tipo</label>
            <select id="c-tipo">
              ${Object.entries(TIPOS).map(([k, v]) => `<option value="${k}" ${f.tipo === k ? 'selected' : ''}>${v.label}</option>`).join('')}
            </select></div>
          <div><label>Periodicidad</label>
            <select id="c-periodicidad" ${esPrestacion ? 'disabled' : ''}>
              ${PERIODICIDADES.map(([k, l]) => `<option value="${k}" ${f.periodicidad === k ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div><label>Desde</label><input type="date" id="c-desde" value="${f.fechaDesde}"></div>
          <div><label>Fecha de pago</label><input type="date" id="c-pago" value="${f.fechaPago}"></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;align-items:center">
          <button class="btn btn-secondary" id="c-calcular">Calcular</button>
          <button class="btn btn-primary" id="c-ejecutar" ${(p && p.items.length && !p.yaExiste && p.errores.length === 0) ? '' : 'disabled'}>Ejecutar corrida</button>
          ${p ? `<span class="nota">Período <b>${esc(p.periodo)}</b> · pago ${p.pagoNumero} de ${p.pagosDelMes} del mes${
            p.consolidado ? ' · un solo asiento para toda la nómina' : ' · un asiento por empleado'}</span>` : ''}
        </div>
      </div>

      ${p ? avisos(p.errores.map((e) => `${e.nombre}: ${e.motivo}`), 'err') : ''}
      ${p && p.yaExiste ? `<div class="aviso err">Ya existe una corrida de ${esc(p.tipo)} para el período ${esc(p.periodo)} (${esc(p.yaExiste.status)}). Anulala antes de rehacerla.</div>` : ''}
      ${p ? avisos(p.faltantes.map((x) => `Falta configurar la cuenta de ${x.etiqueta}.`), 'err') : ''}
      ${p ? avisos(p.avisos) : ''}
      ${p && p.omitidos.length ? `<div class="aviso">${p.omitidos.length} empleado(s) no entran en el período: ${esc(p.omitidos.map((o) => `${o.nombre} (${o.motivo})`).join(', '))}</div>` : ''}

      ${cards}
      ${tabla}
      ${p && p.items.length ? '<p class="nota">Editá días, horas extras u otros ingresos y el servidor vuelve a calcular. Los montos que ves son los que van al asiento.</p>' : ''}
    `;
  }

  /** Un renglón del grid. Las celdas calculadas llevan data-calc para refrescarse solas. */
  function filaCorrida(i, tipo) {
    const a = estado.ajustes[i.employeeId] || {};
    const esPrestacion = tipo !== 'SUELDO';
    const campoMonto = esPrestacion
      ? `<input class="celda" data-edit="montoPrestacion" data-emp="${esc(i.employeeId)}" value="${a.montoPrestacion ?? i.bruto}">`
      : `<input class="celda" data-edit="otrosIngresos" data-emp="${esc(i.employeeId)}" value="${a.otrosIngresos ?? i.otrosIngresos}">`;
    const campoExtras = esPrestacion
      ? '<span class="nota">—</span>'
      : `<input class="celda" data-edit="horasExtras" data-emp="${esc(i.employeeId)}" value="${a.horasExtras ?? i.horasExtras}">`;
    // Ausencia o tardanza: baja el sueldo y la base de cotización. En las prestaciones
    // no se usa —no hay sueldo que descontar— así que la celda queda vacía.
    const campoMenosSueldo = esPrestacion
      ? '<span class="nota">—</span>'
      : `<input class="celda" data-edit="menosSueldo" data-emp="${esc(i.employeeId)}" value="${a.menosSueldo ?? i.menosSueldo ?? 0}">`;

    return `<tr>
      <td>${esc(i.nombre)}${i.cedula ? `<br><span class="nota">${esc(i.cedula)}</span>` : ''}</td>
      <td class="num"><input class="celda" style="width:56px" data-edit="diasTrabajados" data-emp="${esc(i.employeeId)}" value="${a.diasTrabajados ?? i.diasTrabajados}"></td>
      <td class="num">${campoExtras}</td>
      <td class="num">${campoMonto}</td>
      <td class="num">${campoMenosSueldo}</td>
      <td class="num"><input class="celda" data-edit="otrasDeducciones" data-emp="${esc(i.employeeId)}" value="${a.otrasDeducciones ?? i.otrasDeducciones}"></td>
      ${celdasCalculadas(i)}
    </tr>`;
  }

  function celdasCalculadas(i) {
    return `
      <td class="num" data-calc="sueldo-${esc(i.employeeId)}">${num(i.sueldo)}</td>
      <td class="num" data-calc="ss-${esc(i.employeeId)}">${num(i.ss)}</td>
      <td class="num" data-calc="se-${esc(i.employeeId)}">${num(i.se)}</td>
      <td class="num" data-calc="isr-${esc(i.employeeId)}">${num(i.isr)}</td>
      <td class="num" data-calc="neto-${esc(i.employeeId)}"><b>${num(i.neto)}</b></td>`;
  }

  function leerForma() {
    const f = formaCorrida();
    f.tipo = $('c-tipo').value;
    f.periodicidad = TIPOS[f.tipo].periodicidad === 'QUINCENAL' ? $('c-periodicidad').value : TIPOS[f.tipo].periodicidad;
    f.fechaDesde = $('c-desde').value;
    f.fechaPago = $('c-pago').value;
    return f;
  }

  /**
   * Al elegir Semanal, las fechas se van a la semana en curso.
   *
   * Dejarlas en la quincena que estaban daría un período de quince días —que el
   * prorrateo cobra igual, pero con su aviso— y el contador tendría que corregir dos
   * fechas antes de ver algo útil. El día de pago sale de Parámetros: es el mismo que
   * usa el servidor para numerar el pago del mes.
   */
  async function prellenarSemana() {
    if (!estado.parametros) estado.parametros = await pedir('/parametros');
    const dia = Number(estado.parametros?.settings?.diaPagoSemanal ?? 5);
    const ahora = new Date();
    // El lunes de esta semana: `getDay()` pone el domingo en 0.
    const lunes = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - ((ahora.getDay() + 6) % 7));
    const pago = new Date(lunes.getFullYear(), lunes.getMonth(), lunes.getDate() + ((dia + 6) % 7));

    const f = formaCorrida();
    f.fechaDesde = isoDe(lunes);
    f.fechaPago = isoDe(pago);
  }

  async function calcular() {
    const f = leerForma();
    const cuerpo = {
      tipo: f.tipo, periodicidad: f.periodicidad,
      fechaDesde: f.fechaDesde, fechaPago: f.fechaPago,
      ajustes: Object.entries(estado.ajustes).map(([employeeId, v]) => ({ employeeId, ...v })),
    };
    estado.corrida = await pedir('/corridas/preview', { method: 'POST', body: JSON.stringify(cuerpo) });
    return estado.corrida;
  }

  /**
   * Refresca SOLO las celdas calculadas. Volver a pintar la tabla entera en cada
   * tecla haría perder el foco y el cursor, así que el HTML de los inputs no se toca.
   */
  function refrescarCelulas(p) {
    for (const i of p.items) {
      const set = (campo, valor) => {
        const el = document.querySelector(`[data-calc="${campo}-${CSS.escape(i.employeeId)}"]`);
        if (el) el.innerHTML = valor;
      };
      set('sueldo', num(i.sueldo));
      set('ss', num(i.ss));
      set('se', num(i.se));
      set('isr', num(i.isr));
      set('neto', `<b>${num(i.neto)}</b>`);
    }
  }

  /**
   * Teclado del módulo, para cargar treinta renglones sin soltar el mouse ni borrar a
   * mano lo que ya estaba:
   *
   *  · Al entrar a un campo de número o de fecha, su contenido queda seleccionado: lo
   *    que se escriba reemplaza. En los de texto NO, porque seleccionar el nombre
   *    obligaría a volver a escribirlo entero para corregir una letra.
   *  · Enter pasa al campo siguiente en el orden de la pantalla, y en el último
   *    suelta el foco. En un textarea no, ahí Enter es un salto de línea.
   */
  const TIPOS_QUE_SE_SELECCIONAN = ['number', 'date'];

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && TIPOS_QUE_SE_SELECCIONAN.includes(el.type)) {
      // En diferido: el clic que provocó el foco colapsa la selección si se hace ya.
      setTimeout(() => el.select(), 0);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches('input, select, textarea')) return;
    if (el.tagName === 'TEXTAREA') return;
    if (el instanceof HTMLInputElement && ['file', 'checkbox', 'radio', 'button'].includes(el.type)) return;

    e.preventDefault();
    const campos = [...document.querySelectorAll('input, select, textarea')].filter(
      (x) => !x.disabled && x.type !== 'hidden' && x.offsetParent !== null,
    );
    const siguiente = campos[campos.indexOf(el) + 1];
    if (siguiente) siguiente.focus();
    else el.blur();
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset || !el.dataset.edit) return;
    const emp = el.dataset.emp;
    estado.ajustes[emp] = { ...(estado.ajustes[emp] || {}), [el.dataset.edit]: Number(el.value) || 0 };
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      try {
        const p = await calcular();
        refrescarCelulas(p);
      } catch (err) {
        console.error(err);
      }
    }, 700);
  });

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'c-tipo') {
      // Cambiar de tipo cambia los montos y las columnas: la corrida anterior ya no
      // describe lo que se va a pagar, así que se descarta en vez de mostrarla.
      leerForma();
      estado.ajustes = {};
      estado.corrida = null;
      await render();
      return;
    }
    if (e.target.id === 'c-periodicidad' || e.target.id === 'c-desde' || e.target.id === 'c-pago') {
      leerForma();
      if (e.target.id === 'c-periodicidad' && e.target.value === 'SEMANAL') {
        try { await prellenarSemana(); } catch { /* sin parámetros, se dejan las fechas como están */ }
      }
      estado.corrida = null;
      await render();
    }
  });

  document.addEventListener('click', async (e) => {
    const id = e.target.id;
    if (id === 'c-calcular') {
      const btn = e.target; btn.disabled = true; btn.textContent = 'Calculando…';
      try { await calcular(); await render(); } catch (err) { alert(err.message); btn.disabled = false; btn.textContent = 'Calcular'; }
      return;
    }
    if (id === 'c-ejecutar') {
      const p = estado.corrida;
      if (!(await showConfirm(`¿Ejecutar la corrida de ${p.tipo} del período ${p.periodo} por ${num(p.totales.neto)} de neto? Se van a crear ${p.items.length} asientos en BORRADOR.`))) return;
      const f = formaCorrida();
      try {
        const r = await pedir('/corridas', {
          method: 'POST',
          body: JSON.stringify({
            tipo: f.tipo, periodicidad: f.periodicidad, fechaDesde: f.fechaDesde, fechaPago: f.fechaPago,
            ajustes: Object.entries(estado.ajustes).map(([employeeId, v]) => ({ employeeId, ...v })),
          }),
        });
        estado.ajustes = {}; estado.corrida = null;
        // Una corrida consolidada que falla no crea NADA: decir "0 asientos creados"
        // como si hubiera salido bien es la peor forma de reportar, porque el
        // contador se entera cuando el empleado reclama.
        await showAlert(
          r.errores?.length
            ? `La corrida quedó con ${r.creados} asiento(s) y estos errores: ${r.errores.map((e) => `${e.empleado}: ${e.motivo}`).join(' · ')}`
            : `Corrida ejecutada: ${r.creados} asiento(s) por ${num(r.totales.neto)} de neto. Quedan en BORRADOR para que los revises.`,
        );
        estado.vista = 'historial';
        await render();
      } catch (err) { alert(err.message); }
    }
  });

  // ─── Empleados ─────────────────────────────────────────────────────────────

  async function vistaEmpleados() {
    // Los desplegables de clase de riesgo y de banco salen de los parámetros: sin
    // esto la ficha se dibujaría con los selectores vacíos.
    if (!estado.parametros) estado.parametros = await pedir('/parametros');
    if (!estado.empleados.length) estado.empleados = await pedir('/empleados?incluirInactivos=true');

    const filas = estado.empleados.map((e) => `
      <tr>
        <td>${esc(e.nombre)}</td>
        <td>${esc(e.cedula || '—')}</td>
        <td>${esc(e.cargo || '—')}</td>
        <td>${esc(etiquetaTipoPago(e.tipoPago))}</td>
        <td>${esc(e.claseRiesgo || '—')}</td>
        <td class="num">${num(e.sueldoBase)}</td>
        <td class="num">${num(e.acumulados?.decimo?.saldo)}</td>
        <td>${e.isActive ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
        <td><button class="btn btn-secondary btn-sm" data-editar="${esc(e.id)}">Editar</button></td>
      </tr>`).join('');

    const ed = estado.empleadoEditando;
    const form = `
      <div class="card">
        <h3>${ed ? `Editar a ${esc(ed.nombre)}` : 'Nuevo empleado'}</h3>
        <div class="form-grid">
          <div><label>Nombre</label><input id="e-nombre" value="${esc(ed?.nombre || '')}"></div>
          <div><label>Cédula</label><input id="e-cedula" value="${esc(ed?.cedula || '')}"></div>
          <div><label>NSS</label><input id="e-nss" value="${esc(ed?.nss || '')}"></div>
          <div><label>Cargo</label><input id="e-cargo" value="${esc(ed?.cargo || '')}"></div>
          <div><label>Sueldo mensual</label><input id="e-sueldo" type="number" step="0.01" value="${ed?.sueldoBase ?? ''}"></div>
          <div><label>Tipo de pago</label>
            <select id="e-tipopago">
              ${TIPOS_PAGO.map(([k, l]) => `<option value="${k}" ${(ed ? ed.tipoPago === k : k === 'QUINCENAL') ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <div><label>Clase de riesgo</label>
            <select id="e-riesgo">
              <option value="">— la general de la empresa —</option>
              ${(estado.parametros?.clasesRiesgo || ['I', 'II', 'III', 'IV', 'V']).map((c) => `<option value="${c}" ${ed?.claseRiesgo === c ? 'selected' : ''}>Clase ${c}</option>`).join('')}
            </select></div>
          <div><label>Fecha de ingreso</label><input id="e-ingreso" type="date" value="${ed?.fechaIngreso ? String(ed.fechaIngreso).slice(0, 10) : ''}"></div>
          <div><label>Banco (cuenta 1.1.02)</label>
            <select id="e-banco"><option value="">— el de la empresa —</option>
              ${(estado.parametros?.bancos || []).map((b) => `<option value="${esc(b.id)}" ${ed?.bancoCuentaId === b.id ? 'selected' : ''}>${esc(b.code + ' ' + b.name)}</option>`).join('')}
            </select></div>
          <div><label>Décimo acumulado (saldo inicial)</label><input id="e-saldo-decimo" type="number" step="0.01" value="${ed?.decimoSaldoInicial ?? 0}"></div>
          <div><label>Vacaciones acumuladas (inicial)</label><input id="e-saldo-vac" type="number" step="0.01" value="${ed?.vacacionesSaldoInicial ?? 0}"></div>
          <div><label>Prima (inicial)</label><input id="e-saldo-prima" type="number" step="0.01" value="${ed?.primaSaldoInicial ?? 0}"></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:8px">
          <button class="btn btn-primary" id="e-guardar">${ed ? 'Guardar cambios' : 'Crear empleado'}</button>
          ${ed ? '<button class="btn btn-secondary" id="e-cancelar">Cancelar</button>' : ''}
          ${ed ? `<button class="btn ${ed.isActive ? 'btn-danger' : 'btn-secondary'}" id="e-toggle">${ed.isActive ? 'Dar de baja' : 'Reactivar'}</button>` : ''}
        </div>
        <p class="nota">Los saldos iniciales son los acumulados ANTES de usar el módulo: sirven para arrancar desde un corte sin recargar años de planilla.</p>
      </div>`;

    return `
      <div class="card">
        <h3>Alta masiva desde el archivo de planilla</h3>
        <div class="form-grid">
          <div><label>Archivo (CSV o XLSX)</label><input type="file" id="r-archivo" accept=".csv,.xlsx"></div>
          <div><label>Tipo de pago (si el archivo no lo trae)</label>
            <select id="r-tipopago">${TIPOS_PAGO.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        </div>
        <div style="margin-top:12px"><button class="btn btn-secondary" id="r-previa">Previsualizar</button></div>
        <p class="nota">Se leen NOMBRE, CÉDULA y SUELDO (más CARGO, NSS, FECHA DE INGRESO y <b>TIPO DE PAGO</b> si están). El <b>SUELDO del archivo es el salario base MENSUAL</b> y se guarda tal cual: no se multiplica por nada. El tipo de pago sale de su columna, fila por fila —una celda vacía se toma como quincenal—; el selector de arriba solo aplica si el archivo no trae esa columna.</p>
        <div id="r-resultado"></div>
      </div>

      ${form}

      <div class="card">
        <h3>Registro (${estado.empleados.length})</h3>
        <table class="data-table">
          <thead><tr><th>Nombre</th><th>Cédula</th><th>Cargo</th><th>Pago</th><th>Riesgo</th>
            <th class="num">Sueldo mensual</th><th class="num">Décimo acum.</th><th>Estado</th><th></th></tr></thead>
          <tbody>${filas || '<tr><td colspan="9" class="nota">Sin empleados. Cargalos a mano o importá el archivo.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  document.addEventListener('click', async (e) => {
    const id = e.target.id;
    const editar = e.target.dataset?.editar;

    if (editar) {
      estado.empleadoEditando = estado.empleados.find((x) => x.id === editar);
      await render();
      return;
    }
    if (id === 'e-cancelar') { estado.empleadoEditando = null; await render(); return; }
    if (id === 'e-guardar') {
      const ed = estado.empleadoEditando;
      const cuerpo = {
        nombre: $('e-nombre').value.trim(),
        cedula: $('e-cedula').value.trim() || null,
        nss: $('e-nss').value.trim() || null,
        cargo: $('e-cargo').value.trim() || null,
        sueldoBase: Number($('e-sueldo').value),
        tipoPago: $('e-tipopago').value,
        claseRiesgo: $('e-riesgo').value || null,
        fechaIngreso: $('e-ingreso').value || null,
        bancoCuentaId: $('e-banco').value || null,
        decimoSaldoInicial: Number($('e-saldo-decimo').value) || 0,
        vacacionesSaldoInicial: Number($('e-saldo-vac').value) || 0,
        primaSaldoInicial: Number($('e-saldo-prima').value) || 0,
      };
      try {
        if (ed) await pedir(`/empleados/${ed.id}`, { method: 'PATCH', body: JSON.stringify(cuerpo) });
        else await pedir('/empleados', { method: 'POST', body: JSON.stringify(cuerpo) });
        estado.empleadoEditando = null;
        estado.empleados = [];
        await render();
      } catch (err) { alert(err.message); }
      return;
    }
    if (id === 'e-toggle') {
      const ed = estado.empleadoEditando;
      try {
        await pedir(`/empleados/${ed.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !ed.isActive }) });
        estado.empleadoEditando = null;
        estado.empleados = [];
        await render();
      } catch (err) { alert(err.message); }
      return;
    }
    if (id === 'r-previa') {
      const archivo = $('r-archivo').files[0];
      if (!archivo) { alert('Elegí el archivo primero.'); return; }
      const fd = new FormData();
      fd.append('file', archivo);
      fd.append('tipoPago', $('r-tipopago').value);
      try {
        const r = await pedir('/roster/preview', { method: 'POST', body: fd });
        $('r-resultado').innerHTML = `
          <div class="aviso ok">${r.resumen.ok} para crear · ${r.resumen.existentes} ya existen · ${r.resumen.errores} con error</div>
          <table class="data-table"><thead><tr><th>#</th><th>Nombre</th><th>Cédula</th><th>Cargo</th><th>NSS</th>
            <th>Pago</th><th class="num">Sueldo base mensual</th><th>Estado</th></tr></thead>
          <tbody>${r.rows.map((f) => `<tr><td>${f.row}</td><td>${esc(f.nombre || '—')}</td><td>${esc(f.cedula || '—')}</td>
            <td>${esc(f.cargo || '—')}</td><td>${esc(f.nss || '—')}</td>
            <td>${esc(etiquetaTipoPago(f.tipoPago))}${f.tipoPagoFuente === 'DEFECTO' ? ' <span class="nota">(defecto)</span>' : ''}</td>
            <td class="num">${num(f.sueldoBase)}</td>
            <td>${f.status === 'ok' ? '<span class="badge badge-ok">nuevo</span>' : f.status === 'existente' ? '<span class="badge badge-warn">ya existe</span>' : `<span class="badge badge-err">${esc(f.error || 'error')}</span>`}</td></tr>`).join('')}</tbody></table>
          <div style="margin-top:12px"><button class="btn btn-primary" id="r-ejecutar" ${r.resumen.ok ? '' : 'disabled'}>Importar ${r.resumen.ok} empleado(s)</button></div>`;
      } catch (err) { $('r-resultado').innerHTML = `<div class="aviso err">${esc(err.message)}</div>`; }
      return;
    }
    if (id === 'r-ejecutar') {
      const archivo = $('r-archivo').files[0];
      const fd = new FormData();
      fd.append('file', archivo);
      fd.append('tipoPago', $('r-tipopago').value);
      try {
        const r = await pedir('/roster/execute', { method: 'POST', body: fd });
        await showAlert(`Importados ${r.creados}. ${r.omitidos} ya existían. ${r.errores.length} con error.`);
        estado.empleados = [];
        await render();
      } catch (err) { alert(err.message); }
    }
  });

  // ─── Acumulados ────────────────────────────────────────────────────────────

  async function vistaAcumulados() {
    const corte = estado.corte || '';
    const r = await pedir('/acumulados' + (corte ? `?corte=${corte}` : ''));

    const bloque = (a) => `
      <td class="num">${num(a.inicial)}</td><td class="num">${num(a.generado)}</td>
      <td class="num">${num(a.pagado)}</td><td class="num"><b>${num(a.saldo)}</b></td>`;

    return `
      <div class="card">
        <h3>Acumulados por empleado</h3>
        <div class="form-grid" style="grid-template-columns:200px">
          <div><label>Acumulado al</label><input type="date" id="a-corte" value="${esc(corte)}"></div>
        </div>
        <p class="nota">Saldo = saldo inicial + lo devengado en las corridas − lo pagado. Se calcula en el momento, no es un saldo guardado.</p>
      </div>
      <div class="card">
        <table class="data-table">
          <thead>
            <tr><th rowspan="2">Empleado</th><th colspan="4" style="text-align:center">Décimo III</th>
              <th colspan="4" style="text-align:center">Vacaciones</th><th colspan="4" style="text-align:center">Prima de antigüedad</th></tr>
            <tr><th class="num">Inicial</th><th class="num">Devengado</th><th class="num">Pagado</th><th class="num">Saldo</th>
              <th class="num">Inicial</th><th class="num">Devengado</th><th class="num">Pagado</th><th class="num">Saldo</th>
              <th class="num">Inicial</th><th class="num">Devengado</th><th class="num">Pagado</th><th class="num">Saldo</th></tr>
          </thead>
          <tbody>${r.empleados.map((e) => `<tr><td>${esc(e.nombre)}</td>${bloque(e.acumulados.decimo)}${bloque(e.acumulados.vacaciones)}${bloque(e.acumulados.prima)}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'a-corte') { estado.corte = e.target.value; await render(); }
  });

  // ─── Historial ─────────────────────────────────────────────────────────────

  const ESTADO_BADGE = {
    BORRADOR: 'badge-neutral', EJECUTADA: 'badge-ok', ANULADA: 'badge-err',
    CONFIRMADO: 'badge-ok', RECHAZADO: 'badge-err',
  };

  async function vistaHistorial() {
    if (estado.corridaDetalle) return vistaCorridaDetalle();

    const corridas = await pedir('/corridas');
    const filas = corridas.map((c) => {
      const asientos = Object.entries(c.asientos || {})
        .map(([k, v]) => `<span class="badge ${ESTADO_BADGE[k] || 'badge-neutral'}">${v} ${esc(k.toLowerCase())}</span>`).join(' ') || '<span class="nota">—</span>';
      return `<tr>
        <td>${esc(c.tipo)}</td>
        <td>${esc(c.periodo)}</td>
        <td><span class="badge ${ESTADO_BADGE[c.status] || 'badge-neutral'}">${esc(c.status)}</span></td>
        <td>${String(c.fechaPago).slice(0, 10)}</td>
        <td class="num">${c.empleados}</td>
        <td class="num">${num(c.totalNeto)}</td>
        <td class="num">${num(c.totalPatronal)}</td>
        <td>${asientos}</td>
        <td><button class="btn btn-secondary btn-sm" data-ver="${esc(c.id)}">Ver</button></td>
      </tr>`;
    }).join('');

    return `
      <div class="card">
        <h3>Corridas</h3>
        <table class="data-table">
          <thead><tr><th>Tipo</th><th>Período</th><th>Estado</th><th>Fecha de pago</th>
            <th class="num">Empleados</th><th class="num">Neto</th><th class="num">Patronal</th><th>Asientos</th><th></th></tr></thead>
          <tbody>${filas || '<tr><td colspan="9" class="nota">Todavía no hay corridas.</td></tr>'}</tbody>
        </table>
      </div>`;
  }

  async function vistaCorridaDetalle() {
    const c = estado.corridaDetalle;
    const filas = c.items.map((i) => `
      <tr>
        <td>${esc(i.employee?.nombre || '')}</td>
        <td class="num">${i.diasTrabajados}</td>
        <td class="num">${num(i.sueldo)}</td>
        <td class="num">${num(i.horasExtras)}</td>
        <td class="num">${num(i.bruto)}</td>
        <td class="num">${num(i.ss)}</td>
        <td class="num">${num(i.se)}</td>
        <td class="num">${num(i.isr)}</td>
        <td class="num"><b>${num(i.neto)}</b></td>
        <td class="num">${num(i.ssPatronal + i.sePatronal + i.riesgosPatronal)}</td>
        <td>${i.asientoStatus ? `<span class="badge ${ESTADO_BADGE[i.asientoStatus] || 'badge-neutral'}">${esc(i.asientoStatus)}</span>` : '—'}</td>
      </tr>`).join('');

    return `
      <div class="card">
        <h3>Corrida ${esc(c.tipo)} · ${esc(c.periodo)}
          <span class="badge ${ESTADO_BADGE[c.status] || 'badge-neutral'}">${esc(c.status)}</span></h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-secondary" id="h-volver">← Volver</button>
          <button class="btn btn-secondary" id="h-export">Exportar CSV</button>
          ${c.status !== 'ANULADA' ? '<button class="btn btn-primary" id="h-aprobar">Aprobar los asientos</button>' : ''}
          ${c.status !== 'ANULADA' ? '<button class="btn btn-secondary" id="h-rechazar">Rechazar</button>' : ''}
          ${c.status !== 'ANULADA' ? '<button class="btn btn-danger" id="h-anular">Anular la corrida</button>' : ''}
        </div>
        ${c.motivoAnulacion ? `<div class="aviso err">Anulada: ${esc(c.motivoAnulacion)}</div>` : ''}
        <p class="nota">El asiento de cada empleado entra al diario y se aprueba desde acá o desde Revisión, indistintamente. Anular la corrida revierte sus asientos con fecha de hoy: el original sigue contando en su período.</p>
      </div>
      <div class="card">
        <table class="data-table">
          <thead><tr><th>Empleado</th><th class="num">Días</th><th class="num">Sueldo</th><th class="num">Extras</th>
            <th class="num">Bruto</th><th class="num">SS</th><th class="num">SE</th><th class="num">ISR</th>
            <th class="num">Neto</th><th class="num">Patronal</th><th>Asiento</th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>`;
  }

  document.addEventListener('click', async (e) => {
    const ver = e.target.dataset?.ver;
    if (ver) {
      estado.corridaDetalle = await pedir(`/corridas/${ver}`);
      await render();
      return;
    }
    const id = e.target.id;
    if (id === 'h-volver') { estado.corridaDetalle = null; await render(); return; }
    if (id === 'h-export') {
      const res = await authFetch(`${API}/corridas/${estado.corridaDetalle.id}/export.csv`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `planilla-${estado.corridaDetalle.tipo}-${estado.corridaDetalle.periodo}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      return;
    }
    if (id === 'h-aprobar' || id === 'h-rechazar') {
      const accion = id === 'h-aprobar' ? 'aprobar' : 'rechazar';
      if (!(await showConfirm(`¿${accion === 'aprobar' ? 'Aprobar' : 'Rechazar'} todos los asientos de esta corrida?`))) return;
      try {
        const r = await pedir(`/corridas/${estado.corridaDetalle.id}/revisar`, { method: 'POST', body: JSON.stringify({ accion }) });
        await showAlert(`${r.revisados} asiento(s) ${accion === 'aprobar' ? 'aprobados' : 'rechazados'}.${r.omitidos.length ? ` ${r.omitidos.length} se omitieron.` : ''}`);
        estado.corridaDetalle = await pedir(`/corridas/${estado.corridaDetalle.id}`);
        await render();
      } catch (err) { alert(err.message); }
      return;
    }
    if (id === 'h-anular') {
      const motivo = prompt('¿Por qué se anula la corrida? (queda en el registro)');
      if (!motivo || motivo.trim().length < 5) return;
      if (!(await showConfirm('Se van a revertir TODOS los asientos de la corrida con fecha de hoy. ¿Seguimos?'))) return;
      try {
        const r = await pedir(`/corridas/${estado.corridaDetalle.id}/anular`, { method: 'POST', body: JSON.stringify({ motivo }) });
        await showAlert(`Anulada: ${r.anulados} asiento(s) revertidos.`);
        estado.corridaDetalle = null;
        await render();
      } catch (err) { alert(err.message); }
    }
  });

  // ─── CSS ───────────────────────────────────────────────────────────────────

  async function vistaCSS() {
    const meses = estado.mesesCSS || 6;
    if (!estado.parametros) estado.parametros = await pedir('/parametros');
    // El catálogo, para nombrar la cuenta que se debita con cada monto.
    if (!estado.catalogo) estado.catalogo = await pedir('/cuentas');
    const r = await pedir(`/css?meses=${meses}`);
    // El botón "traer los montos del mes" lee de acá, sin volver a pedir.
    estado.cssActual = r;
    const bancos = estado.parametros.bancos || [];

    // Cada monto dice a qué cuenta va: es la que se debita, y verla al lado del
    // importe es lo que hace evidente cuándo el pasivo del patrono está cayendo en
    // la cuenta del obrero por no estar configurado.
    const nombreCuenta = (campo) => {
      const id = estado.parametros?.cuentas?.[campo];
      const c = (estado.catalogo || []).find((x) => x.id === id);
      return c ? `${c.code} ${c.name}` : 'sin cuenta configurada';
    };
    const campoPago = (id, label, campo) => `
      <div><label>${label}</label>
        <input id="${id}" type="number" step="0.01" value="0">
        <div class="nota" style="margin-top:2px">${esc(nombreCuenta(campo))}</div></div>`;

    const mesActual = isoDe(new Date()).slice(0, 7);
    const filas = r.meses.map((m) => `
      <tr>
        <td>${esc(m.etiqueta)}</td>
        <td class="num">${num(m.ss)}</td>
        <td class="num">${num(m.ssPatronal)}</td>
        <td class="num">${num(m.riesgosPatronal)}</td>
        <td class="num"><b>${num(m.totalSS)}</b></td>
        <td class="num">${num(m.se)}</td>
        <td class="num">${num(m.sePatronal)}</td>
        <td class="num"><b>${num(m.totalSE)}</b></td>
        <td class="num">${num(m.isr)}</td>
        <td>${m.obligacion
          ? `<span class="badge ${m.obligacion.status === 'COMPLETED' ? 'badge-ok' : 'badge-warn'}">${esc(m.obligacion.status)}</span>
             <br><span class="nota">vence ${String(m.obligacion.dueDate).slice(0, 10)}${m.obligacion.estimatedAmount != null ? ` · ${num(m.obligacion.estimatedAmount)}` : ''}</span>`
          : '<span class="nota">fuera del calendario</span>'}</td>
        <td><button class="btn btn-secondary btn-sm" data-valorar="${esc(m.periodo)}">Valorar</button></td>
      </tr>`).join('');

    return `
      <div class="summary-cards">
        <div class="summary-card err"><div class="num">${num(r.saldo.ss)}</div><div class="label">Seguro Social por pagar</div></div>
        <div class="summary-card warn"><div class="num">${num(r.saldo.se)}</div><div class="label">Seguro Educativo por pagar</div></div>
        <div class="summary-card warn"><div class="num">${num(r.saldo.isr)}</div><div class="label">ISR retenido por pagar</div></div>
      </div>
      ${avisos(r.avisos)}
      <div class="card">
        <h3>Aportes por mes</h3>
        <div class="form-grid" style="grid-template-columns:200px">
          <div><label>Últimos meses</label>
            <select id="css-meses">${[3, 6, 12, 24].map((n) => `<option value="${n}" ${n === meses ? 'selected' : ''}>${n} meses</option>`).join('')}</select></div>
        </div>
        <table class="data-table" style="margin-top:12px">
          <thead><tr><th>Mes</th><th class="num">SS obrero</th><th class="num">SS patrono</th><th class="num">Riesgos</th>
            <th class="num">Total SS</th><th class="num">SE obrero</th><th class="num">SE patrono</th><th class="num">Total SE</th>
            <th class="num">ISR retenido</th><th>Obligación</th><th></th></tr></thead>
          <tbody>${filas}</tbody>
        </table>
        <p class="nota">El saldo de arriba suma TODOS los períodos, no solo los meses que se muestran: es lo que se le debe a la CSS hoy.</p>
      </div>

      <div class="card">
        <h3>Registrar el pago a la CSS</h3>
        <div class="form-grid">
          <div><label>Período</label><input id="p-periodo" placeholder="AAAA-MM" value="${mesActual}"></div>
          <div><label>Fecha del pago</label><input type="date" id="p-fecha" value="${hoy()}"></div>
          <div><label>Banco</label>
            <select id="p-banco">${bancos.map((b) => `<option value="${esc(b.id)}">${esc(b.code + ' ' + b.name)}</option>`).join('')}</select></div>
          <div><label>Referencia</label><input id="p-ref" placeholder="opcional"></div>
        </div>

        <h3 style="margin-top:18px">Montos por concepto</h3>
        <div class="form-grid tres">
          ${campoPago('p-ss-obrero', 'Seguro Social obrero', 'ss')}
          ${campoPago('p-ss-patronal', 'Seguro Social patrono', 'ssPatronal')}
          ${campoPago('p-riesgos', 'Riesgos profesionales', 'riesgosPatronal')}
          ${campoPago('p-se-obrero', 'Seguro Educativo obrero', 'se')}
          ${campoPago('p-se-patronal', 'Seguro Educativo patrono', 'sePatronal')}
          ${campoPago('p-isr', 'ISR retenido', 'isr')}
        </div>
        <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="p-pagar" ${bancos.length ? '' : 'disabled'}>Registrar el pago</button>
          <button class="btn btn-secondary" id="p-traer">Traer los montos del mes</button>
        </div>
        <p class="nota">Cada concepto debita SU cuenta por pagar contra el banco, en BORRADOR. Van separados porque el pasivo de la CSS puede estar partido en subcuentas —obrero, patrono y riesgos—: con un solo monto, la subcuenta del patrono se acreditaría y nunca bajaría. Marca la obligación CSS del calendario fiscal como cumplida.</p>
      </div>`;
  }

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'css-meses') { estado.mesesCSS = Number(e.target.value); await render(); }
  });

  document.addEventListener('click', async (e) => {
    const valorar = e.target.dataset?.valorar;
    if (valorar) {
      try {
        const r = await pedir(`/css/${valorar}/valorar`, { method: 'POST' });
        await showAlert(r.actualizada ? `Obligación valorizada en ${num(r.monto)}.` : `${num(r.monto)} calculado, pero no se actualizó: ${r.motivo}`);
        await render();
      } catch (err) { alert(err.message); }
      return;
    }
    if (e.target.id === 'p-traer') {
      // Prellena con lo devengado del mes elegido, CONCEPTO POR CONCEPTO: los montos
      // de la tabla de arriba son los mismos que se debitan, y así el pago descarga
      // cada subcuenta del pasivo con lo que se acreditó en el mes. El ISR que se
      // trae es el RETENIDO, no el que la empresa paga por su propia renta: son
      // cuentas distintas y confundirlas descuadraría el pasivo del empleado.
      const periodo = $('p-periodo').value.trim();
      const mes = (estado.cssActual?.meses || []).find((m) => m.periodo === periodo);
      if (!mes) { alert(`No hay corridas en ${periodo}.`); return; }
      $('p-ss-obrero').value = mes.ss;
      $('p-ss-patronal').value = mes.ssPatronal;
      $('p-riesgos').value = mes.riesgosPatronal;
      $('p-se-obrero').value = mes.se;
      $('p-se-patronal').value = mes.sePatronal;
      $('p-isr').value = mes.isr;
      return;
    }
    if (e.target.id === 'p-pagar') {
      const cuerpo = {
        periodo: $('p-periodo').value.trim(),
        fecha: $('p-fecha').value,
        bancoCuentaId: $('p-banco').value,
        montoSSObrero: Number($('p-ss-obrero').value) || 0,
        montoSSPatronal: Number($('p-ss-patronal').value) || 0,
        montoRiesgos: Number($('p-riesgos').value) || 0,
        montoSEObrero: Number($('p-se-obrero').value) || 0,
        montoSEPatronal: Number($('p-se-patronal').value) || 0,
        montoISR: Number($('p-isr').value) || 0,
        referencia: $('p-ref').value.trim() || undefined,
      };
      try {
        const r = await pedir('/css/pago', { method: 'POST', body: JSON.stringify(cuerpo) });
        await showAlert(`Pago registrado por ${num(r.total)}.${r.obligacionMarcada ? ' La obligación quedó marcada como cumplida.' : ''} El asiento está en BORRADOR.`);
        await render();
      } catch (err) { alert(err.message); }
    }
  });

  // ─── Cuadre ────────────────────────────────────────────────────────────────

  async function vistaCuadre() {
    const anio = new Date().getFullYear();
    const desde = estado.cuadreDesde || `${anio}-01-01`;
    const hasta = estado.cuadreHasta || hoy();
    const c = await pedir(`/cuadre?desde=${desde}&hasta=${hasta}`);

    const fila = (etiqueta, mayor, devengado, pagado) => `
      <tr><td>${etiqueta}</td><td class="num">${num(devengado)}</td><td class="num">${num(pagado)}</td>
        <td class="num"><b>${num(mayor)}</b></td></tr>`;

    const dif = c.neto.diferencia;
    const cuadra = Math.abs(dif) < 0.01;

    return `
      <div class="card">
        <h3>Cuadre contra el mayor</h3>
        <div class="form-grid" style="grid-template-columns:200px 200px">
          <div><label>Desde</label><input type="date" id="q-desde" value="${desde}"></div>
          <div><label>Hasta</label><input type="date" id="q-hasta" value="${hasta}"></div>
        </div>
        <p class="nota">Compara lo que las corridas dicen con lo que quedó en la contabilidad. <b>No arregla nada</b>: muestra la diferencia para que la mires.</p>
      </div>

      ${avisos(c.avisos, 'err')}
      ${c.avisos.length === 0 ? '<div class="aviso ok">Todo cuadra en el período.</div>' : ''}

      <div class="summary-cards">
        <div class="summary-card"><div class="num">${c.corridas.total}</div><div class="label">Corridas (${c.corridas.ejecutadas} ejecutadas)</div></div>
        <div class="summary-card"><div class="num">${num(c.neto.corridas)}</div><div class="label">Neto según las corridas</div></div>
        <div class="summary-card"><div class="num">${num(c.neto.banco)}</div><div class="label">Debitado a los bancos</div></div>
        <div class="summary-card ${cuadra ? 'ok' : 'err'}"><div class="num">${num(dif)}</div><div class="label">Diferencia</div></div>
      </div>

      <div class="card">
        <h3>Pasivos: el mayor contra lo que devengó el módulo</h3>
        <table class="data-table">
          <thead><tr><th>Concepto</th><th class="num">Devengado (histórico)</th><th class="num">Pagado</th><th class="num">Saldo en el mayor</th></tr></thead>
          <tbody>
            ${fila('Seguro Social', c.pasivos.ss.mayor, c.pasivos.ss.devengado, c.pasivos.ss.pagado)}
            ${fila('Seguro Educativo', c.pasivos.se.mayor, c.pasivos.se.devengado, c.pasivos.se.pagado)}
            ${fila('ISR retenido', c.pasivos.isr.mayor, c.pasivos.isr.devengado, c.pasivos.isr.pagado)}
          </tbody>
        </table>
        <p class="nota">Pagar solo puede bajar la cuenta, así que un saldo mayor que lo devengado solo se explica con algo acreditado por fuera del módulo.</p>
      </div>

      <div class="card">
        <h3>Asientos de planilla en el período</h3>
        <p class="nota">${Object.entries(c.asientos).map(([k, v]) => `${v} ${esc(k.toLowerCase())}`).join(' · ') || 'Sin asientos.'}</p>
        ${c.itemsProblematicos.length ? `
          <table class="data-table" style="margin-top:10px">
            <thead><tr><th>Empleado</th><th>Corrida</th><th>Período</th><th>Estado</th></tr></thead>
            <tbody>${c.itemsProblematicos.map((i) => `<tr><td>${esc(i.empleado)}</td><td>${esc(i.corrida)}</td>
              <td>${esc(i.periodo)}</td><td><span class="badge ${ESTADO_BADGE[i.estado] || 'badge-err'}">${esc(i.estado)}</span></td></tr>`).join('')}</tbody>
          </table>
          <p class="nota">Su corrida sigue contando para los acumulados aunque el asiento no esté vivo: si el rechazo fue por un error, hay que anular la corrida y rehacerla.</p>` : ''}
      </div>

      <div class="card">
        <h3>Empleados activos sin corrida en el período (${c.sinCorrida.length})</h3>
        ${c.sinCorrida.length
          ? `<table class="data-table"><thead><tr><th>Empleado</th><th>Tipo de pago</th></tr></thead>
             <tbody>${c.sinCorrida.map((e) => `<tr><td>${esc(e.nombre)}</td><td>${esc(etiquetaTipoPago(e.tipoPago))}</td></tr>`).join('')}</tbody></table>`
          : '<p class="nota">Todos los empleados activos tienen al menos una corrida en el período.</p>'}
        <p class="nota">Es el olvido más caro porque no genera ningún error: nadie reclama hasta que no le pagan.</p>
      </div>`;
  }

  document.addEventListener('change', async (e) => {
    if (e.target.id === 'q-desde') { estado.cuadreDesde = e.target.value; await render(); }
    if (e.target.id === 'q-hasta') { estado.cuadreHasta = e.target.value; await render(); }
  });

  // ─── Parámetros ────────────────────────────────────────────────────────────

  async function vistaParametros() {
    // El catálogo se pide acá y no al cargar el archivo: si el usuario abre
    // Parámetros antes de que llegue, los selectores quedarían vacíos para siempre.
    if (!estado.catalogo) estado.catalogo = await pedir('/cuentas');
    const r = await pedir('/parametros');
    estado.parametros = r;
    const s = r.settings;
    // OJO: `r.cuentas` va por CONCEPTO (`sueldo`, `ss`) y con los respaldos ya
    // aplicados; lo que estos selectores escriben son los campos de `Company`
    // (`planillaSueldoId`). Pre-seleccionar con el primero los dejaba todos en blanco
    // y cada guardado borraba las cuentas que no se volvieran a elegir.
    const configuradas = r.configuradas || {};

    const camposCuenta = [
      ['planillaSueldoId', 'Sueldo'], ['planillaHorasExtrasId', 'Horas extras'],
      ['planillaDecimoId', 'Décimo III (pasivo)'], ['planillaVacacionesId', 'Vacaciones (pasivo)'],
      ['planillaSSId', 'Seguro Social (pasivo)'], ['planillaSEId', 'Seguro Educativo (pasivo)'],
      ['planillaISRId', 'ISR (pasivo)'], ['planillaBancoId', 'Neto a banco'],
      ['planillaOtrasDeduccionesId', 'Otras deducciones'],
    ];

    // El pasivo del patrono es UNA CUENTA POR CONCEPTO: el pago a la CSS descarga
    // cada una con su monto, así que las tres tienen que ser configurables. Sin
    // configurar caen al pasivo del obrero (es el mismo pago), y eso se ve: el
    // selector dice a dónde está cayendo cada uno.
    const camposPasivoPatrono = [
      ['planillaSSPatronalId', 'SS del patrono'], ['planillaSEPatronalId', 'SE del patrono'],
      ['planillaRiesgosPatronalId', 'Riesgos Profesionales'],
    ];
    const camposGastoPatrono = [
      ['planillaSSPatronalGastoId', 'SS del patrono'], ['planillaSEPatronalGastoId', 'SE del patrono'],
      ['planillaRiesgosProfesionalesId', 'Riesgos Profesionales'],
    ];

    const selectorCuenta = ([campo, label]) => `
      <div><label>${label}</label>
        <select class="cuenta" data-campo="${campo}">
          <option value="">— sin configurar —</option>
          ${estado.catalogo.map((c) => `<option value="${esc(c.id)}" ${configuradas[campo] === c.id ? 'selected' : ''}>${esc(c.code + ' ' + c.name)}</option>`).join('')}
        </select></div>`;

    return `
      ${avisos(r.avisos)}
      ${r.faltantes.length ? avisos(r.faltantes.map((f) => `Falta la cuenta de ${f.etiqueta}.`), 'err') : ''}

      <div class="card">
        <h3>Tasas</h3>
        <div class="form-grid">
          <div><label>SS empleado — sueldo</label><input id="t-ssobrero" type="number" step="0.0001" value="${s.ssObrero}"></div>
          <div><label>SE empleado — sueldo</label><input id="t-seobrero" type="number" step="0.0001" value="${s.seObrero}"></div>
          <div><label>SS patrono — sueldo</label><input id="t-sspatronal" type="number" step="0.0001" value="${s.ssPatronal}"></div>
          <div><label>SE patrono — sueldo</label><input id="t-sepatronal" type="number" step="0.0001" value="${s.sePatronal}"></div>
          <div><label>SS empleado — décimo</label><input id="t-ssdecimo" type="number" step="0.0001" value="${s.ssObreroDecimo}"></div>
          <div><label>SS patrono — décimo</label><input id="t-sspatdecimo" type="number" step="0.0001" value="${s.ssPatronalDecimo}"></div>
          <div><label>Factor décimo (1/12)</label><input id="t-fdecimo" type="number" step="0.0000000001" value="${s.factorDecimo}"></div>
          <div><label>Factor vacaciones (1/12)</label><input id="t-fvac" type="number" step="0.0000000001" value="${s.factorVacaciones}"></div>
          <div><label>Factor prima (1/52)</label><input id="t-fprima" type="number" step="0.0000000001" value="${s.factorPrima}"></div>
        </div>
        <div class="form-grid" style="margin-top:14px">
          <div><label>Día del pago semanal</label>
            <select id="t-diapago">
              ${(r.diasSemana || ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'])
                .map((d, i) => `<option value="${i}" ${Number(s.diaPagoSemanal) === i ? 'selected' : ''}>${d}</option>`).join('')}
            </select></div>
        </div>
        <label style="display:flex;gap:8px;align-items:center;margin-top:14px;font-size:13px">
          <input type="checkbox" id="t-provisionar" ${s.provisionarPrestaciones ? 'checked' : ''} style="width:auto">
          Contabilizar la provisión de prestaciones (décimo, vacaciones y prima por pagar)
        </label>
        <p class="nota">Las tasas se guardan como decimal: 9,75% es 0.0975. El sueldo base es mensual, así que una quincena es la mitad — o los días exactos del mes— y una semana es <b>mensual × 12/52</b> (52 semanas de 7 días son 364, no 365). El día del pago semanal es el que fija cuántos pagos tiene el mes —4 o 5— y con eso el ISR del mes cierra exacto.</p>
      </div>

      <div class="card">
        <h3>Riesgos profesionales por clase</h3>
        <div class="form-grid">
          <div><label>Tasa general (empleados sin clase)</label><input id="t-riesgos" type="number" step="0.0001" value="${s.riesgosProfesionales}"></div>
          ${(r.clasesRiesgo || []).map((c) => `
            <div><label>Clase ${c}</label>
              <input class="riesgo-clase" data-clase="${c}" type="number" step="0.0001"
                value="${s.riesgosPorClase[c] != null ? s.riesgosPorClase[c] : ''}" placeholder="sin tarifa"></div>`).join('')}
        </div>
        <p class="nota">Una clase sin tarifa <b>rechaza</b> la fila de ese empleado en la corrida, en vez de asumir cero: un cero silencioso subvaluaría el pasivo del patrono y nadie lo notaría. Dejá el campo vacío para que siga sin tarifa.</p>
      </div>

      <div class="card">
        <h3>Escala anual del ISR</h3>
        <table class="data-table">
          <thead><tr><th class="num">Desde</th><th class="num">Hasta</th><th class="num">Tasa</th></tr></thead>
          <tbody>${s.tablaISR.map((t, i) => `<tr>
            <td class="num"><input class="celda isr-tramo" data-i="${i}" data-c="desde" value="${t.desde}"></td>
            <td class="num"><input class="celda isr-tramo" data-i="${i}" data-c="hasta" value="${t.hasta == null ? '' : t.hasta}" placeholder="sin tope"></td>
            <td class="num"><input class="celda isr-tramo" data-i="${i}" data-c="tasa" value="${t.tasa}"></td>
          </tr>`).join('')}</tbody>
        </table>
        <p class="nota">La escala es ANUAL y el impuesto del mes es el anual dividido entre 13 — porque el décimo también es renta gravable. Es lo que hace que el décimo se pague sin retención de ISR.</p>
      </div>

      <div class="card">
        <h3>Cuentas contables</h3>
        <div class="form-grid">${camposCuenta.map(selectorCuenta).join('')}</div>

        <h3 style="margin-top:18px">Pasivo del patrono (por pagar)</h3>
        <div class="form-grid tres">${camposPasivoPatrono.map(selectorCuenta).join('')}</div>
        <p class="nota">Una cuenta por concepto. Sin configurar caen al pasivo del obrero —a la CSS se le paga todo junto— y el pago de la pestaña CSS debita cada una con su monto: si el catálogo está partido y no las configurás, las subcuentas se acreditan y nunca bajan.</p>

        <h3 style="margin-top:18px">Gasto del patrono</h3>
        <div class="form-grid tres">${camposGastoPatrono.map(selectorCuenta).join('')}</div>
        <p class="nota">Se resuelven solas por código del catálogo (6.01.02.01/.02/.03) cuando no están configuradas acá, y de última caen al gasto patronal genérico o a Sueldos — avisando en cada caso. Las cuentas de Décimo, Vacaciones y Prestaciones por pagar también se resuelven solas por código (2.1.10/2.1.11/2.1.09).</p>
      </div>

      <button class="btn btn-primary" id="t-guardar">Guardar parámetros</button>`;
  }

  document.addEventListener('click', async (e) => {
    if (e.target.id !== 't-guardar') return;
    const n = (id) => Number($(id).value);
    const tablaISR = [...document.querySelectorAll('.isr-tramo')].reduce((acc, el) => {
      const i = Number(el.dataset.i);
      acc[i] = acc[i] || {};
      const v = el.value.trim();
      if (el.dataset.c === 'hasta') acc[i].hasta = v === '' ? null : Number(v);
      else acc[i][el.dataset.c] = Number(v);
      return acc;
    }, []);

    const riesgosPorClase = {};
    document.querySelectorAll('.riesgo-clase').forEach((el) => {
      const v = el.value.trim();
      // Vacío = sin tarifa. Se manda null para que el servidor lo OMITA en vez de
      // guardar un cero, que el motor leería como una tarifa del 0%.
      riesgosPorClase[el.dataset.clase] = v === '' ? null : Number(v);
    });

    const cuentas = {};
    document.querySelectorAll('.cuenta').forEach((el) => { cuentas[el.dataset.campo] = el.value || null; });

    const cuerpo = {
      ssObrero: n('t-ssobrero'), seObrero: n('t-seobrero'),
      ssPatronal: n('t-sspatronal'), sePatronal: n('t-sepatronal'),
      ssObreroDecimo: n('t-ssdecimo'), ssPatronalDecimo: n('t-sspatdecimo'),
      riesgosProfesionales: n('t-riesgos'),
      factorDecimo: n('t-fdecimo'), factorVacaciones: n('t-fvac'), factorPrima: n('t-fprima'),
      provisionarPrestaciones: $('t-provisionar').checked,
      diaPagoSemanal: Number($('t-diapago').value),
      tablaISR, riesgosPorClase, cuentas,
    };
    try {
      await pedir('/parametros', { method: 'PUT', body: JSON.stringify(cuerpo) });
      await showAlert('Parámetros guardados.');
      estado.parametros = null;
      await render();
    } catch (err) { alert(err.message); }
  });

})();
