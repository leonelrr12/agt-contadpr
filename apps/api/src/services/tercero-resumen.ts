/**
 * Resumen económico de un tercero para el panel Terceros (modal 💵).
 *
 * Suma DOS fuentes:
 *  · Los documentos formales: Invoice (cliente) o Bill (proveedor).
 *  · Los movimientos al contado: Transactions con `metadata.clientId` /
 *    `metadata.supplierId` (los escribe syncEntityFromEntry/el orquestador) que
 *    NO tienen Invoice/Bill. Si tuvieran documento, se contarían dos veces.
 *
 * Para filas viejas sin id en la metadata se cae al nombre exacto del maestro y
 * a variantes del RUC; el NOT EXISTS sigue evitando duplicar los documentos.
 */
import { billSaldo, invoiceSaldo } from './saldos';

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const MS_DIA = 86400000;
const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

type Tipo = 'cliente' | 'proveedor';
type EstadoDoc = 'PAGADA' | 'PENDIENTE' | 'VENCIDA';

interface Documento {
  id: string;
  tipo: 'factura' | 'bill' | 'contado';
  documento: string;
  fecha: Date;
  detalle: string | null;
  total: number;
  saldo: number;
  estado: EstadoDoc;
  contado: boolean;
  vence: Date | null;
  pagadaEn: Date | null;
}

interface MovimientoContado {
  id: string;
  date: Date;
  amount: number;
  description: string | null;
  concept: string | null;
  type: string;
}

function fechaValida(value: any): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function estadoDocumento(saldo: number, vence: Date | null, pagada: boolean): EstadoDoc {
  if (pagada || saldo <= 0.01) return 'PAGADA';
  if (vence && vence.getTime() < Date.now()) return 'VENCIDA';
  return 'PENDIENTE';
}

/** Antigüedad de los saldos pendientes (misma convención que los aging reports). */
function agingDe(docs: Documento[]) {
  const out = { corriente: 0, d30: 0, d60: 0, d90: 0, d120: 0, over120: 0, vencido: 0 };
  const hoy = Date.now();
  for (const d of docs) {
    if (d.saldo <= 0.01) continue;
    if (!d.vence) {
      out.corriente += d.saldo;
      continue;
    }
    const dias = Math.floor((hoy - d.vence.getTime()) / MS_DIA);
    if (dias <= 0) out.corriente += d.saldo;
    else if (dias <= 30) out.d30 += d.saldo;
    else if (dias <= 60) out.d60 += d.saldo;
    else if (dias <= 90) out.d90 += d.saldo;
    else if (dias <= 120) out.d120 += d.saldo;
    else out.over120 += d.saldo;
  }
  out.vencido = r2(out.d30 + out.d60 + out.d90 + out.d120 + out.over120);
  for (const k of ['corriente', 'd30', 'd60', 'd90', 'd120', 'over120'] as const) out[k] = r2(out[k]);
  return out;
}

/** Últimos 12 meses (mes actual incluido). */
function tendenciaDe(docs: Documento[]) {
  const ahora = new Date();
  const buckets: { key: string; label: string; total: number }[] = [];
  const porMes = new Map<string, number>();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    porMes.set(key, 0);
    buckets.push({ key, label: MESES[d.getMonth()], total: 0 });
  }
  for (const doc of docs) {
    const fecha = fechaValida(doc.fecha);
    if (!fecha) continue;
    const key = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
    if (porMes.has(key)) porMes.set(key, (porMes.get(key) || 0) + doc.total);
  }
  for (const b of buckets) b.total = r2(porMes.get(b.key) || 0);
  return buckets;
}

function promedioDiasPago(docs: Documento[]): number | null {
  const dias = docs
    .filter((d) => d.pagadaEn && !d.contado)
    .map((d) => {
      const fecha = fechaValida(d.fecha);
      const pago = fechaValida(d.pagadaEn);
      if (!fecha || !pago) return null;
      return Math.max(0, Math.round((pago.getTime() - fecha.getTime()) / MS_DIA));
    })
    .filter((n): n is number => n !== null);
  if (!dias.length) return null;
  return Math.round(dias.reduce((a, b) => a + b, 0) / dias.length);
}

/** Variantes en que el RUC pudo quedar en la metadata vieja. */
function variantesRuc(taxId?: string | null, dv?: string | null): string[] {
  const base = String(taxId || '').trim();
  if (!base) return [];
  const dig = String(dv || '').trim();
  const set = new Set<string>([base, base.replace(/\D/g, '')]);
  if (dig) {
    set.add(`${base}-${dig}`);
    set.add(`${base}${dig}`);
    set.add(`${base.replace(/\D/g, '')}${dig}`);
  }
  return [...set].filter(Boolean);
}

