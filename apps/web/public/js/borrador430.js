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
    </div>`;

  return controles + b430Avisos(d) + b430Cards(d) + b430Renglones(d) + b430Liquidacion(d) + b430Retenciones(d) + b430Detalle(d) + b430NoClasificados(d);
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
