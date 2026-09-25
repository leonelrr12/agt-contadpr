import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { validate } from '../middleware/validate';
import { logAudit } from '../services/audit-log';
import { registrarEntrada, registrarSalida, cargarInventarioInicial, registrarAjustes, anularMovimiento } from '../services/inventario';
import { parseInventarioFile } from '../services/csv-parser';
import {
  createProductoSchema,
  updateProductoSchema,
  entradaInventarioSchema,
  salidaInventarioSchema,
  cargaInventarioSchema,
  ajusteInventarioSchema,
  anularMovimientoSchema,
} from '../validation/schemas';

export const inventarioRouter = Router();

// En memoria: el archivo se parsea y se descarta, no se guarda en disco.
const cargaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/**
 * El throw va DENTRO del try y el status se propaga: Express 4 no captura rechazos
 * de handlers async (la petición quedaría colgada para siempre), y un 400 con el
 * motivo real es la diferencia entre corregir y adivinar.
 */
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error('[Inventario]', e?.message);
      res.status(e?.status || 500).json({ error: e?.message || 'Error al procesar la operación de inventario' });
    }
  };

const r2 = (n: number) => Math.round(n * 100) / 100;
const ROLES_ESCRITURA = ['admin', 'contador', 'superadmin'] as const;

/** Saldo del mayor de las cuentas de inventario dadas, con el signo de un activo. */
async function saldoMayor(prisma: any, companyId: string, accountIds: string[]): Promise<number> {
  if (!accountIds.length) return 0;
  const agg = await prisma.journalLine.aggregate({
    _sum: { debit: true, credit: true },
    where: {
      accountId: { in: accountIds },
      journalEntry: { companyId, status: { notIn: ['RECHAZADO', 'ANULADO'] } },
    },
  });
  return r2((agg._sum.debit || 0) - (agg._sum.credit || 0));
}

/** Cuentas de inventario en uso: la de la empresa más las que sobrescriba cada producto. */
async function cuentasInventarioEnUso(prisma: any, companyId: string): Promise<string[]> {
  const [empresa, productos] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId }, select: { inventarioCuentaId: true } }),
    prisma.inventoryProduct.findMany({
      where: { companyId, cuentaInventarioId: { not: null } },
      select: { cuentaInventarioId: true },
    }),
  ]);
  const ids = new Set<string>();
  if (empresa?.inventarioCuentaId) ids.add(empresa.inventarioCuentaId);
  for (const p of productos) if (p.cuentaInventarioId) ids.add(p.cuentaInventarioId);
  if (ids.size) return [...ids];

  // Sin configuración explícita se usa la cuenta del módulo por convención: el alias
  // clásico o el código 1.1.04.01.
  //
  // NO todo el subtree 1.1.04: si se toma entero, un saldo en la cuenta PADRE
  // —una carga inicial contable, por ejemplo— queda dentro de "la cuenta del kardex"
  // y el bloque de saldos sin kardex no lo ve nunca. El cuadre diría que no cuadra
  // sin decir por qué, que es la peor de las dos cosas.
  const porAlias = await prisma.account.findFirst({
    where: { companyId, aliases: { has: 'inventario-mercancia' } },
    select: { id: true },
  });
  if (porAlias) return [porAlias.id];

  const porCodigo = await prisma.account.findFirst({
    where: { companyId, code: '1.1.04.01' },
    select: { id: true },
  });
  return porCodigo ? [porCodigo.id] : [];
}

/** El producto tal como lo ve la pantalla: con su valor y su estado de alerta. */
function presentarProducto(p: any) {
  const estado = p.stockActual < 0 ? 'NEGATIVO'
    : p.stockMinimo > 0 && p.stockActual <= p.stockMinimo ? 'BAJO'
    : p.stockActual > 0 && p.costoPromedio === 0 ? 'SIN_COSTO'
    : 'OK';
  return {
    id: p.id,
    sku: p.sku,
    nombre: p.nombre,
    descripcion: p.descripcion,
    unidad: p.unidad,
    precioVenta: p.precioVenta,
    stockActual: p.stockActual,
    stockMinimo: p.stockMinimo,
    stockValor: p.stockValor,
    costoPromedio: p.costoPromedio,
    cuentaInventarioId: p.cuentaInventarioId,
    cuentaCostoId: p.cuentaCostoId,
    isActive: p.isActive,
    estado,
  };
}