/**
 * Movimientos al contado (sin Invoice/Bill) vinculados al maestro. El fallback
 * por nombre/RUC cubre los asientos previos a los ids en metadata.
 */
async function movimientosContado(
  prisma: any,
  companyId: string,
  tipo: Tipo,
  master: any,
): Promise<MovimientoContado[]> {
  const clave = tipo === 'cliente' ? 'clientId' : 'supplierId';
  const tipos = tipo === 'cliente' ? "('VENTA')" : "('GASTO','COMPRA')";
  const tabla = tipo === 'cliente' ? 'invoice' : 'bill';

  // `metadata` es texto: el CASE evita que un JSON corrupto tumbe el resumen.
  const meta = (k: string) =>
    `(CASE WHEN t.metadata ~ '^\\s*\\{' THEN t.metadata::json->>'${k}' END)`;
  const params: any[] = [companyId, master.id];
  const conds = [`${meta(clave)} = $2`];
  if (master.name) {
    params.push(master.name);
    conds.push(`${meta('provider')} = $${params.length}`);
  }
  const rucs = variantesRuc(master.taxId, master.dv);
  if (rucs.length) {
    const marcas = rucs.map((r) => {
      params.push(r);
      return `$${params.length}`;
    });
    conds.push(`${meta('ruc')} IN (${marcas.join(', ')})`);
  }

  const sql = `
    SELECT t.id, t.date, t.amount, t.description, t.concept, t.type
    FROM "Transaction" t
    JOIN "JournalEntry" je ON je.id = t."journalEntryId"
    WHERE t."companyId" = $1
      AND je.status NOT IN ('RECHAZADO', 'ANULADO')
      AND t.type IN ${tipos}
      AND (${conds.join(' OR ')})
      AND NOT EXISTS (
        SELECT 1 FROM "${tabla}" d
        WHERE d."journalEntryId" = t."journalEntryId"
          AND d."companyId" = t."companyId"
          AND d.status <> 'RECHAZADA'
      )
    ORDER BY t.date ASC
  `;
  return prisma.$queryRawUnsafe(sql, ...params) as Promise<MovimientoContado[]>;
}

function documentoFactura(inv: any): Documento {
  const total = r2(inv.total);
  const saldo = invoiceSaldo(inv);
  const contado = inv.paymentMethod === 'EFECTIVO';
  const vence = fechaValida(inv.dueDate);
  return {
    id: inv.id,
    tipo: 'factura',
    documento: inv.number ? `Factura ${inv.number}` : 'Factura s/n',
    fecha: fechaValida(inv.date) || new Date(),
    detalle: inv.description || null,
    total,
    saldo,
    estado: estadoDocumento(saldo, vence, contado || inv.status === 'PAGADA'),
    contado,
    vence,
    pagadaEn: fechaValida(inv.paidAt),
  };
}

function documentoBill(b: any): Documento {
  const total = r2(b.total);
  const saldo = billSaldo(b);
  const vence = fechaValida(b.dueDate);
  return {
    id: b.id,
    tipo: 'bill',
    documento: b.number ? `Factura ${b.number}` : 'Factura s/n',
    fecha: fechaValida(b.date) || new Date(),
    detalle: b.description || null,
    total,
    saldo,
    estado: estadoDocumento(saldo, vence, b.status === 'PAGADA'),
    contado: false,
    vence,
    pagadaEn: fechaValida(b.paidAt),
  };
}

function documentoContado(tx: MovimientoContado): Documento {
  return {
    id: tx.id,
    tipo: 'contado',
    documento: 'Contado',
    fecha: fechaValida(tx.date) || new Date(),
    detalle: tx.description || tx.concept || 'Movimiento al contado',
    total: r2(tx.amount),
    saldo: 0,
    estado: 'PAGADA',
    contado: true,
    vence: null,
    pagadaEn: null,
  };
}

function resumenDe(docs: Documento[], formal: number, contado: number) {
  const total = r2(docs.reduce((s, d) => s + d.total, 0));
  const pendiente = r2(docs.reduce((s, d) => s + d.saldo, 0));
  const aging = agingDe(docs);
  const fechas = docs.map((d) => d.fecha.getTime());
  const pendientes = docs.filter((d) => d.saldo > 0.01 && d.vence);
  const proximo = pendientes.length
    ? new Date(Math.min(...pendientes.map((d) => d.vence!.getTime())))
    : null;
  const recientes = [...docs].sort((a, b) => b.fecha.getTime() - a.fecha.getTime()).slice(0, 20);

  return {
    resumen: {
      total,
      pagado: r2(total - pendiente),
      pendiente,
      vencido: aging.vencido,
      documentos: docs.length,
      ticketPromedio: docs.length ? r2(total / docs.length) : 0,
      ultimoMovimiento: fechas.length ? new Date(Math.max(...fechas)) : null,
      proximoVencimiento: proximo,
      promedioDiasPago: promedioDiasPago(docs),
    },
    documentos: { total: docs.length, facturas: formal, contado },
    aging,
    tendencia: tendenciaDe(docs),
    recientes,
  };
}

