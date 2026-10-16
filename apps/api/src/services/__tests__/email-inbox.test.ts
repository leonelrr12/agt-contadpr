import { describe, it, expect, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { clasificarErrorImap, faltanCredenciales, barrerFacturasPorCorreo, reprocesarMensaje } from '../email-inbox';

// El pipeline (detectada → asiento) tiene su propia prueba: acá se aísla para que
// estos tests sigan siendo del barrido —cursor, ledger y lease— y no del motor
// contable. Simula que la factura entró bien.
vi.mock('../email-factura-pipeline', () => ({
  cargarFacturaDesdeCorreo: async () => ({ estado: 'CARGADA', detalle: null, journalEntryId: 'je-1', claimId: 'claim-1' }),
}));

/**
 * El servidor de correo contesta en su idioma («Invalid credentials», «NO
 * [AUTHENTICATIONFAILED]»); la tarjeta y el estado de la corrida tienen que
 * decirle al contador si el problema son las credenciales o la conexión, porque
 * la solución es distinta: revisar la app password, o esperar y reintentar.
 */
describe('faltanCredenciales', () => {
  const completo = { imapHost: 'imap.gmail.com', imapUser: 'a@b.com', imapPassword: 'secreta' };

  it('con servidor, usuario y contraseña se puede intentar', () => {
    expect(faltanCredenciales(completo)).toBe(false);
  });

  it('sin ninguno de los tres no se intenta', () => {
    expect(faltanCredenciales({})).toBe(true);
    expect(faltanCredenciales({ ...completo, imapPassword: null })).toBe(true);
    expect(faltanCredenciales({ ...completo, imapHost: '' })).toBe(true);
  });
});

describe('clasificarErrorImap', () => {
  it('el rechazo de credenciales de imapflow es ERROR_CREDENCIALES', () => {
    const err = Object.assign(new Error('Authentication failed'), {
      authenticationFailed: true,
      responseText: 'Invalid credentials (Failure)',
    });
    const r = clasificarErrorImap(err);
    expect(r.codigo).toBe('ERROR_CREDENCIALES');
    expect(r.detalle).toContain('Invalid credentials');
  });

  it('el código del servidor también alcanza, aunque el mensaje no lo diga', () => {
    const err = { serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'NO' };
    expect(clasificarErrorImap(err).codigo).toBe('ERROR_CREDENCIALES');
  });

  it('un servidor caído es ERROR_CONEXION, no credenciales', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED' });
    expect(clasificarErrorImap(err).codigo).toBe('ERROR_CONEXION');
  });

  it('un timeout también es ERROR_CONEXION', () => {
    expect(clasificarErrorImap({ code: 'ETIMEOUT', message: 'Connection timeout' }).codigo).toBe('ERROR_CONEXION');
  });

  it('sin mensaje no revienta', () => {
    expect(clasificarErrorImap({}).codigo).toBe('ERROR_CONEXION');
  });
});

// ── El barrido ───────────────────────────────────────────────────────────────
//
// Sin buzón de prueba todavía, el barrido se verifica con un servidor IMAP de
// mentira que se comporta como el de verdad —incluido el quirk de `N:*`, que
// devuelve el ÚLTIMO mensaje cuando N pasa del último UID— y una BD de mentira
// que respeta el unique del ledger y la condición del lease.

/** Un PDF de factura DGI (mismo texto que el de verdad, generado acá). */
function pdfFactura(numero = '0000221106'): Promise<Buffer> {
  const doc = new PDFDocument();
  const trozos: Buffer[] = [];
  doc.on('data', (c: Buffer) => trozos.push(c));
  const fin = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(trozos))));
  for (const l of [
    'SUPERMERCADOS XTRA, S.A.',
    'RUC: 356-19-77860',
    'Emisor: SUPERMERCADOS XTRA, S.A.',
    `Número: ${numero}`,
    'Fecha de Emisión: 19/06/2026',
    'Subtotal 3.01',
    'Total 3.22',
  ]) doc.text(l);
  doc.end();
  return fin;
}

