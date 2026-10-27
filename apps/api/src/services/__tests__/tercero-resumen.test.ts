import { describe, it, expect } from 'vitest';
import { buildTerceroResumen } from '../tercero-resumen';

const diasAtras = (n: number) => new Date(Date.now() - n * 86400000);

function fakePrisma(opts: {
  client?: any;
  supplier?: any;
  invoices?: any[];
  bills?: any[];
  contado?: any[];
  retenciones?: any[];
}) {
  const raw: { sql: string; params: any[] }[] = [];
  return {
    raw,
    client: { findFirst: async () => opts.client ?? null },
    supplier: { findFirst: async () => opts.supplier ?? null },
    invoice: { findMany: async () => opts.invoices ?? [] },
    bill: { findMany: async () => opts.bills ?? [] },
    retentionItbms: { groupBy: async () => opts.retenciones ?? [] },
    $queryRawUnsafe: async (sql: string, ...params: any[]) => {
      raw.push({ sql, params });
      return opts.contado ?? [];
    },
  };
}

const cliente = {
  id: 'cli-1', name: 'CLIENTE XYZ', tradeName: 'XYZ', taxId: '8-777-1', dv: '45',
  phone: '6000-0000', email: 'x@y.com', address: 'Calle 1', createdAt: new Date(),
  esAgenteRetenedor: true, porcentajeRetencionItbms: 0.5,
};

const proveedor = {
  id: 'sup-1', name: 'PROVEEDOR XYZ', tradeName: null, taxId: '8-733-2267', dv: '88',
  phone: null, email: null, address: null, createdAt: new Date(), paymentTerms: '30',
};

describe('resumen económico de un tercero', () => {
  it('cliente: suma facturas + contado, separa CxC y calcula aging/retención', async () => {
    const prisma = fakePrisma({
      client: cliente,
      invoices: [
        {
          id: 'inv-1', number: 'A-1', date: diasAtras(20), dueDate: diasAtras(10),
          description: 'Servicio', total: 1000, paidAmount: 200, status: 'PENDIENTE',
          paymentMethod: 'CREDITO', paidAt: null,
        },
        {
          id: 'inv-2', number: 'A-2', date: diasAtras(30), dueDate: diasAtras(5),
          description: 'Servicio pagado', total: 500, paidAmount: 500, status: 'PAGADA',
          paymentMethod: 'CREDITO', paidAt: diasAtras(25), // 5 días después de la factura
        },
        {
          id: 'inv-3', number: 'A-3', date: diasAtras(2), dueDate: new Date(Date.now() + 28 * 86400000),
          description: 'Venta mostrador', total: 300, paidAmount: 0, status: 'PENDIENTE',
          paymentMethod: 'EFECTIVO', paidAt: null,
        },
        {
          id: 'inv-r', number: 'A-R', date: diasAtras(1), dueDate: diasAtras(1),
          description: 'Rechazada', total: 999, paidAmount: 0, status: 'RECHAZADA',
          paymentMethod: 'CREDITO', paidAt: null,
        },
      ],
      contado: [
        { id: 'tx-1', date: diasAtras(1), amount: 200, description: 'Venta mostrador', concept: 'Ventas', type: 'VENTA' },
      ],
      retenciones: [
        { estado: 'PENDIENTE', _sum: { montoRetencion: 50 } },
        { estado: 'RECIBIDA', _sum: { montoRetencion: 30 } },
        { estado: 'APLICADA', _sum: { montoRetencion: 20 } },
        { estado: 'ANULADA', _sum: { montoRetencion: 999 } },
      ],
    });

    const r: any = await buildTerceroResumen(prisma as any, 'co-1', 'cliente', 'cli-1');

    expect(r.tipo).toBe('Cliente');
    expect(r.name).toBe('CLIENTE XYZ');
    expect(r.resumen.total).toBe(2000); // 1000 + 500 + 300 + 200 contado
    expect(r.resumen.pendiente).toBe(800); // solo la factura a crédito con saldo
    expect(r.resumen.pagado).toBe(1200);
    expect(r.resumen.vencido).toBe(800);
    expect(r.resumen.documentos).toBe(4); // 3 facturas + 1 contado
    expect(r.documentos).toEqual({ total: 4, facturas: 3, contado: 1 });
    expect(r.aging.d30).toBe(800);
    expect(r.resumen.promedioDiasPago).toBe(5);
    expect(r.retenido).toEqual({ total: 100, pendiente: 50, recibido: 30, aplicado: 20 });
    expect(r.tendencia).toHaveLength(12);
    expect(r.recientes[0].tipo).toBe('contado');
    expect(r.recientes.some((d: any) => d.estado === 'VENCIDA')).toBe(true);
    // La factura de contado no se lista como pendiente.
    expect(r.recientes.find((d: any) => d.id === 'inv-3').estado).toBe('PAGADA');

    // El SQL de contado usa el id de metadata y evita duplicar documentos.
    expect(prisma.raw[0].sql).toContain("metadata::json->>'clientId'");
    expect(prisma.raw[0].sql).toContain('NOT EXISTS');
    expect(prisma.raw[0].sql).toContain('"invoice"');
  });

  it('proveedor: suma Bills + compras al contado y calcula aging', async () => {
    const prisma = fakePrisma({
      supplier: proveedor,
      bills: [
        {
          id: 'b-1', number: 'B-1', date: diasAtras(15), dueDate: diasAtras(5),
          description: 'Materiales', total: 400, status: 'PENDIENTE', paidAt: null,
        },
        {
          id: 'b-2', number: 'B-2', date: diasAtras(20), dueDate: diasAtras(10),
          description: 'Servicio pagado', total: 600, status: 'PAGADA', paidAt: diasAtras(10),
        },
        {
          id: 'b-r', number: 'B-R', date: diasAtras(1), dueDate: diasAtras(1),
          description: 'Rechazada', total: 999, status: 'RECHAZADA', paidAt: null,
        },
      ],
      contado: [
        { id: 'tx-1', date: diasAtras(2), amount: 100, description: 'Compra mostrador', concept: 'Compras', type: 'COMPRA' },
      ],
    });

    const r: any = await buildTerceroResumen(prisma as any, 'co-1', 'proveedor', 'sup-1');

    expect(r.tipo).toBe('Proveedor');
    expect(r.paymentTerms).toBe('30');
    expect(r.resumen.total).toBe(1100); // 400 + 600 + 100
    expect(r.resumen.pendiente).toBe(400);
    expect(r.resumen.pagado).toBe(700);
    expect(r.resumen.vencido).toBe(400);
    expect(r.resumen.documentos).toBe(3); // 2 bills + 1 contado
    expect(r.resumen.promedioDiasPago).toBe(10);
    expect(r.aging.d30).toBe(400);
    expect(prisma.raw[0].sql).toContain("metadata::json->>'supplierId'");
    expect(prisma.raw[0].sql).toContain('"bill"');
  });

  it('devuelve null si el tercero no existe', async () => {
    const prisma = fakePrisma({});
    expect(await buildTerceroResumen(prisma as any, 'co-1', 'cliente', 'no')).toBeNull();
    expect(await buildTerceroResumen(prisma as any, 'co-1', 'proveedor', 'no')).toBeNull();
  });
});
