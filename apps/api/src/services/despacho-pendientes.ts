/**
 * Qué está pendiente en cada empresa, para el tablero del despacho.
 *
 * Es lo que un contador mira al sentarse: **qué le pide atención hoy en cada
 * cliente**. No es un resumen contable —para eso está cada empresa— sino la lista
 * de cosas que alguien tiene que hacer, con el número al lado para poder
 * priorizar sin entrar a mirar una por una.
 *
 * Cinco señales, todas de datos que ya existen:
 *  · **Borradores** esperando revisión (el trabajo pendiente del contador).
 *  · **Buzón de facturas** con problemas: la última corrida falló, o quedaron
 *    correos en un estado que hay que arreglar.
 *  · **Por cobrar vencido**: facturas emitidas que pasaron su fecha y no están pagas.
 *  · **Obligaciones fiscales** vencidas y las que vencen esta semana.
 *  · **Cuota del plan**, para avisar antes de que se agote y las facturas dejen de cargar.
 */

import { ESTADOS_QUE_AVISAN } from './email-facturas-avisos';
import { suscripcionDeEmpresa } from './suscripcion';
import type { EmpresaAccesible } from './empresas-usuario';

export interface PendientesEmpresa {
  id: string;
  name: string;
  role: string;
  borradores: number;
  buzon: { estado: string | null; problemas: number; detalle: string | null };
  porCobrar: { vencidas: number; monto: number };
  obligaciones: { vencidas: number; porVencer: number };
  cuota: { usado: number; limite: number; plan: string | null };
}

/** Cuántos días para adelante se consideran «por vencer». */
const DIAS_AVISO = 7;

export async function pendientesPorEmpresa(prisma: any, empresas: EmpresaAccesible[]): Promise<PendientesEmpresa[]> {
  const hoy = new Date();
  const enUnaSemana = new Date(hoy.getTime() + DIAS_AVISO * 86400000);

  // En paralelo por empresa: son pocas y cada una son consultas chicas. Una que
  // falle no puede dejar sin tablero a las demás (el contador pierde el día).
  const resultados = await Promise.all(
    empresas.map(async (e) => {
      const base: PendientesEmpresa = {
        id: e.id,
        name: e.name,
        role: e.role,
        borradores: 0,
        buzon: { estado: null, problemas: 0, detalle: null },
        porCobrar: { vencidas: 0, monto: 0 },
        obligaciones: { vencidas: 0, porVencer: 0 },
        cuota: { usado: 0, limite: 0, plan: null },
      };
      return computar(prisma, e, base, hoy, enUnaSemana).catch((err: any) => {
        console.error(`[Despacho] No se pudieron leer los pendientes de ${e.id}:`, err?.message);
        return base;
      });
    }),
  );
  return resultados;
}

/** ¿El buzón quedó en un estado que hay que mirar? (los mismos que avisan por correo) */
function buzonConProblema(estado: string | null | undefined): boolean {
  if (!estado) return false;
  return !['OK', 'INACTIVO'].includes(estado);
}

async function computar(
  prisma: any,
  e: EmpresaAccesible,
  base: PendientesEmpresa,
  hoy: Date,
  enUnaSemana: Date,
): Promise<PendientesEmpresa> {
  const companyId = e.id;

  const [borradores, cfg, correos, vencidas, obligaciones, sub] = await Promise.all([
    prisma.journalEntry.count({ where: { companyId, status: 'BORRADOR', isClosing: false } }),
    prisma.emailFacturaConfig.findUnique({ where: { companyId }, select: { ultimoEstado: true, ultimoDetalle: true, isActive: true } }),
    prisma.emailFacturaMensaje.count({
      where: { companyId, estado: { in: ESTADOS_QUE_AVISAN }, createdAt: { gte: new Date(hoy.getTime() - 30 * 86400000) } },
    }),
    // Lo que falta cobrar: `total - paidAmount` no lo suma Prisma, así que se
    // traen las vencidas (son pocas) y se resta acá.
    prisma.invoice.findMany({
      where: { companyId, status: { in: ['PENDIENTE', 'VENCIDA'] }, dueDate: { lt: hoy } },
      select: { total: true, paidAmount: true },
    }),
    prisma.taxObligation.findMany({
      where: { companyId, status: { in: ['PENDING', 'OVERDUE'] }, dueDate: { lte: enUnaSemana } },
      select: { status: true },
    }),
    // La cuota que se muestra es la de la CUENTA: si el despacho tiene un plan que
    // cubre a todas sus empresas, todas muestran el mismo cupo consumido.
    suscripcionDeEmpresa(prisma, companyId),
  ]);

  base.borradores = borradores;

  base.buzon = {
    estado: cfg?.ultimoEstado || null,
    problemas: correos,
    detalle: cfg && buzonConProblema(cfg.ultimoEstado) ? cfg.ultimoDetalle || null : null,
  };

  base.porCobrar = {
    vencidas: vencidas.length,
    monto: Math.round(vencidas.reduce((a: number, f: any) => a + Math.max(0, (f.total || 0) - (f.paidAmount || 0)), 0) * 100) / 100,
  };

  base.obligaciones = {
    vencidas: obligaciones.filter((o: any) => o.status === 'OVERDUE').length,
    porVencer: obligaciones.filter((o: any) => o.status === 'PENDING').length,
  };

  base.cuota = {
    usado: Math.round((sub?.movementsUsed || 0) * 100) / 100,
    limite: sub?.movementsLimit || 0,
    plan: sub?.plan?.name || null,
  };

  return base;
}
