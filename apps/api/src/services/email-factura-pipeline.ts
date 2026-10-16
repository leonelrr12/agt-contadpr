/**
 * El pipeline: de una factura detectada en un correo a un asiento BORRADOR.
 *
 * Es el mismo destino que WhatsApp —extrae, clasifica y crea el asiento en
 * BORRADOR, más el archivo en «Facturas recibidas»— pero **sin nadie del otro
 * lado**: cuando algo falta no se pregunta, se anota el motivo y no se carga
 * nada. Adivinar acá significa un asiento que alguien tiene que anular.
 *
 * Las tres capas que neutralizan al LLM en la contrapartida, en orden:
 *  1. el contexto sintético trae el método de pago y el tipo (GASTO);
 *  2. `paymentMethodForzado` lo impone antes de armar el asiento;
 *  3. `cuentaPagoForzada` reemplaza la línea del banco **pase lo que pase**.
 * Sin la tercera, `aplicarBancoMencionado` podía acreditar OTRO banco del
 * catálogo y el asiento dejaba de cuadrar con la cuenta configurada.
 */

import { OrchestratorAgent } from '@agt-contador/agents';
import { buildDedupeKey, buscarFacturaDuplicada, registrarFacturaRecibida, avisoDuplicado } from './reembolsos';
import { cuentaBancoDeEmpresa, parseReceptorRucs } from './email-facturas-config';
import { resolveCompanyUserId } from './company-user';
import { incrementUsageForCompany } from '../middleware/quota';
import { suscripcionDeEmpresa } from './suscripcion';
import { quickClassify } from './pre-clasificador';
import type { FacturaDetectada } from './email-factura-extract';

export type EstadoCarga =
  | 'CARGADA'
  | 'DUPLICADA'
  | 'OTRO_CLIENTE'
  | 'SIN_CUENTA'
  | 'SIN_CONCEPTO'
  | 'SIN_DATOS'
  | 'CUOTA'
  | 'ERROR';

export interface ResultadoCarga {
  estado: EstadoCarga;
  detalle: string | null;
  journalEntryId: string | null;
  claimId: string | null;
}

/** ¿El receptor de la factura es este RUC (o uno de los extra aceptados)? */
function esRucAceptado(receptor: string, aceptados: string[]): boolean {
  // Las comparaciones por cola exigen un mínimo de dígitos: sin él, un receptor
  // de dos dígitos («79») matchearía cualquier RUC que termine igual.
  const largos = (a: string) => a.length >= 6;
  return aceptados.some((aceptado) => {
    if (!aceptado) return false;
    if (receptor === aceptado) return true;
    return largos(receptor) && largos(aceptado) && (receptor.endsWith(aceptado) || aceptado.endsWith(receptor));
  });
}

/**
 * ¿La factura es de ESTA empresa? El correo trae facturas de cualquiera, y la
 * del cliente de al lado se ve igual que la propia. Se compara por dígitos
 * porque el mismo RUC viaja con y sin guiones, con y sin dígito verificador.
 *
 * Se aceptan el RUC de la empresa **y los extra** que el dueño haya cargado en la
 * configuración del buzón: el caso normal es que compre a su nombre personal, y
 * sin esa lista sus propias facturas caerían como «de otro cliente».
 *
 * Sin RUC en la factura, o sin ningún RUC con qué comparar, **se sigue**: las
 * otras redes (el dedupe y la revisión del contador) siguen puestas.
 */
async function esDeLaEmpresa(
  prisma: any,
  cfg: any,
  clienteRuc: string | null,
  clienteNombre: string | null,
): Promise<{ ok: boolean; detalle?: string }> {
  const receptor = String(clienteRuc || '').replace(/\D/g, '');
  if (!receptor) return { ok: true };

  const empresa = await prisma.company.findUnique({
    where: { id: cfg.companyId },
    select: { name: true, taxId: true },
  });
  const aceptados = [String(empresa?.taxId || '').replace(/\D/g, ''), ...parseReceptorRucs(cfg.receptorRucs)].filter(Boolean);
  if (!aceptados.length) return { ok: true }; // no hay con qué comparar

  if (esRucAceptado(receptor, aceptados)) return { ok: true };

  return {
    ok: false,
    detalle: `La factura está a nombre de ${clienteNombre || 'otro cliente'} (RUC ${clienteRuc}), y esta empresa es ${empresa?.name || cfg.companyId} (RUC ${empresa?.taxId || 'sin RUC'}). Si es una compra tuya a tu nombre, agregá ese RUC en «Aceptar facturas a nombre de».`,
  };
}