// ── Productos ───────────────────────────────────────────────────────────────

/** GET /api/inventario/productos — catálogo con existencia y valor. */
inventarioRouter.get('/productos', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const { q, bajoMinimo, incluirInactivos, page: pageStr, pageSize: pageSizeStr } = req.query;

  const where: any = { companyId };
  if (incluirInactivos !== '1') where.isActive = true;
  if (q) where.OR = [{ nombre: { contains: String(q), mode: 'insensitive' } }, { sku: { contains: String(q), mode: 'insensitive' } }];

  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeStr as string) || 50));

  const [total, filas, todos] = await Promise.all([
    req.prisma.inventoryProduct.count({ where }),
    req.prisma.inventoryProduct.findMany({ where, orderBy: { nombre: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }),
    // Los totales son del catálogo entero, no de la página: si no, el KPI miente.
    req.prisma.inventoryProduct.findMany({ where, select: { stockActual: true, stockValor: true, stockMinimo: true } }),
  ]);

  let items = filas.map(presentarProducto);
  if (bajoMinimo === '1') items = items.filter((p: any) => p.estado === 'BAJO' || p.estado === 'NEGATIVO');

  res.json({
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    totales: {
      valor: r2(todos.reduce((s: number, p: any) => s + p.stockValor, 0)),
      bajoMinimo: todos.filter((p: any) => p.stockMinimo > 0 && p.stockActual <= p.stockMinimo).length,
      negativos: todos.filter((p: any) => p.stockActual < 0).length,
    },
  });
}));

/** POST /api/inventario/productos — alta del producto. */
inventarioRouter.post('/productos', requireRole(...ROLES_ESCRITURA, 'inventario'), validate(createProductoSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const { nombre, sku, descripcion, unidad, precioVenta, stockMinimo, cuentaInventarioId, cuentaCostoId } = req.body;

  try {
    const producto = await req.prisma.inventoryProduct.create({
      data: {
        companyId,
        nombre: nombre.trim(),
        sku: sku?.trim() || null,
        descripcion: descripcion || null,
        unidad: unidad || 'UND',
        precioVenta: precioVenta ?? null,
        stockMinimo: stockMinimo || 0,
        cuentaInventarioId: cuentaInventarioId || null,
        cuentaCostoId: cuentaCostoId || null,
      },
    });

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'INVENTARIO_PRODUCTO_CREATED',
      entity: 'InventoryProduct',
      entityId: producto.id,
      after: { nombre: producto.nombre, sku: producto.sku },
    }).catch(() => {});

    res.status(201).json(presentarProducto(producto));
  } catch (e: any) {
    // @@unique([companyId, nombre]) y [companyId, sku]
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe un producto con ese nombre o ese código.' });
      return;
    }
    throw e;
  }
}));

