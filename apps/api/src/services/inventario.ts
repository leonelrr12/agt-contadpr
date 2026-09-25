/**
 * Lógica del módulo de Inventario: registrar entradas y salidas de mercancía y
 * emitir su asiento.
 *
 * El kardex es la fuente de verdad de las CANTIDADES y el libro diario la de los
 * MONTOS. Se mantienen cuadrados por construcción: cada movimiento guarda el monto
 * que fue al asiento (`costoTotal`) y el saldo corrido es la suma de esos montos,
 * nunca `cantidad × promedio` (ver services/costo-promedio.ts).
 *
 * Todo lo que escribe corre dentro de la `$transaction` que abre la ruta: o queda
 * el movimiento con su asiento, o no queda nada.
 */
import { AccountingAgent } from '@agt-contador/agents';
import { checkNotBlocked } from './journal-guard';
import { calcularMovimiento, type EstadoProducto, type MovimientoCalculado } from './costo-promedio';
import { syncEntityFromEntry } from './entity-service';
import { parseLocalDate } from '../lib/dates';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Cuentas contra las que puede ir una salida manual (merma, consumo, ajuste). */
export interface LineaEntrada { productId: string; cantidad: number; costoUnitario: number }
export interface LineaSalida { productId: string; cantidad: number }

export interface OpcionesEntrada {
  lineas: LineaEntrada[];
  fecha: string;
  paymentMethod: string;
  bancoCuentaId?: string | null;
  supplierId?: string | null;
  referencia?: string | null;
  notas?: string | null;
  /** ITBMS que va a crédito fiscal. Solo si la empresa lo declara; si no, va en el costo. */
  itbmsAmount?: number;
  /** 'COMPRA' para una compra normal, 'APERTURA' para el stock inicial. */
  origen?: 'COMPRA' | 'APERTURA';
  /**
   * Cuenta que recibe la contrapartida de una APERTURA. Es obligatoria ahí y no se
   * adivina: cargar existencias sin compra puede ir contra patrimonio, contra una
   * cuenta de carga inicial o contra proveedores, y eso lo decide el contador.
   */
  cuentaContrapartidaId?: string | null;
  /** Idempotencia: repetir la misma clave no registra dos veces. */
  dedupeKey?: string | null;
}

export interface OpcionesSalida {
  lineas: LineaSalida[];
  fecha: string;
  motivo?: string | null;
  /** Cuenta que recibe el costo de lo que sale. Por defecto, la de costo de ventas. */
  cuentaContrapartidaId?: string | null;
  /** Permite dejar el stock en negativo (venta ya ocurrida sin mercancía cargada). */
  forzar?: boolean;
  dedupeKey?: string | null;
}

export interface ResultadoMovimiento {
  movimientos: any[];
  asiento: any;
  avisos: string[];
}

// ── Cuentas ─────────────────────────────────────────────────────────────────

/**
 * Busca la primera cuenta que exista, sin lanzar: `resolveAlias` del agente tira
 * error en el primer fallo, así que la cadena de respaldo va a mano.
 */
function buscarCuenta(agent: AccountingAgent, ...candidatos: (string | null | undefined)[]): string | null {
  for (const c of candidatos) {
    if (!c) continue;
    try {
      return agent.resolveAlias(c);
    } catch {
      // no está en esta empresa: probamos el siguiente candidato
    }
  }
  return null;
}

/**
 * Cuentas del kardex: la del producto → la de la empresa → el alias clásico → el
 * código del catálogo. Si ninguna existe, el mensaje dice qué hacer, no un genérico.
 */
export function resolverCuentas(
  agent: AccountingAgent,
  empresa: { inventarioCuentaId?: string | null; inventarioCostoId?: string | null },
  producto?: any,
): { inventarioId: string; costoId: string } {
  const inventarioId = buscarCuenta(
    agent,
    producto?.cuentaInventarioId,
    empresa.inventarioCuentaId,
    'inventario-mercancia',
    '1.1.04.01',
  );
  if (!inventarioId) {
    throw Object.assign(
      new Error('No encuentro la cuenta de inventario. Asígnale el alias "inventario-mercancia" a la cuenta de mercancía, o configúrala en el producto.'),
      { status: 400 },
    );
  }

  const costoId = buscarCuenta(
    agent,
    producto?.cuentaCostoId,
    empresa.inventarioCostoId,
    'costo-ventas',
    '5.01.01',
  );
  if (!costoId) {
    throw Object.assign(
      new Error('No encuentro la cuenta de costo de ventas. Asígnale el alias "costo-ventas" a 5.01.01 o configúrala en el producto.'),
      { status: 400 },
    );
  }

  return { inventarioId, costoId };
}

