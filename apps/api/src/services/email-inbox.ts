/**
 * El buzón de facturas por correo, del lado del servidor: la conexión IMAP y el
 * barrido.
 *
 * El barrido es **idempotente por dos redes independientes**: el cursor del buzón
 * (`UIDVALIDITY` + último UID, que hace barato el caso normal) y el ledger
 * (`email_factura_mensaje`, con `Message-ID` único por empresa, que sobrevive a
 * que la DGI o el proveedor cambien de buzón y a que el proceso muera a mitad).
 *
 * Tres decisiones que no son obvias:
 *  · **Nada se marca ni se mueve en el buzón** por defecto: el ledger ES la marca.
 *    Marcar `\Seen` o mover correos es lo que el dueño ve en su Gmail, y hacerlo
 *    sin que lo haya pedido es entrometerse en su correo.
 *  · **La fila del ledger se crea ANTES de bajar el cuerpo**, en `PROCESANDO`: si
 *    el proceso muere entremedio, queda una fila de más de 10 minutos que se ve y
 *    se puede reprocesar — nunca un correo a medio leer sin rastro.
 *  · **Nunca lanza**: un error de credenciales de una empresa no puede tumbar la
 *    corrida de las demás (el cron las recorre todas). El error va al resumen, al
 *    ledger y a `ultimoEstado`, que es donde el dueño lo mira.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getOrCreateEmailConfig } from './email-facturas-config';
import { extraerFacturasDeMensaje, type MensajeFactura } from './email-factura-extract';
import { cargarFacturaDesdeCorreo } from './email-factura-pipeline';

export type CodigoConexion = 'SIN_CREDENCIALES' | 'ERROR_CREDENCIALES' | 'ERROR_CONEXION';

export interface ResultadoConexion {
  ok: boolean;
  /** Buzones del servidor (solo cuando la conexión funcionó). */
  carpetas?: string[];
  codigo?: CodigoConexion;
  error?: string;
}

/**
 * Cliente IMAP con timeouts explícitos: sin ellos, un servidor que acepta la
 * conexión y se queda callado deja la petición colgada para siempre (y con el
 * cron encima, una corrida por empresa).
 */