/** PATCH /api/inventario/productos/:id — datos del producto. Nunca toca stock ni costo. */
inventarioRouter.patch('/productos/:id', requireRole(...ROLES_ESCRITURA, 'inventario'), validate(updateProductoSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const existente = await req.prisma.inventoryProduct.findFirst({ where: { id: req.params.id, companyId } });
  if (!existente) {
    res.status(404).json({ error: 'Producto no encontrado' });
    return;
  }

  // stockActual/stockValor/costoPromedio NO se editan: son el resultado del kardex.
  // Para cambiarlos hay que registrar un movimiento, que es lo que deja el rastro.
  const { nombre, sku, descripcion, unidad, precioVenta, stockMinimo, cuentaInventarioId, cuentaCostoId, isActive } = req.body;
  const data: any = {};
  if (nombre !== undefined) data.nombre = nombre.trim();
  if (sku !== undefined) data.sku = sku?.trim() || null;
  if (descripcion !== undefined) data.descripcion = descripcion || null;
  if (unidad !== undefined) data.unidad = unidad;
  if (precioVenta !== undefined) data.precioVenta = precioVenta;
  if (stockMinimo !== undefined) data.stockMinimo = stockMinimo;
  if (cuentaInventarioId !== undefined) data.cuentaInventarioId = cuentaInventarioId || null;
  if (cuentaCostoId !== undefined) data.cuentaCostoId = cuentaCostoId || null;
  if (isActive !== undefined) data.isActive = isActive;

  try {
    const producto = await req.prisma.inventoryProduct.update({ where: { id: existente.id }, data });
    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'INVENTARIO_PRODUCTO_UPDATED',
      entity: 'InventoryProduct',
      entityId: producto.id,
      before: { nombre: existente.nombre, stockMinimo: existente.stockMinimo, isActive: existente.isActive },
      after: { nombre: producto.nombre, stockMinimo: producto.stockMinimo, isActive: producto.isActive },
    }).catch(() => {});
    res.json(presentarProducto(producto));
  } catch (e: any) {
    if (e.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe un producto con ese nombre o ese código.' });
      return;
    }
    throw e;
  }
}));

// ── Kardex ──────────────────────────────────────────────────────────────────

/** GET /api/inventario/productos/:id/kardex — movimientos con saldo corrido y cuadre. */
inventarioRouter.get('/productos/:id/kardex', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const producto = await req.prisma.inventoryProduct.findFirst({ where: { id: req.params.id, companyId } });
  if (!producto) {
    res.status(404).json({ error: 'Producto no encontrado' });
    return;
  }

  const { page: pageStr, pageSize: pageSizeStr } = req.query;
  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(pageSizeStr as string) || 100));

  const [total, movimientos] = await Promise.all([
    req.prisma.inventoryMovement.count({ where: { companyId, productId: producto.id } }),
    req.prisma.inventoryMovement.findMany({
      where: { companyId, productId: producto.id },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // Comparación contra el mayor de la cuenta que este producto usa.
  const cuentaId = producto.cuentaInventarioId
    || (await req.prisma.company.findUnique({ where: { id: companyId }, select: { inventarioCuentaId: true } }))?.inventarioCuentaId;
  const cuentas = cuentaId
    ? [cuentaId]
    : (await req.prisma.account.findMany({ where: { companyId, code: { startsWith: '1.1.04' } }, select: { id: true } })).map((c: any) => c.id);
  const saldo = await saldoMayor(req.prisma, companyId, cuentas);
  const cuenta = cuentaId ? await req.prisma.account.findUnique({ where: { id: cuentaId }, select: { code: true, name: true } }) : null;

  res.json({
    producto: presentarProducto(producto),
    movimientos,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    mayor: {
      cuenta: cuenta?.code || '1.1.04',
      nombre: cuenta?.name || 'Inventario',
      saldo,
      diferencia: r2(producto.stockValor - saldo),
      cuadra: Math.abs(r2(producto.stockValor - saldo)) < 0.005,
    },
  });
}));

/** GET /api/inventario/movimientos — libro del período. */
inventarioRouter.get('/movimientos', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const { productId, origen, desde, hasta, page: pageStr, pageSize: pageSizeStr } = req.query;

  const where: any = { companyId };
  if (productId) where.productId = String(productId);
  if (origen) where.origen = String(origen);
  if (desde || hasta) {
    where.fecha = {};
    if (desde) where.fecha.gte = new Date(`${desde}T00:00:00`);
    if (hasta) where.fecha.lte = new Date(`${hasta}T23:59:59`);
  }

  const page = Math.max(1, parseInt(pageStr as string) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(pageSizeStr as string) || 50));

  const [total, items] = await Promise.all([
    req.prisma.inventoryMovement.count({ where }),
    req.prisma.inventoryMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { product: { select: { id: true, nombre: true, unidad: true } } },
    }),
  ]);

  res.json({ items, total, page, pageSize, totalPages: Math.ceil(total / pageSize) });
}));

