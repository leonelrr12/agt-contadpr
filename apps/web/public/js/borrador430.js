// borrador430.js — pestaña 🧾 Form. 430: borrador de la declaración mensual de
// ITBMS calculado del libro. Vive dentro del panel Informes (informes.js la carga
// desde los mapas `loaders`, que están duplicados a propósito: hay que tocar los dos).
//
// El informe es de SOLO LECTURA: enseña los renglones del formulario, las bases
// reconstruidas y el cuadre contra el movimiento de la cuenta de ITBMS, para que el
// contador lo compare con el formulario real antes de que el sistema contabilice la
// declaración. No crea asientos.

let _b430Year = null;
let _b430Mes = null;
let _b430AnioFiscal = null;
/** Declaración viva del período que se está mirando (o null). */
let _b430Decl = null;
/** Retenciones aplicables al renglón 52 y lo que espera certificado. */
let _b430Ret = null;

const B430_MESES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const B430_BUCKET = {
  VENTA: { texto: 'Venta', color: '#059669' },
  COMPRA: { texto: 'Compra', color: '#1565c0' },
  NOTA_CREDITO_COMPRA: { texto: 'Devolución a proveedor', color: '#b45309' },
  PAGO_DGI: { texto: 'Pago a la DGI', color: '#6b7280' },
  COMPENSACION_R52: { texto: 'Compensación R52', color: '#7c3aed' },
  AJUSTE: { texto: 'Ajuste', color: '#b45309' },
  NO_CLASIFICADO: { texto: 'Sin clasificar', color: '#c62828' },
};

const B430_CONFIANZA = {
  ALTA: { texto: '✅ Alta', color: '#059669' },
  MEDIA: { texto: '⚠️ Media', color: '#b45309' },
  BAJA: { texto: '🔍 Baja', color: '#c62828' },
};

