/**
 * Fusión de terceros duplicados (clientes o proveedores).
 *
 * Un duplicado no se borra y listo: sus facturas, movimientos de inventario,
 * cuentas de trabajador y la metadata de las Transactions tienen que pasar al
 * maestro; si no, el Anexo/estado de cuenta pierde historia o queda apuntando a
 * un id que ya no existe.
 *
 * El maestro conserva nombre y RUC. Del duplicado solo se completan los campos
 * que el maestro tenga vacíos. Si ambos tienen RUC distinto se exige `forzar`
 * (la UI lo confirma): podrían ser dos proveedores distintos con nombres
 * parecidos y fusionarlos sería peor que dejarlos duplicados.
 */
import { normalizarNombreTercero, normalizarRucBase } from '@agt-contador/shared';

export type TipoFusion = 'cliente' | 'proveedor';

export interface FusionTerceroResultado {
  tipo: TipoFusion;
  origen: { id: string; name: string };
  destino: { id: string; name: string };
  movidos: {
    bills: number;
    invoices: number;
    retenciones: number;
    workerAccounts: number;
    inventoryMovements: number;
    transactions: number;
  };
}

const TIPOS_COMPRA = ['GASTO', 'COMPRA', 'PAGO_PROVEEDOR'];
const TIPOS_VENTA = ['VENTA', 'COBRO_CLIENTE'];

const vacio = (v: any) => v === null || v === undefined || String(v).trim() === '';

/** Campos que el maestro hereda del duplicado solo si los tiene vacíos. */
function camposFaltantes(tipo: TipoFusion, destino: any, origen: any) {
  const data: Record<string, any> = {};
  const copiar = (campo: string) => {
    if (vacio(destino[campo]) && !vacio(origen[campo])) data[campo] = origen[campo];
  };

  if (vacio(destino.taxId) && !vacio(origen.taxId)) {
    data.taxId = origen.taxId;
    if (!vacio(origen.dv)) data.dv = origen.dv;
    if (!vacio(origen.taxIdHash)) data.taxIdHash = origen.taxIdHash;
  } else if (
    !vacio(destino.taxId) &&
    !vacio(origen.taxId) &&
    normalizarRucBase(destino.taxId) === normalizarRucBase(origen.taxId)
  ) {
    if (vacio(destino.dv) && !vacio(origen.dv)) data.dv = origen.dv;
    if (vacio(destino.taxIdHash) && !vacio(origen.taxIdHash)) data.taxIdHash = origen.taxIdHash;
  }

  for (const campo of ['phone', 'email', 'address', 'location', 'tradeName', 'contactName', 'taxIdType']) {
    copiar(campo);
  }
  if (tipo === 'proveedor') copiar('paymentTerms');

  if (vacio(destino.notes)) {
    if (!vacio(origen.notes)) data.notes = origen.notes;
  } else if (!vacio(origen.notes) && origen.notes !== destino.notes) {
    data.notes = `${destino.notes}\n\n[Fusión] ${origen.notes}`;
  }

  if (tipo === 'cliente' && origen.esAgenteRetenedor && !destino.esAgenteRetenedor) {
    data.esAgenteRetenedor = true;
    data.porcentajeRetencionItbms = origen.porcentajeRetencionItbms;
    if (origen.vigenciaRetencionDesde) data.vigenciaRetencionDesde = origen.vigenciaRetencionDesde;
    if (origen.vigenciaRetencionHasta) data.vigenciaRetencionHasta = origen.vigenciaRetencionHasta;
  }

  const fiscales = ['taxId', 'dv', 'phone', 'email', 'address', 'location', 'tradeName', 'contactName', 'taxIdType'];
  if (fiscales.some((k) => k in data)) {
    data.fiscalSource = origen.fiscalSource || 'MANUAL';
    data.fiscalUpdatedAt = new Date();
  }
  return data;
}

/**
 * Re-apunta las Transactions al maestro. Los ids explícitos mandan; para filas
 * viejas sin id se usa el nombre normalizado o el RUC, pero SOLO dentro del tipo
 * de movimiento que corresponde (compra vs. venta) para no cruzar un cliente
 * homónimo con un proveedor.
 */