/** Cuenta que recibe el pago de una compra, según la forma de pago. */
function cuentaDePago(agent: AccountingAgent, paymentMethod: string, bancoCuentaId?: string | null): string {
  if (paymentMethod === 'CREDITO') {
    const proveedores = buscarCuenta(agent, 'proveedores', '2.1.01');
    if (!proveedores) throw Object.assign(new Error('No encuentro la cuenta de proveedores (2.1.01).'), { status: 400 });
    return proveedores;
  }
  if (paymentMethod === 'EFECTIVO') return buscarCuenta(agent, 'caja', '1.1.01') || cuentaBanco(agent, bancoCuentaId);
  return cuentaBanco(agent, bancoCuentaId);
}

function cuentaBanco(agent: AccountingAgent, bancoCuentaId?: string | null): string {
  const banco = buscarCuenta(agent, bancoCuentaId, 'banco-general', '1.1.02.01');
  if (!banco) throw Object.assign(new Error('No encuentro la cuenta bancaria de la empresa.'), { status: 400 });
  return banco;
}

// ── Bloqueo de productos ────────────────────────────────────────────────────

/**
 * Toma el lock de los productos dentro de la transacción, en orden de id, para que
 * dos salidas simultáneas del mismo producto no se pisen ni se produzca un deadlock.
 * Los ids ya se validaron contra la empresa (son cuid de la BD), y el filtro de
 * seguridad es la segunda red.
 */
async function bloquearProductos(tx: any, ids: string[]): Promise<void> {
  const limpios = [...new Set(ids)].map((id) => String(id).replace(/[^A-Za-z0-9_-]/g, '')).filter(Boolean).sort();
  if (!limpios.length) return;
  const lista = limpios.map((id) => `'${id}'`).join(',');
  await tx.$queryRawUnsafe(`SELECT id FROM inventory_product WHERE id IN (${lista}) ORDER BY id FOR UPDATE`);
}

async function cargarProductos(tx: any, companyId: string, ids: string[]): Promise<Map<string, any>> {
  const productos = await tx.inventoryProduct.findMany({ where: { companyId, id: { in: [...new Set(ids)] } } });
  const mapa = new Map<string, any>(productos.map((p: any) => [p.id, p]));
  for (const id of new Set(ids)) {
    if (!mapa.has(id)) throw Object.assign(new Error(`Producto no encontrado: ${id}`), { status: 404 });
  }
  return mapa;
}

/** Estado vigente del producto, tal como lo espera el motor de costo. */
const estadoDe = (p: any): EstadoProducto => ({ cantidad: p.stockActual, valor: p.stockValor, promedio: p.costoPromedio });

/** Comprueba que la clave de idempotencia no se haya usado ya. */
async function verificarIdempotencia(tx: any, companyId: string, dedupeKey?: string | null): Promise<void> {
  if (!dedupeKey) return;
  const ya = await tx.inventoryMovement.findFirst({
    where: { companyId, dedupeKey: { startsWith: `${dedupeKey}:` } },
    select: { id: true },
  });
  if (ya) {
    throw Object.assign(new Error('Esa operación ya fue registrada (misma clave de idempotencia).'), { status: 409 });
  }
}

/** Clave por FILA: una operación con varias líneas no puede repetir la misma clave. */
const claveFila = (base: string, productId: string, seq: number) => `${base}:${productId}:${seq}`;

// ── Entradas ────────────────────────────────────────────────────────────────

/**
 * Registra una entrada de mercancía: mueve el kardex y emite el asiento de compra.
 *
 * `costoUnitario` es SIEMPRE lo que queda en el kardex, y el asiento debita
 * inventario por exactamente ese importe — es lo que mantiene kardex y mayor
 * cuadrados. El ITBMS es una línea aparte contra crédito fiscal, y solo si la
 * empresa lo declara: si no, va dentro del costo y no se informa acá.
 */