/** Un correo MIME de verdad: texto + adjuntos, como lo manda un proveedor. */
function eml(opts: {
  messageId: string;
  from?: string;
  subject?: string;
  text?: string;
  adjuntos?: { nombre: string; tipo: string; contenido: Buffer }[];
}): Buffer {
  const B = 'LIMITE-AGT';
  const cabeceras = [
    `From: ${opts.from || 'Proveedor <facturas@proveedor.com>'}`,
    'To: buzon@empresa.com',
    `Subject: ${opts.subject || 'Factura'}`,
    `Message-ID: <${opts.messageId}>`,
    'Date: Mon, 15 Oct 2026 09:00:00 -0500',
    'MIME-Version: 1.0',
  ];
  if (!opts.adjuntos?.length) {
    return Buffer.from([...cabeceras, 'Content-Type: text/plain; charset=utf-8', '', opts.text || ''].join('\r\n'));
  }
  const partes = [
    `--${B}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.text || 'Adjunto la factura.',
  ];
  for (const a of opts.adjuntos) {
    partes.push(
      `--${B}`,
      `Content-Type: ${a.tipo}; name="${a.nombre}"`,
      `Content-Disposition: attachment; filename="${a.nombre}"`,
      'Content-Transfer-Encoding: base64',
      '',
      a.contenido.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
  }
  partes.push(`--${B}--`, '');
  return Buffer.from([...cabeceras, `Content-Type: multipart/mixed; boundary="${B}"`, '', ...partes].join('\r\n'));
}

/** El servidor IMAP de mentira, con el quirk de `N:*` incluido. */
class ImapFalso {
  mailbox = { uidValidity: 111 };
  conectado = false;
  acciones: any[] = [];
  lockOpts: any = null;
  mensajes: { uid: number; source: Buffer; envelope: any; size?: number }[] = [];

  async connect() {
    this.conectado = true;
  }
  async logout() {
    this.conectado = false;
  }
  async getMailboxLock(_carpeta: string, opts: any) {
    this.lockOpts = opts;
    return { release: () => {} };
  }
  async *fetch(rango: any, _query: any, opts: any) {
    this.acciones.push({ tipo: 'fetch', rango, opts });
    const orden = [...this.mensajes].sort((a, b) => a.uid - b.uid);
    if (typeof rango === 'string') {
      const desde = parseInt(rango.split(':')[0], 10);
      let elegidos = orden.filter((m) => m.uid >= desde);
      // El quirk: si N pasa del último UID, el servidor devuelve el último mensaje.
      if (!elegidos.length && orden.length) elegidos = [orden[orden.length - 1]];
      for (const m of elegidos) yield m;
      return;
    }
    for (const m of orden) yield m; // búsqueda por fecha: todo lo que haya
  }
  async fetchOne(uid: string, _query: any, _opts: any) {
    return this.mensajes.find((m) => m.uid === Number(uid)) || null;
  }
  async messageFlagsAdd(uid: string, flags: string[]) {
    this.acciones.push({ tipo: 'flags', uid: Number(uid), flags });
  }
  async messageMove(uid: string, carpeta: string) {
    this.acciones.push({ tipo: 'move', uid: Number(uid), carpeta });
  }
}

/** La BD de mentira: respeta el unique del ledger y la condición del lease. */
function prismaFalso(config: any = {}) {
  const cfg: any = {
    companyId: 'c1',
    isActive: true,
    imapHost: 'imap.test',
    imapUser: 'u',
    imapPassword: 'p',
    imapFolder: 'INBOX',
    imapUidValidity: null,
    imapLastUid: null,
    marcarLeido: false,
    carpetaMover: null,
    ultimoEstado: null,
    ultimaCorridaAt: null,
    ...config,
  };
  const filas: any[] = [];
  return {
    _cfg: cfg,
    _filas: filas,
    emailFacturaConfig: {
      upsert: async () => cfg,
      updateMany: async ({ data }: any) => {
        const colgada = cfg.ultimaCorridaAt && Date.now() - new Date(cfg.ultimaCorridaAt).getTime() < 10 * 60 * 1000;
        if (cfg.ultimoEstado === 'CORRIENDO' && colgada) return { count: 0 };
        Object.assign(cfg, data);
        return { count: 1 };
      },
      update: async ({ data }: any) => {
        Object.assign(cfg, data);
        return cfg;
      },
    },
    emailFacturaMensaje: {
      create: async ({ data }: any) => {
        if (filas.some((f) => f.messageId === data.messageId)) throw Object.assign(new Error('P2002'), { code: 'P2002' });
        const fila = { id: `fila-${filas.length + 1}`, ...data };
        filas.push(fila);
        return fila;
      },
      update: async ({ where, data }: any) => {
        const f = filas.find((x) => x.id === where.id);
        Object.assign(f, data);
        return f;
      },
      updateMany: async () => ({ count: 0 }),
      findFirst: async ({ where }: any) => filas.find((f) => f.id === where.id && f.companyId === where.companyId) || null,
      findUnique: async ({ where }: any) => filas.find((f) => f.id === where.id) || null,
    },
  };
}

/**
 * Un mensaje como lo devuelve el servidor: el ENVELOPE trae el `Message-ID` real
 * de las cabeceras (por eso se lee del propio MIME y no se inventa: es lo que
 * distingue un reenvío del mismo correo de un correo nuevo).
 */
const mensaje = (uid: number, source: Buffer, extra: any = {}) => ({
  uid,
  source,
  size: source.length,
  envelope: {
    messageId: source.toString('utf8', 0, 2000).match(/^Message-ID:\s*(<[^>]+>)/im)?.[1] || null,
    subject: `Factura ${uid}`,
    from: [{ name: 'Proveedor', address: 'facturas@proveedor.com' }],
    date: new Date('2026-10-15T09:00:00-05:00'),
  },
  ...extra,
});

describe('barrerFacturasPorCorreo — el caso normal', () => {
  it('detecta la factura del PDF, la anota en el ledger y avanza el cursor', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(7, eml({ messageId: 'm7@x', adjuntos: [{ nombre: 'FE.pdf', tipo: 'application/pdf', contenido: await pdfFactura() }] }))];

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(r.ok).toBe(true);
    expect(r.revisados).toBe(1);
    expect(r.facturas).toBe(1);
    expect(r.estados).toEqual({ CARGADA: 1 });

    const fila = prisma._filas[0];
    expect(fila.estado).toBe('CARGADA');
    expect(fila.origen).toBe('IMAP');
    expect(fila.uid).toBe(7);
    expect(JSON.parse(fila.facturas)[0].proveedor).toContain('SUPERMERCADOS XTRA');
    expect(JSON.parse(fila.facturas)[0].total).toBe(3.22);

    expect(prisma._cfg.imapLastUid).toBe(7);
    expect(prisma._cfg.imapUidValidity).toBe(111);
    expect(prisma._cfg.ultimoEstado).toBe('OK');

    // El buzón NO se toca si el dueño no lo pidió.
    expect(imap.acciones.filter((a) => a.tipo === 'flags' || a.tipo === 'move')).toEqual([]);
    expect(imap.lockOpts.readOnly).toBe(true);
    expect(imap.conectado).toBe(false); // se cerró la conexión
  });

  it('un correo que no es una factura queda anotado y NO se vuelve a mirar', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(3, eml({ messageId: 'promo@x', subject: 'Ofertas', text: '¡50% de descuento!' }))];

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(r.estados).toEqual({ SIN_ADJUNTOS: 1 });
    expect(prisma._filas[0].estado).toBe('SIN_ADJUNTOS');
    expect(prisma._cfg.imapLastUid).toBe(3);
  });

  it('el segundo barrido no duplica nada (el unique del ledger frena)', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(7, eml({ messageId: 'm7@x', text: 'Hola' }))];

    await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });
    // El mismo correo otra vez, con el cursor ya en 7: se pide 8:* y el servidor
    // (por el quirk) devuelve el 7 igual.
    const r2 = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(prisma._filas).toHaveLength(1);
    expect(r2.revisados).toBe(0); // el filtro `uid > desde` lo descarta antes de todo
  });

  it('el quirk de IMAP no hace reprocesar el último mensaje', async () => {
    const prisma = prismaFalso({ imapUidValidity: 111, imapLastUid: 99 });
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(7, eml({ messageId: 'm7@x', text: 'Hola' }))];

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(r.revisados).toBe(0);
    expect(prisma._filas).toHaveLength(0);
    expect(prisma._cfg.imapLastUid).toBe(99); // el cursor no retrocede
  });
});

describe('barrerFacturasPorCorreo — cursor y buzón recreado', () => {
  it('si cambia la UIDVALIDITY, se relee la ventana y el ledger frena lo ya visto', async () => {
    const prisma = prismaFalso({ imapUidValidity: 100, imapLastUid: 80 });
    const imap = new ImapFalso();
    imap.mailbox = { uidValidity: 222 }; // el buzón se recreó: los UIDs no son los mismos
    imap.mensajes = [mensaje(1, eml({ messageId: 'viejo@x', text: 'Hola' }))];

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    // Se pidió por FECHA (no por UID) y el correo se procesó igual.
    expect(imap.acciones[0].rango.since).toBeInstanceOf(Date);
    expect(r.revisados).toBe(1);
    expect(prisma._filas).toHaveLength(1);
    expect(prisma._cfg.imapUidValidity).toBe(222);
    expect(prisma._cfg.imapLastUid).toBe(1);
  });

  it('el mismo correo reenviado con otro UID no se procesa dos veces (Message-ID)', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(1, eml({ messageId: 'mismo@x', text: 'Hola' }))];
    await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    // Otro UID (el buzón se recreó), pero el MISMO Message-ID y sin cursor previo.
    imap.mailbox = { uidValidity: 333 };
    imap.mensajes = [mensaje(50, eml({ messageId: 'mismo@x', text: 'Hola' }))];
    const r2 = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(prisma._filas).toHaveLength(1);
    expect(r2.estados).toEqual({ YA_VISTO: 1 });
  });
});

describe('barrerFacturasPorCorreo — lo que no debe barrer', () => {
  it('una configuración sin activar no se barre (salvo el botón «Revisar ahora»)', async () => {
    const prisma = prismaFalso({ isActive: false });
    const imap = new ImapFalso();

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });
    expect(r.codigo).toBe('INACTIVO');
    expect(imap.conectado).toBe(false);

    const r2 = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap, forzar: true });
    expect(r2.codigo).toBeUndefined();
    expect(imap.conectado).toBe(false); // se conectó y se cerró
  });

  it('sin credenciales no se intenta', async () => {
    const prisma = prismaFalso({ imapHost: null });
    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: new ImapFalso() });
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('SIN_CREDENCIALES');
  });

  it('dos corridas a la vez: la segunda no barre', async () => {
    const prisma = prismaFalso({ ultimoEstado: 'CORRIENDO', ultimaCorridaAt: new Date() });
    const imap = new ImapFalso();
    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });
    expect(r.codigo).toBe('YA_CORRIENDO');
    expect(imap.conectado).toBe(false);
  });

  it('una corrida colgada de hace más de 10 minutos no bloquea para siempre', async () => {
    const prisma = prismaFalso({ ultimoEstado: 'CORRIENDO', ultimaCorridaAt: new Date(Date.now() - 11 * 60 * 1000) });
    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: new ImapFalso() });
    expect(r.codigo).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('un correo gigante se anota como ERROR sin bajarlo', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(4, eml({ messageId: 'grande@x', text: 'x' }), { size: 20 * 1024 * 1024 })];

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(r.estados).toEqual({ ERROR: 1 });
    expect(prisma._filas[0].detalle).toContain('MB');
    expect(prisma._cfg.imapLastUid).toBe(4);
  });

  it('si el dueño pide marcar como leído, se marca', async () => {
    const prisma = prismaFalso({ marcarLeido: true });
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(9, eml({ messageId: 'm9@x', text: 'Hola' }))];

    await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(imap.lockOpts.readOnly).toBe(false);
    expect(imap.acciones.find((a) => a.tipo === 'flags')?.flags).toEqual(['\\Seen']);
  });

  it('un error de conexión deja el estado en la config y no lanza', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.connect = async () => {
      throw Object.assign(new Error('Invalid credentials'), { authenticationFailed: true });
    };

    const r = await barrerFacturasPorCorreo(prisma, 'c1', { cliente: imap });

    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('ERROR_CREDENCIALES');
    expect(prisma._cfg.ultimoEstado).toBe('ERROR_CREDENCIALES');
  });
});

describe('reprocesarMensaje', () => {
  it('solo reprocesa lo INTERRUMPIDO o ERROR', async () => {
    const prisma = prismaFalso();
    prisma._filas.push({ id: 'fila-1', companyId: 'c1', estado: 'CARGADA', uid: 5, folder: 'INBOX' });

    const r = await reprocesarMensaje(prisma, 'c1', 'fila-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('CARGADA');
  });

  it('no toca filas de otra empresa', async () => {
    const prisma = prismaFalso();
    prisma._filas.push({ id: 'fila-1', companyId: 'otra', estado: 'ERROR', uid: 5 });
    const r = await reprocesarMensaje(prisma, 'c1', 'fila-1');
    expect(r.ok).toBe(false);
  });

  it('relee el correo del buzón y vuelve a analizarlo con el MISMO camino', async () => {
    const prisma = prismaFalso();
    const imap = new ImapFalso();
    imap.mensajes = [mensaje(5, eml({ messageId: 'm5@x', adjuntos: [{ nombre: 'FE.pdf', tipo: 'application/pdf', contenido: await pdfFactura() }] }))];
    prisma._filas.push({ id: 'fila-1', companyId: 'c1', estado: 'ERROR', uid: 5, folder: 'INBOX', detalle: 'se cortó' });

    const r = await reprocesarMensaje(prisma, 'c1', 'fila-1', { cliente: imap });

    expect(r.ok).toBe(true);
    const fila = prisma._filas[0];
    expect(fila.estado).toBe('CARGADA');
    expect(JSON.parse(fila.facturas)[0].total).toBe(3.22);
    expect(JSON.parse(fila.facturas)[0].journalEntryId).toBe('je-1');
  });

  it('si el correo ya no está en el buzón, lo dice', async () => {
    const prisma = prismaFalso();
    prisma._filas.push({ id: 'fila-1', companyId: 'c1', estado: 'ERROR', uid: 404, folder: 'INBOX' });
    const r = await reprocesarMensaje(prisma, 'c1', 'fila-1', { cliente: new ImapFalso() });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ya no está');
  });
});
