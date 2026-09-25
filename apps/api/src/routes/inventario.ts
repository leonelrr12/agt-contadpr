import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { validate } from '../middleware/validate';
import { logAudit } from '../services/audit-log';
import { registrarEntrada, registrarSalida, cargarInventarioInicial } from '../services/inventario';
import { parseInventarioFile } from '../services/csv-parser';
import {
  createProductoSchema,
  updateProductoSchema,
  entradaInventarioSchema,
  salidaInventarioSchema,
  cargaInventarioSchema,
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

  // Sin configuración explícita, cae al catálogo clásico (1.1.04 completo).
  if (!ids.size) {
    const cuentas = await prisma.account.findMany({
      where: { companyId, code: { startsWith: '1.1.04' } },
      select: { id: true },
    });
    for (const c of cuentas) ids.add(c.id);
  }
  return [...ids];
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
  const { nombre, sku, descripcion, unidad, stockMinimo, cuentaInventarioId, cuentaCostoId } = req.body;

  try {
    const producto = await req.prisma.inventoryProduct.create({
      data: {
        companyId,
        nombre: nombre.trim(),
        sku: sku?.trim() || null,
        descripcion: descripcion || null,
        unidad: unidad || 'UND',
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
  const { nombre, sku, descripcion, unidad, stockMinimo, cuentaInventarioId, cuentaCostoId, isActive } = req.body;
  const data: any = {};
  if (nombre !== undefined) data.nombre = nombre.trim();
  if (sku !== undefined) data.sku = sku?.trim() || null;
  if (descripcion !== undefined) data.descripcion = descripcion || null;
  if (unidad !== undefined) data.unidad = unidad;
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
