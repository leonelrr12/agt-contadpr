/**
 * La corrida diaria del buzón de facturas por correo.
 *
 * Un `setInterval` cada media hora que decide si **corresponde** barrer: pasada
 * la hora objetivo (`EMAIL_FACTURAS_HORA`, 3 AM por defecto) y sin una corrida
 * de hoy. Ese «sin corrida de hoy» es el **catch-up**: si el VPS estaba caído a
 * las 3, la corrida sale cuando vuelva, no se pierde el día. Y sirve para lo
 * mismo al revés: si el dueño ya le dio a «Revisar ahora» a las 10, la de la
 * madrugada siguiente es la que corre (no dos el mismo día).
 *
 * **El aislamiento es la parte importante**: cada empresa tiene sus credenciales
 * y su buzón, y una que las tenga mal no puede dejar sin leer a las demás. Por
 * eso se recorren con `allSettled` y cada una con su propio try/catch — el
 * barrido ya no lanza, pero el que decide y loguea tampoco puede caerse.
 *
 * No se corre al arrancar el servidor: la primera verificación cae dentro de los
 * primeros 30 minutos de vida del proceso, que es suficiente para el catch-up y
 * evita un barrido sorpresa en cada reinicio.
 */

import { barrerBuzonCentral, barrerFacturasPorCorreo } from './email-inbox';

/** Cada cuánto se pregunta si toca (no es la frecuencia del barrido: es el reloj). */
const INTERVALO_MIN = Number(process.env.EMAIL_FACTURAS_INTERVALO_MIN) || 30;
/** Hora local a partir de la cual se barre (madrugada). */
const HORA_OBJETIVO = Number(process.env.EMAIL_FACTURAS_HORA) || 3;

/** ¿`fecha` es del mismo día calendario local que `ahora`? */
function esDeHoy(fecha: Date | null | undefined, ahora: Date): boolean {
  if (!fecha) return false;
  const d = new Date(fecha);
  return (
    d.getFullYear() === ahora.getFullYear() &&
    d.getMonth() === ahora.getMonth() &&
    d.getDate() === ahora.getDate()
  );
}

/** ¿Ya pasó la hora objetivo y todavía no hubo corrida hoy? */
export function tocaCorrer(ahora: Date, ultimaCorridaAt: Date | null | undefined, horaObjetivo = HORA_OBJETIVO): boolean {
  if (ahora.getHours() < horaObjetivo) return false;
  return !esDeHoy(ultimaCorridaAt, ahora);
}

export interface ResumenCron {
  /** Empresas con el buzón activo y configurado. */
  empresas: number;
  /** A las que les tocaba y se barrieron. */
  corridas: number;
  /** Cuántas terminaron mal (credenciales, conexión): no cortan a las demás. */
  fallidas: number;
  /** La pasada del buzón central, si había alguna empresa en modo CENTRAL. */
  central?: { revisados: number; ignorados: number; codigo?: string };
}

/**
 * Última pasada del buzón central, por proceso. El buzón central es UNO para
 * todas las empresas, así que no tiene una fila de configuración donde anotar su
 * `ultimaCorridaAt`: se guarda acá. Un reinicio solo provoca una pasada de más,
 * y el ledger se encarga de que eso no procese nada dos veces.
 */
let ultimaCorridaCentral: Date | null = null;

/**
 * Una pasada: barre las empresas a las que les toca. Nunca lanza — quien la
 * llama es un `setInterval` que no puede quedarse sin reloj.
 */
