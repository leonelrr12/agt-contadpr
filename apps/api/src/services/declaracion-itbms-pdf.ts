/**
 * PDF de la declaración de ITBMS (Formulario 430) — A4 vertical, una hoja.
 *
 * Es la **copia de trabajo** de lo que se presentó: renglones, número de formulario,
 * fecha y los asientos que la declaración creó. No sustituye el acuse de la DGI y el
 * pie lo dice; un borrador sale con la cinta de «NO PRESENTADO» para que nadie lo
 * confunda con el formulario presentado (pasó con el export del informe, que hubo que
 * rotular).
 *
 * Sin Prisma y sin `res`: recibe el documento de pdfkit ya creado, para poder probarlo.
 */

import type PDFKit from 'pdfkit';

const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

export interface DeclaracionPdfData {
  empresa: { name: string; taxId?: string | null };
  declaracion: any; // el read model de `declaracionConDetalle`
  /** Quién y cuándo generó la copia. */
  generadoPor?: string | null;
  ahora?: Date;
}

const money = (n: any) => {
  const v = Number(n) || 0;
  return (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

/** Fecha local (las del sistema son días a mediodía local: no se pasan por UTC). */
const fecha = (d: any) => {
  if (!d) return '—';
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
};

const etiquetaPeriodo = (year: number, mes: number) => `${MESES[mes - 1]} ${year}`;

const ESTADOS: Record<string, string> = {
  BORRADOR: 'BORRADOR — NO PRESENTADO',
  PRESENTADA: 'PRESENTADA',
  PAGADA: 'PRESENTADA Y PAGADA',
  ANULADA: 'ANULADA',
};

export function dibujarDeclaracion430(doc: PDFKit.PDFDocument, data: DeclaracionPdfData): void {
  const d = data.declaracion;
  const r = d.renglones;
  const ancho = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const x0 = doc.page.margins.left;
  let y = doc.y;

  const linea = (yy: number) => doc.moveTo(x0, yy).lineTo(x0 + ancho, yy).lineWidth(0.5).strokeColor('#d1d5db').stroke();

  /** Fila «concepto ....... monto». */
  const fila = (concepto: string, monto: any, opts: { bold?: boolean; color?: string; sangria?: number } = {}) => {
    doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(opts.color || '#111111');
    doc.text(concepto, x0 + (opts.sangria || 0), y, { width: ancho - 110, lineBreak: false });
    doc.text(monto === null ? '—' : money(monto), x0 + ancho - 110, y, { width: 110, align: 'right', lineBreak: false });
    y += 16;
  };

  const seccion = (titulo: string) => {
    y += 8;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280').text(titulo.toUpperCase(), x0, y);
    y += 14;
    linea(y - 4);
  };

  // ── Encabezado ──
  doc.font('Helvetica-Bold').fontSize(15).fillColor('#1a1a2e')
    .text(data.empresa.name, x0, y, { width: ancho, align: 'center' });
  y += 20;
  doc.font('Helvetica').fontSize(10).fillColor('#374151')
    .text(`RUC ${data.empresa.taxId || '—'}`, x0, y, { width: ancho, align: 'center' });
  y += 16;
  doc.font('Helvetica-Bold').fontSize(12)
    .text('Declaración Jurada Mensual de ITBMS — Formulario 430', x0, y, { width: ancho, align: 'center' });
  y += 18;
  doc.font('Helvetica').fontSize(10).fillColor('#374151')
    .text(`Período declarado: ${etiquetaPeriodo(d.year, d.mes)}`, x0, y, { width: ancho, align: 'center' });
  y += 14;
  doc.text(
    d.numeroFormulario
      ? `Formulario N° ${d.numeroFormulario} · presentada el ${fecha(d.fechaPresentacion)}`
      : 'Sin número de formulario (borrador)',
    x0, y, { width: ancho, align: 'center' },
  );
  y += 20;

  // Estado, bien visible: es lo que evita confundir la copia con el formulario.
  const estado = ESTADOS[d.estado] || d.estado;
  const colorEstado = d.estado === 'ANULADA' ? '#c62828' : d.estado === 'BORRADOR' ? '#b45309' : '#059669';
  doc.rect(x0, y, ancho, 20).fill(d.estado === 'ANULADA' ? '#fef2f2' : d.estado === 'BORRADOR' ? '#fffbeb' : '#ecfdf5');
  doc.font('Helvetica-Bold').fontSize(10).fillColor(colorEstado).text(estado, x0, y + 5, { width: ancho, align: 'center' });
  y += 30;

  if (d.estado === 'ANULADA') {
    doc.font('Helvetica').fontSize(9).fillColor('#c62828')
      .text(`Anulada el ${fecha(d.anuladaAt)}${d.motivoAnulacion ? ` — ${d.motivoAnulacion}` : ''}`, x0, y, { width: ancho });
    y += 18;
  }

  // ── Renglones ──
  seccion('Renglones declarados');
  fila('Base gravada de ventas', r.baseVentas);
  fila('Débito fiscal (ITBMS de ventas)', r.debitoFiscal);
  fila('Base gravada de compras', r.baseCompras);
  fila('Crédito fiscal (ITBMS de compras y gastos)', r.creditoFiscal);
  fila('Retenciones sufridas aplicadas (renglón 52)', r.retencionAplicada);
  fila('Saldo anterior (arrastre del libro)', r.saldoAnterior);

  seccion('Liquidación');
  const subtotal = Math.round((r.debitoFiscal - r.creditoFiscal - r.retencionAplicada) * 100) / 100;
  fila('ITBMS del período', subtotal, { sangria: 8 });
  fila(d.saldoAFavor ? 'SALDO A FAVOR (se arrastra al mes siguiente)' : 'TOTAL A PAGAR', d.saldoAPagar, {
    bold: true,
    color: d.saldoAFavor ? '#059669' : '#b45309',
  });
  if (d.saldoAFavor) {
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
      .text('El saldo a favor no se solicita en devolución: se arrastra al mes siguiente.', x0 + 8, y, { width: ancho - 8 });
    y += 14;
  }
  if (d.estado === 'PAGADA') {
    fila('Pagado', d.montoPagado, { color: '#6b7280' });
    doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(`Fecha de pago: ${fecha(d.fechaPago)}`, x0 + 8, y, { width: ancho - 8 });
    y += 14;
  }

  // ── Retenciones aplicadas ──
  const rets: any[] = d.retenciones || [];
  if (rets.length) {
    seccion(`Retenciones aplicadas al renglón 52 (${rets.length})`);
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280');
    doc.text('Fecha', x0, y, { width: 60, lineBreak: false });
    doc.text('Cliente', x0 + 60, y, { width: 170, lineBreak: false });
    doc.text('Certificado', x0 + 230, y, { width: 110, lineBreak: false });
    doc.text('Retenido', x0 + ancho - 80, y, { width: 80, align: 'right', lineBreak: false });
    y += 12;
    for (const x of rets) {
      doc.font('Helvetica').fontSize(8).fillColor('#111111');
      doc.text(fecha(x.fecha), x0, y, { width: 60, lineBreak: false });
      doc.text(String(x.client?.name || '').slice(0, 40), x0 + 60, y, { width: 170, lineBreak: false });
      doc.text(String(x.numeroCertificado || '—'), x0 + 230, y, { width: 110, lineBreak: false });
      doc.text(money(x.montoRetencion), x0 + ancho - 80, y, { width: 80, align: 'right', lineBreak: false });
      y += 12;
    }
  }

  // ── Asientos ──
  const asientos: any[] = d.asientos || [];
  if (asientos.length) {
    seccion('Asientos que generó la declaración');
    for (const a of asientos) {
      const esPago = a.id === d.asientoPagoId || (a.description || '').startsWith('Pago de ITBMS');
      doc.font('Helvetica').fontSize(9).fillColor('#111111')
        .text(`${esPago ? 'Pago' : 'Compensación R52'}: ${a.description}`, x0, y, { width: ancho - 90 });
      doc.font('Helvetica').fontSize(8).fillColor('#6b7280')
        .text(fecha(a.date), x0 + ancho - 85, y, { width: 85, align: 'right', lineBreak: false });
      y += 14;
      if (a.anuladoPorId) {
        doc.font('Helvetica').fontSize(8).fillColor('#c62828').text('Anulado (reverso registrado)', x0 + 8, y, { width: ancho - 8 });
        y += 12;
      }
    }
  }

  // ── Pie ──
  y = Math.max(y + 12, doc.page.height - 90);
  linea(y);
  y += 6;
  doc.font('Helvetica').fontSize(8).fillColor('#6b7280').text(
    'Copia registrada en el sistema: los importes son los que el contador registró al presentar. '
      + 'No sustituye el formulario ni el acuse de la DGI.',
    x0, y, { width: ancho },
  );
  y += 22;
  doc.text(
    `Generado el ${fecha(data.ahora || new Date())}${data.generadoPor ? ` por ${data.generadoPor}` : ''}`,
    x0, y, { width: ancho },
  );
}