export function clienteImap(cfg: any): ImapFlow {
  return new ImapFlow({
    host: String(cfg.imapHost || ''),
    port: Number(cfg.imapPort) || 993,
    secure: cfg.imapSecure !== false,
    auth: { user: String(cfg.imapUser || ''), pass: String(cfg.imapPassword || '') },
    logger: false,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
}

/** ¿Faltan datos para siquiera intentar la conexión? */
export function faltanCredenciales(cfg: any): boolean {
  return !cfg?.imapHost || !cfg?.imapUser || !cfg?.imapPassword;
}

/**
 * Traduce el error del servidor de correo a un código y una frase corta.
 * Gmail y compañía responden «Invalid credentials» / «Authentication failed»;
 * imapflow además marca `authenticationFailed` cuando el servidor rechaza el login.
 */
export function clasificarErrorImap(err: any): { codigo: CodigoConexion; detalle: string } {
  const texto = [err?.responseText, err?.response, err?.message].filter(Boolean).join(' — ');
  const esAuth =
    err?.authenticationFailed === true ||
    err?.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    /auth|credential|login|password|usuario|contraseñ/i.test(String(texto));
  if (esAuth) {
    return {
      codigo: 'ERROR_CREDENCIALES',
      detalle: `El servidor rechazó el usuario o la contraseña. ${texto}`.trim(),
    };
  }
  return {
    codigo: 'ERROR_CONEXION',
    detalle: `No se pudo conectar con el servidor de correo. ${texto}`.trim(),
  };
}

/**
 * Prueba la conexión: entra, lista los buzones y confirma que la carpeta
 * configurada existe. Nunca lanza — el resultado es lo que se muestra en la tarjeta.
 */
export async function probarConexion(cfg: any): Promise<ResultadoConexion> {
  if (faltanCredenciales(cfg)) {
    return {
      ok: false,
      codigo: 'SIN_CREDENCIALES',
      error: 'Faltan el servidor, el usuario o la contraseña del buzón.',
    };
  }

  const client = clienteImap(cfg);
  try {
    await client.connect();
    const buzones = await client.list();
    const carpetas = buzones.map((b: any) => String(b.path));

    const carpeta = String(cfg.imapFolder || 'INBOX');
    if (!carpetas.some((c) => c.toLowerCase() === carpeta.toLowerCase())) {
      return {
        ok: false,
        codigo: 'ERROR_CONEXION',
        error: `La conexión funcionó, pero el buzón no tiene la carpeta "${carpeta}".`,
      };
    }

    // Se cierra la carpeta que se va a leer: que exista no es lo mismo que
    // poder abrirla (permisos de solo-lectura parcial, buzones compartidos).
    const lock = await client.getMailboxLock(carpeta);
    lock.release();

    return { ok: true, carpetas };
  } catch (err: any) {
    const { codigo, detalle } = clasificarErrorImap(err);
    return { ok: false, codigo, error: detalle };
  } finally {
    // `logout()` sobre una conexión que nunca se abrió también falla: se ignora.
    try {
      await client.logout();
    } catch {
      /* la conexión ya estaba cerrada */
    }
  }
}

// ── El barrido ──────────────────────────────────────────────────────────────

/** Tope de correos por corrida: un buzón abandonado no puede colgar la madrugada. */
const MAX_CORREOS = 50;
/** Tope por mensaje: por encima de esto no es una factura, es un archivo. */
const MAX_BYTES = 15 * 1024 * 1024;
/** Ventana al arrancar de cero (primer barrido, o el buzón se recreó). */
const VENTANA_DIAS = 7;
/** Una corrida que no volvió en este tiempo dejó el lease colgado. */
const CORRIDA_COLGADA_MS = 10 * 60 * 1000;
/** Techo duro por empresa: el socket ya tiene 60 s, esto cubre el barrido entero. */
const TIMEOUT_CORRIDA_MS = 180 * 1000;

export interface ResumenBarrido {
  ok: boolean;
  /** Correos que el buzón devolvió en esta corrida. */
  revisados: number;
  /** Facturas detectadas (en esta fase NO se crean asientos). */
  facturas: number;
  /** Cuántos correos quedaron en cada estado. */
  estados: Record<string, number>;
  codigo?: string;
  detalle?: string;
}

const RESUMEN_VACIO: ResumenBarrido = { ok: true, revisados: 0, facturas: 0, estados: {} };

/**
 * Toma el lease de la empresa en UN solo `updateMany` condicionado: sirve incluso
 * con dos instancias corriendo (el botón y el cron), porque la condición la
 * resuelve Postgres, no el código. Si otra corrida lo tiene y es reciente, no se
 * barre: dos barridos del mismo buzón se pisarían el cursor.
 */
async function tomarLease(prisma: any, companyId: string, ahora: Date): Promise<boolean> {
  const limite = new Date(ahora.getTime() - CORRIDA_COLGADA_MS);
  const r = await prisma.emailFacturaConfig.updateMany({
    where: {
      companyId,
      OR: [
        { ultimoEstado: null },
        { ultimoEstado: { not: 'CORRIENDO' } },
        { ultimaCorridaAt: null },
        { ultimaCorridaAt: { lt: limite } },
      ],
    },
    data: { ultimoEstado: 'CORRIENDO', ultimaCorridaAt: ahora },
  });
  return r.count === 1;
}

/** El remitente como texto: `envelope.from` viene como lista de direcciones. */
function remitenteDe(envelope: any): string | null {
  const d = envelope?.from?.[0];
  if (!d) return null;
  return [d.name, d.address].filter(Boolean).join(' <') + (d.name && d.address ? '>' : '');
}

/** Un `Message-ID` que falte se sintetiza con el UID: la red es el unique de la BD. */
function messageIdDe(envelope: any, uidValidity: number, uid: number): string {
  return envelope?.messageId || `uid:${uidValidity}:${uid}`;
}

/**
 * Barre el buzón de una empresa.
 *
 * `forzar` es para el botón «Revisar ahora»: deja barrer una configuración
 * completa que todavía no está activa (para probarla antes de encenderla). El
 * cron no lo usa: barre lo que el dueño activó.
 */
export async function barrerFacturasPorCorreo(
  prisma: any,
  companyId: string,
  opts: { forzar?: boolean; cliente?: any; maxCorreos?: number } = {},
): Promise<ResumenBarrido> {
  const cfg = await getOrCreateEmailConfig(prisma, companyId);
  if (!cfg.isActive && !opts.forzar) {
    return { ...RESUMEN_VACIO, codigo: 'INACTIVO', detalle: 'El buzón no está activo.' };
  }
  if (faltanCredenciales(cfg)) {
    return { ...RESUMEN_VACIO, ok: false, codigo: 'SIN_CREDENCIALES', detalle: 'Faltan el servidor, el usuario o la contraseña del buzón.' };
  }

  const ahora = new Date();
  if (!(await tomarLease(prisma, companyId, ahora))) {
    return { ...RESUMEN_VACIO, ok: false, codigo: 'YA_CORRIENDO', detalle: 'Ya hay una revisión del buzón en curso.' };
  }

  // El barrido nunca lanza (lo dice el contrato del módulo), así que el techo de
  // tiempo se resuelve por carrera y no por aborto: si se pasa, se responde y el
  // barrido termina solo — el lease lo protege de solaparse con el siguiente.
  const resumen = await Promise.race([
    correrBarrido(prisma, companyId, cfg, ahora, opts),
    new Promise<ResumenBarrido>((resolve) =>
      setTimeout(
        () => resolve({ ...RESUMEN_VACIO, ok: false, codigo: 'TIMEOUT', detalle: `El barrido pasó de ${TIMEOUT_CORRIDA_MS / 1000} s.` }),
        TIMEOUT_CORRIDA_MS,
      ),
    ),
  ]);

  await anotarCorrida(prisma, companyId, resumen);
  return resumen;
}

/** Deja el resultado de la corrida donde el dueño lo mira (la tarjeta). */
async function anotarCorrida(prisma: any, companyId: string, resumen: ResumenBarrido): Promise<void> {
  try {
    await prisma.emailFacturaConfig.update({
      where: { companyId },
      data: {
        ultimoEstado: resumen.ok ? 'OK' : resumen.codigo || 'ERROR',
        ultimoDetalle: resumen.detalle || `revisados=${resumen.revisados} facturas=${resumen.facturas}`,
      },
    });
  } catch (err: any) {
    console.error('[EmailFacturas] No se pudo guardar el estado de la corrida:', err?.message);
  }
}

async function correrBarrido(
  prisma: any,
  companyId: string,
  cfg: any,
  ahora: Date,
  opts: { cliente?: any; maxCorreos?: number },
): Promise<ResumenBarrido> {
  const client: any = opts.cliente || clienteImap(cfg);
  const carpeta = String(cfg.imapFolder || 'INBOX');
  const max = opts.maxCorreos || MAX_CORREOS;
  const estados: Record<string, number> = {};
  let revisados = 0;
  let detectadas = 0;
  let cortadaPorCuota = false;
  // OJO: el cursor NO se inicializa con el guardado. Si la UIDVALIDITY cambió, el
  // número viejo no significa nada en el buzón nuevo y arrastrarlo dejaría los
  // correos con UID menor en silencio. Se fija abajo, con el buzón ya abierto.
  let ultimoUid = 0;
  let uidValidity = Number(cfg.imapUidValidity || 0);

  const sumar = (estado: string) => {
    estados[estado] = (estados[estado] || 0) + 1;
  };
  const cerrar = (ok: boolean, codigo?: string, detalle?: string): ResumenBarrido => ({
    ok,
    revisados,
    facturas: detectadas,
    estados,
    codigo,
    detalle,
  });

  try {
    await client.connect();
    // Solo se abre en escritura si el dueño pidió tocar su buzón: `mailparser`
    // lee con BODY.PEEK, así que sin esto el buzón queda intacto de todos modos.
    const tocaElBuzon = !!(cfg.marcarLeido || cfg.carpetaMover);
    const lock = await client.getMailboxLock(carpeta, { readOnly: !tocaElBuzon });
    try {
      uidValidity = Number(client.mailbox?.uidValidity || 0);

      // El buzón se recreó (o es la primera corrida): el cursor viejo no dice nada
      // de los UIDs de ahora, así que se vuelve a empezar con una ventana corta.
      const desdeCero = !cfg.imapUidValidity || Number(cfg.imapUidValidity) !== uidValidity;
      const desde = desdeCero ? 0 : Number(cfg.imapLastUid || 0);
      ultimoUid = desde;
      const rango: any = desde > 0 ? `${desde}:*` : { since: new Date(ahora.getTime() - VENTANA_DIAS * 86400000) };

      // 1) Metadatos: barato, y decide qué vale la pena bajar. OJO con el quirk de
      //    IMAP: `N:*` con N mayor que el último UID devuelve el ÚLTIMO mensaje,
      //    así que el filtro `uid > desde` no es opcional.
      const candidatos: any[] = [];
      for await (const msg of client.fetch(rango, { uid: true, envelope: true, size: true }, { uid: true })) {
        const uid = Number(msg.uid);
        if (!uid || uid <= desde) continue;
        revisados++;
        if (Number(msg.size) > MAX_BYTES) {
          sumar('ERROR');
          await anotarMensaje(prisma, companyId, cfg, uidValidity, uid, msg, {
            estado: 'ERROR',
            detalle: `El correo pesa ${(Number(msg.size) / 1048576).toFixed(1)} MB (máximo ${MAX_BYTES / 1048576} MB).`,
          });
          ultimoUid = Math.max(ultimoUid, uid);
          continue;
        }
        candidatos.push(msg);
        if (candidatos.length >= max) break;
      }

      // 2) Cuerpo: uno por uno, con la fila del ledger ya creada en PROCESANDO.
      for (const meta of candidatos) {
        const uid = Number(meta.uid);
        const messageId = messageIdDe(meta.envelope, uidValidity, uid);

        const fila = await anotarMensaje(prisma, companyId, cfg, uidValidity, uid, meta, {
          messageId,
          estado: 'PROCESANDO',
        });
        if (!fila) {
          // P2002: el correo ya está en el ledger (otra corrida, u otro canal).
          sumar('YA_VISTO');
          ultimoUid = Math.max(ultimoUid, uid);
          continue;
        }

        let resultado: AnalisisCorreo;
        try {
          const bajado = await client.fetchOne(String(uid), { source: true }, { uid: true });
          resultado = await analizarCorreo(prisma, cfg, fila.id, bajado?.source || Buffer.alloc(0));
        } catch (err: any) {
          resultado = { estado: 'ERROR', detalle: String(err?.message || err).slice(0, 500), facturas: [], adjuntos: [], messageId: null };
          console.error('[EmailFacturas] Correo', uid, 'error:', err?.message);
        }

        if (resultado.cuotaAgotada) {
          // La cuota es del plan, no del correo: se corta la corrida SIN avanzar
          // el cursor y se borra la fila — si quedara, el correo no se volvería a
          // mirar nunca y esas facturas se perderían en silencio.
          await prisma.emailFacturaMensaje
            .delete({ where: { id: fila.id } })
            .catch((e: any) => console.error('[EmailFacturas] No se pudo soltar la fila CUOTA:', e?.message));
          sumar('CUOTA');
          cortadaPorCuota = true;
          break;
        }

        sumar(resultado.estado);
        detectadas += resultado.facturas.filter((f: any) => f.estado === 'CARGADA').length;
        await anotarResultado(prisma, fila.id, resultado, !meta.envelope?.messageId);

        // Lo ÚLTIMO: el buzón solo se toca cuando el correo ya quedó anotado. Si
        // marcar o mover falla, el ledger ya lo tiene y el cursor igual avanza.
        if (tocaElBuzon) await tocarCorreo(client, cfg, uid);

        ultimoUid = Math.max(ultimoUid, uid);
      }

      // El cursor se guarda SIEMPRE, también cuando un correo falló: si no, el
      // próximo barrido volvería a caer en el mismo correo roto para siempre.
      await prisma.emailFacturaConfig.update({
        where: { companyId },
        data: { imapUidValidity: uidValidity, imapLastUid: ultimoUid },
      });

      console.log(
        `[EmailFacturas] empresa=${companyId} revisados=${revisados} cargadas=${detectadas} ${JSON.stringify(estados)}`,
      );
      if (cortadaPorCuota) {
        return cerrar(
          false,
          'CUOTA',
          'La cuota de movimientos del plan se agotó: se cortó la revisión sin descartar correos.',
        );
      }
      return cerrar(
        true,
        undefined,
        revisados ? `${revisados} correo(s): ${JSON.stringify(estados)}` : 'Sin correos nuevos.',
      );
    } finally {
      lock.release();
    }
  } catch (err: any) {
    const { codigo, detalle } = clasificarErrorImap(err);
    console.error('[EmailFacturas] empresa=' + companyId, codigo, err?.message);
    return cerrar(false, codigo, detalle.slice(0, 500));
  } finally {
    try {
      await client.logout();
    } catch {
      /* la conexión ya estaba cerrada */
    }
  }
}

/**
 * Una fila que quedó en `PROCESANDO` cuando el proceso murió a mitad no se
 * arregla sola: el barrido nunca re-lee un UID que ya pasó, así que esa factura
 * quedaría invisible para siempre. Se marca `INTERRUMPIDO` pasados 10 minutos
 * (nadie procesa un correo en 10 minutos) y el dueño decide con «Reprocesar».
 */
export async function marcarInterrumpidos(prisma: any, companyId: string): Promise<number> {
  const limite = new Date(Date.now() - CORRIDA_COLGADA_MS);
  try {
    const r = await prisma.emailFacturaMensaje.updateMany({
      where: { companyId, estado: 'PROCESANDO', createdAt: { lt: limite } },
      data: { estado: 'INTERRUMPIDO', detalle: 'El proceso se cortó a mitad. Reprocesá el correo.' },
    });
    return r.count || 0;
  } catch (err: any) {
    console.error('[EmailFacturas] No se pudieron marcar los interrumpidos:', err?.message);
    return 0;
  }
}

/**
 * Estados que «Reprocesar» puede reintentar (ver el comentario en la función):
 * los que dependen de la configuración del buzón, no de los datos del correo.
 */
export const ESTADOS_REPROCESABLES = ['INTERRUMPIDO', 'ERROR', 'SIN_CUENTA', 'SIN_CONCEPTO', 'SIN_DATOS'];

/**
 * Reintento explícito de un correo que quedó a medio camino.
 *
 * Se vuelve a leer del buzón por UID (el cuerpo no se guarda: guardar los correos
 * de un cliente es otra conversación) y se corre el MISMO análisis del barrido.
 * Nunca automático: el unique del ledger ya pasó, así que reprocesar dos veces un
 * correo que sí se cargó crearía un asiento de más.
 */
export async function reprocesarMensaje(
  prisma: any,
  companyId: string,
  mensajeId: string,
  opts: { cliente?: any } = {},
): Promise<{ ok: true; mensaje: any } | { ok: false; error: string }> {
  const fila = await prisma.emailFacturaMensaje.findFirst({ where: { id: mensajeId, companyId } });
  if (!fila) return { ok: false, error: 'El correo no está en el registro de esta empresa.' };
  // Se reprocesa lo que un cambio de configuración puede arreglar: la corrida que
  // murió, el error de red, y los «falta algo» que el dueño resuelve cargando la
  // cuenta de contrapartida, un concepto por defecto o unas credenciales que
  // sirvan. Lo que es un hecho de los datos —duplicada, factura de otro
  // cliente— no se reintenta: daría lo mismo.
  if (!ESTADOS_REPROCESABLES.includes(fila.estado)) {
    return {
      ok: false,
      error: `Este correo quedó en ${fila.estado}: solo se reprocesan los que puede arreglar un cambio de configuración (${ESTADOS_REPROCESABLES.join(', ')}).`,
    };
  }

  const cfg = await getOrCreateEmailConfig(prisma, companyId);
  if (faltanCredenciales(cfg)) return { ok: false, error: 'Faltan las credenciales del buzón.' };

  const client: any = opts.cliente || clienteImap(cfg);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(String(fila.folder || cfg.imapFolder || 'INBOX'), {
      readOnly: !(cfg.marcarLeido || cfg.carpetaMover),
    });
    try {
      const bajado = await client.fetchOne(String(fila.uid), { source: true }, { uid: true });
      if (!bajado?.source) {
        return { ok: false, error: 'El correo ya no está en esa carpeta del buzón.' };
      }
      const resultado = await analizarCorreo(prisma, cfg, fila.id, bajado.source);
      await anotarResultado(prisma, fila.id, resultado, false);
      if (cfg.marcarLeido || cfg.carpetaMover) await tocarCorreo(client, cfg, Number(fila.uid));
      const mensaje = await prisma.emailFacturaMensaje.findUnique({ where: { id: fila.id } });
      return { ok: true, mensaje };
    } finally {
      lock.release();
    }
  } catch (err: any) {
    const { codigo, detalle } = clasificarErrorImap(err);
    return { ok: false, error: `${codigo}: ${detalle}`.slice(0, 300) };
  } finally {
    try {
      await client.logout();
    } catch {
      /* la conexión ya estaba cerrada */
    }
  }
}

export interface AnalisisCorreo {
  estado: string;
  detalle: string | null;
  /** Resumen de lo detectado, para el ledger (no la factura completa). */
  facturas: any[];
  adjuntos: any[];
  /** `Message-ID` real del cuerpo; null si el correo no lo trae. */
  messageId: string | null;
  /** El plan se quedó sin movimientos: hay que cortar la corrida acá. */
  cuotaAgotada?: boolean;
}

/**
 * El análisis de un correo: parsear el MIME, detectar las facturas y resumirlas
 * para el ledger. **No crea asientos** — eso es del pipeline (fase siguiente).
 *
 * Es el mismo camino para el barrido y para «Reprocesar»: un correo reprocesado
 * tiene que dar exactamente lo mismo que dio la primera vez.
 */
export async function analizarCorreo(
  prisma: any,
  cfg: any,
  filaId: string,
  source: Buffer,
): Promise<AnalisisCorreo> {
  const parsed: any = await simpleParser(source || Buffer.alloc(0));
  const adjuntos = (parsed.attachments || []).map((a: any) => ({
    nombre: a.filename || null,
    tipo: a.contentType || null,
    bytes: a.size || a.content?.length || 0,
  }));

  const mensaje: MensajeFactura = {
    text: parsed.text || null,
    html: typeof parsed.html === 'string' ? parsed.html : null,
    adjuntos: (parsed.attachments || []).map((a: any) => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      content: a.content || Buffer.alloc(0),
    })),
  };
  const deteccion = await extraerFacturasDeMensaje(prisma, mensaje);
  const messageId = parsed.messageId ? String(parsed.messageId).slice(0, 300) : null;

  if (!deteccion.facturas.length) {
    return {
      estado: deteccion.motivo || 'SIN_FACTURA',
      detalle: deteccion.enlaces.length ? `Enlaces del CUTE en el cuerpo: ${deteccion.enlaces.length}` : null,
      facturas: [],
      adjuntos,
      messageId,
    };
  }

  // Las facturas del correo se cargan una por una. La cuota, si se agota, corta
  // la corrida: las que quedan sin cargar se vuelven a ver en la próxima (el
  // barrido no avanza el cursor ni deja la fila del ledger).
  const cargas: any[] = [];
  let cuotaAgotada = false;
  for (const det of deteccion.facturas) {
    const r = await cargarFacturaDesdeCorreo(prisma, cfg, det, { mensajeId: filaId });
    cargas.push({
      via: det.via,
      origen: det.origen,
      proveedor: det.factura.proveedor,
      ruc: det.factura.ruc,
      numeroFactura: det.factura.numeroFactura,
      fecha: det.factura.fecha,
      total: det.factura.total,
      items: det.items.length,
      estado: r.estado,
      detalle: r.detalle,
      journalEntryId: r.journalEntryId,
      claimId: r.claimId,
    });
    if (r.estado === 'CUOTA') {
      cuotaAgotada = true;
      break;
    }
  }

  const cargadas = cargas.filter((c) => c.estado === 'CARGADA');
  const fallidas = cargas.filter((c) => c.estado !== 'CARGADA');
  return {
    // Un correo con varias facturas resume en CARGADA si entró alguna: el
    // detalle dice, factura por factura, qué pasó con cada una.
    estado: cargadas.length ? 'CARGADA' : cargas[0]?.estado || 'SIN_DATOS',
    detalle: fallidas.length
      ? fallidas.map((c) => `${c.proveedor || 'factura'} (${c.numeroFactura || 's/n'}): ${c.estado}${c.detalle ? ` — ${c.detalle}` : ''}`).join(' · ').slice(0, 900)
      : null,
    facturas: cargas,
    adjuntos,
    messageId,
    cuotaAgotada,
  };
}