export async function correrBarridoDiario(prisma: any, ahora: Date = new Date()): Promise<ResumenCron> {
  const resumen: ResumenCron = { empresas: 0, corridas: 0, fallidas: 0 };

  let configs: any[] = [];
  try {
    // Solo las que tienen el interruptor encendido y un buzón que leer: una fila
    // a medio configurar (la que se creó al abrir la pantalla) no es una empresa
    // que haya que salir a buscar.
    configs = await prisma.emailFacturaConfig.findMany({
      where: { isActive: true, imapHost: { not: null }, imapUser: { not: null } },
      select: { companyId: true, ultimaCorridaAt: true },
    });
  } catch (err: any) {
    console.error('[EmailFacturas] No se pudieron leer las configuraciones:', err?.message);
    return resumen;
  }

  resumen.empresas = configs.length;
  const pendientes = configs.filter((c) => tocaCorrer(ahora, c.ultimaCorridaAt));

  const resultados = await Promise.allSettled(
    pendientes.map(async (cfg) => {
      try {
        const r = await barrerFacturasPorCorreo(prisma, cfg.companyId);
        console.log(
          `[EmailFacturas] empresa=${cfg.companyId} revisados=${r.revisados} cargadas=${r.facturas}` +
            `${r.codigo ? ` estado=${r.codigo}` : ''}`,
        );
        return r;
      } catch (err: any) {
        // El barrido promete no lanzar; si igual lo hace, esta empresa se anota
        // como fallida y las demás siguen.
        console.error(`[EmailFacturas] empresa=${cfg.companyId} error inesperado:`, err?.message);
        return null;
      }
    }),
  );

  for (const r of resultados) {
    if (r.status === 'rejected' || r.value === null) {
      resumen.fallidas++;
      continue;
    }
    resumen.corridas++;
    // El barrido ya guarda el porqué en `ultimoEstado` (credenciales, conexión);
    // acá solo se cuenta para el log de la pasada.
    if (!r.value.ok) resumen.fallidas++;
  }

  resumen.central = await pasarPorBuzonCentral(prisma, ahora);

  if (resumen.corridas || resumen.fallidas || resumen.central) {
    console.log(
      `[EmailFacturas] Pasada: ${resumen.corridas} corrida(s), ${resumen.fallidas} con problema, de ${resumen.empresas} buzón(es) activo(s).`,
    );
  }
  return resumen;
}

/**
 * La pasada del buzón central, si hay alguna empresa usándolo.
 *
 * Sin ninguna empresa en modo CENTRAL **no se toca ese buzón**: es la cuenta
 * personal de quien lo administra, y no hay razón para abrirla si nadie va a
 * recibir facturas por ahí.
 */
async function pasarPorBuzonCentral(prisma: any, ahora: Date): Promise<ResumenCron['central']> {
  try {
    const empresasCentral = await prisma.emailFacturaConfig.count({
      where: { isActive: true, modo: 'CENTRAL', inboxAlias: { not: null } },
    });
    if (!empresasCentral || !tocaCorrer(ahora, ultimaCorridaCentral)) return undefined;

    const r = await barrerBuzonCentral(prisma);
    // Sin credenciales del buzón central no se marca la corrida: cuando el dueño
    // las agregue, la próxima pasada lo intenta en vez de esperar al otro día.
    if (r.codigo !== 'SIN_CREDENCIALES') ultimaCorridaCentral = ahora;
    if (!r.ok) console.warn(`[EmailFacturas] Central: ${r.codigo} ${r.detalle || ''}`);
    return { revisados: r.revisados, ignorados: r.ignorados, codigo: r.codigo };
  } catch (err: any) {
    console.error('[EmailFacturas] Central: error inesperado:', err?.message);
    return { revisados: 0, ignorados: 0, codigo: 'ERROR' };
  }
}

/** El reloj: cada media hora, preguntar si toca. */
export function startEmailFacturasCron(prisma: any): void {
  setInterval(() => {
    correrBarridoDiario(prisma).catch((err) => console.error('[EmailFacturas] Cron:', err?.message));
  }, INTERVALO_MIN * 60 * 1000);
  console.log(`[EmailFacturas] Cron cada ${INTERVALO_MIN} min; barre a partir de las ${HORA_OBJETIVO}:00.`);
}