/** Hay cuota de movimientos en el plan. Sin suscripción no se carga nada. */
async function hayCuota(prisma: any, companyId: string): Promise<boolean> {
  const sub = await suscripcionDeEmpresa(prisma, companyId);
  return !!sub && sub.movementsUsed < sub.movementsLimit;
}

/** El nombre del concepto configurado como default, si sigue existiendo. */
async function conceptoDefault(prisma: any, companyId: string, conceptoId: string | null): Promise<string | null> {
  if (!conceptoId) return null;
  const c = await prisma.concept.findFirst({
    where: { id: conceptoId, companyId, isActive: true },
    select: { name: true },
  });
  return c?.name || null;
}

/**
 * Carga UNA factura detectada. Nunca lanza: el resultado es lo que va al ledger
 * (un error se devuelve como estado, no como excepción, para no cortar el barrido
 * de los demás correos).
 */
export async function cargarFacturaDesdeCorreo(
  prisma: any,
  cfg: any,
  det: FacturaDetectada,
  correo: { mensajeId: string },
): Promise<ResultadoCarga> {
  const companyId = cfg.companyId;
  const vacio = { journalEntryId: null, claimId: null };

  try {
    // 1) Duplicada: se resuelve ANTES de gastar LLM. La misma factura puede
    //    venir por correo, por WhatsApp y a mano; el dedupe es el mismo para todos.
    const duplicado = await buscarFacturaDuplicada(prisma, companyId, buildDedupeKey(det.factura));
    if (duplicado) {
      return { estado: 'DUPLICADA', detalle: avisoDuplicado(duplicado), ...vacio };
    }

    // 2) ¿Es de esta empresa?
    const propia = await esDeLaEmpresa(prisma, cfg, det.clienteRuc, det.clienteNombre);
    if (!propia.ok) return { estado: 'OTRO_CLIENTE', detalle: propia.detalle || null, ...vacio };

    // 3) La contrapartida: sin cuenta de banco configurada no se carga nada.
    const cuenta = await cuentaBancoDeEmpresa(prisma, companyId, cfg.cuentaPagoId);
    if (!cuenta) {
      return {
        estado: 'SIN_CUENTA',
        detalle: 'Falta la cuenta de contrapartida en la configuración del buzón: sin ella no se sabe contra qué banco acreditar.',
        ...vacio,
      };
    }

    if (!(await hayCuota(prisma, companyId))) {
      return { estado: 'CUOTA', detalle: 'La cuota de movimientos del plan está agotada.', ...vacio };
    }

    // 4) Contexto sintético, como el de WhatsApp: con `source` el motor trata
    //    `amount` como TOTAL con ITBMS adentro.
    const f = det.factura;
    const itemsDesc = det.items.join(', ');
    const concepto =
      (await conceptoDefault(prisma, companyId, cfg.conceptoDefaultId)) ||
      (await quickClassify(f.proveedor, prisma, companyId)) ||
      (await quickClassify(itemsDesc, prisma, companyId)) ||
      (await quickClassify(det.texto, prisma, companyId));

    const extractedData: Record<string, any> = {
      type: 'GASTO',
      source: 'correo',
      // El método de pago entra por CONTEXTO, no solo por `paymentMethodForzado`:
      // el diálogo decide qué le falta ANTES de que el orquestador imponga nada,
      // así que sin esto el flujo headless se queda pidiendo «¿Cómo se pagó?».
      paymentMethod: cfg.metodoPago || 'TRANSFERENCIA',
      // selectedEntityId = null ⇒ la guarda de `entityMatches` no se abre: es un
      // flujo sin nadie que pueda contestar el selector (trampa del headless).
      selectedEntityId: null,
    };
    if (f.proveedor) extractedData.provider = f.proveedor;
    if (f.total) extractedData.amount = f.total;
    if (f.fecha) extractedData.date = f.fecha;
    if (f.ruc) extractedData.ruc = f.ruc;
    if (f.numeroFactura) extractedData.invoiceNumber = f.numeroFactura;
    if (f.itbms) {
      extractedData.itbms = true;
      extractedData.itbmsAmount = f.itbms;
    }
    if (det.items.length) extractedData.items = det.items;
    if (concepto) extractedData.concept = concepto;

    const input = [
      'compré',
      f.proveedor ? `en ${f.proveedor}` : '',
      f.total ? `$${Number(f.total).toFixed(2)}` : '',
      f.numeroFactura ? `factura ${f.numeroFactura}` : '',
    ]
      .filter(Boolean)
      .join(' ');

    const orchestrator = new OrchestratorAgent({
      prisma,
      companyId,
      userId: await resolveCompanyUserId(prisma, companyId, 'correo'),
      deepseekApiKey: process.env.DEEPSEEK_API_KEY,
      paymentMethodForzado: cfg.metodoPago || 'TRANSFERENCIA',
      cuentaPagoForzada: { id: cuenta.id, name: cuenta.name },
    });

    // 5) Procesar. Si el motor necesita preguntar algo, NO se confirma nada.
    const r = await orchestrator.process(input, { messages: [], extractedData } as any);
    if (!r.needsConfirmation || !r.result?.entry) {
      const prompt = String(r.prompt || '');
      return {
        estado: /concepto/i.test(prompt) ? 'SIN_CONCEPTO' : 'SIN_DATOS',
        detalle: prompt || 'El motor no pudo armar el asiento con lo que traía la factura.',
        ...vacio,
      };
    }

    // 6) Confirmar → asiento BORRADOR + Transaction.
    const confirmado = await orchestrator.confirm(r.result);
    const journalEntry = confirmado.journalEntry;
    if (!journalEntry?.id) {
      return { estado: 'ERROR', detalle: 'El asiento no se pudo guardar.', ...vacio };
    }

    const registro = await registrarFacturaRecibida(prisma, {
      companyId,
      workerId: null, // factura de la empresa: se archiva, no se reembolsa
      journalEntry,
      tipo: 'GASTO',
      factura: f,
      origen: 'CORREO',
      emailMensajeId: correo.mensajeId,
    });

    // 7) Carrera con otro canal: la factura ya estaba archivada, así que el
    //    asiento recién creado sobra. Se borra —si no, queda un BORRADOR fantasma
    //    con el mismo gasto contado dos veces y nadie sabe de dónde salió.
    if (!registro.creado) {
      if (registro.duplicado) {
        await compensarAsiento(prisma, journalEntry.id);
        return {
          estado: 'DUPLICADA',
          detalle: `${avisoDuplicado(registro.duplicado)} Se descartó el asiento que se había creado.`,
          ...vacio,
        };
      }
      await compensarAsiento(prisma, journalEntry.id);
      return { estado: 'ERROR', detalle: `No se pudo archivar la factura (${registro.motivo || 'motivo desconocido'}).`, ...vacio };
    }

    // 8) La cuota se consume solo cuando la factura quedó cargada y archivada.
    await incrementUsageForCompany(prisma, companyId, 1);

    return {
      estado: 'CARGADA',
      detalle: null,
      journalEntryId: journalEntry.id,
      claimId: registro.claim?.id || null,
    };
  } catch (err: any) {
    return { estado: 'ERROR', detalle: String(err?.message || err).slice(0, 500), ...vacio };
  }
}

/** Deshace un asiento recién creado (transacciones → líneas → asiento). */
async function compensarAsiento(prisma: any, journalEntryId: string): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.transaction.deleteMany({ where: { journalEntryId } }),
      prisma.journalLine.deleteMany({ where: { journalEntryId } }),
      prisma.journalEntry.delete({ where: { id: journalEntryId } }),
    ]);
  } catch (err: any) {
    // Si la compensación falla, el asiento queda visible en Revisión: es
    // preferible un borrador de más que una factura perdida en silencio.
    console.error('[EmailFacturas] No se pudo compensar el asiento', journalEntryId, err?.message);
  }
}
