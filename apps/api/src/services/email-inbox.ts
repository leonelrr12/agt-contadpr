/**
 * El buzón de facturas por correo, del lado del servidor.
 *
 * Acá vive la conexión IMAP. El **barrido** (leer los correos nuevos, dejarlos en
 * el ledger y detectar las facturas) llega en la fase siguiente: por ahora el
 * módulo solo sabe probar que la conexión y la carpeta funcionan, que es lo que
 * el dueño necesita para saber si las credenciales que pegó sirven ANTES de
 * dejarlo corriendo solo.
 *
 * Nada de esto lanza hacia afuera con un error crudo de IMAP: se clasifica en
 * códigos (`ERROR_CREDENCIALES` / `ERROR_CONEXION`) porque el texto de un servidor
 * de correo no le dice nada a un contador.
 */

import { ImapFlow } from 'imapflow';

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