// ── Valoración ──────────────────────────────────────────────────────────────

/** GET /api/inventario/valoracion — existencias a costo promedio, con el cuadre contra el mayor. */
inventarioRouter.get('/valoracion', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const productos = await req.prisma.inventoryProduct.findMany({
    where: { companyId, isActive: true },
    orderBy: { nombre: 'asc' },
  });

  const filas = productos.map((p: any) => ({
    id: p.id,
    sku: p.sku,
    nombre: p.nombre,
    unidad: p.unidad,
    cantidad: p.stockActual,
    costoPromedio: p.costoPromedio,
    valor: p.stockValor,
    estado: presentarProducto(p).estado,
  }));

  const cuentas = await cuentasInventarioEnUso(req.prisma, companyId);
  const saldo = await saldoMayor(req.prisma, companyId, cuentas);
  const total = r2(filas.reduce((s: number, f: any) => s + f.valor, 0));

  res.json({
    filas,
    total,
    mayor: {
      saldo,
      diferencia: r2(total - saldo),
      cuadra: Math.abs(r2(total - saldo)) < 0.005,
    },
  });
}));

// ── Cuadre y alertas ────────────────────────────────────────────────────────

/**
 * GET /api/inventario/cuadre — kardex contra contabilidad, sin arreglar nada solo.
 *
 * Cinco bloques, cada uno con su lista y su veredicto. La doctrina es la del cuadre
 * del lote de la importación: mostrar lo que quedó fuera es más útil que un OK
 * mentiroso, y ninguna diferencia se corrige automáticamente.
 */
