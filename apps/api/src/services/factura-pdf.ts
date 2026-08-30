/**
 * Generador de facturas PDF (módulo Facturas PDF) — pdfkit.
 * Cumplimiento DGI: razón social + RUC + dirección del emisor, número
 * correlativo, leyenda de resolución autorizadora, ITBMS desglosado.
 */
import PDFDocument from 'pdfkit';

const r2 = (n: number) => Math.round(n * 100) / 100;

function fmtMoney(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
}

export interface FacturaPdfData {
  company: any;
  invoice: any;
  items: any[];
  client: any;
}

export function buildFacturaPdf(data: FacturaPdfData): PDFKit.PDFDocument {
  const { company, invoice, items, client } = data;
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const pageW = doc.page.width - 100; // 612 - 100

  // ── Encabezado: logo + datos del emisor ──
  const emisor = company.name || '—';
  const ruc = company.taxId || '—';
  const addr = [company.address, company.phone, company.email].filter(Boolean).join(' · ');

  if (company.logo) {
    try {
      doc.image(company.logo, 50, 50, { width: 80, height: 60, fit: [80, 60] });
    } catch { /* logo inválido: seguir sin imagen */ }
  }
  const textX = company.logo ? 145 : 50;
  doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a1a2e').text(emisor, textX, 50, { width: pageW - (textX - 50) });
  doc.font('Helvetica').fontSize(9).fillColor('#4b5563');
  doc.text(`RUC: ${ruc}`, textX, 70, { width: pageW - (textX - 50) });
  if (addr) doc.text(addr, textX, 82, { width: pageW - (textX - 50) });

  // ── Título + número ──
  doc.moveDown(1.2);
  doc.fontSize(20).font('Helvetica-Bold').fillColor('#1a1a2e').text('FACTURA', { align: 'center' });
  doc.fontSize(12).font('Helvetica').fillColor('#4b5563').text(`Nº ${invoice.number || '—'}`, { align: 'center' });

  // ── Leyenda DGI (resolución autorizadora) ──
  if (company.facturaResolucion) {
    const leyenda = `Factura autorizada mediante Resolución Nº ${company.facturaResolucion} de la DGI de fecha ${fmtDate(company.facturaResolucionFecha)}`;
    doc.moveDown(0.6);
    const y = doc.y;
    doc.roundedRect(50, y, pageW, 26, 4).stroke('#9ca3af');
    doc.fontSize(8.5).font('Helvetica-Oblique').fillColor('#374151')
      .text(leyenda, 58, y + 6, { width: pageW - 16, align: 'center' });
    doc.moveDown(1);
  }

  // ── Datos de la factura: fecha + cliente ──
  doc.moveDown(0.8);
  const infoY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a2e');
  doc.font('Helvetica-Bold').text('Fecha:', 50, infoY, { continued: true });
  doc.font('Helvetica').text(` ${fmtDate(invoice.date)}`, { continued: true });
  doc.font('Helvetica-Bold').text('   Vence:', { continued: true });
  doc.font('Helvetica').text(` ${fmtDate(invoice.dueDate)}`);
  doc.font('Helvetica-Bold').text('Cliente:', 50, doc.y + 4, { continued: true });
  doc.font('Helvetica').text(` ${client?.name || 'Consumidor Final'}`);
  const clientRuc = client?.taxId || 'Consumidor Final';
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280').text(`RUC: ${clientRuc}`, 50, doc.y + 2);

  // ── Tabla de items ──
  doc.moveDown(1.2);
  const tableY = doc.y;
  const colX = {
    desc: 50,
    cant: 320,
    precio: 380,
    itbms: 455,
    total: 510,
  };
  const headerBg = '#f3f4f6';
  doc.rect(50, tableY, pageW, 22).fill(headerBg);
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#374151');
  doc.text('Descripción', colX.desc + 4, tableY + 6);
  doc.text('Cant.', colX.cant, tableY + 6, { width: 40, align: 'right' });
  doc.text('Precio', colX.precio, tableY + 6, { width: 60, align: 'right' });
  doc.text('ITBMS', colX.itbms, tableY + 6, { width: 45, align: 'right' });
  doc.text('Total', colX.total, tableY + 6, { width: 45, align: 'right' });

  let y = tableY + 22;
  doc.font('Helvetica').fontSize(9).fillColor('#1a1a2e');
  for (const it of items || []) {
    const base = r2((it.cantidad || 1) * (it.precio || 0));
    const total = r2(base + (it.itbms || 0));
    // Alto estimado de línea: descripción puede ocupar 1-2 líneas
    const descLines = doc.heightOfString(it.descripcion || '', { width: colX.cant - colX.desc - 8 });
    const rowH = Math.max(20, descLines + 8);
    if (y + rowH > 720) { doc.addPage(); y = 50; }
    doc.rect(50, y, pageW, rowH).stroke('#e5e7eb');
    doc.text(it.descripcion || '—', colX.desc + 4, y + 5, { width: colX.cant - colX.desc - 8 });
    doc.text(String(it.cantidad || 1), colX.cant, y + 5, { width: 40, align: 'right' });
    doc.text(fmtMoney(it.precio || 0), colX.precio, y + 5, { width: 60, align: 'right' });
    doc.text(fmtMoney(it.itbms || 0), colX.itbms, y + 5, { width: 45, align: 'right' });
    doc.text(fmtMoney(total), colX.total, y + 5, { width: 45, align: 'right' });
    y += rowH;
  }

  // ── Totales ──
  doc.moveDown(0.6);
  const totX = 370;
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a2e');
  doc.text('Subtotal:', totX, doc.y + 4, { width: 60 });
  doc.font('Helvetica-Bold').text(fmtMoney(invoice.amount || 0), totX + 70, doc.y - 13, { width: 90, align: 'right' });
  doc.font('Helvetica').text(`ITBMS (${r2(invoice.itbms / (invoice.amount || 1) * 100).toFixed(0)}%):`, totX, doc.y + 4, { width: 100 });
  doc.text(fmtMoney(invoice.itbms || 0), totX + 70, doc.y - 13, { width: 90, align: 'right' });
  doc.moveDown(0.4);
  doc.rect(totX - 8, doc.y, 148, 24).fill('#1a1a2e');
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#ffffff').text('TOTAL:', totX, doc.y + 6, { width: 60 });
  doc.text(fmtMoney(invoice.total || 0), totX + 66, doc.y - 16, { width: 70, align: 'right' });

  // ── Pie ──
  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(9).fillColor('#6b7280');
  const cond = invoice.paymentMethod === 'CREDITO'
    ? `Condiciones de pago: Crédito a ${Math.max(1, Math.round((new Date(invoice.dueDate).getTime() - new Date(invoice.date).getTime()) / 86400000))} días`
    : invoice.status === 'PAGADA' ? 'Condiciones de pago: Pagada' : 'Condiciones de pago: Pago de contado';
  doc.text(cond, 50, doc.y + 4);
  doc.text('Generado con Contador507', 50, doc.y + 12);

  doc.end();
  return doc;
}