/**
 * Cierra la fila del ledger con lo que dio el análisis.
 *
 * `elEnvelopeNoTraiaId` es el caso en que la fila nació con un id sintetizado por
 * UID: ahora que el cuerpo se leyó, se guarda el `Message-ID` de verdad, que es
 * el que va a traer un reenvío del mismo correo.
 */
async function anotarResultado(
  prisma: any,
  filaId: string,
  r: AnalisisCorreo,
  elEnvelopeNoTraiaId?: boolean,
): Promise<void> {
  const data: Record<string, any> = {
    estado: r.estado,
    detalle: r.detalle,
    facturas: JSON.stringify(r.facturas),
    adjuntos: JSON.stringify(r.adjuntos),
  };
  if (elEnvelopeNoTraiaId && r.messageId) data.messageId = r.messageId;
  await prisma.emailFacturaMensaje
    .update({ where: { id: filaId }, data })
    .catch((e: any) => console.error('[EmailFacturas] No se pudo cerrar la fila del ledger:', e?.message));
}

/**
 * Marca como leído y/o mueve el correo, si el dueño lo pidió.
 *
 * Va aparte del barrido porque es lo único que cambia SU buzón: si falla, se
 * avisa y se sigue — el correo ya está en el ledger y no se va a reprocesar.
 */