inventarioRouter.get('/cuadre', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const { fechaCorte } = req.query;
  const corte = fechaCorte ? new Date(`${fechaCorte}T23:59:59`) : null;

  const productos = await req.prisma.inventoryProduct.findMany({
    where: { companyId },
    select: { id: true, nombre: true, stockActual: true, stockValor: true, cuentaInventarioId: true },
  });

  const movWhere: any = { companyId };
  if (corte) movWhere.fecha = { lte: corte };

  const movimientos = await req.prisma.inventoryMovement.findMany({
    where: movWhere,
    select: { id: true, productId: true, origen: true, cantidad: true, costoTotal: true, journalEntryId: true, estado: true },
  });

  // ── 1. Kardex contra el mayor ──
  const cuentasKardex = await cuentasInventarioEnUso(req.prisma, companyId);
  const saldoKardex = r2(productos.reduce((s: number, p: any) => s + p.stockValor, 0));
  const saldoContable = await saldoMayor(req.prisma, companyId, cuentasKardex);
  const difKardex = r2(saldoKardex - saldoContable);

  // ── 2. Saldos en cuentas de inventario que el kardex no explica ──
  // Es lo que aparece cuando el inventario se cargó por la contabilidad y nunca se
  // pasó al kardex (el caso de ODESA, con su carga inicial).
  const cuentasSubárbol = await req.prisma.account.findMany({
    where: { companyId, code: { startsWith: '1.1.04' } },
    select: { id: true, code: true, name: true },
    orderBy: { code: 'asc' },
  });
  const saldos: any[] = [];
  for (const c of cuentasSubárbol) {
    if (cuentasKardex.includes(c.id)) continue;
    const saldo = await saldoMayor(req.prisma, companyId, [c.id]);
    if (Math.abs(saldo) >= 0.005) saldos.push({ ...c, saldo });
  }

  // ── 3. Movimientos sin asiento, o con el asiento rechazado ──
  const idsAsientos = [...new Set(movimientos.map((m: any) => m.journalEntryId).filter(Boolean))] as string[];
  const asientos = idsAsientos.length
    ? await req.prisma.journalEntry.findMany({
        where: { id: { in: idsAsientos } },
        select: { id: true, status: true, description: true },
      })
    : [];
  const estadoPorAsiento = new Map(asientos.map((a: any) => [a.id, a]));

  const sinAsiento = movimientos.filter((m: any) => !m.journalEntryId);
  const conAsientoCaido = movimientos.filter((m: any) => {
    const a: any = m.journalEntryId ? estadoPorAsiento.get(m.journalEntryId) : null;
    return a && ['RECHAZADO', 'ANULADO'].includes(a.status);
  });

  // ── 4. Ventas sin costo: renglones de factura sin producto ──
  // No es un error —un servicio no lleva costo— pero sirve verlo: si son mercancía,
  // esa venta no descontó stock.
  const ventasSinCosto = await req.prisma.$queryRawUnsafe(`
    SELECT COUNT(*)::int AS n
    FROM invoice_item i
    JOIN invoice f ON f.id = i."invoiceId"
    WHERE f."companyId" = '${companyId}' AND i."productId" IS NULL
  `).catch(() => [{ n: 0 }]);

  // ── 5. Recurrentes de compra apuntando a inventario ──
  // Una plantilla con cuenta explícita debita lo que diga su cuenta, sin pasar por
  // el kardex: si apunta acá, vuelve el problema que la Fase 5 cerró.
  const plantillas = await req.prisma.recurringTemplate.findMany({
    where: { companyId, isActive: true, type: 'COMPRA', debitAccountId: { in: cuentasKardex } },
    select: { id: true, description: true, amount: true },
  });

  const sinAsientoDetalle = [
    ...sinAsiento.map((m: any) => ({ ...m, motivo: 'Sin asiento' })),
    ...conAsientoCaido.map((m: any) => ({ ...m, motivo: `Asiento ${estadoPorAsiento.get(m.journalEntryId)?.status}` })),
  ];
  const renglonesSinProducto = (ventasSinCosto as any[])[0]?.n || 0;

  res.json({
    fechaCorte: corte ? corte.toISOString().slice(0, 10) : null,
    bloques: [
      {
        clave: 'kardex-mayor',
        titulo: 'Kardex contra el mayor',
        detalle: 'El valor del kardex y el saldo de la cuenta de inventario tienen que coincidir al centavo.',
        kardex: saldoKardex,
        mayor: saldoContable,
        diferencia: difKardex,
        cuadra: Math.abs(difKardex) < 0.005,
        items: [],
      },
      {
        clave: 'sin-kardex',
        titulo: 'Saldos en cuentas de inventario sin kardex',
        detalle: 'Cuentas de inventario con saldo que el kardex no explica. Suele venir de una carga inicial contable: se resuelve abriendo el kardex con una apertura por ese monto, o dejándolo si la empresa no usa el módulo.',
        items: saldos,
        cuadra: !saldos.length,
      },
      {
        clave: 'asientos',
        titulo: 'Movimientos sin asiento o con el asiento caído',
        detalle: 'El kardex es un hecho físico y no se revierte si el contador rechaza el asiento; el mayor sí. Esa diferencia es legítima y conviene verla.',
        items: sinAsientoDetalle,
        cuadra: !sinAsientoDetalle.length,
      },
      {
        clave: 'sin-producto',
        titulo: 'Renglones de factura sin producto',
        // Informativo, nunca un descuadre: un servicio no lleva costo y está bien.
        detalle: 'Un servicio no lleva costo y está bien. Si son mercancía, esa venta no descontó stock.',
        cantidad: renglonesSinProducto,
        items: [],
        cuadra: true,
      },
      {
        clave: 'recurrentes',
        titulo: 'Recurrentes de compra que debitan inventario',
        detalle: 'Una plantilla con cuenta explícita debita lo que dice su cuenta, sin pasar por el kardex: volvería a inflar el inventario sin cantidad.',
        items: plantillas,
        cuadra: !plantillas.length,
      },
    ],
  });
}));