export async function registrarEntrada(
  tx: any,
  companyId: string,
  userId: string,
  data: OpcionesEntrada,
): Promise<ResultadoMovimiento> {
  await verificarIdempotencia(tx, companyId, data.dedupeKey);

  const agent = new AccountingAgent(tx, companyId);
  await agent.init();
  const empresa = await tx.company.findUnique({
    where: { id: companyId },
    select: { inventarioCuentaId: true, inventarioCostoId: true, declaraITBMS: true },
  });

  const itbms = r2(data.itbmsAmount || 0);
  if (itbms > 0 && !empresa?.declaraITBMS) {
    throw Object.assign(
      new Error('Esta empresa no declara ITBMS: el impuesto va dentro del costo unitario, no como línea aparte.'),
      { status: 400 },
    );
  }

  const ids = data.lineas.map((l) => l.productId);
  await bloquearProductos(tx, ids);
  const productos = await cargarProductos(tx, companyId, ids);

  // Cuentas: si todos los productos comparten cuenta se resuelve una vez; si algún
  // producto tiene la suya, se resuelve por producto.
  const cuentasPorProducto = new Map<string, { inventarioId: string; costoId: string }>();
  for (const id of new Set(ids)) {
    cuentasPorProducto.set(id, resolverCuentas(agent, empresa || {}, productos.get(id)));
  }

  // ── Motor de costo ──
  const calcular: { producto: any; mov: MovimientoCalculado; origen: string; linea: LineaEntrada }[] = [];
  const avisos: string[] = [];
  const estados = new Map<string, EstadoProducto>();

  for (const linea of data.lineas) {
    const producto = productos.get(linea.productId);
    const estado = estados.get(producto.id) || estadoDe(producto);
    const res = calcularMovimiento(estado, {
      tipo: 'ENTRADA',
      cantidad: linea.cantidad,
      costoUnitario: linea.costoUnitario,
    });
    if (!res.ok) throw Object.assign(new Error(`${producto.nombre}: ${res.error}`), { status: 400 });

    for (const mov of res.movimientos) {
      calcular.push({
        producto,
        mov,
        // La regularización conserva su propio origen: no es una compra.
        origen: mov.origen === 'REGULARIZACION' ? 'REGULARIZACION' : (data.origen || 'COMPRA'),
        linea,
      });
      avisos.push(...mov.avisos.map((a) => `${producto.nombre}: ${a}`));
    }
    const ultimo = res.movimientos[res.movimientos.length - 1];
    estados.set(producto.id, {
      cantidad: ultimo.saldoCantidad,
      valor: ultimo.saldoValor,
      promedio: ultimo.saldoCostoPromedio,
    });
  }

  // ── Asiento: agrupado por cuenta para que quede legible ──
  const porCuenta = new Map<string, { debit: number; credit: number }>();
  const sumar = (accountId: string, campo: 'debit' | 'credit', monto: number) => {
    const acc = porCuenta.get(accountId) || { debit: 0, credit: 0 };
    acc[campo] = r2(acc[campo] + monto);
    porCuenta.set(accountId, acc);
  };

  let totalCompra = 0;
  for (const { mov, producto } of calcular) {
    const { inventarioId, costoId } = cuentasPorProducto.get(producto.id)!;
    if (mov.origen === 'REGULARIZACION') {
      // Las unidades que habían salido sin costo ahora tienen costo: entra a costo de
      // ventas y sale del inventario. Es un par completo, no un débito suelto.
      sumar(inventarioId, 'credit', mov.costoTotal);
      sumar(costoId, 'debit', mov.costoTotal);
    } else {
      sumar(inventarioId, 'debit', mov.costoTotal);
      totalCompra = r2(totalCompra + mov.costoTotal);
    }
  }
  if (itbms > 0) sumar(buscarCuenta(agent, 'itbms-por-pagar', '2.1.05')!, 'debit', itbms);

  // La apertura no tiene pago: su contrapartida la elige el contador.
  let cuentaCreditoId: string;
  if (data.origen === 'APERTURA') {
    const contrapartida = buscarCuenta(agent, data.cuentaContrapartidaId);
    if (!contrapartida) {
      throw Object.assign(
        new Error('Una apertura de inventario necesita la cuenta de contrapartida (contra qué se carga la existencia).'),
        { status: 400 },
      );
    }
    cuentaCreditoId = contrapartida;
  } else {
    cuentaCreditoId = cuentaDePago(agent, data.paymentMethod, data.bancoCuentaId);
  }
  sumar(cuentaCreditoId, 'credit', r2(totalCompra + itbms));

  const lineas = [...porCuenta.entries()].map(([accountId, v]) => ({ accountId, debit: v.debit, credit: v.credit }));

  const bloqueada = await checkNotBlocked(tx, companyId, lineas.map((l) => l.accountId));
  if (bloqueada) throw Object.assign(new Error(bloqueada), { status: 400 });

  const fecha = parseLocalDate(data.fecha);
  const descripcion = descripcionEntrada(data, calcular);
  const asiento = await tx.journalEntry.create({
    data: {
      date: fecha,
      description: descripcion,
      status: 'BORRADOR',
      companyId,
      createdById: userId,
      lines: { create: lineas },
    },
  });

  const movimientos = await crearMovimientos(tx, companyId, userId, {
    calcular, estados, fecha, asientoId: asiento.id,
    origenPorDefecto: data.origen || 'COMPRA',
    supplierId: data.supplierId || null,
    referencia: data.referencia || null,
    notas: data.notas || null,
    dedupeKey: data.dedupeKey || null,
  });

  // ── Auxiliar de CxP ──
  // Una compra a crédito acredita Proveedores: sin esto el asiento existe pero la
  // deuda no aparece en el auxiliar. El sync lee la contraparte de la Transaction,
  // así que hay que crearla antes y con el nombre del proveedor.
  // La condición es "quedó a deber", no la forma de pago: una apertura contra
  // proveedores también es deuda y tiene que verse en el auxiliar.
  const proveedoresId = buscarCuenta(agent, 'proveedores', '2.1.01');
  if (proveedoresId && cuentaCreditoId === proveedoresId) {
    const proveedor = data.supplierId
      ? await tx.supplier.findFirst({ where: { id: data.supplierId, companyId } })
      : null;
    if (!proveedor) {
      throw Object.assign(new Error('Una compra a crédito necesita proveedor.'), { status: 400 });
    }
    await tx.transaction.create({
      data: {
        type: 'COMPRA',
        amount: totalCompra,
        description: descripcion,
        concept: 'Compra de mercancía',
        paymentMethod: data.paymentMethod,
        date: fecha,
        companyId,
        createdById: userId,
        journalEntryId: asiento.id,
        metadata: JSON.stringify({
          provider: proveedor.name,
          ruc: proveedor.taxId || null,
          invoiceNumber: data.referencia || null,
          source: 'inventario',
        }),
      },
    });
    await syncEntityFromEntry(tx, companyId, asiento);
  } else {
    await tx.transaction.create({
      data: {
        type: 'COMPRA',
        amount: totalCompra,
        description: descripcion,
        concept: 'Compra de mercancía',
        paymentMethod: data.paymentMethod,
        date: fecha,
        companyId,
        createdById: userId,
        journalEntryId: asiento.id,
        metadata: JSON.stringify({ source: 'inventario', contado: true }),
      },
    });
  }

  return { movimientos, asiento, avisos };
}