async function tocarCorreo(client: any, cfg: any, uid: number): Promise<void> {
  if (cfg.marcarLeido) {
    await client
      .messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
      .catch((e: any) => console.error('[EmailFacturas] No se pudo marcar como leído:', e?.message));
  }
  if (cfg.carpetaMover) {
    await client
      .messageMove(String(uid), String(cfg.carpetaMover), { uid: true })
      .catch((e: any) => console.error('[EmailFacturas] No se pudo mover el correo:', e?.message));
  }
}

/**
 * Crea (o reconoce) la fila del ledger de un correo. Devuelve null si ya existía:
 * el `@@unique(companyId, messageId)` es la red que impide procesar dos veces el
 * mismo correo aunque el cursor se haya perdido.
 */
async function anotarMensaje(
  prisma: any,
  companyId: string,
  cfg: any,
  uidValidity: number,
  uid: number,
  meta: any,
  datos: { messageId?: string; estado: string; detalle?: string | null },
): Promise<any | null> {
  try {
    return await prisma.emailFacturaMensaje.create({
      data: {
        companyId,
        origen: 'IMAP',
        folder: cfg.imapFolder || 'INBOX',
        uidValidity,
        uid,
        messageId: datos.messageId || messageIdDe(meta.envelope, uidValidity, uid),
        remitente: remitenteDe(meta.envelope)?.slice(0, 300) || null,
        asunto: (meta.envelope?.subject || '').slice(0, 300) || null,
        recibidoAt: meta.envelope?.date ? new Date(meta.envelope.date) : null,
        estado: datos.estado,
        detalle: datos.detalle || null,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return null;
    throw err;
  }
}