/** GET /api/inventario/alertas — lo que hay que mirar del catálogo. */
inventarioRouter.get('/alertas', wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const productos = await req.prisma.inventoryProduct.findMany({
    where: { companyId, isActive: true },
    select: { id: true, sku: true, nombre: true, unidad: true, stockActual: true, stockMinimo: true, costoPromedio: true, stockValor: true },
    orderBy: { nombre: 'asc' },
  });

  const bajoMinimo = productos.filter((p: any) => p.stockMinimo > 0 && p.stockActual <= p.stockMinimo);
  const negativos = productos.filter((p: any) => p.stockActual < 0);
  const sinCosto = productos.filter((p: any) => p.stockActual > 0 && p.costoPromedio === 0);
  const sinPrecio = productos.filter((p: any) => p.precioVenta == null && p.stockActual > 0);

  const cuentasKardex = await cuentasInventarioEnUso(req.prisma, companyId);
  const subárbol = await req.prisma.account.findMany({
    where: { companyId, code: { startsWith: '1.1.04' } },
    select: { id: true, code: true, name: true },
  });
  const sinKardex: any[] = [];
  for (const c of subárbol) {
    if (cuentasKardex.includes(c.id)) continue;
    const saldo = await saldoMayor(req.prisma, companyId, [c.id]);
    if (Math.abs(saldo) >= 0.005) sinKardex.push({ ...c, saldo });
  }

  res.json({ bajoMinimo, negativos, sinCosto, sinPrecio, sinKardex });
}));

// ── Entradas y salidas ──────────────────────────────────────────────────────

/** POST /api/inventario/entradas — compra de mercancía: mueve el kardex y emite el asiento. */
inventarioRouter.post('/entradas', requireRole(...ROLES_ESCRITURA, 'inventario'), requireQuota, validate(entradaInventarioSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  const result = await req.prisma.$transaction((tx: any) => registrarEntrada(tx, companyId, userId, req.body));

  await incrementUsage(req);
  await logAudit(req.prisma, {
    userId,
    action: 'INVENTARIO_ENTRADA',
    entity: 'InventoryMovement',
    entityId: result.asiento.id,
    after: { asiento: result.asiento.id, movimientos: result.movimientos.length },
  }).catch(() => {});

  res.status(201).json(result);
}));

// ── Carga inicial ───────────────────────────────────────────────────────────

/**
 * POST /api/inventario/carga-inicial/preview — lee el archivo y devuelve lo que
 * haría, sin tocar nada.
 *
 * Se separa del execute a propósito, igual que la importación masiva: cargar un
 * catálogo de existencias es una operación de una sola vez y el usuario tiene que
 * poder ver qué va a entrar antes de que entre.
 */
inventarioRouter.post('/carga-inicial/preview', requireRole(...ROLES_ESCRITURA, 'inventario'), cargaUpload.single('file'), wrap(async (req: any, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'Subí un archivo CSV o Excel.' });
    return;
  }
  const companyId = req.user!.companyId;

  let parsed;
  try {
    parsed = await parseInventarioFile(req.file.buffer, req.file.originalname || 'archivo.csv');
  } catch (e: any) {
    res.status(400).json({ error: e.message });
    return;
  }

  // Productos que ya existen: se avisa antes de cargar, no después.
  const claves = parsed.rows.filter((r) => !r.errores).map((r) => (r.sku ? { sku: r.sku } : { nombre: r.nombre }));
  const existentes = claves.length
    ? await req.prisma.inventoryProduct.findMany({ where: { companyId, OR: claves }, select: { sku: true, nombre: true } })
    : [];
  const yaExiste = new Set(existentes.map((p: any) => (p.sku || p.nombre).toLowerCase()));

  const conError = parsed.rows.filter((r) => r.errores.length);
  const validas = parsed.rows.filter((r) => !r.errores.length);
  const filas = parsed.rows.map((r) => ({
    ...r,
    existente: yaExiste.has((r.sku || r.nombre).toLowerCase()),
  }));

  res.json({
    headers: parsed.headers,
    columnas: parsed.cuentas,
    filas,
    resumen: {
      total: parsed.totalRows,
      validas: validas.length,
      conError: conError.length,
      existentes: filas.filter((f) => f.existente && !f.errores.length).length,
      valorTotal: r2(validas.reduce((s, f) => s + f.cantidad * f.costoUnitario, 0)),
    },
    duplicadas: parsed.duplicadas,
  });
}));