const B430_AVISO = {
  SIN_CLASIFICAR: { icono: '🔴', fondo: '#fef2f2', borde: '#fecaca', tinta: '#991b1b' },
  SIN_CUENTA_ITBMS: { icono: '🔴', fondo: '#fef2f2', borde: '#fecaca', tinta: '#991b1b' },
  BORRADORES_INCLUIDOS: { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  BASE_NO_DERIVABLE: { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  ASIENTO_MIXTO: { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  ANULACION_DE_OTRO_MES: { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  CUENTA_RETENCION_NO_RESUELTA: { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  'CIERRE_EN_2.1.05': { icono: '⚠️', fondo: '#fffbeb', borde: '#fde68a', tinta: '#92400e' },
  TASA_ATIPICA: { icono: 'ℹ️', fondo: '#eff6ff', borde: '#bfdbfe', tinta: '#1e40af' },
  ANULACIONES: { icono: 'ℹ️', fondo: '#eff6ff', borde: '#bfdbfe', tinta: '#1e40af' },
};

function b430Money(n) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−$' : '$') + s;
}

/** Base gravada: `null` es «no se pudo reconstruir», y eso NO es cero. */
function b430Base(n) {
  return n === null || n === undefined ? '—' : b430Money(n);
}

function b430Fecha(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/* ── Entrada del panel ── */
async function loadReportBorrador430() {
  const el = document.getElementById('informes-inline-result');
  if (!el) return;
  el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Cargando borrador del 430...</div>';
  const q = new URLSearchParams();
  if (_b430Year) q.set('year', String(_b430Year));
  if (_b430Mes) q.set('mes', String(_b430Mes));
  let d;
  try {
    const res = await authFetch(`${API_URL}/reports/borrador-430${q.toString() ? '?' + q.toString() : ''}`);
    if (!res.ok) throw new Error('Error al cargar');
    d = await res.json();
  } catch {
    el.innerHTML = '<div style="text-align:center;padding:32px;color:#6b7280">Error al cargar el borrador del 430.</div>';
    return;
  }
  _b430Year = d.periodo.year;
  _b430Mes = d.periodo.mes;
  _b430AnioFiscal = d.periodo.anioFiscal;

  // La declaración del período se pide aparte: si falla, el informe se pinta igual.
  _b430Decl = null;
  _b430Ret = null;
  try {
    const rd = await authFetch(`${API_URL}/declaraciones-itbms/periodo/${d.periodo.start.slice(0, 7)}`);
    if (rd.ok) {
      const jd = await rd.json();
      _b430Decl = jd.declaracion || null;
      _b430Ret = jd.retenciones || null;
    }
  } catch { /* sin declaración: el borrador es la vista */ }

  el.innerHTML = b430Html(d);
  // La barra de export GLOBAL vive dentro de #informes-date-filter, que se oculta en
  // esta pestaña (no usa el filtro de fechas): sus botones quedarían invisibles. Los
  // del 430 van en la barra del propio informe, junto al período y el vencimiento.
  setInformesExportBar(null);
}

async function b430CambiarPeriodo(year, mes) {
  _b430Year = Number(year);
  _b430Mes = Number(mes);
  await loadReportBorrador430();
}

/* ── Render ── */
function b430Html(d) {
  const años = [];
  for (let a = _b430AnioFiscal - 2; a <= _b430AnioFiscal + 1; a++) años.push(a);
  if (!años.includes(_b430Year)) años.push(_b430Year);
  años.sort();

  const l = d.liquidacion;
  const total = l.totalAPagar;
  const colorTotal = total > 0 ? '#b45309' : '#059669';

  const controles = `
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px">
      <label style="font-size:12px;color:#6b7280">Año
        <select onchange="b430CambiarPeriodo(this.value, ${_b430Mes})" style="margin-left:6px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff">
          ${años.map((a) => `<option value="${a}"${a === _b430Year ? ' selected' : ''}>${a}${a === _b430AnioFiscal ? ' (fiscal)' : ''}</option>`).join('')}
        </select>
      </label>
      <label style="font-size:12px;color:#6b7280">Mes
        <select onchange="b430CambiarPeriodo(${_b430Year}, this.value)" style="margin-left:6px;padding:5px 8px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff">
          ${B430_MESES.map((m, i) => `<option value="${i + 1}"${i + 1 === _b430Mes ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
      </label>
      <span style="flex:1"></span>
      <span style="font-size:12px;color:#6b7280">${d.periodo.label} · vence el <b>${b430Fecha(d.periodo.vence)}</b></span>
      <button onclick="exportInforme('borrador-430','xlsx')" title="Descargar el borrador en Excel" style="padding:5px 12px;font-size:11px;background:#1565c0;color:#fff;border:none;border-radius:4px;cursor:pointer">📥 Excel</button>
      <button onclick="exportInforme('borrador-430','csv')" title="Descargar el borrador en CSV" style="padding:5px 12px;font-size:11px;background:#333;color:#fff;border:none;border-radius:4px;cursor:pointer">CSV</button>
    </div>
    ${b430BarraDeclaracion(d)}`;

  return controles + b430Avisos(d) + b430Declarado(d) + b430Cards(d) + b430Renglones(d) + b430Liquidacion(d) + b430Retenciones(d) + b430Detalle(d) + b430NoClasificados(d);
}

/** Franja de avisos + el cuadre. El descuadre va primero y en rojo. */
function b430Avisos(d) {
  const partes = [];
  if (!d.cuadre.cuadra) {
    partes.push(`
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:12px;color:#991b1b">
        🔴 <b>El informe no cuadra con el mayor.</b>
        Movimiento del mes en la cuenta: ${b430Money(d.cuadre.movimientoLibroMes)} ·
        suma de renglones: ${b430Money(d.cuadre.sumaDeBuckets)} ·
        diferencia: ${b430Money(d.cuadre.diferencia)}${d.noClasificados.length ? ` · ${d.noClasificados.length} asiento(s) sin clasificar` : ''}.
        Revísalo antes de usarlo.
      </div>`);
  } else {
    partes.push(`
      <div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:#065f46">
        ✅ Cuadra con el mayor: ${d.cuadre.asientos} asiento(s), movimiento del mes ${b430Money(d.cuadre.movimientoLibroMes)}.
      </div>`);
  }
  for (const a of d.avisos) {
    const s = B430_AVISO[a.codigo] || { icono: 'ℹ️', fondo: '#f9fafb', borde: '#e5e7eb', tinta: '#374151' };
    partes.push(`
      <div style="background:${s.fondo};border:1px solid ${s.borde};border-radius:8px;padding:8px 12px;margin-bottom:8px;font-size:12px;color:${s.tinta}">
        ${s.icono} ${a.mensaje}
      </div>`);
  }
  return partes.join('');
}

function b430Card(etiqueta, valor, color, nota) {
  return `<div style="background:#fff;border-radius:8px;padding:12px 14px">
    <div style="font-size:11px;color:#6b7280">${etiqueta}</div>
    <div style="font-size:19px;font-weight:700;color:${color || '#1a1a2e'}">${valor}</div>
    ${nota ? `<div style="font-size:10px;color:#9ca3af">${nota}</div>` : ''}
  </div>`;
}

function b430Cards(d) {
  const l = d.liquidacion;
  const aFavor = l.totalAPagar < 0;
  return `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px">
      ${b430Card('Débito fiscal (ventas)', b430Money(l.debitoFiscal), '#1a1a2e', `${b430Money(d.bases.ventasGravadas)} de base gravada`)}
      ${b430Card('Crédito fiscal (compras)', b430Money(l.creditoFiscal), '#1565c0', `${b430Money(d.bases.comprasGravadas)} de base gravada`)}
      ${b430Card('Retenciones por aplicar (R52)', b430Money(l.renglon52), '#7c3aed', `${d.retenciones.registrosDelMes} en el mes · ${b430Money(d.retenciones.pendienteCertificado)} sin certificado`)}
      ${b430Card(aFavor ? 'Saldo a favor (se arrastra)' : 'Total a pagar', b430Money(l.totalAPagar), aFavor ? '#059669' : '#b45309', `saldo anterior ${b430Money(l.saldoAnterior)}`)}
    </div>`;
}

function b430Renglones(d) {
  const headers = ['Concepto', 'Monto', 'Asientos'];
  const rows = d.renglones
    .filter((r) => r.monto !== 0 || r.asientos > 0)
    .map((r) => {
      const color = r.id === 'noClasificado' && r.monto !== 0 ? '#c62828' : r.signo < 0 ? '#6b7280' : '#1a1a2e';
      const signo = r.signo < 0 && r.monto > 0 ? '− ' : '';
      return [`<span style="color:${color}">${r.etiqueta}</span>`, `<span style="color:${color};font-variant-numeric:tabular-nums">${signo}${b430Money(r.monto)}</span>`, String(r.asientos)];
    });
  return `
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 6px">Renglones del formulario</div>
    ${buildInformesTable(headers, rows)}
    <div style="font-size:11px;color:#9ca3af;margin-top:4px">${d.bases.nota}</div>`;
}

function b430Liquidacion(d) {
  const l = d.liquidacion;
  const fila = (etiqueta, valor, opts = {}) => `<tr style="${opts.borde ? 'border-top:2px solid #1a1a2e;' : ''}${opts.fondo ? 'background:#f9fafb;' : ''}">
      <td style="padding:6px 10px;${opts.fuerte ? 'font-weight:700;' : ''}">${etiqueta}</td>
      <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums;${opts.fuerte ? 'font-weight:700;' : ''}color:${opts.color || '#1a1a2e'}">${b430Money(valor)}</td>
    </tr>`;
  const aFavor = l.totalAPagar < 0;
  return `
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">Liquidación (Form. 430)</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff">
      ${fila('Débito fiscal (ITBMS de ventas)', l.debitoFiscal)}
      ${fila('− Crédito fiscal (ITBMS de compras y gastos)', l.creditoFiscal, { color: '#6b7280' })}
      ${fila('= ITBMS del período', l.sinRetenciones, { fondo: true })}
      ${fila('− Retenciones sufridas por aplicar (R52)', l.renglon52, { color: '#7c3aed' })}
      ${fila('= A pagar del período', l.aPagarMes, { fondo: true })}
      ${fila('+ Saldo anterior (arrastre del mayor)', l.saldoAnterior)}
      ${fila('− Pagos a la DGI ya registrados', l.pagosDelMes, { color: '#6b7280' })}
      ${fila('− Compensaciones R52 ya contabilizadas', l.compensacionesDelMes, { color: '#6b7280' })}
      ${fila(aFavor ? 'SALDO A FAVOR (se arrastra al mes siguiente)' : 'TOTAL A PAGAR', l.totalAPagar, { fuerte: true, borde: true, color: aFavor ? '#059669' : '#b45309' })}
    </table></div>
    <div style="font-size:11px;color:#9ca3af;margin-top:4px">
      El saldo anterior sale del mayor y conserva el signo: si es negativo, es un saldo a favor que arrastra la cuenta.
      La regla del contador (15-10-2026) es que el saldo a favor <b>no se pide en devolución: se arrastra al mes siguiente</b>,
      que es lo que ya hace este informe al recibirlo como saldo anterior.
      ${l.diferenciaVsMayor !== 0 ? ` Diferencia contra el mayor: ${b430Money(l.diferenciaVsMayor)} (ajustes de balance y movimientos sin clasificar).` : ''}
    </div>`;
}

function b430Retenciones(d) {
  const r = d.retenciones;
  if (!r.detalle.length && !r.disponibles && !r.pendienteCertificado) return '';
  const headers = ['Fecha', 'Cliente', 'Certificado', 'Estado', 'Base', 'ITBMS facturado', 'Retenido'];
  const rows = r.detalle.map((x) => [
    b430Fecha(x.fecha),
    x.cliente || '—',
    x.numeroCertificado || '<span style="color:#b45309">sin certificado</span>',
    x.estado,
    b430Money(x.baseGravada),
    b430Money(x.itbmsFacturado),
    b430Money(x.montoRetencion),
  ]);
  const footer = ['', '', '', '', '', '<b>Total del mes</b>', `<b>${b430Money(r.delMes)}</b>`];
  return `
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">Retenciones sufridas — renglón 52 (${b430Money(r.disponibles)} aplicables hoy)</div>
    ${buildInformesTable(headers, rows, footer)}`;
}

function b430DetalleAsiento(a) {
  const b = B430_BUCKET[a.clasificacion] || { texto: a.clasificacion, color: '#6b7280' };
  const conf = B430_CONFIANZA[a.confianza] || { texto: a.confianza, color: '#6b7280' };
  const origen = a.origen ? `${a.origen.icon} ${a.origen.label}${a.origen.detail ? ` · ${a.origen.detail}` : ''}` : 'Sin origen identificado';
  const avisos = (a.avisos || []).length
    ? `<div style="margin-top:6px;font-size:11px;color:#b45309">Avisos: ${a.avisos.join(', ')}</div>`
    : '';
  return `
    <div style="font-size:12px;color:#374151;line-height:1.7">
      <div><b>Por qué cae en «${b.texto}»:</b> ${a.motivo}</div>
      <div>Débito a ITBMS: <b>${b430Money(a.debitoItbms)}</b> · Crédito a ITBMS: <b>${b430Money(a.creditoItbms)}</b> · Efecto en el saldo: <b>${b430Money(a.efectoSaldo)}</b></div>
      <div>Base gravada reconstruida: <b>${b430Base(a.baseGravada)}</b>${a.tasaImplicita !== null ? ` · tasa implícita: <b>${(a.tasaImplicita * 100).toFixed(2)} %</b>` : ''}</div>
      <div>Confianza: <span style="color:${conf.color};font-weight:600">${conf.texto}</span> · Origen: ${origen}${a.esAnulacion ? ' · <span style="color:#b45309">asiento de anulación (reverso)</span>' : ''}</div>
      ${avisos}
    </div>`;
}

function b430Detalle(d) {
  if (!d.detalle.length) return '';
  const headers = ['Fecha', 'Asiento', 'Clasificación', 'Base', 'ITBMS', ''];
  const rows = d.detalle.map((a, i) => {
    const b = B430_BUCKET[a.clasificacion] || { texto: a.clasificacion, color: '#6b7280' };
    const itbms = a.clasificacion === 'VENTA' ? a.creditoItbms : a.debitoItbms || a.efectoSaldo;
    return {
      cells: [
        b430Fecha(a.fecha),
        `<span style="color:#374151">${(a.descripcion || '').slice(0, 90)}</span>${a.status === 'BORRADOR' ? ' <span style="font-size:10px;color:#b45309">borrador</span>' : ''}`,
        `<span style="color:${b.color};font-weight:600">${b.texto}</span>`,
        b430Base(a.baseGravada),
        b430Money(itbms),
        `<button onclick="toggleInformesDetalle('b430-${i}', this)" style="padding:3px 8px;font-size:11px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer">📋 Detalle</button>`,
      ],
      detalleId: `b430-${i}`,
      detalleHtml: b430DetalleAsiento(a),
    };
  });
  return `
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">Detalle por asiento (${d.detalle.length})</div>
    ${buildInformesTable(headers, rows)}`;
}

function b430NoClasificados(d) {
  if (!d.noClasificados.length) return '';
  const headers = ['Fecha', 'Asiento', 'Débito', 'Crédito', 'Por qué no se pudo clasificar'];
  const rows = d.noClasificados.map((a) => [
    b430Fecha(a.fecha),
    (a.descripcion || '').slice(0, 70),
    b430Money(a.debitoItbms),
    b430Money(a.creditoItbms),
    `<span style="color:#c62828">${a.motivo}</span>`,
  ]);
  return `
    <div style="font-size:12px;font-weight:700;color:#c62828;text-transform:uppercase;letter-spacing:.04em;margin:18px 0 6px">Movimientos sin clasificar</div>
    ${buildInformesTable(headers, rows)}`;
}

/* ── La declaración del período: el «informe real» ──
 * El borrador de arriba es lo que dice el libro HOY; esto es lo que se presentó, con
 * su número de formulario y sus asientos. Es una foto: no se recalcula nunca. */

const B430_ESTADO_DECL = {
  BORRADOR: { texto: 'BORRADOR', color: '#b45309', bg: '#fffbeb' },
  PRESENTADA: { texto: 'PRESENTADA', color: '#1565c0', bg: '#eff6ff' },
  PAGADA: { texto: 'PAGADA', color: '#059669', bg: '#ecfdf5' },
  ANULADA: { texto: 'ANULADA', color: '#c62828', bg: '#fef2f2' },
};

const b430Boton = (onclick, texto, color, title) =>
  `<button onclick="${onclick}"${title ? ` title="${title}"` : ''} style="padding:6px 12px;font-size:12px;background:${color};color:#fff;border:none;border-radius:6px;cursor:pointer">${texto}</button>`;

/** Barra de acciones del período, según el estado de la declaración. */
function b430BarraDeclaracion(d) {
  const dec = _b430Decl;
  if (!dec) {
    return `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px">
      <span style="font-size:12px;color:#6b7280">Todavía no hay declaración de <b>${d.periodo.label}</b>: lo de abajo es un borrador de trabajo, no una declaración presentada.</span>
      <span style="flex:1"></span>
      ${b430Boton('b430CrearDeclaracion()', '🧾 Crear declaración', '#1565c0', 'Guarda los renglones de este período para presentarlos ante la DGI')}
    </div>`;
  }
  const e = B430_ESTADO_DECL[dec.estado] || { texto: dec.estado, color: '#6b7280', bg: '#f3f4f6' };
  const datos = [];
  if (dec.numeroFormulario) datos.push(`Form. N° <b>${dec.numeroFormulario}</b>`);
  if (dec.fechaPresentacion) datos.push(`presentada el <b>${b430Fecha(dec.fechaPresentacion)}</b>`);
  if (dec.estado === 'PAGADA') datos.push(`pagada ${b430Money(dec.montoPagado)} el <b>${b430Fecha(dec.fechaPago)}</b>`);
  if (dec.estado === 'ANULADA' && dec.motivoAnulacion) datos.push(`anulada: ${dec.motivoAnulacion}`);

  let acciones = '';
  if (dec.estado === 'BORRADOR') {
    acciones = [
      b430Boton('b430ModalRenglones()', '✏️ Editar renglones', '#6b7280', 'Corregir los renglones antes de presentar'),
      b430Boton('b430ModalPresentar()', '📤 Presentar', '#1565c0', 'Registrar el número de formulario y aplicar el R52'),
      b430Boton('b430Anular()', '🚫 Anular', '#c62828'),
    ].join(' ');
  } else if (dec.estado === 'PRESENTADA') {
    acciones = [
      b430Boton('b430ModalPagar()', '💵 Registrar pago', '#059669'),
      b430Boton('b430Pdf()', '📄 PDF', '#374151'),
      b430Boton('b430Anular()', '🚫 Anular', '#c62828'),
    ].join(' ');
  } else if (dec.estado === 'PAGADA') {
    acciones = [b430Boton('b430Pdf()', '📄 PDF', '#374151'), b430Boton('b430Anular()', '🚫 Anular', '#c62828')].join(' ');
  } else {
    acciones = [b430Boton('b430CrearDeclaracion()', '🧾 Crear de nuevo', '#1565c0'), b430Boton('b430Pdf()', '📄 PDF', '#374151')].join(' ');
  }

  return `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;padding:10px 12px;background:${e.bg};border:1px solid ${e.color}44;border-radius:8px">
    <span style="font-size:11px;font-weight:700;color:${e.color};background:#fff;border:1px solid ${e.color}66;border-radius:10px;padding:2px 10px">${e.texto}</span>
    <span style="font-size:12px;color:#374151">${datos.join(' · ') || 'Sin presentar'}</span>
    <span style="flex:1"></span>
    ${acciones}
  </div>`;
}

/** Los renglones DECLARADOS al lado de lo que dice el libro hoy. */
function b430Declarado(d) {
  const dec = _b430Decl;
  if (!dec) return '';
  const libro = {
    baseVentas: d.bases.ventasGravadas,
    debitoFiscal: (d.renglones.find((r) => r.id === 'debitoFiscal') || {}).monto || 0,
    baseCompras: d.bases.comprasGravadas,
    creditoFiscal: (d.renglones.find((r) => r.id === 'creditoFiscal') || {}).monto || 0,
    retencionAplicada: (d.renglones.find((r) => r.id === 'renglon52') || {}).monto || 0,
    saldoAnterior: d.liquidacion.saldoAnterior,
  };
  const etiquetas = [
    ['baseVentas', 'Base gravada de ventas'],
    ['debitoFiscal', 'Débito fiscal'],
    ['baseCompras', 'Base gravada de compras'],
    ['creditoFiscal', 'Crédito fiscal'],
    ['retencionAplicada', 'Retenciones aplicadas (R52)'],
    ['saldoAnterior', 'Saldo anterior'],
  ];
  const filas = etiquetas.map(([k, etiqueta]) => {
    const dec0 = Number(dec.renglones[k]) || 0;
    const lib = Number(libro[k]) || 0;
    const difiere = dec.estado !== 'BORRADOR' && Math.abs(dec0 - lib) > 0.005;
    return `<tr>
      <td style="padding:5px 10px">${etiqueta}</td>
      <td style="padding:5px 10px;text-align:right;font-variant-numeric:tabular-nums;font-weight:600">${b430Money(dec0)}</td>
      <td style="padding:5px 10px;text-align:right;font-variant-numeric:tabular-nums;color:${difiere ? '#b45309' : '#9ca3af'}">${b430Money(lib)}${difiere ? ' ⚠️' : ''}</td>
    </tr>`;
  }).join('');

  const pendiente = _b430Ret && _b430Ret.pendienteCertificado > 0
    ? `<div style="font-size:11px;color:#b45309;margin-top:6px">Hay ${b430Money(_b430Ret.pendienteCertificado)} en retenciones esperando certificado: no se pueden aplicar al renglón 52 hasta registrarlo (Informes → Retenciones ITBMS).</div>`
    : '';

  return `
    <div style="font-size:12px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;margin:6px 0 6px">Declaración del período</div>
    <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff">
      <thead><tr>
        <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase">Renglón</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase">Declarado</th>
        <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #e5e7eb;font-size:11px;color:#6b7280;text-transform:uppercase">Libro hoy</th>
      </tr></thead>
      <tbody>${filas}</tbody>
      <tfoot><tr style="border-top:2px solid #1a1a2e;font-weight:700">
        <td style="padding:6px 10px">${dec.saldoAFavor ? 'SALDO A FAVOR (se arrastra)' : 'TOTAL A PAGAR'}</td>
        <td style="padding:6px 10px;text-align:right;font-variant-numeric:tabular-nums">${b430Money(dec.saldoAPagar)}</td>
        <td></td>
      </tr></tfoot>
    </table></div>
    <div style="font-size:11px;color:#9ca3af;margin-top:4px">El declarado es lo que se presentó (no se recalcula); la columna «libro hoy» es lo que dice la contabilidad ahora — si difieren, el libro se movió después de declarar.</div>
    ${pendiente}`;
}

/* ── Acciones ── */

function b430Pdf() {
  if (!_b430Decl) return;
  window.open(`${API_URL}/declaraciones-itbms/${_b430Decl.id}/pdf?token=${getToken()}`, '_blank');
}

function b430Dialogo(html) {
  const overlay = document.createElement('div');
  overlay.className = 'app-dialog-overlay';
  overlay.innerHTML = `<div class="app-dialog" style="max-width:560px;text-align:left">${html}</div>`;
  document.body.appendChild(overlay);
  return overlay;
}

const b430Input = (id, valor, opts = {}) =>
  `<input id="${id}" type="${opts.type || 'number'}"${opts.type === 'text' || opts.type === 'date' ? '' : ' step="0.01"'} value="${valor}" ${opts.min ? `min="${opts.min}"` : ''} style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px">`;

const b430Etiqueta = (texto) => `<label style="font-size:11px;color:#6b7280;display:block;margin:10px 0 3px">${texto}</label>`;

const b430Pie = (accion, texto, color) => `
  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
    <button class="app-dialog-btn" onclick="this.closest('.app-dialog-overlay').remove()">Cancelar</button>
    <button class="app-dialog-btn primary" onclick="${accion}" style="background:${color};border-color:${color}">${texto}</button>
  </div>`;

async function b430Enviar(metodo, ruta, body, btn, msgOk) {
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando...'; }
  try {
    const res = await authFetch(`${API_URL}/declaraciones-itbms${ruta}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw d;
    document.querySelectorAll('.app-dialog-overlay').forEach((o) => o.remove());
    await showAlert(`✅ ${msgOk}`);
    await loadReportBorrador430();
    return d;
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Reintentar'; }
    await showAlert(`❌ ${e.error || 'No se pudo completar la operación'}`);
    return null;
  }
}

async function b430CrearDeclaracion() {
  if (!_b430Decl) {
    const ok = await showConfirm(`¿Crear la declaración de ${B430_MESES[_b430Mes - 1]} ${_b430Year} con los renglones de este borrador? Después vas a poder corregirlos antes de presentar.`);
    if (!ok) return;
    await b430Enviar('POST', '/', { year: _b430Year, mes: _b430Mes }, null, 'Declaración creada. Revísala y preséntala cuando esté lista.');
  }
}

function b430ModalRenglones() {
  const dec = _b430Decl;
  if (!dec) return;
  const campo = (k, etiqueta) => b430Etiqueta(etiqueta) + b430Input(`r-${k}`, dec.renglones[k]);
  b430Dialogo(`
    <div style="font-weight:700;font-size:16px;margin-bottom:6px">✏️ Renglones declarados</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:8px">Corrígelos si el formulario que vas a presentar difiere del libro. El total se recalcula solo.</div>
    ${campo('baseVentas', 'Base gravada de ventas')}
    ${campo('debitoFiscal', 'Débito fiscal (ITBMS de ventas)')}
    ${campo('baseCompras', 'Base gravada de compras')}
    ${campo('creditoFiscal', 'Crédito fiscal (ITBMS de compras y gastos)')}
    ${campo('retencionAplicada', 'Retenciones aplicadas (renglón 52)')}
    ${campo('saldoAnterior', 'Saldo anterior (negativo = saldo a favor)')}
    <div style="margin-top:10px;padding:8px 10px;background:#f9fafb;border-radius:6px;font-size:12px">
      Total a pagar = débito − crédito − R52 + saldo anterior =
      <b id="r-total">—</b>
    </div>
    <div style="font-size:11px;color:#9ca3af;margin-top:6px">Al presentar, el renglón 52 tiene que coincidir con las retenciones que de verdad se apliquen.</div>
    ${b430Pie('b430GuardarRenglones(this)', '💾 Guardar', '#1565c0')}`);
  const recalcular = () => {
    const v = (k) => Number(document.getElementById(`r-${k}`).value) || 0;
    const total = v('debitoFiscal') - v('creditoFiscal') - v('retencionAplicada') + v('saldoAnterior');
    document.getElementById('r-total').textContent = b430Money(total);
  };
  ['baseVentas', 'debitoFiscal', 'baseCompras', 'creditoFiscal', 'retencionAplicada', 'saldoAnterior'].forEach((k) => {
    document.getElementById(`r-${k}`).addEventListener('input', recalcular);
  });
  recalcular();
}

async function b430GuardarRenglones(btn) {
  const v = (k) => Number(document.getElementById(`r-${k}`).value) || 0;
  await b430Enviar('PATCH', `/${_b430Decl.id}`, {
    baseVentas: v('baseVentas'),
    debitoFiscal: v('debitoFiscal'),
    baseCompras: v('baseCompras'),
    creditoFiscal: v('creditoFiscal'),
    retencionAplicada: v('retencionAplicada'),
    saldoAnterior: v('saldoAnterior'),
  }, btn, 'Renglones actualizados.');
}

function b430ModalPresentar() {
  const dec = _b430Decl;
  if (!dec) return;
  const ret = _b430Ret || { aplicables: [], pendienteCertificado: 0 };
  const [y, m] = [dec.year, dec.mes];
  const minFecha = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
  const hoy = todayLocalStr();
  const filas = ret.aplicables.length
    ? ret.aplicables.map((r, i) => `
      <label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:12px;border-bottom:1px solid #f3f4f6">
        <input type="checkbox" class="r52-430" data-i="${i}" data-monto="${r.montoRetencion}" checked>
        <span style="flex:1">${b430Fecha(r.fecha)} · ${r.cliente || 'Cliente'} · certificado ${r.numeroCertificado || '—'}</span>
        <b>${b430Money(r.montoRetencion)}</b>
      </label>`).join('')
    : `<div style="font-size:12px;color:#6b7280;padding:6px 0">No hay retenciones con certificado para aplicar.</div>`;
  b430Dialogo(`
    <div style="font-weight:700;font-size:16px;margin-bottom:6px">📤 Presentar la declaración 430</div>
    <div style="font-size:12px;color:#6b7280">Al presentar se registra el número de formulario, se compensa el R52 aplicado y la obligación del calendario queda cumplida.</div>
    ${b430Etiqueta('N° de formulario (el de la DGI)')}${b430Input('pr-numero', '', { type: 'text' })}
    ${b430Etiqueta('Fecha de presentación')}${b430Input('pr-fecha', hoy, { type: 'date', min: minFecha })}
    ${b430Etiqueta('Retenciones a aplicar al renglón 52')}
    <div id="pr-rets" style="max-height:180px;overflow:auto">${filas}</div>
    <div style="margin-top:8px;padding:8px 10px;background:#f9fafb;border-radius:6px;font-size:12px">
      Renglón 52 declarado: <b>${b430Money(dec.renglones.retencionAplicada)}</b> · seleccionado: <b id="pr-total">$0.00</b>
      <div id="pr-aviso" style="display:none;color:#b45309;margin-top:4px"></div>
    </div>
    ${ret.pendienteCertificado > 0 ? `<div style="font-size:11px;color:#b45309;margin-top:6px">Quedan ${b430Money(ret.pendienteCertificado)} en retenciones sin certificado: no se pueden aplicar (regístralas con 📥 en Informes → Retenciones ITBMS).</div>` : ''}
    ${b430Pie('b430ConfirmarPresentar(this)', '📤 Presentar', '#1565c0')}`);

  const total = () => [...document.querySelectorAll('.r52-430')].filter((c) => c.checked).reduce((s, c) => s + Number(c.dataset.monto), 0);
  const pintar = () => {
    const t = Math.round(total() * 100) / 100;
    document.getElementById('pr-total').textContent = b430Money(t);
    const dif = Math.abs(t - Number(dec.renglones.retencionAplicada)) > 0.005;
    const aviso = document.getElementById('pr-aviso');
    aviso.style.display = dif ? '' : 'none';
    aviso.textContent = dif
      ? `El renglón 52 declarado (${b430Money(dec.renglones.retencionAplicada)}) no coincide con lo seleccionado (${b430Money(t)}): corrígelo en «✏️ Editar renglones» o marca las retenciones que falten.`
      : '';
  };
  document.querySelectorAll('.r52-430').forEach((c) => c.addEventListener('change', pintar));
  pintar();
}

async function b430ConfirmarPresentar(btn) {
  const ids = [...document.querySelectorAll('.r52-430')].filter((c) => c.checked)
    .map((c) => (_b430Ret.aplicables[Number(c.dataset.i)] || {}).id).filter(Boolean);
  await b430Enviar('POST', `/${_b430Decl.id}/presentar`, {
    numeroFormulario: document.getElementById('pr-numero').value,
    fechaPresentacion: document.getElementById('pr-fecha').value,
    retencionIds: ids,
  }, btn, 'Declaración presentada.');
}

async function b430ModalPagar() {
  const dec = _b430Decl;
  if (!dec) return;
  let cuentas = [];
  try {
    const res = await authFetch(`${API_URL}/declaraciones-itbms/cuentas-pago`);
    if (res.ok) cuentas = await res.json();
  } catch { /* sin cuentas: el select sale vacío y el guardado avisa */ }
  const opciones = cuentas.map((c) => `<option value="${c.id}">${c.code} ${c.name}</option>`).join('');
  b430Dialogo(`
    <div style="font-weight:700;font-size:16px;margin-bottom:6px">💵 Registrar el pago</div>
    <div style="font-size:12px;color:#6b7280">Se crea el asiento contra el banco (débito ITBMS por Pagar) y la declaración queda pagada.</div>
    ${b430Etiqueta('Monto pagado')}${b430Input('pg-monto', dec.saldoAPagar)}
    ${b430Etiqueta('Cuenta de banco')}
    <select id="pg-cuenta" style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;background:#fff">
      ${opciones || '<option value="">No hay cuentas de banco en el catálogo</option>'}
    </select>
    ${b430Etiqueta('Fecha del pago')}${b430Input('pg-fecha', todayLocalStr(), { type: 'date' })}
    ${b430Pie('b430ConfirmarPago(this)', '💵 Registrar pago', '#059669')}`);
}

async function b430ConfirmarPago(btn) {
  await b430Enviar('POST', `/${_b430Decl.id}/pagar`, {
    monto: Number(document.getElementById('pg-monto').value),
    cuentaBancoId: document.getElementById('pg-cuenta').value,
    fecha: document.getElementById('pg-fecha').value,
  }, btn, 'Pago registrado.');
}

async function b430Anular() {
  const dec = _b430Decl;
  if (!dec) return;
  const que = [];
  if (dec.asientos && dec.asientos.length) que.push(`se creará el asiento espejo de ${dec.asientos.length} asiento(s)`);
  if (dec.retenciones && dec.retenciones.length) que.push(`${dec.retenciones.length} retención(es) vuelven a RECIBIDA`);
  que.push('la obligación del período vuelve a pendiente');
  b430Dialogo(`
    <div style="font-weight:700;font-size:16px;margin-bottom:6px">🚫 Anular la declaración</div>
    <div style="font-size:12px;color:#6b7280">Al anular: ${que.join(', ')}. El número de formulario no se reutiliza y el período queda libre para volver a declarar.</div>
    ${b430Etiqueta('Motivo (queda en la auditoría)')}
    <textarea id="an-motivo" rows="3" style="width:100%;padding:7px 9px;border:1px solid #d1d5db;border-radius:6px;box-sizing:border-box;font-size:13px"></textarea>
    ${b430Pie('b430ConfirmarAnular(this)', '🚫 Anular', '#c62828')}`);
}

async function b430ConfirmarAnular(btn) {
  await b430Enviar('POST', `/${_b430Decl.id}/anular`, { motivo: document.getElementById('an-motivo').value }, btn, 'Declaración anulada.');
}