// ── Salidas ─────────────────────────────────────────────────────────────────

/**
 * Registra una salida manual (merma, consumo interno, corrección). La salida por
 * VENTA no pasa por acá: la genera el asiento de la factura (ver INVENTARIO.md §3.5).
 */
export async function registrarSalida(
  tx: any,
  companyId: string,
  userId: string,
  data: OpcionesSalida,
): Promise<ResultadoMovimiento> {
  await verificarIdempotencia(tx, companyId, data.dedupeKey);

  const agent = new AccountingAgent(tx, companyId);
  await agent.init();
  const empresa = await tx.company.findUnique({
    where: { id: companyId },
    select: { inventarioCuentaId: true, inventarioCostoId: true },
  });

  const ids = data.lineas.map((l) => l.productId);
  await bloquearProductos(tx, ids);
  const productos = await cargarProductos(tx, companyId, ids);

  const cuentasPorProducto = new Map<string, { inventarioId: string; costoId: string }>();
  for (const id of new Set(ids)) {
    cuentasPorProducto.set(id, resolverCuentas(agent, empresa || {}, productos.get(id)));
  }

  const calcular: { producto: any; mov: MovimientoCalculado; origen: string; linea: any }[] = [];
  const avisos: string[] = [];
  const estados = new Map<string, EstadoProducto>();

  for (const linea of data.lineas) {
    const producto = productos.get(linea.productId);
    const estado = estados.get(producto.id) || estadoDe(producto);
    const res = calcularMovimiento(
      estado,
      { tipo: 'AJUSTE_NEGATIVO', cantidad: linea.cantidad },
      { forzar: !!data.forzar },
    );
    if (!res.ok) throw Object.assign(new Error(`${producto.nombre}: ${res.error}`), { status: 400 });

    calcular.push({ producto, mov: res.movimientos[0], origen: 'AJUSTE', linea });
    avisos.push(...res.movimientos[0].avisos.map((a) => `${producto.nombre}: ${a}`));
    estados.set(producto.id, {
      cantidad: res.movimientos[0].saldoCantidad,
      valor: res.movimientos[0].saldoValor,
      promedio: res.movimientos[0].saldoCostoPromedio,
    });
  }

  const porCuenta = new Map<string, { debit: number; credit: number }>();
  const sumar = (accountId: string, campo: 'debit' | 'credit', monto: number) => {
    const acc = porCuenta.get(accountId) || { debit: 0, credit: 0 };
    acc[campo] = r2(acc[campo] + monto);
    porCuenta.set(accountId, acc);
  };

  for (const { mov, producto } of calcular) {
    const { inventarioId, costoId } = cuentasPorProducto.get(producto.id)!;
    const contrapartida = data.cuentaContrapartidaId || costoId;
    sumar(inventarioId, 'credit', mov.costoTotal);
    sumar(contrapartida, 'debit', mov.costoTotal);
  }

  const lineas = [...porCuenta.entries()]
    .map(([accountId, v]) => ({ accountId, debit: v.debit, credit: v.credit }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);

  const bloqueada = await checkNotBlocked(tx, companyId, lineas.map((l) => l.accountId));
  if (bloqueada) throw Object.assign(new Error(bloqueada), { status: 400 });

  const fecha = parseLocalDate(data.fecha);
  const descripcion = `Salida de inventario${data.motivo ? `: ${data.motivo}` : ''} - $${totalDe(calcular)}`;
  const asiento = await tx.journalEntry.create({
    data: {
      date: fecha,
      description: descripcion,
      status: 'BORRADOR',
      companyId,
      createdById: userId,
      lines: { create: lineas },
    },
  });

  const movimientos = await crearMovimientos(tx, companyId, userId, {
    calcular, estados, fecha, asientoId: asiento.id,
    origenPorDefecto: 'AJUSTE',
    notas: data.motivo || null,
    dedupeKey: data.dedupeKey || null,
  });

  return { movimientos, asiento, avisos };
}

// ── Apoyo ───────────────────────────────────────────────────────────────────

const totalDe = (calcular: { mov: MovimientoCalculado }[]) =>
  r2(calcular.reduce((s, c) => s + c.mov.costoTotal, 0)).toFixed(2);

function descripcionEntrada(data: OpcionesEntrada, calcular: { mov: MovimientoCalculado; producto: any }[]) {
  const etiqueta = data.origen === 'APERTURA' ? 'Apertura de inventario' : 'Compra de mercancía';
  const detalle = calcular
    .filter((c) => c.mov.origen !== 'REGULARIZACION')
    .map((c) => `${c.producto.nombre} × ${c.mov.cantidad}`)
    .join(', ');
  return `${etiqueta}: ${detalle} - $${totalDe(calcular)}`;
}

/**
 * Crea las filas del kardex y deja el producto con su saldo vigente.
 *
 * El saldo del producto se escribe al final, con el estado que devolvió el motor:
 * es la única escritura que no sale del kardex y por eso se hace en el mismo acto.
 */
async function crearMovimientos(
  tx: any,
  companyId: string,
  userId: string,
  ctx: {
    calcular: { producto: any; mov: MovimientoCalculado; origen: string }[];
    estados: Map<string, EstadoProducto>;
    fecha: Date;
    asientoId: string;
    origenPorDefecto: string;
    supplierId?: string | null;
    referencia?: string | null;
    notas?: string | null;
    dedupeKey?: string | null;
  },
) {
  const filas: any[] = [];
  let seq = 0;
  for (const { producto, mov } of ctx.calcular) {
    filas.push({
      companyId,
      productId: producto.id,
      fecha: ctx.fecha,
      tipo: mov.tipo,
      origen: mov.origen === 'REGULARIZACION' ? 'REGULARIZACION' : ctx.origenPorDefecto,
      cantidad: mov.cantidad,
      costoUnitario: mov.costoUnitario,
      costoTotal: mov.costoTotal,
      saldoCantidad: mov.saldoCantidad,
      saldoValor: mov.saldoValor,
      saldoCostoPromedio: mov.saldoCostoPromedio,
      journalEntryId: ctx.asientoId,
      supplierId: ctx.supplierId || null,
      referencia: ctx.referencia || null,
      notas: ctx.notas || null,
      dedupeKey: ctx.dedupeKey ? claveFila(ctx.dedupeKey, producto.id, seq++) : null,
      createdById: userId,
    });
  }

  await tx.inventoryMovement.createMany({ data: filas });

  for (const [productId, estado] of ctx.estados) {
    await tx.inventoryProduct.update({
      where: { id: productId },
      data: {
        stockActual: estado.cantidad,
        stockValor: estado.valor,
        costoPromedio: estado.promedio,
      },
    });
  }

  return tx.inventoryMovement.findMany({
    where: { journalEntryId: ctx.asientoId },
    orderBy: { createdAt: 'asc' },
    include: { product: { select: { id: true, nombre: true, unidad: true } } },
  });
}