/** POST /api/inventario/carga-inicial/execute — crea los productos y el kardex. */
inventarioRouter.post('/carga-inicial/execute', requireRole(...ROLES_ESCRITURA, 'inventario'), requireQuota, validate(cargaInventarioSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  const result = await req.prisma.$transaction((tx: any) => cargarInventarioInicial(tx, companyId, userId, req.body));

  // Una carga inicial es UN movimiento contable, no doscientos: se consume una sola
  // cuota aunque el archivo traiga cien productos.
  if (result.asiento) await incrementUsage(req);
  await logAudit(req.prisma, {
    userId,
    action: 'INVENTARIO_CARGA_INICIAL',
    entity: 'InventoryProduct',
    entityId: result.asiento?.id || 'sin-asiento',
    after: { creados: result.creados, actualizados: result.actualizados, valor: result.valorTotal },
  }).catch(() => {});

  res.status(201).json(result);
}));

/** POST /api/inventario/salidas — salida manual (merma, consumo, corrección). */
inventarioRouter.post('/salidas', requireRole(...ROLES_ESCRITURA, 'inventario'), requireQuota, validate(salidaInventarioSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  const result = await req.prisma.$transaction((tx: any) => registrarSalida(tx, companyId, userId, req.body));

  await incrementUsage(req);
  await logAudit(req.prisma, {
    userId,
    action: 'INVENTARIO_SALIDA',
    entity: 'InventoryMovement',
    entityId: result.asiento.id,
    after: { asiento: result.asiento.id, movimientos: result.movimientos.length },
  }).catch(() => {});

  res.status(201).json(result);
}));

/** POST /api/inventario/ajustes — toma física: se cuenta el depósito y se registra la diferencia. */
inventarioRouter.post('/ajustes', requireRole(...ROLES_ESCRITURA, 'inventario'), requireQuota, validate(ajusteInventarioSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  const result = await req.prisma.$transaction((tx: any) => registrarAjustes(tx, companyId, userId, req.body));

  if (result.asiento) await incrementUsage(req);
  await logAudit(req.prisma, {
    userId,
    action: 'INVENTARIO_AJUSTE',
    entity: 'InventoryMovement',
    entityId: result.asiento?.id || 'sin-asiento',
    after: { ajustados: result.ajustados, motivo: req.body.motivo },
  }).catch(() => {});

  res.status(201).json(result);
}));

/**
 * POST /api/inventario/movimientos/:id/anular — anula la OPERACIÓN del movimiento.
 *
 * Por operación y no por fila: un movimiento suelto de una compra de tres productos
 * no se puede revertir solo, porque el asiento cubre los tres. La respuesta dice
 * cuántos movimientos abarcó para que la UI pueda avisarlo.
 */
inventarioRouter.post('/movimientos/:id/anular', requireRole(...ROLES_ESCRITURA, 'inventario'), requireQuota, validate(anularMovimientoSchema), wrap(async (req, res) => {
  const companyId = req.user!.companyId;
  const userId = req.user!.userId;

  const result = await req.prisma.$transaction((tx: any) =>
    anularMovimiento(tx, companyId, userId, req.params.id, req.body.motivo));

  await incrementUsage(req);
  await logAudit(req.prisma, {
    userId,
    action: 'INVENTARIO_ANULADO',
    entity: 'InventoryMovement',
    entityId: req.params.id,
    after: { movimientos: result.cantidad, motivo: req.body.motivo },
  }).catch(() => {});

  res.status(201).json(result);
}));