async function resumenCliente(prisma: any, companyId: string, id: string) {
  const cliente = await prisma.client.findFirst({
    where: { id, companyId },
    select: {
      id: true, name: true, tradeName: true, taxId: true, dv: true,
      phone: true, email: true, address: true, createdAt: true,
      esAgenteRetenedor: true, porcentajeRetencionItbms: true,
    },
  });
  if (!cliente) return null;

  const [invoices, contado, retenciones] = await Promise.all([
    prisma.invoice.findMany({
      where: { clientId: id, companyId, status: { not: 'RECHAZADA' } },
      select: {
        id: true, number: true, date: true, dueDate: true, description: true,
        total: true, paidAmount: true, status: true, paymentMethod: true, paidAt: true,
      },
      orderBy: { date: 'desc' },
    }),
    movimientosContado(prisma, companyId, 'cliente', cliente),
    prisma.retentionItbms.groupBy({
      by: ['estado'],
      where: { companyId, clientId: id, estado: { not: 'ANULADA' } },
      _sum: { montoRetencion: true },
    }),
  ]);

  const facturas = (invoices || []).filter((i: any) => i.status !== 'RECHAZADA').map(documentoFactura);
  const caja = (contado || []).map(documentoContado);
  const docs = [...facturas, ...caja];
  const base = resumenDe(docs, facturas.length, caja.length);

  const retenido = { total: 0, pendiente: 0, recibido: 0, aplicado: 0 };
  for (const r of retenciones || []) {
    if (r.estado === 'ANULADA') continue;
    const monto = r2(r._sum?.montoRetencion || 0);
    retenido.total = r2(retenido.total + monto);
    if (r.estado === 'PENDIENTE') retenido.pendiente = r2(retenido.pendiente + monto);
    else if (r.estado === 'RECIBIDA') retenido.recibido = r2(retenido.recibido + monto);
    else if (r.estado === 'APLICADA') retenido.aplicado = r2(retenido.aplicado + monto);
  }

  return {
    tipo: 'Cliente',
    id: cliente.id,
    name: cliente.name,
    tradeName: cliente.tradeName,
    taxId: cliente.taxId,
    dv: cliente.dv,
    phone: cliente.phone,
    email: cliente.email,
    address: cliente.address,
    createdAt: cliente.createdAt,
    esAgenteRetenedor: cliente.esAgenteRetenedor,
    porcentajeRetencionItbms: cliente.porcentajeRetencionItbms,
    ...base,
    retenido,
  };
}

async function resumenProveedor(prisma: any, companyId: string, id: string) {
  const proveedor = await prisma.supplier.findFirst({
    where: { id, companyId },
    select: {
      id: true, name: true, tradeName: true, taxId: true, dv: true,
      phone: true, email: true, address: true, createdAt: true, paymentTerms: true,
    },
  });
  if (!proveedor) return null;

  const [bills, contado] = await Promise.all([
    prisma.bill.findMany({
      where: { supplierId: id, companyId, status: { not: 'RECHAZADA' } },
      select: {
        id: true, number: true, date: true, dueDate: true, description: true,
        total: true, status: true, paidAt: true,
      },
      orderBy: { date: 'desc' },
    }),
    movimientosContado(prisma, companyId, 'proveedor', proveedor),
  ]);

  const facturas = (bills || []).filter((b: any) => b.status !== 'RECHAZADA').map(documentoBill);
  const caja = (contado || []).map(documentoContado);
  const docs = [...facturas, ...caja];
  const base = resumenDe(docs, facturas.length, caja.length);

  return {
    tipo: 'Proveedor',
    id: proveedor.id,
    name: proveedor.name,
    tradeName: proveedor.tradeName,
    taxId: proveedor.taxId,
    dv: proveedor.dv,
    phone: proveedor.phone,
    email: proveedor.email,
    address: proveedor.address,
    createdAt: proveedor.createdAt,
    paymentTerms: proveedor.paymentTerms,
    ...base,
  };
}

export async function buildTerceroResumen(prisma: any, companyId: string, tipo: Tipo, id: string) {
  return tipo === 'cliente'
    ? resumenCliente(prisma, companyId, id)
    : resumenProveedor(prisma, companyId, id);
}