async function moverMetadata(
  tx: any,
  companyId: string,
  tipo: TipoFusion,
  origen: any,
  destino: any,
): Promise<number> {
  const clave = tipo === 'cliente' ? 'clientId' : 'supplierId';
  const tipos = tipo === 'cliente' ? TIPOS_VENTA : TIPOS_COMPRA;
  const nombreOrigen = normalizarNombreTercero(origen.name);
  const rucOrigen = normalizarRucBase(origen.taxId);
  const txs = await tx.transaction.findMany({
    where: { companyId },
    select: { id: true, metadata: true, type: true },
  });

  let movidos = 0;
  for (const t of txs || []) {
    let m: any = {};
    try { m = JSON.parse(t.metadata || '{}'); } catch { continue; }
    if (!m || typeof m !== 'object') continue;
    if (m[clave] === destino.id) continue;

    const idMatch = m[clave] === origen.id;
    const nombreMatch =
      !!nombreOrigen &&
      (normalizarNombreTercero(m.provider) === nombreOrigen ||
        normalizarNombreTercero(m.nombre) === nombreOrigen);
    const rucMatch = !!rucOrigen && !!m.ruc && normalizarRucBase(m.ruc) === rucOrigen;
    const tipoOk = tipos.includes(String(t.type || '').toUpperCase());

    if (!idMatch && !((nombreMatch || rucMatch) && tipoOk)) continue;

    m[clave] = destino.id;
    await tx.transaction.update({
      where: { id: t.id },
      data: { metadata: JSON.stringify(m) },
    });
    movidos++;
  }
  return movidos;
}

export async function fusionarTercero(
  prisma: any,
  companyId: string,
  tipo: TipoFusion,
  origenId: string,
  destinoId: string,
  opts: { forzar?: boolean } = {},
): Promise<FusionTerceroResultado> {
  if (!origenId || !destinoId) {
    throw Object.assign(new Error('Indicá el tercero duplicado y el maestro'), { status: 400 });
  }
  if (origenId === destinoId) {
    throw Object.assign(new Error('El origen y el destino son el mismo tercero'), { status: 400 });
  }

  const modelo = tipo === 'cliente' ? 'client' : 'supplier';
  return prisma.$transaction(async (tx: any) => {
    const [origen, destino] = await Promise.all([
      tx[modelo].findFirst({ where: { id: origenId, companyId } }),
      tx[modelo].findFirst({ where: { id: destinoId, companyId } }),
    ]);
    if (!origen || !destino) {
      throw Object.assign(new Error('Tercero no encontrado'), { status: 404 });
    }

    const rucOrigen = normalizarRucBase(origen.taxId);
    const rucDestino = normalizarRucBase(destino.taxId);
    if (rucOrigen && rucDestino && rucOrigen !== rucDestino && !opts.forzar) {
      throw Object.assign(
        new Error('Los terceros tienen RUC distintos. Confirmá que son el mismo tercero.'),
        { status: 400, code: 'RUC_DISTINTO' },
      );
    }

    const movidos = {
      bills: 0,
      invoices: 0,
      retenciones: 0,
      workerAccounts: 0,
      inventoryMovements: 0,
      transactions: 0,
    };

    if (tipo === 'proveedor') {
      movidos.bills = (await tx.bill.updateMany({
        where: { companyId, supplierId: origenId },
        data: { supplierId: destinoId },
      })).count;
      movidos.workerAccounts = (await tx.workerAccount.updateMany({
        where: { companyId, supplierId: origenId },
        data: { supplierId: destinoId },
      })).count;
      movidos.inventoryMovements = (await tx.inventoryMovement.updateMany({
        where: { companyId, supplierId: origenId },
        data: { supplierId: destinoId },
      })).count;
    } else {
      movidos.invoices = (await tx.invoice.updateMany({
        where: { companyId, clientId: origenId },
        data: { clientId: destinoId },
      })).count;
      movidos.retenciones = (await tx.retentionItbms.updateMany({
        where: { companyId, clientId: origenId },
        data: { clientId: destinoId },
      })).count;
    }

    movidos.transactions = await moverMetadata(tx, companyId, tipo, origen, destino);

    const data = camposFaltantes(tipo, destino, origen);
    // El duplicado se elimina ANTES de copiarle el RUC/hash al maestro: el
    // índice único (companyId, taxIdHash) no admite dos filas con el mismo hash,
    // y el duplicado todavía lo tiene. Si el update del maestro falla, toda la
    // transacción vuelve atrás y el duplicado reaparece.
    await tx[modelo].delete({ where: { id: origenId } });
    if (Object.keys(data).length > 0) {
      await tx[modelo].update({ where: { id: destinoId }, data });
    }

    return {
      tipo,
      origen: { id: origen.id, name: origen.name },
      destino: { id: destino.id, name: destino.name },
      movidos,
    };
  });
}
